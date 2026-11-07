#!/usr/bin/env python3
"""Stateless guest-side bridge for linux-computer.

Reads one JSON request {"operation": ..., "params": {...}} on stdin and writes one JSON reply on stdout.
Failures are a JSON object on stderr ({"ok": false, "error": ..., "code": ...}) with exit status 1.

Also usable from a shell:
  helper.py --env        print `export` lines for the logged-in desktop session
  helper.py --handback   return control to the agent (used by the hand-back dialog)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

STATE_DIR = Path.home() / ".local" / "state" / "linux-computer"
CONTROL_FILE = STATE_DIR / "control.json"
CAPTURE_DIR = Path.home() / ".local" / "share" / "linux-computer" / "captures"
SESSION_PROCESSES = ("xfce4-session", "gnome-session-binary", "gnome-shell", "plasmashell", "ksmserver", "lxqt-session", "mate-session", "cinnamon-session", "xfwm4")
ENV_KEYS = ("DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP")
CDP = "http://127.0.0.1:9222"


class HelperError(Exception):
    def __init__(self, message: str, code: str = "ERROR"):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Desktop session environment


def session_environment() -> Dict[str, str]:
    """Environment of the user's running desktop session, discovered from its processes."""
    uid = os.getuid()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if proc.stat().st_uid != uid:
                continue
            if (proc / "comm").read_text().strip() not in SESSION_PROCESSES:
                continue
            raw = (proc / "environ").read_bytes()
        except OSError:
            continue
        env = dict(item.split("=", 1) for item in raw.decode(errors="replace").split("\0") if "=" in item)
        found = {key: env[key] for key in ENV_KEYS if env.get(key)}
        if "DISPLAY" in found or "WAYLAND_DISPLAY" in found:
            return found
    runtime = f"/run/user/{uid}"
    return {
        "DISPLAY": ":0",
        "XAUTHORITY": str(Path.home() / ".Xauthority"),
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path={runtime}/bus",
        "XDG_RUNTIME_DIR": runtime,
    }


def apply_session_environment():
    for key, value in session_environment().items():
        os.environ.setdefault(key, value)


pyatspi = None  # imported lazily: needs the session bus environment first


def atspi():
    global pyatspi
    if pyatspi is None:
        import pyatspi as module  # type: ignore

        pyatspi = module
    return pyatspi


# ---------------------------------------------------------------------------
# Control hand-off between agent and user


def read_control() -> Dict[str, Any]:
    try:
        data = json.loads(CONTROL_FILE.read_text())
        if data.get("holder") in ("agent", "user"):
            return data
    except (OSError, ValueError):
        pass
    return {"holder": "agent", "since": None}


def write_control(data: Dict[str, Any]):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONTROL_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(CONTROL_FILE)


def notify(summary: str, body: str):
    subprocess.run(["notify-send", "-a", "linux-computer", "-i", "dialog-information", summary, body], check=False, timeout=10, capture_output=True)


def require_agent_control(operation: str):
    control = read_control()
    if control.get("holder") == "user":
        since = control.get("since") or "unknown time"
        raise HelperError(
            f"The user has control of this VM (since {since}). {operation} is blocked so agent input does not clash with the user. "
            "Wait for the user to hand control back (they click 'Hand back to agent' in the VM, or tell you in chat), "
            "then call vm_control with to='agent'. Observation tools still work.",
            "USER_CONTROL",
        )


def kill_dialog(control: Dict[str, Any]):
    pid = control.get("dialogPid")
    if pid:
        try:
            os.killpg(int(pid), signal.SIGTERM)
        except (OSError, ValueError):
            pass


