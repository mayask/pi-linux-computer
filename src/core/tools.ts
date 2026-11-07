import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { loadSettings } from "./config.js";
import { run, shellQuote, sleep } from "./exec.js";
import * as libvirt from "./libvirt.js";
import { toPng } from "./png.js";
import { externalEndpoint, HELPER_PATH, helperCall, ssh, sshPipe, type Endpoint } from "./ssh.js";
import { authorize, loadApprovals, loadSecretMeta, redactor, resolveValue, type Confirm } from "./secrets.js";
import {
  describeStatus,
  destroyVm,
  ensureRunning,
  ensureScopeVm,
  findVm,
  openViewer,
  saveRecord,
  setControl,
  stopVm,
  suspendVm,
  vmStatus,
  type ControlState,
  type Scope,
  type VmRecord,
} from "./vm.js";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: Content[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolContext {
  /** The calling session's identity; decides which VM the call addresses. */
  scope: Scope;
  /** Host directory relative paths resolve against. */
  cwd: string;
  signal?: AbortSignal;
  progress?: (message: string) => void;
  /** Out-of-band question to the human (never the model); enables secret approvals. */
  confirm?: Confirm;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  /** `params` must already satisfy `parameters`; every harness validates tool arguments before calling. */
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

function defineTool<P>(spec: Omit<ToolSpec, "execute"> & { execute(params: P, ctx: ToolContext): Promise<ToolResult> }): ToolSpec {
  return {
    ...spec,
    async execute(params, ctx) {
      // Everything leaving a tool (results, details, progress, errors) is scrubbed of secret values,
      // whatever path they took into the VM.
      const before = await redactor();
      const progress = ctx.progress && ((message: string) => ctx.progress!(before(message)));
      let result: ToolResult;
      try {
        // The harness validated the arguments against `parameters`, which mirrors P.
        result = await spec.execute(params as P, { ...ctx, progress });
      } catch (error) {
        throw new Error((await redactor())(error instanceof Error ? error.message : String(error)));
      }
      // Rebuilt after the call: it may have resolved values (TOTP codes) the earlier one did not know.
      const scrub = await redactor();
      if (scrub.empty) return result;
      return {
        ...result,
        content: result.content.map((part) => (part.type === "text" ? { ...part, text: scrub(part.text) } : part)),
        details: result.details && (JSON.parse(scrub(JSON.stringify(result.details))) as Record<string, unknown>),
      };
    },
  };
}

const MAX_TEXT = 48_000;

// --- schema builders (plain JSON Schema, accepted by MCP, pi and omp) ---
const str = (description: string): JsonSchema => ({ type: "string", description });
const int = (description: string, minimum?: number, maximum?: number, defaultValue?: number): JsonSchema => ({
  type: "integer",
  description,
  ...(minimum !== undefined && { minimum }),
  ...(maximum !== undefined && { maximum }),
  ...(defaultValue !== undefined && { default: defaultValue }),
});
const bool = (description: string, defaultValue?: boolean): JsonSchema => ({
  type: "boolean",
  description,
  ...(defaultValue !== undefined && { default: defaultValue }),
});
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: values, description });
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties: { ...properties, target: str("Name of an external SSH target from the linux-computer config. Omit to use this session's own VM.") },
  required,
  additionalProperties: false,
});

