import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBase, currentBase, GUEST_USER, listBases, type BaseInfo, type Progress } from "./base-image.js";
import type { Settings } from "./config.js";
import { domainXml } from "./domain-xml.js";
import { run, runChecked, sleep } from "./exec.js";
import * as libvirt from "./libvirt.js";
import { withLock } from "./lock.js";
import { ensureDir, paths } from "./paths.js";
import { closeMaster, helperCall, managedEndpoint, type Endpoint } from "./ssh.js";

/** Who a VM belongs to. One scope owns at most one VM. */
export interface Scope {
  /** Stable identity, e.g. `omp:<root session id>` or `dir:/path/to/project`. */
  id: string;
  /** Human label (project directory name) used in the VM name and title. */
  label: string;
  harness: string;
  cwd?: string;
  /** Root session transcript; lets `gc` find VMs whose session was deleted. */
  sessionFile?: string;
}

export type ControlHolder = "agent" | "user";

export interface ControlState {
  holder: ControlHolder;
  since: string | null;
  message?: string;
}

export interface VmRecord {
  name: string;
  scope: string;
  label: string;
  harness: string;
  cwd?: string;
  sessionFile?: string;
  base: string;
  hostKeyAlias: string;
  memoryMiB: number;
  vcpus: number;
  createdAt: string;
  lastUsedAt: string;
  /** Last control state seen by the host (the guest file is authoritative). */
  control?: ControlState;
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "vm";
}

function recordPath(name: string): string {
  return join(paths.vmDir(name), "vm.json");
}

export function saveRecord(record: VmRecord): void {
  writeFileSync(recordPath(record.name), JSON.stringify(record, null, 2), { mode: 0o600 });
}