def spawn_detached(argv: List[str], stdin=subprocess.DEVNULL) -> subprocess.Popen:
    """Start a process owned by the user's systemd manager instead of this SSH session, so it keeps
    running when the connection closes (dialogs, browsers, clipboard owners)."""
    return subprocess.Popen(
        ["systemd-run", "--user", "--scope", "--quiet", "--collect", "--", *argv],
        stdin=stdin,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def control_set(params: Dict[str, Any]) -> Dict[str, Any]:
    holder = params.get("holder")
    if holder not in ("agent", "user"):
        raise HelperError("holder must be 'agent' or 'user'", "INVALID")
    previous = read_control()
    kill_dialog(previous)
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    message = str(params.get("message") or "")
    data: Dict[str, Any] = {"holder": holder, "since": now, "message": message, "by": params.get("by", "agent")}
    if holder == "user":
        text = (message + "\n\n" if message else "") + "The agent is paused and will not touch the keyboard or mouse.\nClick the button below when you are done."
        dialog = spawn_detached(
            [
                "sh",
                "-c",
                'zenity --info --title="linux-computer: your turn" --icon=input-mouse --ok-label="Hand back to agent" --width=420 --text="$1"; exec python3 "$2" --handback',
                "sh",
                text,
                str(Path(__file__).resolve()),
            ]
        )
        data["dialogPid"] = dialog.pid
        write_control(data)
        notify("You have control", message or "The agent is paused until you hand control back.")
    else:
        write_control(data)
        if previous.get("holder") == "user" and params.get("by") != "user":
            notify("Agent resumed", message or "The agent has control of this VM again.")
    return {"ok": True, "control": data, "previous": previous}


def handback():
    control = read_control()
    if control.get("holder") != "user":
        return
    write_control({"holder": "agent", "since": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "message": "handed back from the VM", "by": "user"})
    notify("Agent resumed", "Control returned to the agent.")


# ---------------------------------------------------------------------------
# AT-SPI accessibility tree


def safe(callable_, default=None):
    try:
        return callable_()
    except Exception:
        return default


def state_constants():
    a = atspi()
    return [
        ("active", a.STATE_ACTIVE),
        ("checked", a.STATE_CHECKED),
        ("editable", a.STATE_EDITABLE),
        ("enabled", a.STATE_ENABLED),
        ("expanded", a.STATE_EXPANDED),
        ("focusable", a.STATE_FOCUSABLE),
        ("focused", a.STATE_FOCUSED),
        ("selected", a.STATE_SELECTED),
        ("sensitive", a.STATE_SENSITIVE),
        ("showing", a.STATE_SHOWING),
        ("visible", a.STATE_VISIBLE),
        ("modal", a.STATE_MODAL),
    ]


def child_at(node, index: int):
    return node.getChildAtIndex(index)


def node_at_path(root, node_id: str):
    if node_id in ("", "root"):
        return root
    node = root
    for part in node_id.split("/"):
        if not part.isdigit():
            raise HelperError(f"Invalid node ID: {node_id!r}", "INVALID")
        index = int(part)
        count = safe(lambda: node.childCount, 0)
        if index < 0 or index >= count:
            raise HelperError(f"Stale node ID {node_id!r}; observe again", "STALE_NODE")
        node = child_at(node, index)
    return node


def node_states(node) -> List[str]:
    state_set = safe(node.getState, None)
    if state_set is None:
        return []
    return [name for name, value in state_constants() if safe(lambda value=value: state_set.contains(value), False)]


def node_bounds(node) -> Optional[List[int]]:
    component = safe(node.queryComponent, None)
    if component is None:
        return None
    extents = safe(lambda: component.getExtents(atspi().DESKTOP_COORDS), None)
    if extents is None or extents.width <= 0 or extents.height <= 0:
        return None
    if abs(extents.x) > 100000 or abs(extents.y) > 100000:
        return None
    return [int(extents.x), int(extents.y), int(extents.width), int(extents.height)]


def node_actions(node) -> List[str]:
    action = safe(node.queryAction, None)
    if action is None:
        return []
    count = safe(lambda: action.nActions, 0)
    return [safe(lambda i=i: action.getName(i), "") for i in range(count)]


def node_text(node, max_chars: int) -> Optional[str]:
    text_iface = safe(node.queryText, None)
    if text_iface is None:
        return None
    count = safe(lambda: text_iface.characterCount, 0)
    if count <= 0:
        return None
    text = safe(lambda: text_iface.getText(max(0, count - max_chars), count), "") or ""
    text = text.replace("\x00", "").replace("\ufffc", "").strip()
    return text or None


def node_value(node) -> Optional[str]:
    value = safe(node.queryValue, None)
    if value is None:
        return None
    current = safe(lambda: value.currentValue, None)
    return None if current is None else f"{current:g}"


def windows() -> List[Dict[str, Any]]:
    try:
        result = subprocess.run(["wmctrl", "-lx"], check=False, capture_output=True, text=True, timeout=5)
    except Exception:
        return []
    active = ""
    try:
        active = subprocess.run(["xdotool", "getactivewindow"], check=False, capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        pass
    output = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) >= 5:
            item = {"id": parts[0], "class": parts[3], "title": parts[4]}
            if active and int(parts[0], 16) == int(active):
                item["active"] = True
            output.append(item)
    return output


def snapshot(params: Dict[str, Any]) -> Dict[str, Any]:
    max_depth = max(1, min(int(params.get("maxDepth", 12)), 40))
    max_nodes = max(10, min(int(params.get("maxNodes", 300)), 3000))
    max_text = max(40, min(int(params.get("maxTextChars", 600)), 20000))
    include_text = bool(params.get("includeText", True))
    visible_only = bool(params.get("visibleOnly", True))
    app_filter = str(params.get("app") or "").lower()
    window_filter = str(params.get("window") or "").lower()
    focused_only = bool(params.get("focusedWindow", False))
    find = str(params.get("find") or "").lower()

    root = atspi().Registry.getDesktop(0)
    nodes: List[Dict[str, Any]] = []
    truncated = False
    pending_app: List[Optional[Dict[str, Any]]] = [None]

    def wanted_window(node, depth: int) -> bool:
        if depth != 2:
            return True
        if focused_only and "active" not in node_states(node):
            return False
        if window_filter and window_filter not in (safe(lambda: node.name, "") or "").lower():
            return False
        return True

    def visit(node, path: List[int], depth: int):
        nonlocal truncated
        if len(nodes) >= max_nodes:
            truncated = True
            return
        role = safe(node.getRoleName, "unknown") or "unknown"
        name = safe(lambda: node.name, "") or ""
        if depth == 1 and app_filter and app_filter not in name.lower():
            return
        if not wanted_window(node, depth):
            return
        states = node_states(node)
        child_count = safe(lambda: node.childCount, 0) or 0
        # Hidden subtrees (closed menus, background tabs) are skipped entirely, which keeps snapshots small.
        if visible_only and depth >= 2 and "showing" not in states:
            return
        actions = node_actions(node)
        text = node_text(node, max_text) if include_text else None
        value = node_value(node)
        hit = not find or find in name.lower() or find in role or (text is not None and find in text.lower())
        if depth == 1 or (depth > 1 and hit):
            item: Dict[str, Any] = {"id": "/".join(str(i) for i in path), "depth": depth, "role": role, "name": name, "states": states}
            bounds = node_bounds(node)
            if bounds is not None:
                item["bounds"] = bounds
            if actions:
                item["actions"] = actions
            if text and text != name:
                item["text"] = text
            if value is not None:
                item["value"] = value
            if depth == 1:
                # Emit an application only once something inside it is listed.
                pending_app[0] = item
            else:
                if pending_app[0] is not None:
                    nodes.append(pending_app[0])
                    pending_app[0] = None
                nodes.append(item)
        if depth >= max_depth:
            if child_count > 0:
                truncated = True
            return
        for index in range(child_count):
            if len(nodes) >= max_nodes:
                truncated = True
                return
            child = safe(lambda index=index: child_at(node, index), None)
            if child is not None:
                visit(child, [*path, index], depth + 1)

    visit(root, [], 0)
    revision = hashlib.sha256(json.dumps(nodes, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
    return {"ok": True, "revision": revision, "nodes": nodes, "windows": windows(), "truncated": truncated, "control": read_control()}


def focus_node(node) -> bool:
    component = safe(node.queryComponent, None)
    return bool(component is not None and safe(component.grabFocus, False))


DEFAULT_ACTIONS = ["click", "press", "activate", "open", "toggle", "check", "uncheck", "select", "jump", "expand or contract", "default.activate"]


def invoke_node(node, requested: Optional[str] = None) -> str:
    action = safe(node.queryAction, None)
    if action is None:
        raise HelperError("Node exposes no accessible actions", "NO_ACTION")
    names = [safe(lambda i=i: action.getName(i), "") for i in range(safe(lambda: action.nActions, 0))]
    for wanted in [requested] if requested else DEFAULT_ACTIONS:
        for index, name in enumerate(names):
            if name and wanted and name.lower() == wanted.lower():
                if not action.doAction(index):
                    raise HelperError(f"Accessible action {name!r} failed", "ACTION_FAILED")
                return name
    if not requested and len(names) == 1 and names[0]:
        if not action.doAction(0):
            raise HelperError(f"Accessible action {names[0]!r} failed", "ACTION_FAILED")
        return names[0]
    raise HelperError(f"Requested action is unavailable; node actions: {names}", "NO_ACTION")


def xdotool(*args: str, timeout: int = 15):
    subprocess.run(["xdotool", *args], check=True, timeout=timeout)


def center(bounds: List[int]) -> Tuple[int, int]:
    return bounds[0] + bounds[2] // 2, bounds[1] + bounds[3] // 2


def act(params: Dict[str, Any]) -> Dict[str, Any]:
    action_name = str(params.get("action", ""))
    if action_name != "wait":
        require_agent_control(f"vm_act {action_name}")
    node_id = params.get("nodeId")
    node = node_at_path(atspi().Registry.getDesktop(0), str(node_id)) if node_id not in (None, "") else None
    button = str(int(params.get("button", 1)))

    def point() -> Tuple[int, int]:
        if "x" in params and "y" in params and params["x"] is not None:
            return int(params["x"]), int(params["y"])
        if node is not None:
            bounds = node_bounds(node)
            if bounds is None:
                raise HelperError("Node has no usable on-screen bounds", "NO_BOUNDS")
            return center(bounds)
        raise HelperError(f"{action_name} requires nodeId or x and y", "INVALID")

    if action_name == "invoke":
        if node is None:
            raise HelperError("invoke requires nodeId", "INVALID")
        performed = invoke_node(node, params.get("accessibleAction"))
    elif action_name == "focus":
        if node is None:
            raise HelperError("focus requires nodeId", "INVALID")
        if not focus_node(node):
            raise HelperError("Node could not be focused", "ACTION_FAILED")
        performed = "focus"
    elif action_name == "click":
        # A real pointer click behaves exactly like the user's; some widgets (e.g. panel launchers)
        # report success for their accessible "click" action yet do nothing. Fall back to the
        # accessible action only for nodes without on-screen bounds.
        bounds = node_bounds(node) if node is not None and params.get("x") is None else None
        if node is not None and params.get("x") is None and bounds is None:
            performed = invoke_node(node, params.get("accessibleAction"))
        else:
            x, y = point()
            xdotool("mousemove", str(x), str(y), "click", button)
            performed = f"pointer-click {x},{y}"
    elif action_name in ("double_click", "right_click", "move"):
        x, y = point()
        if action_name == "double_click":
            xdotool("mousemove", str(x), str(y), "click", "--repeat", "2", "--delay", "80", button)
        elif action_name == "right_click":
            xdotool("mousemove", str(x), str(y), "click", "3")
        else:
            xdotool("mousemove", str(x), str(y))
        performed = f"{action_name} {x},{y}"
    elif action_name == "drag":
        x, y = point()
        if params.get("toX") is None or params.get("toY") is None:
            raise HelperError("drag requires toX and toY", "INVALID")
        to_x, to_y = int(params["toX"]), int(params["toY"])
        xdotool("mousemove", str(x), str(y), "mousedown", button)
        steps = 12
        for step in range(1, steps + 1):
            xdotool("mousemove", str(x + (to_x - x) * step // steps), str(y + (to_y - y) * step // steps))
            time.sleep(0.02)
        xdotool("mouseup", button)
        performed = f"drag {x},{y} -> {to_x},{to_y}"
    elif action_name == "set_text":
        if node is None:
            raise HelperError("set_text requires nodeId", "INVALID")
        editable = safe(node.queryEditableText, None)
        if editable is None:
            raise HelperError("Node does not expose editable text; focus it and use type", "NOT_EDITABLE")
        editable.setTextContents(str(params.get("text", "")))
        performed = "set_text"
    elif action_name == "type":
        if node is not None:
            focus_node(node)
        delay = max(0, min(int(params.get("delayMs", 12)), 1000))
        text = str(params.get("text", ""))
        xdotool("type", "--clearmodifiers", "--delay", str(delay), "--", text, timeout=30 + len(text) * max(delay, 1) // 1000)
        performed = "type"
    elif action_name == "key":
        key = str(params.get("key", ""))
        if not key:
            raise HelperError("key requires key", "INVALID")
        if node is not None:
            focus_node(node)
        xdotool("key", "--clearmodifiers", *key.split())
        performed = "key"
    elif action_name == "scroll":
        direction = str(params.get("direction", "down"))
        amount = max(1, min(int(params.get("amount", 3)), 50))
        wheel = {"up": "4", "down": "5", "left": "6", "right": "7"}.get(direction)
        if wheel is None:
            raise HelperError("direction must be up, down, left or right", "INVALID")
        if node is not None or "x" in params:
            x, y = point()
            xdotool("mousemove", str(x), str(y))
        xdotool("click", "--repeat", str(amount), "--delay", "40", wheel)
        performed = f"scroll-{direction}"
    elif action_name == "wait":
        time.sleep(max(0, min(int(params.get("milliseconds", 1000)), 30000)) / 1000)
        performed = "wait"
    else:
        raise HelperError(f"Unsupported action: {action_name!r}", "INVALID")

    result: Dict[str, Any] = {"ok": True, "action": action_name, "performed": performed}
    if node is not None:
        result["node"] = {"id": node_id, "role": safe(node.getRoleName, ""), "name": safe(lambda: node.name, "")}
    return result


# ---------------------------------------------------------------------------
# OCR for canvases, images and widgets without accessibility data


def ocr(params: Dict[str, Any]) -> Dict[str, Any]:
    region = [params.get(key) for key in ("x", "y", "width", "height")]
    with tempfile.TemporaryDirectory() as tmp:
        image = os.path.join(tmp, "screen.png")
        args = ["scrot", "-o", "-p" if params.get("pointer") else "-z"]
        offset_x = offset_y = 0
        if all(value is not None for value in region):
            x, y, w, h = (int(value) for value in region)
            args += ["-a", f"{x},{y},{w},{h}"]
            offset_x, offset_y = x, y
        subprocess.run([*args, image], check=True, timeout=20, capture_output=True)
        tsv = subprocess.run(
            ["tesseract", image, "-", "--psm", str(int(params.get("psm", 11))), "tsv"],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout
    min_conf = float(params.get("minConfidence", 40))
    lines: Dict[Tuple[int, int, int, int], Dict[str, Any]] = {}
    for row in tsv.splitlines()[1:]:
        cols = row.split("\t")
        if len(cols) < 12 or not cols[11].strip():
            continue
        conf = float(cols[10])
        if conf < min_conf:
            continue
        key = (int(cols[1]), int(cols[2]), int(cols[3]), int(cols[4]))
        left, top, width, height = (int(cols[i]) for i in (6, 7, 8, 9))
        line = lines.setdefault(key, {"words": [], "box": [left, top, left + width, top + height], "conf": []})
        line["words"].append(cols[11])
        line["conf"].append(conf)
        box = line["box"]
        line["box"] = [min(box[0], left), min(box[1], top), max(box[2], left + width), max(box[3], top + height)]
    output = []
    for line in lines.values():
        x0, y0, x1, y1 = line["box"]
        output.append({"text": " ".join(line["words"]), "bounds": [x0 + offset_x, y0 + offset_y, x1 - x0, y1 - y0], "confidence": round(sum(line["conf"]) / len(line["conf"]))})
    output.sort(key=lambda item: (item["bounds"][1] // 8, item["bounds"][0]))
    return {"ok": True, "lines": output}


# ---------------------------------------------------------------------------
# Chromium DevTools protocol (DOM-level browser driving)


def cdp_get(path: str, method: str = "GET", timeout: float = 5) -> Any:
    request = urllib.request.Request(CDP + path, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode()
    try:
        return json.loads(body)
    except ValueError:
        return body


def cdp_available() -> bool:
    try:
        cdp_get("/json/version", timeout=1)
        return True
    except Exception:
        return False


def ensure_chromium(url: Optional[str] = None):
    if cdp_available():
        return False
    spawn_detached(["chromium", "--new-window", url or "about:blank"])
    deadline = time.time() + 30
    while time.time() < deadline:
        if cdp_available() and any(tab.get("type") == "page" for tab in cdp_get("/json/list")):
            return True
        time.sleep(0.3)
    raise HelperError("Chromium did not expose its DevTools endpoint on 127.0.0.1:9222", "BROWSER_UNAVAILABLE")


def pages() -> List[Dict[str, Any]]:
    return [tab for tab in cdp_get("/json/list") if tab.get("type") == "page"]


def pick_page(tab: Any) -> Dict[str, Any]:
    tabs = pages()
    if not tabs:
        raise HelperError("Chromium has no open tab", "NO_TAB")
    if tab in (None, ""):
        return tabs[0]
    for index, item in enumerate(tabs):
        if str(tab) == item["id"] or str(tab) == str(index):
            return item
    raise HelperError(f"No tab {tab!r}; tabs: {[t['id'] for t in tabs]}", "NO_TAB")


class Cdp:
    def __init__(self, page: Dict[str, Any], timeout: float):
        import websocket  # type: ignore

        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=timeout, suppress_origin=True)
        self.next_id = 0

    def call(self, method: str, **params):
        self.next_id += 1
        message_id = self.next_id
        self.ws.send(json.dumps({"id": message_id, "method": method, "params": params}))
        while True:
            reply = json.loads(self.ws.recv())
            if reply.get("id") == message_id:
                if "error" in reply:
                    raise HelperError(f"{method}: {reply['error'].get('message')}", "CDP_ERROR")
                return reply.get("result", {})

    def evaluate(self, expression: str, timeout_ms: int = 20000):
        result = self.call("Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True, userGesture=True, timeout=timeout_ms)
        if result.get("exceptionDetails"):
            details = result["exceptionDetails"]
            text = details.get("exception", {}).get("description") or details.get("text")
            raise HelperError(f"JavaScript error: {text}", "JS_ERROR")
        return result.get("result", {}).get("value")

    def close(self):
        safe(self.ws.close)


ELEMENTS_JS = r"""
(() => {
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || style.visibility === 'hidden' || style.display === 'none') continue;
    if (r.bottom < 0 || r.top > innerHeight * 3) continue;
    el.setAttribute('data-lc-id', String(n));
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    out.push({
      id: n++,
      tag: el.tagName.toLowerCase(),
      type: el.type || undefined,
      role: el.getAttribute('role') || undefined,
      label,
      href: el.getAttribute('href') || undefined,
      name: el.name || undefined,
      checked: el.checked === true ? true : undefined,
      disabled: el.disabled === true ? true : undefined,
      inView: r.top >= 0 && r.bottom <= innerHeight,
    });
    if (out.length >= LIMIT) break;
  }
  return { title: document.title, url: location.href, elements: out };
})()
"""


def element_selector(params: Dict[str, Any]) -> str:
    if params.get("element") is not None:
        return f'[data-lc-id="{int(params["element"])}"]'
    selector = params.get("selector")
    if not selector:
        raise HelperError("Requires element (from elements) or selector", "INVALID")
    return str(selector)


def element_center(cdp: Cdp, selector: str) -> Tuple[float, float]:
    box = cdp.evaluate(
        f"""(() => {{ const el = document.querySelector({json.dumps(selector)}); if (!el) return null;
        el.scrollIntoView({{block: 'center', inline: 'center'}}); const r = el.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2]; }})()"""
    )
    if not box:
        raise HelperError(f"No element matches {selector!r}; list elements again", "NO_ELEMENT")
    return box[0], box[1]


def browser(params: Dict[str, Any]) -> Dict[str, Any]:
    action = str(params.get("action", "tabs"))
    max_chars = max(200, min(int(params.get("maxChars", 20000)), 200000))
    timeout = max(1, min(int(params.get("timeoutSeconds", 30)), 120))
    if action not in ("tabs", "text", "elements"):
        require_agent_control(f"vm_browser {action}")

    if action == "open":
        url = str(params.get("url") or "about:blank")
        if ensure_chromium(url):
            page = pages()[0]
        else:
            page = cdp_get("/json/new?" + urllib.parse.quote(url, safe=""), method="PUT")
            cdp_get(f"/json/activate/{page['id']}")
        return {"ok": True, "tab": {"id": page["id"], "url": page.get("url"), "title": page.get("title")}}
    if not cdp_available():
        if action == "tabs":
            return {"ok": True, "tabs": [], "note": "Chromium with DevTools is not running; use action 'open'"}
        ensure_chromium()
    if action == "tabs":
        return {"ok": True, "tabs": [{"index": i, "id": t["id"], "title": t.get("title"), "url": t.get("url")} for i, t in enumerate(pages())]}
    page = pick_page(params.get("tab"))
    if action == "close":
        cdp_get(f"/json/close/{page['id']}")
        return {"ok": True, "closed": page["id"]}
    if action == "activate":
        cdp_get(f"/json/activate/{page['id']}")
        return {"ok": True, "tab": page["id"]}

    cdp = Cdp(page, timeout)
    try:
        if action == "navigate":
            url = str(params.get("url") or "")
            if not url:
                raise HelperError("navigate requires url", "INVALID")
            cdp.call("Page.navigate", url=url)
            deadline = time.time() + timeout
            state = ""
            while time.time() < deadline:
                time.sleep(0.25)
                state = safe(lambda: cdp.evaluate("document.readyState + ' ' + location.href"), "") or ""
                if state.startswith("complete"):
                    break
            return {"ok": True, "tab": page["id"], "state": state}
        if action == "text":
            value = cdp.evaluate("({title: document.title, url: location.href, text: document.body ? document.body.innerText : ''})")
            text = value.get("text") or ""
            return {"ok": True, "tab": page["id"], "title": value.get("title"), "url": value.get("url"), "text": text[:max_chars], "truncated": len(text) > max_chars}
        if action == "elements":
            limit = max(10, min(int(params.get("limit", 200)), 2000))
            value = cdp.evaluate(ELEMENTS_JS.replace("LIMIT", str(limit)))
            return {"ok": True, "tab": page["id"], **value}
        if action == "eval":
            expression = str(params.get("expression") or "")
            if not expression:
                raise HelperError("eval requires expression", "INVALID")
            value = cdp.evaluate(expression, timeout * 1000)
            encoded = json.dumps(value, ensure_ascii=False, default=str)
            return {"ok": True, "tab": page["id"], "value": encoded[:max_chars], "truncated": len(encoded) > max_chars}
        if action == "click":
            x, y = element_center(cdp, element_selector(params))
            for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
                cdp.call("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", clickCount=1)
            return {"ok": True, "tab": page["id"], "clicked": [round(x), round(y)]}
        if action == "fill":
            selector = element_selector(params)
            focused = cdp.evaluate(
                f"""(() => {{ const el = document.querySelector({json.dumps(selector)}); if (!el) return false;
                el.scrollIntoView({{block: 'center'}}); el.focus();
                if (el.select) el.select(); else document.execCommand('selectAll'); return true; }})()"""
            )
            if not focused:
                raise HelperError(f"No element matches {selector!r}; list elements again", "NO_ELEMENT")
            cdp.call("Input.insertText", text=str(params.get("text", "")))
            if params.get("submit"):
                for kind in ("keyDown", "keyUp"):
                    cdp.call("Input.dispatchKeyEvent", type=kind, key="Enter", code="Enter", windowsVirtualKeyCode=13, text="\r" if kind == "keyDown" else None)
            return {"ok": True, "tab": page["id"], "filled": selector}
        raise HelperError(f"Unsupported browser action {action!r}", "INVALID")
    finally:
        cdp.close()


# ---------------------------------------------------------------------------
# Terminal output capture


def walk(node, max_depth: int = 20, depth: int = 0):
    yield node
    if depth >= max_depth:
        return
    for index in range(safe(lambda: node.childCount, 0)):
        child = safe(lambda index=index: child_at(node, index), None)
        if child is not None:
            yield from walk(child, max_depth, depth + 1)


def find_terminal_context():
    root = atspi().Registry.getDesktop(0)
    fallback = None
    for app in (safe(lambda i=i: child_at(root, i), None) for i in range(safe(lambda: root.childCount, 0))):
        if app is None:
            continue
        for node in walk(app):
            if safe(node.getRoleName, "") != "terminal":
                continue
            context = (app, node)
            if "focused" in node_states(node):
                return context
            if fallback is None and "showing" in node_states(node):
                fallback = context
    if fallback is not None:
        return fallback
    raise HelperError("No visible terminal was found through AT-SPI", "NO_TERMINAL")


def read_clipboard() -> Tuple[bool, bytes]:
    result = subprocess.run(["xclip", "-selection", "clipboard", "-o"], check=False, capture_output=True, timeout=10)
    return result.returncode == 0, result.stdout


def write_clipboard(value: bytes):
    # An X11 clipboard is owned by a live process. Leave xclip detached as the
    # replacement owner; it exits automatically when another process claims it.
    owner = spawn_detached(["xclip", "-selection", "clipboard", "-in"], stdin=subprocess.PIPE)
    assert owner.stdin is not None
    owner.stdin.write(value)
    owner.stdin.close()
    time.sleep(0.1)
    if owner.poll() not in (None, 0):
        raise HelperError("Could not restore clipboard", "CLIPBOARD")


def clipboard_scrollback() -> Tuple[str, bool]:
    app, terminal = find_terminal_context()
    select_all = next(
        (node for node in walk(app) if safe(node.getRoleName, "") == "menu item" and (safe(lambda: node.name, "") or "").strip().lower().replace("_", "") == "select all"),
        None,
    )
    had_clipboard, old_clipboard = read_clipboard()
    restored = False
    try:
        focus_node(terminal)
        if select_all is not None:
            invoke_node(select_all, "click")
        else:
            # Menus are often built lazily; GTK/VTE terminals bind Select All to ctrl+shift+a.
            xdotool("key", "--clearmodifiers", "ctrl+shift+a")
        time.sleep(0.15)
        xdotool("key", "--clearmodifiers", "ctrl+shift+c")
        time.sleep(0.25)
        copied, contents = read_clipboard()
        if not copied:
            raise HelperError("Terminal copy did not produce readable clipboard text", "CLIPBOARD")
        scrollback = contents.decode("utf-8", errors="replace")
        bounds = node_bounds(terminal)
        if bounds is not None:
            xdotool("mousemove", *map(str, center(bounds)), "click", "1")
    finally:
        try:
            write_clipboard(old_clipboard if had_clipboard else b"")
            restored = True
        except Exception:
            restored = False
    return scrollback, restored


def tmux_scrollback(requested_pane: Optional[str] = None) -> Tuple[str, str]:
    pane = requested_pane
    if not pane:
        listed = subprocess.run(
            ["tmux", "list-panes", "-a", "-F", "#{session_name}:#{window_index}.#{pane_index}\t#{pane_active}\t#{session_attached}"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if listed.returncode != 0:
            raise HelperError("No tmux server is running", "NO_TMUX")
        candidates = [fields[0] for fields in (line.split("\t") for line in listed.stdout.splitlines()) if len(fields) == 3 and fields[1] == "1" and fields[2] != "0"]
        if len(candidates) != 1:
            raise HelperError(f"Expected one active attached tmux pane, found {len(candidates)}; specify tmuxPane", "NO_TMUX")
        pane = candidates[0]
    captured = subprocess.run(["tmux", "capture-pane", "-p", "-J", "-S", "-", "-t", pane], check=False, capture_output=True, text=True, timeout=15)
    if captured.returncode != 0:
        raise HelperError(f"tmux capture-pane failed: {captured.stderr.strip()}", "NO_TMUX")
    return captured.stdout, pane


PROMPT_PATTERNS = [
    re.compile(r"^(?P<prompt>[^\s@]+@[^:\s]+:[^\n]*?[$#] )(?P<command>.*)$"),
    re.compile(r"^(?P<prompt>.+?[$#] )(?P<command>.*)$"),
]


def prompt_match(line: str):
    for pattern in PROMPT_PATTERNS:
        match = pattern.match(line)
        if match:
            return match
    return None


def extract_last_command(scrollback: str) -> Tuple[Optional[str], str]:
    lines = scrollback.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    prompt_lines = [(index, match) for index, match in ((i, prompt_match(line)) for i, line in enumerate(lines)) if match is not None]
    for position in range(len(prompt_lines) - 1, -1, -1):
        index, match = prompt_lines[position]
        command = match.group("command").strip()
        if not command:
            continue
        next_index = prompt_lines[position + 1][0] if position + 1 < len(prompt_lines) else len(lines)
        # A command still being typed at the final prompt has no following output.
        if next_index == len(lines) and not any(line.strip() for line in lines[index + 1 :]):
            continue
        return command, "\n".join(lines[index + 1 : next_index]).rstrip("\n")
    return None, ""


def terminal_capture(params: Dict[str, Any]) -> Dict[str, Any]:
    strategy = str(params.get("strategy", "auto"))
    tmux_pane = params.get("tmuxPane")
    include_scrollback = bool(params.get("includeScrollback", False))
    max_chars = max(1000, min(int(params.get("maxChars", 45000)), 200000))
    pane = None
    clipboard_restored = None
    if strategy not in ("auto", "tmux", "clipboard"):
        raise HelperError(f"Unsupported capture strategy: {strategy!r}", "INVALID")

    def via_clipboard():
        require_agent_control("Clipboard terminal capture")
        return clipboard_scrollback()

    if strategy in ("auto", "tmux"):
        try:
            scrollback, pane = tmux_scrollback(str(tmux_pane) if tmux_pane else None)
            used = "tmux"
        except HelperError:
            if strategy == "tmux":
                raise
            scrollback, clipboard_restored = via_clipboard()
            used = "clipboard"
    else:
        scrollback, clipboard_restored = via_clipboard()
        used = "clipboard"

    command, output = extract_last_command(scrollback)
    truncated = len(output) > max_chars
    capture_path = None
    if truncated:
        CAPTURE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        capture_path = CAPTURE_DIR / "last-command-output.txt"
        capture_path.write_text(output, encoding="utf-8")
        capture_path.chmod(0o600)
        output = output[:max_chars]
    result: Dict[str, Any] = {
        "ok": True,
        "strategy": used,
        "tmuxPane": pane,
        "clipboardRestored": clipboard_restored,
        "command": command,
        "output": output,
        "truncated": truncated,
        "capturePath": str(capture_path) if capture_path else None,
        "scrollbackChars": len(scrollback),
    }
    if include_scrollback:
        result["scrollback"] = scrollback[:max_chars]
        result["scrollbackTruncated"] = len(scrollback) > max_chars
    return result


# ---------------------------------------------------------------------------


def ping(_params: Dict[str, Any]) -> Dict[str, Any]:
    desktop = atspi().Registry.getDesktop(0)
    return {"ok": True, "display": os.environ.get("DISPLAY", ""), "applications": safe(lambda: desktop.childCount, 0), "control": read_control()}


OPERATIONS = {
    "ping": ping,
    "snapshot": snapshot,
    "act": act,
    "ocr": ocr,
    "browser": browser,
    "terminal_capture": terminal_capture,
    "control_get": lambda _params: {"ok": True, "control": read_control()},
    "control_set": control_set,
}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--env":
        # Explicit values (target overrides) win over discovery.
        apply_session_environment()
        for key in ENV_KEYS:
            if os.environ.get(key):
                print(f"export {key}={shlex.quote(os.environ[key])}")
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--handback":
        apply_session_environment()
        handback()
        return
    apply_session_environment()
    request = json.load(sys.stdin)
    operation = request.get("operation")
    handler = OPERATIONS.get(operation)
    if handler is None:
        raise HelperError(f"Unsupported operation: {operation!r}", "INVALID")
    json.dump(handler(request.get("params") or {}), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except HelperError as error:
        json.dump({"ok": False, "error": str(error), "code": error.code}, sys.stderr)
        sys.stderr.write("\n")
        raise SystemExit(1)
    except subprocess.CalledProcessError as error:
        stderr = error.stderr.decode(errors="replace").strip() if isinstance(error.stderr, bytes) else (error.stderr or "")
        json.dump({"ok": False, "error": f"{' '.join(map(str, error.cmd))} failed ({error.returncode}) {stderr}".strip(), "code": "COMMAND_FAILED"}, sys.stderr)
        sys.stderr.write("\n")
        raise SystemExit(1)
    except Exception as error:
        json.dump({"ok": False, "error": f"{type(error).__name__}: {error}", "code": "ERROR"}, sys.stderr)
        sys.stderr.write("\n")
        raise SystemExit(1)
