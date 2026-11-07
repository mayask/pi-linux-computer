import { existsSync, readFileSync } from "node:fs";
import { configPath, expandHome } from "./paths.js";

/** An existing machine reachable over SSH (not managed by linux-computer). */
export interface ExternalTarget {
  host: string;
  port?: number;
  user: string;
  identityFile?: string;
  knownHostsFile?: string;
  /** Optional overrides; the guest helper discovers the desktop session environment when omitted. */
  display?: string;
  xauthority?: string;
  dbusAddress?: string;
}

export type SessionEndPolicy = "suspend" | "keep-running" | "shutdown";

export interface Settings {
  /** Guest RAM in MiB for newly created VMs. */
  memoryMiB: number;
  vcpus: number;
  /** Virtual disk size of the base image in GiB (sparse). */
  diskGiB: number;
  /** Guest screen size. */
  width: number;
  height: number;
  /** What happens to a session's VM when its owning agent session ends. */
  onSessionEnd: SessionEndPolicy;
  /** Open a host viewer window whenever a session VM is started. */
  openViewer: boolean;
  /** Viewer command; `{socket}` and `{name}` are substituted. */
  viewerCommand: string[];
  /** Extra Debian packages baked into the base image. */
  extraPackages: string[];
  /** Debian cloud image URL used to build the base. */
  imageUrl: string;
  targets: Record<string, ExternalTarget>;
}

export const DEFAULT_SETTINGS: Settings = {
  memoryMiB: 4096,
  vcpus: 4,
  diskGiB: 64,
  width: 1600,
  height: 900,
  onSessionEnd: "suspend",
  openViewer: true,
  viewerCommand: ["vncviewer", "-Shared=1", "{socket}"],
  extraPackages: [],
  imageUrl: "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2",
  targets: {},
};

export function loadSettings(): Settings {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
  const targets: Record<string, ExternalTarget> = {};
  for (const [name, target] of Object.entries(raw.targets ?? {})) {
    if (!target || typeof target !== "object" || !target.host || !target.user) continue;
    targets[name] = {
      ...target,
      identityFile: target.identityFile ? expandHome(target.identityFile) : undefined,
      knownHostsFile: target.knownHostsFile ? expandHome(target.knownHostsFile) : undefined,
    };
  }
  return { ...DEFAULT_SETTINGS, ...raw, targets };
}
