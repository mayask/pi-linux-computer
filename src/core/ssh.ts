import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExternalTarget } from "./config.js";
import { run, runChecked, shellQuote, type RunOptions, type RunResult } from "./exec.js";
import { ensureDir, paths } from "./paths.js";

/** Everything needed to reach one guest over SSH. */
export interface Endpoint {
  /** Stable identity used for connection multiplexing and helper upload caching. */
  key: string;
  destination: string;
  options: string[];
  /** `VAR=value ` assignments prefixed to every guest command (desktop session overrides). */
  envPrefix?: string;
}

export async function ensureClientKey(): Promise<string> {
  ensureDir(paths.root);
  if (!existsSync(paths.clientKey)) {
    await runChecked("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "linux-computer", "-f", paths.clientKey]);
  }
  return paths.clientKey;
}

const LIBVIRT_PROXIES = ["/usr/libexec/libvirt-ssh-proxy", "/usr/lib/libvirt/libvirt-ssh-proxy", "/usr/lib64/libvirt/libvirt-ssh-proxy"];

/** Python fallback: connect AF_VSOCK and hand the socket to ssh (ProxyUseFdpass). */
function pythonVsockProxy(cid: number): string {
  const code = `import socket;s=socket.socket(socket.AF_VSOCK,socket.SOCK_STREAM);s.connect((${cid},22));socket.send_fds(socket.socket(fileno=1),[b'\\0'],[s.fileno()])`;
  return `python3 -c "${code}"`;
}

function commonOptions(controlKey: string): string[] {
  const control = join(ensureDir(paths.run), `ssh-${createHash("sha1").update(controlKey).digest("hex").slice(0, 16)}`);
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", `ControlPath=${control}`, "-o", "LogLevel=ERROR"];
}

/**
 * Managed VMs have no network ports: SSH runs over AF_VSOCK, via libvirt's ssh proxy when installed
 * (resolves the domain's CID itself) or a tiny python fd-passing proxy otherwise.
 */
export function managedEndpoint(domain: string, hostKeyAlias: string, user: string, cid: number | undefined): Endpoint {
  const libvirtProxy = LIBVIRT_PROXIES.find((path) => existsSync(path));
  let proxy: string;
  if (libvirtProxy) proxy = `${libvirtProxy} %h %p`;
  else if (cid !== undefined) proxy = pythonVsockProxy(cid);
  else throw new Error(`No vsock CID known for ${domain}; is it running?`);
  return {
    key: `managed:${domain}`,
    destination: `${user}@qemu:session/${domain}`,
    options: [
      ...commonOptions(`managed:${domain}`),
      "-o", `ProxyCommand=${proxy}`,
      "-o", "ProxyUseFdpass=yes",
      "-o", "CheckHostIP=no",
      "-o", `HostKeyAlias=${hostKeyAlias}`,
      "-o", `UserKnownHostsFile=${paths.knownHosts}`,
      "-o", "StrictHostKeyChecking=yes",
      "-o", "IdentitiesOnly=yes",
      "-i", paths.clientKey,
    ],
  };
}

export function externalEndpoint(name: string, target: ExternalTarget): Endpoint {
  const options = [...commonOptions(`external:${name}`), "-p", String(target.port ?? 22), "-o", "StrictHostKeyChecking=yes"];
  if (target.identityFile) options.push("-i", target.identityFile, "-o", "IdentitiesOnly=yes");
  if (target.knownHostsFile) options.push("-o", `UserKnownHostsFile=${target.knownHostsFile}`);
  const overrides = { DISPLAY: target.display, XAUTHORITY: target.xauthority, DBUS_SESSION_BUS_ADDRESS: target.dbusAddress };
  const envPrefix = Object.entries(overrides)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${shellQuote(value!)} `)
    .join("");
  return { key: `external:${name}`, destination: `${target.user}@${target.host}`, options, envPrefix };
}

const masters = new Map<string, Promise<void>>();

/**
 * Keep one multiplexed connection per guest so each tool call costs a channel, not a handshake.
 * The master is started detached with no stdio so it never holds our pipes open.
 */
async function ensureMaster(endpoint: Endpoint): Promise<void> {
  const check = await run("ssh", [...endpoint.options, "-O", "check", endpoint.destination], { timeoutMs: 5000 }).catch(() => undefined);
  if (check?.exitCode === 0) return;
  let pending = masters.get(endpoint.key);
  if (!pending) {
    // `-f` backgrounds after authentication, so the foreground process exits once the master is up (or failed).
    const { promise, resolve } = Promise.withResolvers<void>();
    const child = spawn("ssh", [...endpoint.options, "-M", "-N", "-f", "-o", "ControlPersist=600", endpoint.destination], {
      stdio: "ignore",
      detached: true,
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
    pending = promise.finally(() => masters.delete(endpoint.key));
    masters.set(endpoint.key, pending);
  }
  await pending;
}

export async function ssh(endpoint: Endpoint, command: string, options: RunOptions = {}): Promise<RunResult> {
  await ensureMaster(endpoint);
  return await run("ssh", [...endpoint.options, "-o", "ControlMaster=no", endpoint.destination, `${endpoint.envPrefix ?? ""}${command}`], options);
}

/**
 * Stream between a local shell command and a guest command without buffering, e.g. tar in and out.
 * `to` pipes local stdout into the guest command; `from` pipes the guest command into local stdin.
 */
export async function sshPipe(endpoint: Endpoint, direction: "to" | "from", local: string, remote: string, options: RunOptions = {}): Promise<RunResult> {
  await ensureMaster(endpoint);
  const sshCommand = ["ssh", ...endpoint.options, "-o", "ControlMaster=no", endpoint.destination, `${endpoint.envPrefix ?? ""}${remote}`].map(shellQuote).join(" ");
  const pipeline = direction === "to" ? `${local} | ${sshCommand}` : `${sshCommand} | ${local}`;
  return await run("bash", ["-o", "pipefail", "-c", pipeline], options);
}

export async function closeMaster(endpoint: Endpoint): Promise<void> {
  await run("ssh", [...endpoint.options, "-O", "exit", endpoint.destination], { timeoutMs: 5000 }).catch(() => undefined);
}

const helperSource = readFileSync(new URL("../../guest/linux_computer.py", import.meta.url));
const helperHash = createHash("sha256").update(helperSource).digest("hex").slice(0, 16);
export const HELPER_PATH = ".local/share/linux-computer/helper.py";
const uploaded = new Set<string>();

export async function ensureHelper(endpoint: Endpoint, signal?: AbortSignal): Promise<void> {
  const marker = `${endpoint.key}:${helperHash}`;
  if (uploaded.has(marker)) return;
  const script = [
    "set -e",
    "umask 077",
    `d=$(dirname ${HELPER_PATH})`,
    'mkdir -p "$d"',
    `if [ "$(cat "$d/helper.hash" 2>/dev/null)" != ${helperHash} ]; then cat > "$d/helper.py.tmp"; mv "$d/helper.py.tmp" ${HELPER_PATH}; echo ${helperHash} > "$d/helper.hash"; else cat > /dev/null; fi`,
  ].join("\n");
  const result = await ssh(endpoint, `sh -c ${shellQuote(script)}`, { input: helperSource, signal, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`Uploading guest helper failed: ${result.stderr.toString("utf8").trim()}`);
  uploaded.add(marker);
}

export interface HelperFailure {
  ok: false;
  error: string;
  code?: string;
}

/** Call one operation of the guest helper with JSON in/out. */
export async function helperCall<T>(
  endpoint: Endpoint,
  operation: string,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  await ensureHelper(endpoint, options.signal);
  const result = await ssh(endpoint, `python3 ${HELPER_PATH}`, {
    input: JSON.stringify({ operation, params }),
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  const stdout = result.stdout.toString("utf8").trim();
  const stderr = result.stderr.toString("utf8").trim();
  const parsed = (() => {
    for (const text of [stdout, stderr.split("\n").at(-1) ?? ""]) {
      try {
        return JSON.parse(text) as T | HelperFailure;
      } catch {
        // Not JSON; try the next stream.
      }
    }
    return undefined;
  })();
  if (result.exitCode !== 0 || !parsed) {
    const failure = parsed as HelperFailure | undefined;
    const error = new Error(failure?.error ?? (stderr || `guest helper ${operation} exited ${result.exitCode}`)) as Error & { code?: string };
    error.code = failure?.code;
    throw error;
  }
  return parsed as T;
}