export function listVms(): VmRecord[] {
  if (!existsSync(paths.vms)) return [];
  return readdirSync(paths.vms)
    .filter((name) => existsSync(recordPath(name)))
    .map((name) => JSON.parse(readFileSync(recordPath(name), "utf8")) as VmRecord)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findVm(nameOrScope: string): VmRecord | undefined {
  return listVms().find((vm) => vm.name === nameOrScope || vm.scope === nameOrScope);
}

function diskPath(name: string): string {
  return join(paths.vmDir(name), "disk.qcow2");
}

function domainSpec(record: VmRecord, base: BaseInfo, settings: Settings) {
  return domainXml({
    name: record.name,
    title: `linux-computer: ${record.label} (${record.harness})`,
    description: `Agent desktop VM for ${record.scope}${record.cwd ? ` in ${record.cwd}` : ""}`,
    memoryMiB: record.memoryMiB,
    vcpus: record.vcpus,
    disk: diskPath(record.name),
    width: settings.width,
    height: settings.height,
    metadata: { scope: record.scope, base: base.id, harness: record.harness, cwd: record.cwd ?? "" },
  });
}

async function defineFromRecord(record: VmRecord, settings: Settings): Promise<void> {
  const base = listBases().find((candidate) => candidate.id === record.base);
  if (!base) throw new Error(`Base image ${record.base} of ${record.name} is missing; the VM disk cannot be used`);
  const xmlPath = join(paths.vmDir(record.name), "domain.xml");
  writeFileSync(xmlPath, domainSpec(record, base, settings));
  await libvirt.defineDomain(xmlPath);
}

async function createVm(scope: Scope, settings: Settings, progress: Progress, signal?: AbortSignal): Promise<VmRecord> {
  const base = currentBase(settings) ?? (await buildBase(settings, progress, signal));
  const name = `lc-${slug(scope.label)}-${createHash("sha256").update(scope.id).digest("hex").slice(0, 8)}`;
  ensureDir(paths.vmDir(name));
  progress(`creating VM ${name} from ${base.id}`);
  await runChecked("qemu-img", ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", base.disk, diskPath(name)]);
  const now = new Date().toISOString();
  const record: VmRecord = {
    name,
    scope: scope.id,
    label: scope.label,
    harness: scope.harness,
    cwd: scope.cwd,
    sessionFile: scope.sessionFile,
    base: base.id,
    hostKeyAlias: base.hostKeyAlias,
    memoryMiB: settings.memoryMiB,
    vcpus: settings.vcpus,
    createdAt: now,
    lastUsedAt: now,
    control: { holder: "agent", since: now },
  };
  await defineFromRecord(record, settings);
  saveRecord(record);
  return record;
}

export async function endpointFor(record: VmRecord): Promise<Endpoint> {
  const cid = await libvirt.vsockCid(record.name).catch(() => undefined);
  return managedEndpoint(record.name, record.hostKeyAlias, GUEST_USER, cid);
}

export interface PingResult {
  ok: true;
  display: string;
  applications: number;
  control: ControlState;
}

async function waitForDesktop(record: VmRecord, progress: Progress, signal?: AbortSignal): Promise<PingResult> {
  const deadline = Date.now() + 240_000;
  let lastError = "";
  progress(`waiting for ${record.name} desktop`);
  while (Date.now() < deadline) {
    try {
      const endpoint = await endpointFor(record);
      return await helperCall<PingResult>(endpoint, "ping", {}, { signal, timeoutMs: 20_000 });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(2000, signal);
    }
  }
  throw new Error(`${record.name} did not become ready: ${lastError}`);
}

/**
 * The user's graphical session environment. The harness may run without it (tmux, ssh, a service), and
 * on Wayland hosts XAUTHORITY for Xwayland usually lives only in the systemd user manager.
 */
async function hostDisplayEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const result = await run("systemctl", ["--user", "show-environment"], { timeoutMs: 5000 }).catch(() => undefined);
  for (const line of result?.exitCode === 0 ? result.stdout.toString("utf8").split("\n") : []) {
    const match = /^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=(.*)$/.exec(line);
    if (match && !env[match[1]!]) env[match[1]!] = match[2];
  }
  return env.DISPLAY || env.WAYLAND_DISPLAY ? env : undefined;
}

function viewerPidFile(name: string): string {
  return join(ensureDir(paths.run), `viewer-${name}.pid`);
}

function viewerAlive(name: string): boolean {
  try {
    const pid = Number(readFileSync(viewerPidFile(name), "utf8"));
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Show the VM's live screen on the host desktop; the user can watch and take part through it. */
export async function openViewer(record: VmRecord, settings: Settings): Promise<string> {
  const socket = await libvirt.vncSocket(record.name);
  if (!socket) throw new Error(`${record.name} has no VNC display`);
  if (viewerAlive(record.name)) return `viewer already open (${socket})`;
  const env = await hostDisplayEnv();
  if (!env) return `no host display available; attach a VNC viewer to ${socket}`;
  const [command, ...args] = settings.viewerCommand.map((part) => part.replaceAll("{socket}", socket).replaceAll("{name}", record.name));
  const log = join(ensureDir(paths.run), `viewer-${record.name}.log`);
  const out = openSync(log, "w");
  const child = spawn(command!, args, { stdio: ["ignore", out, out], detached: true, env });
  closeSync(out);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  child.once("error", (error) => reject(new Error(`Could not start viewer ${command}: ${error.message}`)));
  child.once("exit", (code) => reject(new Error(`Viewer ${command} exited (${code}): ${readFileSync(log, "utf8").trim().split("\n").at(-1)}`)));
  // A viewer that cannot reach the display or socket exits right away; one that survives this is showing.
  const settle = setTimeout(resolve, 1500);
  await promise.finally(() => clearTimeout(settle));
  child.removeAllListeners("exit");
  writeFileSync(viewerPidFile(record.name), String(child.pid));
  child.unref();
  return `viewer opened (${socket})`;
}

function closeViewer(name: string): void {
  try {
    process.kill(Number(readFileSync(viewerPidFile(name), "utf8")), "SIGTERM");
  } catch {
    // Not running.
  }
  rmSync(viewerPidFile(name), { force: true });
}

export interface ReadyVm {
  record: VmRecord;
  endpoint: Endpoint;
  ping: PingResult;
  /** True when this call created, booted or resumed the VM. */
  started: boolean;
}

/** Start or resume a defined VM and wait until its desktop answers. */
export async function ensureRunning(record: VmRecord, settings: Settings, progress: Progress, signal?: AbortSignal): Promise<ReadyVm> {
  return await withLock(`vm-${record.name}`, async () => {
    let state = await libvirt.domainState(record.name);
    let started = false;
    if (state === "missing") {
      if (!existsSync(diskPath(record.name))) throw new Error(`${record.name} has no disk; destroy it and start over`);
      await defineFromRecord(record, settings);
      state = "shut off";
    }
    if (state === "paused" || state === "pmsuspended") {
      await libvirt.virsh(["resume", record.name]);
      started = true;
    } else if (state !== "running") {
      const resumed = await libvirt.hasManagedSave(record.name);
      progress(resumed ? `resuming ${record.name} from saved state` : `booting ${record.name}`);
      await libvirt.startDomain(record.name);
      started = true;
    }
    const ping = await waitForDesktop(record, progress, signal);
    record.lastUsedAt = new Date().toISOString();
    record.control = ping.control;
    saveRecord(record);
    if (settings.openViewer && (started || !viewerAlive(record.name))) {
      progress(await openViewer(record, settings).catch((error: Error) => error.message));
    }
    return { record, endpoint: await endpointFor(record), ping, started };
  });
}

/** The scope's VM, created from the current base image on first use. */
export async function ensureScopeVm(scope: Scope, settings: Settings, progress: Progress, signal?: AbortSignal): Promise<ReadyVm> {
  const key = `scope-${createHash("sha256").update(scope.id).digest("hex").slice(0, 16)}`;
  const record = await withLock(key, async () => findVm(scope.id) ?? (await createVm(scope, settings, progress, signal)));
  return await ensureRunning(record, settings, progress, signal);
}

/** Hand keyboard/mouse to the user or back to the agent. The guest file is authoritative; the record caches it. */
export async function setControl(guest: { record?: VmRecord; endpoint: Endpoint }, holder: ControlHolder, message: string, by: "agent" | "user"): Promise<ControlState> {
  const { control } = await helperCall<{ control: ControlState }>(guest.endpoint, "control_set", { holder, message, by });
  if (guest.record) {
    guest.record.control = control;
    saveRecord(guest.record);
  }
  return control;
}

export async function suspendVm(record: VmRecord): Promise<string> {
  const state = await libvirt.domainState(record.name);
  if (state !== "running" && state !== "paused") return `${record.name} is ${state}`;
  await closeMaster(await endpointFor(record));
  closeViewer(record.name);
  await libvirt.managedSave(record.name);
  return `${record.name} suspended to disk; the next use resumes it exactly where it was`;
}

/** Fire-and-forget suspend for shutdown hooks that cannot wait. */
export function suspendDetached(record: VmRecord): void {
  closeViewer(record.name);
  const child = spawn("virsh", ["-q", "-c", libvirt.LIBVIRT_URI, "managedsave", record.name], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

export async function stopVm(record: VmRecord, force = false): Promise<string> {
  const state = await libvirt.domainState(record.name);
  if (state !== "running" && state !== "paused") return `${record.name} is ${state}`;
  await closeMaster(await endpointFor(record));
  closeViewer(record.name);
  if (!force) {
    await libvirt.shutdownDomain(record.name).catch(() => undefined);
    for (let i = 0; i < 60; i++) {
      if ((await libvirt.domainState(record.name)) === "shut off") return `${record.name} shut down`;
      await sleep(1000);
    }
  }
  await libvirt.destroyDomain(record.name);
  return `${record.name} powered off`;
}

/** Remove the VM, its disk and snapshots permanently. */
export async function destroyVm(record: VmRecord): Promise<string> {
  return await withLock(`vm-${record.name}`, async () => {
    closeViewer(record.name);
    const state = await libvirt.domainState(record.name);
    if (state !== "missing") {
      if (state === "running" || state === "paused") {
        await closeMaster(await endpointFor(record));
        await libvirt.destroyDomain(record.name).catch(() => undefined);
      }
      await libvirt.undefineDomain(record.name);
    }
    rmSync(paths.vmDir(record.name), { recursive: true, force: true });
    return `${record.name} destroyed`;
  });
}

export interface VmStatus {
  record: VmRecord;
  state: string;
  savedState: boolean;
  displaySocket?: string;
  diskBytes: number;
  viewerOpen: boolean;
}

export async function vmStatus(record: VmRecord): Promise<VmStatus> {
  const state = await libvirt.domainState(record.name);
  const savedState = state === "shut off" ? await libvirt.hasManagedSave(record.name).catch(() => false) : false;
  const displaySocket = state === "running" ? await libvirt.vncSocket(record.name).catch(() => undefined) : undefined;
  let diskBytes = 0;
  const info = await run("qemu-img", ["info", "-U", "--output=json", diskPath(record.name)]).catch(() => undefined);
  if (info?.exitCode === 0) diskBytes = Number(JSON.parse(info.stdout.toString("utf8"))["actual-size"] ?? 0);
  else if (existsSync(diskPath(record.name))) diskBytes = statSync(diskPath(record.name)).size;
  return { record, state, savedState, displaySocket, diskBytes, viewerOpen: viewerAlive(record.name) };
}

export function describeStatus(status: VmStatus): string {
  const { record } = status;
  const state = status.savedState ? "suspended (saved to disk)" : status.state;
  return [
    `vm: ${record.name}`,
    `state: ${state}`,
    `scope: ${record.scope}`,
    record.cwd ? `project: ${record.cwd}` : undefined,
    `base: ${record.base}`,
    `resources: ${record.vcpus} vCPU, ${record.memoryMiB} MiB RAM, disk ${(status.diskBytes / 2 ** 30).toFixed(1)} GiB used`,
    status.displaySocket ? `display: vnc+unix://${status.displaySocket}${status.viewerOpen ? " (viewer open)" : ""}` : undefined,
    record.control ? `control: ${record.control.holder} since ${record.control.since}${record.control.message ? ` — ${record.control.message}` : ""}` : undefined,
    `created: ${record.createdAt}; last used: ${record.lastUsedAt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** VMs whose owning session transcript no longer exists. */
export function orphanedVms(): VmRecord[] {
  return listVms().filter((vm) => vm.sessionFile && !existsSync(vm.sessionFile));
}
