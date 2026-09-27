import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { loadConfig, resolveTarget, type TargetConfig } from "./config.js";
import { desktopEnvironment, shellQuote, sshRun } from "./ssh.js";

const helperSource = readFileSync(new URL("../remote/linux_computer.py", import.meta.url));
const helperHash = createHash("sha256").update(helperSource).digest("hex");
const uploaded = new Set<string>();
const MAX_TEXT_RESULT = 48_000;

interface SnapshotNode {
  id: string;
  depth: number;
  role: string;
  name: string;
  states: string[];
  bounds?: [number, number, number, number];
  actions?: string[];
  text?: string;
}

interface SnapshotResult {
  ok: boolean;
  revision: string;
  nodes: SnapshotNode[];
  windows: Array<{ id: string; desktop: string; host: string; class: string; title: string }>;
  truncated: boolean;
  display: string;
  error?: string;
}

function remoteError(prefix: string, exitCode: number, stderr: Buffer): Error {
  const message = stderr.toString("utf8").trim();
  return new Error(`${prefix} failed with exit code ${exitCode}${message ? `: ${message}` : ""}`);
}

async function ensureHelper(name: string, target: TargetConfig, signal?: AbortSignal): Promise<void> {
  const cacheKey = `${name}:${helperHash}`;
  if (uploaded.has(cacheKey)) return;
  const helperPath = target.helperPath!;
  const command = [
    "umask 077",
    `mkdir -p ${shellQuote(dirname(helperPath))}`,
    `cat > ${shellQuote(helperPath)}`,
    `chmod 700 ${shellQuote(helperPath)}`,
  ].join(" && ");
  const result = await sshRun(target, command, { input: helperSource, signal, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw remoteError("Remote helper upload", result.exitCode, result.stderr);
  uploaded.add(cacheKey);
}

async function bridgeCall<T>(
  name: string,
  target: TargetConfig,
  operation: "snapshot" | "act" | "ping",
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  await ensureHelper(name, target, signal);
  const command = `${desktopEnvironment(target)} python3 ${shellQuote(target.helperPath!)}`;
  const result = await sshRun(target, command, {
    input: JSON.stringify({ operation, params }),
    signal,
    timeoutMs: operation === "act" ? 45_000 : 30_000,
  });
  if (result.exitCode !== 0) throw remoteError(`Desktop ${operation}`, result.exitCode, result.stderr);
  try {
    return JSON.parse(result.stdout.toString("utf8")) as T;
  } catch {
    throw new Error(`Desktop ${operation} returned invalid JSON: ${result.stdout.toString("utf8").slice(0, 1000)}`);
  }
}

function oneLine(value: string): string {
  return value.replaceAll("\r", "").replaceAll("\n", "\\n");
}

function formatSnapshot(snapshot: SnapshotResult): string {
  const lines: string[] = [
    `revision: ${snapshot.revision}`,
    `display: ${snapshot.display}`,
    `nodes: ${snapshot.nodes.length}${snapshot.truncated ? " (truncated)" : ""}`,
  ];

  if (snapshot.windows.length > 0) {
    lines.push("windows:");
    for (const window of snapshot.windows) {
      lines.push(`  ${window.id} ${JSON.stringify(window.title)} class=${window.class}`);
    }
  }

  lines.push("accessibility:");
  for (const node of snapshot.nodes) {
    const indent = "  ".repeat(Math.min(node.depth, 12));
    const fields = [`[${node.id}]`, node.role, JSON.stringify(node.name || "")];
    if (node.states.length) fields.push(`states=${node.states.join(",")}`);
    if (node.bounds) fields.push(`bounds=${node.bounds.join(",")}`);
    if (node.actions?.length) fields.push(`actions=${node.actions.join(",")}`);
    lines.push(`${indent}${fields.join(" ")}`);
    if (node.text) lines.push(`${indent}  text=${JSON.stringify(oneLine(node.text))}`);
    if (lines.join("\n").length > MAX_TEXT_RESULT) {
      lines.push("... model-facing output truncated; request a smaller maxNodes/maxDepth snapshot ...");
      break;
    }
  }
  return lines.join("\n");
}

function currentTarget(requested?: string) {
  return resolveTarget(loadConfig(), requested);
}

export default function linuxComputerExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "linux_vm_observe",
    label: "Observe Linux VM desktop",
    description:
      "Inspect a Linux VM desktop as a compact AT-SPI accessibility tree. Returns semantic node IDs, roles, names, states, actions, bounds, visible text, and windows. Prefer this before screenshots. Node IDs can become stale after the UI changes.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Configured VM target name; omitted when a default exists" })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 8 })),
      maxNodes: Type.Optional(Type.Integer({ minimum: 10, maximum: 2000, default: 300 })),
      maxTextChars: Type.Optional(Type.Integer({ minimum: 40, maximum: 10000, default: 1200 })),
      includeText: Type.Optional(Type.Boolean({ default: true })),
      visibleOnly: Type.Optional(Type.Boolean({ default: true })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const target = currentTarget(params.target);
      const snapshot = await bridgeCall<SnapshotResult>(target.name, target.config, "snapshot", params, signal);
      if (!snapshot.ok) throw new Error(snapshot.error ?? "Desktop observation failed");
      return {
        content: [{ type: "text", text: formatSnapshot(snapshot) }],
        details: {
          target: target.name,
          revision: snapshot.revision,
          nodeCount: snapshot.nodes.length,
          truncated: snapshot.truncated,
        },
      };
    },
  });

  pi.registerTool({
    name: "linux_vm_act",
    label: "Act on Linux VM desktop",
    description:
      "Perform one semantic or X11 action on a configured Linux VM. Prefer nodeId from a fresh linux_vm_observe result. Use invoke/click for accessible controls, focus plus type for text entry, and coordinates only as fallback. Observe again after state-changing actions.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Configured VM target name" })),
      action: StringEnum(["invoke", "focus", "click", "set_text", "type", "key", "scroll", "wait"] as const),
      nodeId: Type.Optional(Type.String({ description: "Node ID from the latest accessibility snapshot" })),
      accessibleAction: Type.Optional(Type.String({ description: "Exact AT-SPI action name when invoke exposes several actions" })),
      text: Type.Optional(Type.String({ description: "Text for type or set_text" })),
      key: Type.Optional(Type.String({ description: "xdotool key expression, e.g. Return, Super_L, or ctrl+l" })),
      x: Type.Optional(Type.Integer()),
      y: Type.Optional(Type.Integer()),
      button: Type.Optional(Type.Integer({ minimum: 1, maximum: 9, default: 1 })),
      delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000, default: 30 })),
      direction: Type.Optional(StringEnum(["up", "down"] as const)),
      amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 3 })),
      milliseconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000, default: 1000 })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const target = currentTarget(params.target);
      const result = await bridgeCall<Record<string, unknown>>(target.name, target.config, "act", params, signal);
      return {
        content: [{ type: "text", text: JSON.stringify({ target: target.name, ...result }, null, 2) }],
        details: { target: target.name, ...result },
      };
    },
  });

  pi.registerTool({
    name: "linux_vm_screenshot",
    label: "Screenshot Linux VM desktop",
    description:
      "Capture the configured Linux VM desktop as PNG. Use only when accessibility text is insufficient or visual layout must be checked.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Configured VM target name" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const target = currentTarget(params.target);
      const command = `${desktopEnvironment(target.config)} sh -c ${shellQuote('tmp=$(mktemp --suffix=.png); trap \'rm -f "$tmp"\' EXIT; scrot -o "$tmp"; cat "$tmp"')}`;
      const result = await sshRun(target.config, command, { signal, timeoutMs: 30_000 });
      if (result.exitCode !== 0) throw remoteError("Screenshot", result.exitCode, result.stderr);
      return {
        content: [
          { type: "text", text: `Screenshot of ${target.name} (${result.stdout.length} bytes)` },
          { type: "image", data: result.stdout.toString("base64"), mimeType: "image/png" },
        ],
        details: { target: target.name, bytes: result.stdout.length },
      };
    },
  });

  pi.registerTool({
    name: "linux_vm_exec",
    label: "Execute in Linux VM",
    description:
      "Run a shell command in a configured Linux VM over key-authenticated SSH. Use this for files, packages, services, and diagnostics; use desktop tools only when visible GUI interaction is required.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Configured VM target name" })),
      command: Type.String({ description: "Bash command to run in the VM" }),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, default: 30 })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const target = currentTarget(params.target);
      const command = `bash -lc ${shellQuote(params.command)}`;
      const result = await sshRun(target.config, command, {
        signal,
        timeoutMs: (params.timeoutSeconds ?? 30) * 1000,
      });
      const stdout = result.stdout.toString("utf8");
      const stderr = result.stderr.toString("utf8");
      const text = [stdout, stderr ? `stderr:\n${stderr}` : "", `exit code: ${result.exitCode}`].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: text.slice(0, MAX_TEXT_RESULT) }],
        details: { target: target.name, exitCode: result.exitCode, truncated: text.length > MAX_TEXT_RESULT },
      };
    },
  });

  pi.registerCommand("linux-computer", {
    description: "Show configured Linux computer-use targets",
    handler: async (_args, ctx) => {
      try {
        const config = loadConfig();
        const names = Object.keys(config.targets);
        ctx.ui.notify(`Linux computer targets: ${names.join(", ")}; default: ${config.defaultTarget ?? "none"}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const config = loadConfig();
      const label = config.defaultTarget ?? `${Object.keys(config.targets).length} targets`;
      ctx.ui.setStatus("linux-computer", ctx.ui.theme.fg("accent", `VM: ${label}`));
    } catch {
      ctx.ui.setStatus("linux-computer", ctx.ui.theme.fg("warning", "VM: unconfigured"));
    }
  });
}
