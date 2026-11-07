import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

function xdg(name: "XDG_DATA_HOME" | "XDG_CONFIG_HOME", fallback: string): string {
  const value = process.env[name];
  return value && value.startsWith("/") ? value : join(homedir(), fallback);
}

/** Root for all mutable state. Override with LINUX_COMPUTER_HOME. */
export function dataDir(): string {
  return process.env.LINUX_COMPUTER_HOME
    ? expandHome(process.env.LINUX_COMPUTER_HOME)
    : join(xdg("XDG_DATA_HOME", ".local/share"), "linux-computer");
}

export function configPath(): string {
  return process.env.LINUX_COMPUTER_CONFIG
    ? expandHome(process.env.LINUX_COMPUTER_CONFIG)
    : join(xdg("XDG_CONFIG_HOME", ".config"), "linux-computer", "config.json");
}

export const paths = {
  get root() {
    return dataDir();
  },
  get cache() {
    return join(dataDir(), "cache");
  },
  get bases() {
    return join(dataDir(), "bases");
  },
  get vms() {
    return join(dataDir(), "vms");
  },
  get run() {
    return join(dataDir(), "run");
  },
  get clientKey() {
    return join(dataDir(), "id_ed25519");
  },
  get knownHosts() {
    return join(dataDir(), "known_hosts");
  },
  vmDir(name: string) {
    return join(dataDir(), "vms", name);
  },
};

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