const text = (value: string, details?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n… output truncated …` : value }],
  details,
});

interface Targeted {
  target?: string;
}

interface Guest {
  label: string;
  endpoint: Endpoint;
  record?: VmRecord;
}

/** This session's VM (created/booted/resumed on demand) or a configured external target. */
async function guest(params: Targeted, ctx: ToolContext, settings = loadSettings()): Promise<Guest> {
  if (params.target) {
    const target = settings.targets[params.target];
    if (!target) throw new Error(`Unknown target ${JSON.stringify(params.target)}; configured: ${Object.keys(settings.targets).join(", ") || "none"}`);
    return { label: params.target, endpoint: externalEndpoint(params.target, target) };
  }
  const ready = await ensureScopeVm(ctx.scope, settings, ctx.progress ?? (() => {}), ctx.signal);
  return { label: ready.record.name, endpoint: ready.endpoint, record: ready.record };
}

function rememberControl(record: VmRecord | undefined, control: ControlState): void {
  if (!record) return;
  record.control = control;
  saveRecord(record);
}

async function readControl(g: Guest, ctx: ToolContext): Promise<ControlState> {
  const { control } = await helperCall<{ control: ControlState }>(g.endpoint, "control_get", {}, { signal: ctx.signal });
  rememberControl(g.record, control);
  return control;
}

/** Approvals are per VM: the session's scope, or the external target. */
function approvalScope(params: Targeted, ctx: ToolContext): string {
  return params.target ? `target:${params.target}` : ctx.scope.id;
}

/** Drop the adapter-level `target` before forwarding parameters to the guest helper. */
function helperParams<P extends Targeted>(params: P): Omit<P, "target"> {
  const { target: _target, ...rest } = params;
  return rest;
}

// --- accessibility snapshot formatting ---
interface SnapshotNode {
  id: string;
  depth: number;
  role: string;
  name: string;
  states: string[];
  bounds?: number[];
  actions?: string[];
  text?: string;
  value?: string;
}

interface Snapshot {
  revision: string;
  nodes: SnapshotNode[];
  windows: { id: string; class: string; title: string; active?: boolean }[];
  truncated: boolean;
  control: ControlState;
}

/** States that hold for nearly every visible node; omitting them roughly halves snapshot size. */
const IMPLIED_STATES: Record<string, true> = { enabled: true, sensitive: true, visible: true, showing: true, focusable: true };
const TOP_LEVEL_ROLES: Record<string, true> = { application: true, frame: true, window: true, dialog: true, alert: true, "file chooser": true };

/**
 * Text rendering of a snapshot. Anonymous layout containers (unnamed panels/fillers without text,
 * actions or notable state) are dropped and their children re-indented; ids stay valid because they
 * are absolute paths.
 */
function formatSnapshot(snapshot: Snapshot, label: string, full: boolean): string {
  const lines = [`vm: ${label}  revision: ${snapshot.revision}  nodes: ${snapshot.nodes.length}${snapshot.truncated ? " (truncated; narrow with app/window/focusedWindow/find or raise maxNodes)" : ""}`];
  if (snapshot.control.holder === "user") lines.push(`control: USER since ${snapshot.control.since} — input tools are blocked until the user hands back`);
  if (snapshot.windows.length) {
    lines.push("windows (* = active):");
    for (const window of snapshot.windows) lines.push(`  ${window.active ? "*" : " "}${window.id} ${JSON.stringify(window.title)} ${window.class}`);
  }
  lines.push('tree ([id] role "name" states @x,y,w,h {actions}):');
  let length = lines.reduce((sum, line) => sum + line.length + 1, 0);
  const shown = new Set<string>();
  for (const node of snapshot.nodes) {
    const states = node.states.filter((state) => !IMPLIED_STATES[state]);
    if (!node.states.includes("enabled") && !node.states.includes("sensitive") && node.depth > 1) states.push("disabled");
    const offscreen = node.bounds && (node.bounds[0]! + node.bounds[2]! <= 0 || node.bounds[1]! + node.bounds[3]! <= 0);
    const anonymous = !node.name && !node.text && !node.actions?.length && node.value === undefined && !states.length && !TOP_LEVEL_ROLES[node.role];
    if (!full && (offscreen || anonymous)) continue;
    shown.add(node.id);
    let depth = 0;
    for (let i = node.id.indexOf("/"); i !== -1; i = node.id.indexOf("/", i + 1)) if (shown.has(node.id.slice(0, i))) depth++;
    const indent = "  ".repeat(Math.min(depth, 16));
    const fields = [`[${node.id}]`, node.role, JSON.stringify(node.name)];
    if (states.length) fields.push(states.join(","));
    if (node.bounds) fields.push(`@${node.bounds.join(",")}`);
    if (node.actions?.length) fields.push(`{${node.actions.join(",")}}`);
    if (node.value !== undefined) fields.push(`value=${node.value}`);
    let line = `${indent}${fields.join(" ")}`;
    if (node.text) line += `\n${indent}  text=${JSON.stringify(node.text.replaceAll("\r", ""))}`;
    length += line.length + 1;
    if (length > MAX_TEXT) {
      lines.push("… output truncated; narrow the snapshot (app, window, focusedWindow, find, maxDepth) …");
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

interface Region {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function regionOf(params: Region): [number, number, number, number] | undefined {
  const { x, y, width, height } = params;
  if (x === undefined && y === undefined && width === undefined && height === undefined) return undefined;
  if (x === undefined || y === undefined || width === undefined || height === undefined) throw new Error("A region needs x, y, width and height");
  return [x, y, width, height];
}

/** Full screens come from the hypervisor (works whatever the guest shows); regions are cut in the guest. */
async function screenshotPng(g: Guest, region: number[] | undefined, signal?: AbortSignal): Promise<Buffer> {
  if (g.record && !region) {
    const dir = mkdtempSync(join(tmpdir(), "linux-computer-"));
    try {
      const file = join(dir, "screen");
      await libvirt.screenshot(g.record.name, file);
      return toPng(readFileSync(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const area = region ? `-a ${region.map((n) => Math.round(n)).join(",")} ` : "";
  const script = `eval "$(python3 ${HELPER_PATH} --env)"; t=$(mktemp --suffix=.png); scrot -o -z ${area}"$t" && cat "$t"; rm -f "$t"`;
  const result = await ssh(g.endpoint, `sh -c ${shellQuote(script)}`, { signal, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`Screenshot failed: ${result.stderr.toString("utf8").trim()}`);
  return result.stdout;
}

async function usbList(): Promise<string> {
  const devices = await libvirt.virsh(["nodedev-list", "--cap", "usb_device"]);
  const lines: string[] = [];
  for (const device of devices.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const xml = await libvirt.virsh(["nodedev-dumpxml", device]).catch(() => "");
    const vendor = /<vendor id='0x([0-9a-f]+)'>([^<]*)</.exec(xml);
    const product = /<product id='0x([0-9a-f]+)'>([^<]*)</.exec(xml);
    const devnode = /<devnode type='dev'>([^<]+)</.exec(xml)?.[1];
    if (vendor && product) lines.push(`${vendor[1]}:${product[1]}  ${vendor[2]} ${product[2]}  ${devnode ?? device}`.trim());
  }
  return lines.join("\n") || "no USB devices";
}

async function usbChange(domain: string, attach: boolean, device: string): Promise<string> {
  const match = /^([0-9a-f]{4}):([0-9a-f]{4})$/i.exec(device);
  if (!match) throw new Error("device must be vendor:product hex, e.g. 0bda:0852 (see usb_list)");
  const dir = mkdtempSync(join(tmpdir(), "linux-computer-usb-"));
  try {
    const file = join(dir, "hostdev.xml");
    writeFileSync(file, `<hostdev mode='subsystem' type='usb' managed='yes'><source><vendor id='0x${match[1]}'/><product id='0x${match[2]}'/></source></hostdev>`);
    const result = await run("virsh", ["-q", "-c", libvirt.LIBVIRT_URI, attach ? "attach-device" : "detach-device", domain, file, "--live"], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      const error = result.stderr.toString("utf8").trim();
      const hint = /permission|denied|EACCES/i.test(error)
        ? " The rootless VM cannot open the device node; the user can grant access once with `sudo setfacl -m u:$USER:rw /dev/bus/usb/BBB/DDD` (path from usb_list)."
        : "";
      throw new Error(`${attach ? "Attach" : "Detach"} failed: ${error}${hint}`);
    }
    return `${device} ${attach ? "attached to" : "detached from"} ${domain} (live only; not kept across VM power-off)`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const secretsTool = defineTool<Targeted & { action: "list" }>({
  name: "vm_secrets",
  label: "List usable secrets",
  description:
    "List credentials the user stored for you: name, kind (password, token, totp), username, and where each may be used (browser origins, apps, shell). You never see values. Use them by name: vm_browser fill secret=<name> on an allowed origin, vm_act type secret=<name> into a password field of an allowed app, vm_exec secretEnv={VAR: <name>} when shell use is allowed. A totp secret fills the current one-time code. The first use per VM and place asks the user to approve.",
  parameters: object({ action: oneOf(["list"], "Only list") }, ["action"]),
  async execute(params, ctx) {
    const scope = approvalScope(params, ctx);
    const lines = Object.entries(loadSecretMeta()).map(([name, meta]) => {
      const uses = [...(meta.origins ?? []).map((o) => `browser ${o}`), ...(meta.apps ?? []).map((a) => `app ${a}`), ...(meta.exec ? ["shell"] : [])];
      const approved = loadApprovals().filter((a) => a.secret === name && (a.scope === scope || a.scope === "*")).map((a) => a.use);
      return `${name}  ${meta.kind}${meta.username ? `  user=${meta.username}` : ""}  uses: ${uses.join(", ") || "none"}${approved.length ? `  approved here: ${approved.join(", ")}` : ""}${meta.description ? `  — ${meta.description}` : ""}`;
    });
    return text(lines.length ? lines.join("\n") : "No secrets stored. The user adds them on the host with `linux-computer secret add <name>`.");
  },
});

const LIFECYCLE_ACTIONS = ["status", "start", "view", "suspend", "stop", "restart", "snapshot", "revert", "snapshots", "delete_snapshot", "usb_list", "usb_attach", "usb_detach", "destroy"] as const;

interface LifecycleParams extends Targeted {
  action: (typeof LIFECYCLE_ACTIONS)[number];
  name?: string;
  device?: string;
  confirm?: boolean;
}

const lifecycleTool = defineTool<LifecycleParams>({
  name: "vm_lifecycle",
  label: "VM lifecycle",
  description: [
    "Manage this session's private Linux desktop VM (Debian 13, XFCE, Firefox, Chromium). Each agent session gets its own VM, created on first use from a shared base image; its disk, apps and running state persist across turns and harness restarts until it is destroyed.",
    "status: report without starting. start: boot or resume. view: open the live screen on the user's desktop. suspend: save RAM to disk and stop (resumes exactly). stop: power off. restart: reboot.",
    "snapshot/revert/snapshots/delete_snapshot: named disk+memory checkpoints (name). usb_list/usb_attach/usb_detach: pass a host USB device (vendor:product from usb_list) through; attaching takes it away from the host, so ask the user first.",
    "destroy: delete the VM and its disk permanently; requires confirm=true and an explicit user request.",
  ].join(" "),
  parameters: object(
    {
      action: oneOf(LIFECYCLE_ACTIONS, "Lifecycle operation"),
      name: str("Snapshot name for snapshot/revert/delete_snapshot"),
      device: str("USB device as vendor:product hex, e.g. 0bda:0852, for usb_attach/usb_detach"),
      confirm: bool("Must be true for destroy"),
    },
    ["action"],
  ),
  async execute(params, ctx) {
    if (params.target) throw new Error("vm_lifecycle manages this session's VM only; external targets are controlled outside linux-computer");
    const settings = loadSettings();
    const existing = findVm(ctx.scope.id);
    switch (params.action) {
      case "status":
        return text(existing ? describeStatus(await vmStatus(existing)) : `No VM yet for this session (${ctx.scope.id}). It is created automatically on first use, or with action=start.`);
      case "destroy":
        if (!existing) return text("This session has no VM.");
        if (params.confirm !== true) throw new Error("destroy deletes the VM disk permanently; pass confirm=true only when the user asked for it");
        return text(await destroyVm(existing));
      case "suspend":
        return text(existing ? await suspendVm(existing) : "This session has no VM.");
      case "stop":
        return text(existing ? await stopVm(existing) : "This session has no VM.");
      case "usb_list":
        return text(await usbList());
    }
    const progress = ctx.progress ?? (() => {});
    if (params.action === "restart" && existing) await stopVm(existing);
    const ready = await ensureScopeVm(ctx.scope, settings, progress, ctx.signal);
    const name = ready.record.name;
    switch (params.action) {
      case "start":
      case "restart":
        return text(`${describeStatus(await vmStatus(ready.record))}\napplications on the accessibility bus: ${ready.ping.applications}`);
      case "view":
        return text(await openViewer(ready.record, settings));
      case "snapshot": {
        const snapshot = params.name || `snap-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`;
        await libvirt.snapshotCreate(name, snapshot, `linux-computer snapshot of ${name}`);
        return text(`snapshot ${snapshot} created (disk and memory)`);
      }
      case "revert":
        if (!params.name) throw new Error("revert requires name");
        await libvirt.snapshotRevert(name, params.name);
        await ensureRunning(ready.record, settings, progress, ctx.signal);
        return text(`reverted to ${params.name}`);
      case "delete_snapshot":
        if (!params.name) throw new Error("delete_snapshot requires name");
        await libvirt.snapshotDelete(name, params.name);
        return text(`snapshot ${params.name} deleted`);
      case "snapshots": {
        const snapshots = await libvirt.snapshotList(name);
        return text(snapshots.length ? snapshots.map((s) => `${s.name}  ${s.created}  ${s.state}`).join("\n") : "no snapshots");
      }
      case "usb_attach":
      case "usb_detach":
        return text(await usbChange(name, params.action === "usb_attach", params.device ?? ""));
    }
  },
});

interface ControlParams extends Targeted {
  to: "user" | "agent" | "status";
  message?: string;
  waitSeconds?: number;
}

const controlTool = defineTool<ControlParams>({
  name: "vm_control",
  label: "VM control hand-off",
  description: [
    "Coordinate who drives the VM so the agent and the user never fight over keyboard and mouse.",
    "to='user': after agreeing with the user in chat, hand the VM over. The user's viewer opens, a dialog in the VM tells them they have control, and agent input (vm_act, mutating vm_browser actions) is refused until control returns. Observation tools keep working.",
    "Control returns when the user clicks 'Hand back to agent' in the VM, or when you call to='agent' after the user says they are done. waitSeconds blocks until the user hands back (or the wait ends).",
    "to='status' reports the current holder.",
  ].join(" "),
  parameters: object(
    {
      to: oneOf(["user", "agent", "status"], "New holder, or status"),
      message: str("What the user should do or check; shown in the VM"),
      waitSeconds: int("With to='user' or 'status': wait up to this long for the user to hand back", 0, 3600, 0),
    },
    ["to"],
  ),
  async execute(params, ctx) {
    const settings = loadSettings();
    const g = await guest(params, ctx, settings);
    let control: ControlState;
    if (params.to === "status") control = await readControl(g, ctx);
    else {
      control = await setControl(g, params.to, params.message ?? "", "agent");
      if (params.to === "user" && g.record) await openViewer(g.record, settings).catch(() => undefined);
    }
    const deadline = Date.now() + (params.waitSeconds ?? 0) * 1000;
    while (control.holder === "user" && Date.now() < deadline) {
      await sleep(2000, ctx.signal);
      control = await readControl(g, ctx);
    }
    const summary =
      control.holder === "user"
        ? `The user has control of ${g.label} (since ${control.since}). Agent input is blocked until they click 'Hand back to agent' in the VM or you call vm_control to='agent' after they say they are done.`
        : `The agent has control of ${g.label}${control.message ? ` (${control.message})` : ""}. Observe before acting: the user may have changed the screen.`;
    return text(summary, { control });
  },
});

interface ObserveParams extends Targeted {
  app?: string;
  window?: string;
  focusedWindow?: boolean;
  find?: string;
  maxDepth?: number;
  maxNodes?: number;
  maxTextChars?: number;
  includeText?: boolean;
  visibleOnly?: boolean;
  full?: boolean;
}

const observeTool = defineTool<ObserveParams>({
  name: "vm_observe",
  label: "Observe VM desktop",
  description:
    "Read the VM screen as text: a compact AT-SPI accessibility tree of visible windows (roles, names, states, bounds, actions, text, values) plus the window list. Works for GTK/Qt apps, Firefox, Chromium and WebKit pages. Prefer this over screenshots. Narrow with app, window, focusedWindow or find to save tokens. Node ids are paths and go stale when the UI changes; observe again after acting. Implied states (enabled, visible, showing, focusable) and anonymous layout containers are omitted.",
  parameters: object({
    app: str("Only applications whose name contains this (case-insensitive), e.g. firefox"),
    window: str("Only windows whose title contains this"),
    focusedWindow: bool("Only the active window", false),
    find: str("Only nodes whose name, role or text contains this"),
    maxDepth: int("Tree depth limit", 1, 40, 12),
    maxNodes: int("Node limit", 10, 3000, 300),
    maxTextChars: int("Per-node text limit", 40, 20000, 600),
    includeText: bool("Include text content", true),
    visibleOnly: bool("Skip hidden subtrees", true),
    full: bool("Also list anonymous layout containers", false),
  }),
  async execute(params, ctx) {
    const g = await guest(params, ctx);
    const { full, ...rest } = helperParams(params);
    const snapshot = await helperCall<Snapshot>(g.endpoint, "snapshot", { ...rest }, { signal: ctx.signal, timeoutMs: 90_000 });
    rememberControl(g.record, snapshot.control);
    return text(formatSnapshot(snapshot, g.label, full === true), { vm: g.label, revision: snapshot.revision, nodes: snapshot.nodes.length, truncated: snapshot.truncated });
  },
});

interface ActParams extends Targeted {
  action: string;
  nodeId?: string;
  [key: string]: unknown;
}

const actTool = defineTool<ActParams>({
  name: "vm_act",
  label: "Act on VM desktop",
  description:
    "One input action in the VM, targeted by nodeId from a fresh vm_observe or by x,y. click/double_click/right_click: real pointer clicks at the node's center (most reliable; works like the user). invoke: the node's accessible action (click/press/toggle/check…) without moving the pointer; works for off-screen nodes but some widgets ignore it. focus; set_text replaces an editable field. move, drag (to toX,toY), scroll (at nodeId or x,y). Keyboard: type (unicode text, optional nodeId to focus first), key (xdotool names, e.g. Return, ctrl+l, super, 'ctrl+a BackSpace'). wait pauses. Refused while the user has control (see vm_control). Observe again after state changes.",
  parameters: object(
    {
      action: oneOf(["invoke", "focus", "click", "double_click", "right_click", "move", "drag", "set_text", "type", "key", "scroll", "wait"], "Action"),
      nodeId: str("Node id from the latest vm_observe"),
      accessibleAction: str("Exact AT-SPI action name when a node exposes several"),
      text: str("Text for type or set_text"),
      secret: str("Name of a stored secret to type instead of text (action=type with nodeId of a password field); the value is never shown to you"),
      key: str("Key chord(s) for key, space separated"),
      x: int("Screen x for pointer actions"),
      y: int("Screen y for pointer actions"),
      toX: int("Drag end x"),
      toY: int("Drag end y"),
      button: int("Mouse button", 1, 9, 1),
      direction: oneOf(["up", "down", "left", "right"], "Scroll direction"),
      amount: int("Scroll steps", 1, 50, 3),
      delayMs: int("Delay between typed characters", 0, 1000, 12),
      milliseconds: int("Duration for wait", 0, 30000, 1000),
    },
    ["action"],
  ),
  async execute(params, ctx) {
    const g = await guest(params, ctx);
    let forward: Record<string, unknown> = helperParams(params);
    if (typeof params.secret === "string") {
      if (params.action !== "type" || !params.nodeId) throw new Error("secret works with action=type and the nodeId of the field to type into");
      const node = await helperCall<{ app: string; role: string }>(g.endpoint, "node_info", { nodeId: params.nodeId }, { signal: ctx.signal });
      const meta = await authorize(params.secret, approvalScope(params, ctx), g.label, { via: "app", app: node.app }, ctx.confirm);
      const { secret: _secret, text: _text, ...rest } = forward;
      forward = { ...rest, secretValue: await resolveValue(params.secret, meta), secretKind: meta.kind, expectApp: node.app };
    }
    const result = await helperCall<{ performed: string; node?: { id: string; role: string; name: string } }>(g.endpoint, "act", forward, {
      signal: ctx.signal,
      timeoutMs: 120_000,
    });
    const node = result.node;
    const what = typeof params.secret === "string" ? ` «secret:${params.secret}»` : "";
    return text(`${result.performed}${what}${node ? ` on [${node.id}] ${node.role} ${JSON.stringify(node.name)}` : ""}`, { vm: g.label, ...result });
  },
});

interface ScreenTextParams extends Targeted, Region {
  minConfidence?: number;
}

const screenTextTool = defineTool<ScreenTextParams>({
  name: "vm_screen_text",
  label: "OCR VM screen",
  description:
    "Read on-screen text with OCR (tesseract, in the VM) when the accessibility tree has nothing: canvases, images, games, terminals without AT-SPI, remote desktops. Returns text lines with screen bounds usable for vm_act coordinates. An optional region narrows and speeds it up. No image model needed.",
  parameters: object({
    x: int("Region left"),
    y: int("Region top"),
    width: int("Region width"),
    height: int("Region height"),
    minConfidence: int("Drop words below this confidence (0-100)", 0, 100, 40),
  }),
  async execute(params, ctx) {
    const g = await guest(params, ctx);
    const region = regionOf(params);
    const result = await helperCall<{ lines: { text: string; bounds: number[]; confidence: number }[] }>(
      g.endpoint,
      "ocr",
      { ...(region && { x: region[0], y: region[1], width: region[2], height: region[3] }), minConfidence: params.minConfidence ?? 40 },
      { signal: ctx.signal, timeoutMs: 120_000 },
    );
    const lines = result.lines.map((line) => `@${line.bounds.join(",")} ${JSON.stringify(line.text)}`);
    return text(lines.length ? lines.join("\n") : "no text recognized", { vm: g.label, lines: result.lines.length });
  },
});

const screenshotTool = defineTool<Targeted & Region>({
  name: "vm_screenshot",
  label: "Screenshot VM",
  description:
    "PNG of the VM screen (or a region). Only for genuinely visual checks such as layout, colors, rendering or images; use vm_observe or vm_screen_text for reading UI and text.",
  parameters: object({
    x: int("Region left"),
    y: int("Region top"),
    width: int("Region width"),
    height: int("Region height"),
  }),
  async execute(params, ctx) {
    const g = await guest(params, ctx);
    const png = await screenshotPng(g, regionOf(params), ctx.signal);
    return {
      content: [
        { type: "text", text: `Screenshot of ${g.label} (${png.length} bytes)` },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ],
      details: { vm: g.label, bytes: png.length },
    };
  },
});

interface ExecParams extends Targeted {
  command: string;
  timeoutSeconds?: number;
  background?: boolean;
  cwd?: string;
  secretEnv?: Record<string, string>;
}

const execTool = defineTool<ExecParams>({
  name: "vm_exec",
  label: "Run command in VM",
  description:
    "Run a bash command in the VM as user 'agent' (passwordless sudo). The desktop session environment (DISPLAY, DBUS, XAUTHORITY) is set, so GUI programs open on the shared screen. Use background=true for GUI apps, servers and anything that leaves processes running (a foreground command returns only when every process holding its output exits); background output goes to a log file. Use this for files, packages, builds and services; use vm_act only for real GUI interaction.",
  parameters: object(
    {
      command: str("Bash command"),
      timeoutSeconds: int("Timeout for foreground commands", 1, 3600, 120),
      background: bool("Detach and return immediately", false),
      cwd: str("Guest working directory (default: home)"),
      secretEnv: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Environment variables filled from stored secrets, e.g. {\"GH_TOKEN\": \"github/token\"}; only for secrets with exec allowed. Output is scrubbed of the values.",
      },
    },
    ["command"],
  ),
  async execute(params, ctx) {
    const g = await guest(params, ctx);
    const cd = params.cwd ? `cd ${shellQuote(params.cwd)} && ` : "";
    const env = `eval "$(python3 ${HELPER_PATH} --env)"`;
    // Secret values travel on stdin as NUL-separated VAR=value records, never in argv or on disk.
    let input = "";
    let readSecrets = "";
    for (const [variable, name] of Object.entries(params.secretEnv ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error(`Invalid environment variable name ${variable}`);
      const meta = await authorize(name, approvalScope(params, ctx), g.label, { via: "exec" }, ctx.confirm);
      input += `${variable}=${await resolveValue(name, meta)}\0`;
    }
    if (input) {
      input += "\0";
      readSecrets = `while IFS= read -r -d '' kv && [ -n "$kv" ]; do export "$kv"; done; `;
    }
    if (params.background) {
      const log = `.local/state/linux-computer/bg-${Date.now().toString(36)}.log`;
      // systemd-run moves the job into the guest user's manager, so it outlives this SSH connection.
      const script = `${readSecrets}${env}; mkdir -p .local/state/linux-computer; ${cd}nohup systemd-run --user --scope --quiet --collect -- bash -lc ${shellQuote(params.command)} > ~/${log} 2>&1 < /dev/null & echo $!`;
      const result = await ssh(g.endpoint, `bash -c ${shellQuote(script)}`, { input, signal: ctx.signal, timeoutMs: 30_000 });
      if (result.exitCode !== 0) throw new Error(`Background start failed: ${result.stderr.toString("utf8")}`);
      const pid = Number(result.stdout.toString("utf8").trim());
      return text(`started pid ${pid}; output: ~/${log} (read it with vm_exec; secret values are scrubbed)`, { vm: g.label, pid, log: `~/${log}` });
    }
    const result = await ssh(g.endpoint, `bash -c ${shellQuote(`${readSecrets}exec bash -lc ${shellQuote(`${env}; ${cd}${params.command}`)}`)}`, {
      input,
      signal: ctx.signal,
      timeoutMs: (params.timeoutSeconds ?? 120) * 1000,
    });
    const stdout = result.stdout.toString("utf8");
    const stderr = result.stderr.toString("utf8");
    return text([stdout, stderr ? `stderr:\n${stderr}` : "", `exit code: ${result.exitCode}`].filter(Boolean).join("\n"), { vm: g.label, exitCode: result.exitCode });
  },
});

interface CopyParams extends Targeted {
  direction: "to_vm" | "from_vm";
  source: string;
  destination: string;
  exclude?: string[];
}

const copyTool = defineTool<CopyParams>({
  name: "vm_copy",
  label: "Copy files to/from VM",
  description:
    "Copy a file or directory between the host (relative to the project directory) and the VM (relative to the guest home) by streaming tar over the VM connection. The source is placed inside destination, keeping its name.",
  parameters: object(
    {
      direction: oneOf(["to_vm", "from_vm"], "Copy direction"),
      source: str("Source path (host path for to_vm, guest path for from_vm)"),
      destination: str("Destination directory (guest for to_vm, host for from_vm)"),
      exclude: { type: "array", items: { type: "string" }, description: "tar --exclude patterns, e.g. node_modules, target, .git" },
    },
    ["direction", "source", "destination"],
  ),
  async execute(params, ctx) {
    const g = await guest(params, ctx);
    const excludes = (params.exclude ?? []).map((pattern) => `--exclude=${shellQuote(pattern)}`).join(" ");
    const options = { signal: ctx.signal, timeoutMs: 3_600_000 };
    if (params.direction === "to_vm") {
      const source = isAbsolute(params.source) ? params.source : resolve(ctx.cwd, params.source);
      const local = `tar -C ${shellQuote(dirname(source))} ${excludes} -cf - ${shellQuote(basename(source))}`;
      const remote = `mkdir -p ${shellQuote(params.destination)} && tar -C ${shellQuote(params.destination)} -xf -`;
      const result = await sshPipe(g.endpoint, "to", local, `sh -c ${shellQuote(remote)}`, options);
      if (result.exitCode !== 0) throw new Error(`Copy failed: ${result.stderr.toString("utf8")}`);
      return text(`copied ${source} -> ${g.label}:${params.destination}/${basename(source)}`);
    }
    const destination = isAbsolute(params.destination) ? params.destination : resolve(ctx.cwd, params.destination);
    const remote = `cd "$(dirname ${shellQuote(params.source)})" && tar ${excludes} -cf - "$(basename ${shellQuote(params.source)})"`;
    const local = `mkdir -p ${shellQuote(destination)} && tar -C ${shellQuote(destination)} -xf -`;
    const result = await sshPipe(g.endpoint, "from", `{ ${local}; }`, `sh -c ${shellQuote(remote)}`, options);
    if (result.exitCode !== 0) throw new Error(`Copy failed: ${result.stderr.toString("utf8")}`);
    return text(`copied ${g.label}:${params.source} -> ${join(destination, basename(params.source))}`);
  },
});

interface BrowserParams extends Targeted {
  action: "open" | "navigate" | "text" | "elements" | "click" | "fill" | "eval" | "tabs" | "activate" | "close";
  [key: string]: unknown;
}

interface BrowserElement {
  id: number;
  tag: string;
  label: string;
  type?: string;
  role?: string;
  name?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  inView: boolean;
}

interface BrowserResult {
  tabs?: { index: number; id: string; title: string; url: string }[];
  note?: string;
  title?: string;
  url?: string;
  text?: string;
  value?: string;
  truncated?: boolean;
  elements?: BrowserElement[];
  [key: string]: unknown;
}

const browserTool = defineTool<BrowserParams>({
  name: "vm_browser",
  label: "Drive Chromium in VM",
  description:
    "DOM-level control of Chromium inside the VM through its DevTools endpoint (the window stays visible on the shared screen). open (url; starts Chromium if needed), navigate (url), text (page text), elements (numbered interactive elements), click / fill (element number from elements, or CSS selector; fill can submit), eval (JavaScript expression, awaited), tabs, activate, close. tab selects by id or index (default: most recent). Firefox and other browsers are driven through vm_observe/vm_act instead. Mutating actions are refused while the user has control.",
  parameters: object(
    {
      action: oneOf(["open", "navigate", "text", "elements", "click", "fill", "eval", "tabs", "activate", "close"], "Browser action"),
      url: str("URL for open/navigate"),
      tab: str("Tab id or index"),
      element: int("Element number from the latest elements call"),
      selector: str("CSS selector (alternative to element)"),
      text: str("Text for fill"),
      secret: str("Name of a stored secret to fill instead of text; only allowed on the secret's origins, the value is never shown to you"),
      submit: bool("Press Enter after fill", false),
      expression: str("JavaScript for eval"),
      limit: int("Max elements", 10, 2000, 200),
      maxChars: int("Max characters returned", 200, 200000, 20000),
      timeoutSeconds: int("Navigation/eval timeout", 1, 120, 30),
    },
    ["action"],
  ),
  async execute(params, ctx) {
    const g = await guest(params, ctx);
    let forward: Record<string, unknown> = helperParams(params);
    if (typeof params.secret === "string") {
      if (params.action !== "fill") throw new Error("secret works with action=fill");
      const { secret: _secret, text: _text, ...rest } = forward;
      const target = await helperCall<{ origin: string }>(g.endpoint, "browser", { ...rest, action: "origin" }, { signal: ctx.signal, timeoutMs: 60_000 });
      const meta = await authorize(params.secret, approvalScope(params, ctx), g.label, { via: "browser", origin: target.origin }, ctx.confirm);
      forward = { ...rest, secretValue: await resolveValue(params.secret, meta), expectOrigin: target.origin };
    }
    const result = await helperCall<BrowserResult>(g.endpoint, "browser", forward, { signal: ctx.signal, timeoutMs: 180_000 });
    switch (params.action) {
      case "tabs":
        return text(result.tabs?.length ? result.tabs.map((t) => `${t.index} ${t.id} ${JSON.stringify(t.title)} ${t.url}`).join("\n") : (result.note ?? "no tabs"), { vm: g.label });
      case "text":
        return text(`${result.title}\n${result.url}\n\n${result.text}${result.truncated ? "\n… truncated (raise maxChars)" : ""}`, { vm: g.label });
      case "elements":
        return text(
          [
            `${result.title}\n${result.url}`,
            ...(result.elements ?? []).map((e) => {
              const attrs = [e.type && `type=${e.type}`, e.role && `role=${e.role}`, e.name && `name=${e.name}`, e.href && `href=${e.href}`, e.checked && "checked", e.disabled && "disabled", !e.inView && "offscreen"].filter(Boolean);
              return `[${e.id}] ${e.tag} ${JSON.stringify(e.label)}${attrs.length ? ` ${attrs.join(" ")}` : ""}`;
            }),
          ].join("\n"),
          { vm: g.label, elements: result.elements?.length ?? 0 },
        );
      case "eval":
        return text(`${result.value}${result.truncated ? "\n… truncated" : ""}`, { vm: g.label });
      default: {
        const { ok: _ok, ...summary } = result;
        return text(JSON.stringify(summary), { vm: g.label, ...summary });
      }
    }
  },
});

interface TerminalParams extends Targeted {
  strategy?: "auto" | "tmux" | "clipboard";
  tmuxPane?: string;
  includeScrollback?: boolean;
  maxChars?: number;
}

interface TerminalCapture {
  strategy: "tmux" | "clipboard";
  tmuxPane: string | null;
  clipboardRestored: boolean | null;
  command: string | null;
  output: string;
  truncated: boolean;
  capturePath: string | null;
  scrollback?: string;
}

const terminalTool = defineTool<TerminalParams>({
  name: "vm_terminal_capture",
  label: "Capture VM terminal output",
  description:
    "Recover the last command and its complete output from a terminal on the VM screen without rerunning it. auto prefers the single attached tmux pane, then falls back to the focused terminal's Select All + copy while restoring the clipboard. Use for off-screen scrollback instead of screenshots.",
  parameters: object({
    strategy: oneOf(["auto", "tmux", "clipboard"], "Capture strategy"),
    tmuxPane: str("Explicit tmux target such as session:0.0"),
    includeScrollback: bool("Also return raw retained scrollback", false),
    maxChars: int("Max output characters", 1000, 45000, 45000),
  }),
  async execute(params, ctx) {
    const g = await guest(params, ctx);
    const capture = await helperCall<TerminalCapture>(g.endpoint, "terminal_capture", helperParams(params), { signal: ctx.signal, timeoutMs: 90_000 });
    const lines = [
      `strategy: ${capture.strategy}${capture.tmuxPane ? ` (${capture.tmuxPane})` : ""}`,
      `command: ${capture.command ?? "<no command boundary found; use includeScrollback>"}`,
      "output:",
      capture.output,
    ];
    if (capture.truncated && capture.capturePath) lines.push(`… truncated; complete output in the VM at ${capture.capturePath}`);
    if (capture.strategy === "clipboard") lines.push(`clipboard restored: ${capture.clipboardRestored ? "yes" : "no"}`);
    if (capture.scrollback !== undefined) lines.push("raw scrollback:", capture.scrollback);
    return text(lines.join("\n"), { vm: g.label, strategy: capture.strategy, command: capture.command });
  },
});

export const TOOLS: readonly ToolSpec[] = [
  lifecycleTool,
  controlTool,
  secretsTool,
  observeTool,
  actTool,
  screenTextTool,
  screenshotTool,
  execTool,
  copyTool,
  browserTool,
  terminalTool,
];

/** Shared operating guidance for any harness (MCP instructions, skill text). */
export const INSTRUCTIONS = `linux-computer gives this session its own persistent Linux desktop VM (Debian 13 + XFCE, Firefox, Chromium), created on first use. The user can watch the same screen live and take part.
- Read the screen as text: vm_observe (accessibility tree) first, vm_screen_text (OCR) for canvases/images, vm_screenshot only for visual checks.
- Act on nodes: vm_act click/set_text/type/key with node ids from a fresh vm_observe (raw coordinates only for canvases or OCR hits). Observe again after each state change.
- Web apps: vm_browser drives Chromium at DOM level (elements, click, fill, eval). Firefox works through vm_observe/vm_act.
- Commands, builds, files: vm_exec (desktop env set; background=true for GUI/long jobs) and vm_copy.
- Credentials: never ask the user to paste passwords or tokens into chat. vm_secrets list shows what is stored; use them by name (vm_browser fill secret=, vm_act type secret=, vm_exec secretEnv=). Values never reach you and appear as «secret:name» if they show up anywhere.
- Never fight the user for input. When the user should test or do something in the VM, agree in chat, then vm_control to='user' (optionally waitSeconds). Input is blocked until they hand back.
- The VM persists until destroyed; vm_lifecycle snapshot before risky steps, revert to undo. Destroy only on explicit request.`;
