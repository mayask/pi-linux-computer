import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface TargetConfig {
  host: string;
  port?: number;
  user: string;
  identityFile: string;
  knownHostsFile: string;
  display: string;
  xauthority: string;
  dbusAddress: string;
  helperPath?: string;
}

export interface ComputerConfig {
  targets: Record<string, TargetConfig>;
  defaultTarget?: string;
}

export const DEFAULT_CONFIG_PATH = "~/.config/pi-linux-computer/targets.json";

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

export function loadConfig(path = process.env.PI_LINUX_COMPUTER_CONFIG ?? DEFAULT_CONFIG_PATH): ComputerConfig {
  const configPath = expandHome(path);
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const rawTargets = (parsed.targets ?? parsed) as Record<string, TargetConfig>;
  const targets: Record<string, TargetConfig> = {};

  for (const [name, target] of Object.entries(rawTargets)) {
    if (!target || typeof target !== "object" || !("host" in target)) continue;
    targets[name] = {
      ...target,
      port: target.port ?? 22,
      identityFile: expandHome(target.identityFile),
      knownHostsFile: expandHome(target.knownHostsFile),
      helperPath: target.helperPath ?? `/home/${target.user}/.local/share/pi-linux-computer/linux_computer.py`,
    };
  }

  if (Object.keys(targets).length === 0) {
    throw new Error(`No targets configured in ${configPath}`);
  }

  const configuredDefault = typeof parsed.defaultTarget === "string" ? parsed.defaultTarget : undefined;
  return {
    targets,
    defaultTarget: configuredDefault ?? (Object.keys(targets).length === 1 ? Object.keys(targets)[0] : undefined),
  };
}

export function resolveTarget(config: ComputerConfig, requested?: string): { name: string; config: TargetConfig } {
  const name = requested || config.defaultTarget;
  if (!name) throw new Error(`A target is required. Available targets: ${Object.keys(config.targets).join(", ")}`);
  const target = config.targets[name];
  if (!target) throw new Error(`Unknown target ${JSON.stringify(name)}. Available targets: ${Object.keys(config.targets).join(", ")}`);
  return { name, config: target };
}
