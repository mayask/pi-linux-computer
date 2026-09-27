#!/usr/bin/env python3
"""Small, stateless AT-SPI/X11 bridge for pi-linux-computer."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pyatspi

STATE_CONSTANTS = [
    ("active", pyatspi.STATE_ACTIVE),
    ("checked", pyatspi.STATE_CHECKED),
    ("editable", pyatspi.STATE_EDITABLE),
    ("enabled", pyatspi.STATE_ENABLED),
    ("expanded", pyatspi.STATE_EXPANDED),
    ("focusable", pyatspi.STATE_FOCUSABLE),
    ("focused", pyatspi.STATE_FOCUSED),
    ("selected", pyatspi.STATE_SELECTED),
    ("sensitive", pyatspi.STATE_SENSITIVE),
    ("showing", pyatspi.STATE_SHOWING),
    ("visible", pyatspi.STATE_VISIBLE),
]


def safe(callable_, default=None):
    try:
        return callable_()
    except Exception:
        return default


def child_at(node, index: int):
    return node.getChildAtIndex(index)


def node_at_path(root, node_id: str):
    if node_id in ("", "root"):
        return root
    node = root
    for part in node_id.split("/"):
        if not part.isdigit():
            raise ValueError(f"Invalid node ID: {node_id!r}")
        index = int(part)
        count = safe(lambda: node.childCount, 0)
        if index < 0 or index >= count:
            raise ValueError(f"Stale node ID: {node_id!r}")
        node = child_at(node, index)
    return node


def node_states(node) -> list[str]:
    state_set = safe(node.getState, None)
    if state_set is None:
        return []
    return [name for name, value in STATE_CONSTANTS if safe(lambda value=value: state_set.contains(value), False)]


def node_bounds(node) -> list[int] | None:
    component = safe(node.queryComponent, None)
    if component is None:
        return None
    extents = safe(lambda: component.getExtents(pyatspi.DESKTOP_COORDS), None)
    if extents is None or extents.width <= 0 or extents.height <= 0:
        return None
    if abs(extents.x) > 100000 or abs(extents.y) > 100000:
        return None
    return [int(extents.x), int(extents.y), int(extents.width), int(extents.height)]


def node_actions(node) -> list[str]:
    action = safe(node.queryAction, None)
    if action is None:
        return []
    count = safe(lambda: action.nActions, 0)
    return [safe(lambda i=i: action.getName(i), "") for i in range(count)]


def node_text(node, max_chars: int) -> str | None:
    text_iface = safe(node.queryText, None)
    if text_iface is None:
        return None
    count = safe(lambda: text_iface.characterCount, 0)
    if count <= 0:
        return None
    text = safe(lambda: text_iface.getText(max(0, count - max_chars), count), "")
    text = text.replace("\x00", "").strip()
    return text or None


def windows() -> list[dict[str, Any]]:
    try:
        result = subprocess.run(["wmctrl", "-lx"], check=False, capture_output=True, text=True, timeout=5)
    except Exception:
        return []
    output = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) >= 5:
            output.append({"id": parts[0], "desktop": parts[1], "host": parts[2], "class": parts[3], "title": parts[4]})
    return output


def snapshot(params: dict[str, Any]) -> dict[str, Any]:
    max_depth = max(1, min(int(params.get("maxDepth", 8)), 20))
    max_nodes = max(10, min(int(params.get("maxNodes", 300)), 2000))
    max_text = max(40, min(int(params.get("maxTextChars", 1200)), 10000))
    include_text = bool(params.get("includeText", True))
    visible_only = bool(params.get("visibleOnly", True))

    root = pyatspi.Registry.getDesktop(0)
    nodes: list[dict[str, Any]] = []
    truncated = False

    def visit(node, path: list[int], depth: int):
        nonlocal truncated
        if len(nodes) >= max_nodes:
            truncated = True
            return

        role = safe(node.getRoleName, "unknown") or "unknown"
        name = safe(lambda: node.name, "") or ""
        states = node_states(node)
        bounds = node_bounds(node)
        actions = node_actions(node)
        text = node_text(node, max_text) if include_text else None
        child_count = safe(lambda: node.childCount, 0)
        showing = "showing" in states or role == "desktop frame" or (role == "application" and child_count > 0)

        if not visible_only or showing or text or actions:
            item: dict[str, Any] = {
                "id": "/".join(str(i) for i in path) or "root",
                "depth": depth,
                "role": role,
                "name": name,
                "states": states,
            }
            if bounds is not None:
                item["bounds"] = bounds
            if actions:
                item["actions"] = actions
            if text:
                item["text"] = text
            nodes.append(item)

        if depth >= max_depth:
            if safe(lambda: node.childCount, 0) > 0:
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
    revision_source = json.dumps(nodes, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    revision = hashlib.sha256(revision_source.encode()).hexdigest()[:16]
    return {
        "ok": True,
        "revision": revision,
        "nodes": nodes,
        "windows": windows(),
        "truncated": truncated,
        "display": os.environ.get("DISPLAY", ""),
    }


def focus_node(node) -> bool:
    component = safe(node.queryComponent, None)
    return bool(component is not None and safe(component.grabFocus, False))


def invoke_node(node, requested: str | None = None) -> str:
    action = safe(node.queryAction, None)
    if action is None:
        raise RuntimeError("Node exposes no accessible actions")
    names = [safe(lambda i=i: action.getName(i), "") for i in range(safe(lambda: action.nActions, 0))]
    preferred = [requested] if requested else ["click", "press", "activate", "open", "toggle", "jump"]
    for wanted in preferred:
        if not wanted:
            continue
        for index, name in enumerate(names):
            if name.lower() == wanted.lower():
                if not action.doAction(index):
                    raise RuntimeError(f"Accessible action {name!r} failed")
                return name
    raise RuntimeError(f"Requested action is unavailable; node actions: {names}")


def click_at(x: int, y: int, button: int = 1):
    subprocess.run(["xdotool", "mousemove", str(x), str(y), "click", str(button)], check=True, timeout=10)


def act(params: dict[str, Any]) -> dict[str, Any]:
    action_name = str(params.get("action", ""))
    node_id = params.get("nodeId")
    root = pyatspi.Registry.getDesktop(0)
    node = node_at_path(root, str(node_id)) if node_id is not None else None

    if action_name == "invoke":
        if node is None:
            raise ValueError("invoke requires nodeId")
        performed = invoke_node(node, params.get("accessibleAction"))
    elif action_name == "focus":
        if node is None:
            raise ValueError("focus requires nodeId")
        if not focus_node(node):
            raise RuntimeError("Node could not be focused")
        performed = "focus"
    elif action_name == "click":
        if node is not None:
            try:
                performed = invoke_node(node, params.get("accessibleAction"))
            except Exception:
                bounds = node_bounds(node)
                if bounds is None:
                    raise RuntimeError("Node has neither a click action nor usable bounds")
                click_at(bounds[0] + bounds[2] // 2, bounds[1] + bounds[3] // 2, int(params.get("button", 1)))
                performed = "coordinate-click"
        else:
            if "x" not in params or "y" not in params:
                raise ValueError("click requires nodeId or x and y")
            click_at(int(params["x"]), int(params["y"]), int(params.get("button", 1)))
            performed = "coordinate-click"
    elif action_name == "set_text":
        if node is None:
            raise ValueError("set_text requires nodeId")
        editable = safe(node.queryEditableText, None)
        if editable is None:
            raise RuntimeError("Node does not expose editable text")
        editable.setTextContents(str(params.get("text", "")))
        performed = "set_text"
    elif action_name == "type":
        if node is not None:
            focus_node(node)
        text = str(params.get("text", ""))
        delay = max(0, min(int(params.get("delayMs", 30)), 1000))
        subprocess.run(["xdotool", "type", "--clearmodifiers", "--delay", str(delay), "--", text], check=True, timeout=30)
        performed = "type"
    elif action_name == "key":
        key = str(params.get("key", ""))
        if not key:
            raise ValueError("key requires key")
        subprocess.run(["xdotool", "key", "--clearmodifiers", key], check=True, timeout=10)
        performed = "key"
    elif action_name == "scroll":
        direction = str(params.get("direction", "down"))
        amount = max(1, min(int(params.get("amount", 3)), 50))
        button = "4" if direction == "up" else "5"
        subprocess.run(["xdotool", "click", "--repeat", str(amount), "--delay", "50", button], check=True, timeout=10)
        performed = f"scroll-{direction}"
    elif action_name == "wait":
        milliseconds = max(0, min(int(params.get("milliseconds", 1000)), 30000))
        time.sleep(milliseconds / 1000)
        performed = "wait"
    else:
        raise ValueError(f"Unsupported action: {action_name!r}")

    return {
        "ok": True,
        "action": action_name,
        "performed": performed,
        "nodeId": node_id,
        "node": {
            "role": safe(node.getRoleName, "") if node is not None else None,
            "name": safe(lambda: node.name, "") if node is not None else None,
        },
    }


def walk(node, max_depth: int = 20, depth: int = 0):
    yield node
    if depth >= max_depth:
        return
    for index in range(safe(lambda: node.childCount, 0)):
        child = safe(lambda index=index: child_at(node, index), None)
        if child is not None:
            yield from walk(child, max_depth, depth + 1)


def find_terminal_context():
    root = pyatspi.Registry.getDesktop(0)
    fallback = None
    for app in (safe(lambda: child_at(root, i), None) for i in range(safe(lambda: root.childCount, 0))):
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
    raise RuntimeError("No visible terminal was found through AT-SPI")


def read_clipboard() -> tuple[bool, bytes]:
    result = subprocess.run(
        ["xclip", "-selection", "clipboard", "-o"],
        check=False,
        capture_output=True,
        timeout=10,
    )
    return result.returncode == 0, result.stdout


def write_clipboard(value: bytes):
    # An X11 clipboard is owned by a live process. Leave xclip detached as the
    # replacement owner; it exits automatically when another process claims it.
    owner = subprocess.Popen(
        ["xclip", "-selection", "clipboard", "-in"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    assert owner.stdin is not None
    owner.stdin.write(value)
    owner.stdin.close()
    time.sleep(0.1)
    if owner.poll() not in (None, 0):
        raise RuntimeError("Could not restore clipboard")


def clipboard_scrollback() -> tuple[str, bool]:
    app, terminal = find_terminal_context()
    select_all = next(
        (
            node
            for node in walk(app)
            if safe(node.getRoleName, "") == "menu item" and safe(lambda: node.name, "").strip().lower() == "select all"
        ),
        None,
    )
    if select_all is None:
        raise RuntimeError("The terminal does not expose a Select All accessibility action")

    had_clipboard, old_clipboard = read_clipboard()
    restored = False
    try:
        focus_node(terminal)
        invoke_node(select_all, "click")
        time.sleep(0.15)
        subprocess.run(["xdotool", "key", "--clearmodifiers", "ctrl+shift+c"], check=True, timeout=10)
        time.sleep(0.25)
        copied, contents = read_clipboard()
        if not copied:
            raise RuntimeError("Terminal copy did not produce readable clipboard text")
        scrollback = contents.decode("utf-8", errors="replace")
        bounds = node_bounds(terminal)
        if bounds is not None:
            click_at(bounds[0] + bounds[2] // 2, bounds[1] + bounds[3] // 2)
    finally:
        try:
            write_clipboard(old_clipboard if had_clipboard else b"")
            restored = True
        except Exception:
            # Capture remains useful, but callers are explicitly told that
            # restoration failed.
            restored = False
    return scrollback, restored


def tmux_scrollback(requested_pane: str | None = None) -> tuple[str, str]:
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
            raise RuntimeError("No tmux server is running")
        candidates = []
        for line in listed.stdout.splitlines():
            fields = line.split("\t")
            if len(fields) == 3 and fields[1] == "1" and fields[2] != "0":
                candidates.append(fields[0])
        if len(candidates) != 1:
            raise RuntimeError(f"Expected one active attached tmux pane, found {len(candidates)}; specify tmuxPane")
        pane = candidates[0]

    captured = subprocess.run(
        ["tmux", "capture-pane", "-p", "-J", "-S", "-", "-t", pane],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if captured.returncode != 0:
        raise RuntimeError(f"tmux capture-pane failed: {captured.stderr.strip()}")
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


def extract_last_command(scrollback: str) -> tuple[str | None, str]:
    lines = scrollback.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    prompt_lines = [(index, prompt_match(line)) for index, line in enumerate(lines)]
    prompt_lines = [(index, match) for index, match in prompt_lines if match is not None]

    for position in range(len(prompt_lines) - 1, -1, -1):
        index, match = prompt_lines[position]
        command = match.group("command").strip()
        if not command:
            continue
        next_index = prompt_lines[position + 1][0] if position + 1 < len(prompt_lines) else len(lines)
        # A command still being typed at the final prompt has no following output.
        if next_index == len(lines) and not any(line.strip() for line in lines[index + 1 :]):
            continue
        output = "\n".join(lines[index + 1 : next_index]).rstrip("\n")
        return command, output
    return None, ""


def terminal_capture(params: dict[str, Any]) -> dict[str, Any]:
    strategy = str(params.get("strategy", "auto"))
    tmux_pane = params.get("tmuxPane")
    include_scrollback = bool(params.get("includeScrollback", False))
    max_chars = max(1000, min(int(params.get("maxChars", 48000)), 200000))
    pane = None
    clipboard_restored = None

    if strategy not in ("auto", "tmux", "clipboard"):
        raise ValueError(f"Unsupported capture strategy: {strategy!r}")

    if strategy in ("auto", "tmux"):
        try:
            scrollback, pane = tmux_scrollback(str(tmux_pane) if tmux_pane else None)
            used_strategy = "tmux"
        except Exception:
            if strategy == "tmux":
                raise
            scrollback, clipboard_restored = clipboard_scrollback()
            used_strategy = "clipboard"
    else:
        scrollback, clipboard_restored = clipboard_scrollback()
        used_strategy = "clipboard"

    command, output = extract_last_command(scrollback)
    truncated = len(output) > max_chars
    capture_path = None
    if truncated:
        capture_dir = Path.home() / ".local" / "share" / "pi-linux-computer" / "captures"
        capture_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        capture_path = capture_dir / "last-command-output.txt"
        capture_path.write_text(output, encoding="utf-8")
        capture_path.chmod(0o600)
        output = output[:max_chars]

    result = {
        "ok": True,
        "strategy": used_strategy,
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


def main():
    request = json.load(sys.stdin)
    operation = request.get("operation")
    params = request.get("params") or {}
    if operation == "snapshot":
        result = snapshot(params)
    elif operation == "act":
        result = act(params)
    elif operation == "terminal_capture":
        result = terminal_capture(params)
    elif operation == "ping":
        result = {"ok": True, "display": os.environ.get("DISPLAY", ""), "desktop": pyatspi.Registry.getDesktop(0).name}
    else:
        raise ValueError(f"Unsupported operation: {operation!r}")
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        json.dump({"ok": False, "error": f"{type(error).__name__}: {error}"}, sys.stderr)
        sys.stderr.write("\n")
        raise SystemExit(1)
