/**
 * Extension entry for omp and pi. Both load `package.json#omp.extensions` / `pi.extensions` and
 * expose the same factory shape; only the minimal surface used here is typed so the package has no
 * dependency on either host.
 */
import { spawn } from "node:child_process";
import { loadSettings } from "../core/config.js";
import { LIBVIRT_URI, domainState } from "../core/libvirt.js";
import { rootSessionFile, sessionScope } from "../core/scope.js";
import { INSTRUCTIONS, TOOLS, type ToolResult } from "../core/tools.js";
import { describeStatus, destroyVm, ensureRunning, findVm, listVms, openViewer, setControl, stopVm, suspendDetached, suspendVm, vmStatus, type Scope } from "../core/vm.js";

interface SessionManagerLike {
  getSessionId(): string;
  getSessionFile(): string | undefined;
}

interface UiLike {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
  confirm?(title: string, message: string): Promise<boolean>;
}

interface ContextLike {
  cwd: string;
  sessionManager: SessionManagerLike;
  ui: UiLike;
  hasUI?: boolean;
}

interface ExtensionApiLike {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: ((update: { content: { type: "text"; text: string }[] }) => void) | undefined,
      ctx: ContextLike,
    ): Promise<ToolResult>;
  }): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: ContextLike): Promise<void> }): void;
  on(event: string, handler: (event: unknown, ctx: ContextLike) => unknown): void;
}

const HARNESS = process.versions.bun ? "omp" : "pi";

function scopeOf(ctx: ContextLike): Scope {
  return sessionScope(HARNESS, ctx.cwd, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
}

async function refreshStatus(ctx: ContextLike): Promise<void> {
  if (!ctx.ui.setStatus) return;
  const record = findVm(scopeOf(ctx).id);
  if (!record) {
    ctx.ui.setStatus("linux-computer", "VM: on demand");
    return;
  }
  const state = await domainState(record.name).catch(() => "unknown");
  const holder = record.control?.holder === "user" ? " · user has control" : "";
  ctx.ui.setStatus("linux-computer", `VM: ${record.name} ${state === "shut off" ? "saved/off" : state}${holder}`);
}

const USAGE = "/vm [status|view|user [message]|agent|suspend|stop|destroy|list]";

export default function linuxComputer(pi: ExtensionApiLike): void {
  for (const tool of TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.name === "vm_lifecycle" ? `${tool.description}\n\n${INSTRUCTIONS}` : tool.description,
      parameters: tool.parameters,
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const result = await tool.execute(params, {
          scope: scopeOf(ctx),
          cwd: ctx.cwd,
          signal,
          progress: (message) => onUpdate?.({ content: [{ type: "text", text: message }] }),
        });
        void refreshStatus(ctx).catch(() => undefined);
        return result;
      },
    });
  }

  pi.registerCommand("vm", {
    description: `This session's Linux desktop VM: ${USAGE}`,
    async handler(args, ctx) {
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const scope = scopeOf(ctx);
      const record = findVm(scope.id);
      const settings = loadSettings();
      const say = (message: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(message, level);
      try {
        switch (command) {
          case "status":
            say(record ? describeStatus(await vmStatus(record)) : `No VM yet for this session; the agent creates one on first use (${scope.id}).`);
            break;
          case "list":
            say(
              (
                await Promise.all(
                  listVms().map(async (vm) => `${vm.scope === scope.id ? "*" : " "} ${vm.name}  ${await domainState(vm.name).catch(() => "?")}  ${vm.cwd ?? ""}`),
                )
              ).join("\n") || "no VMs",
            );
            break;
          case "view": {
            if (!record) return say("This session has no VM yet.", "warning");
            const ready = await ensureRunning(record, { ...settings, openViewer: false }, () => {});
            say(await openViewer(ready.record, settings));
            break;
          }
          case "user":
          case "agent": {
            if (!record) return say("This session has no VM yet.", "warning");
            const ready = await ensureRunning(record, { ...settings, openViewer: command === "user" && settings.openViewer }, () => {});
            await setControl(ready, command, rest.join(" "), "user");
            say(command === "user" ? "You have control of the VM; agent input is blocked until `/vm agent` or 'Hand back to agent' in the VM." : "The agent has control of the VM again.");
            break;
          }
          case "suspend":
            say(record ? await suspendVm(record) : "This session has no VM.");
            break;
          case "stop":
            say(record ? await stopVm(record) : "This session has no VM.");
            break;
          case "destroy": {
            if (!record) return say("This session has no VM.");
            const confirmed = ctx.ui.confirm ? await ctx.ui.confirm("Destroy VM?", `Permanently delete ${record.name} and its disk?`) : rest.includes("--yes");
            if (!confirmed) return say("Kept the VM.");
            say(await destroyVm(record));
            break;
          }
          default:
            say(`Usage: ${USAGE}`, "warning");
        }
      } catch (error) {
        say(error instanceof Error ? error.message : String(error), "error");
      }
      await refreshStatus(ctx).catch(() => undefined);
    },
  });

  for (const event of ["session_start", "session_switch", "session_branch"]) {
    pi.on(event, async (_event, ctx) => {
      await refreshStatus(ctx).catch(() => undefined);
    });
  }

  pi.on("session_shutdown", (_event, ctx) => {
    // Subagent sessions end all the time; only the owning top-level session decides the VM's fate.
    const file = ctx.sessionManager.getSessionFile();
    if (file && rootSessionFile(file) !== file) return;
    const record = findVm(scopeOf(ctx).id);
    if (!record || record.control?.holder === "user") return;
    const policy = loadSettings().onSessionEnd;
    if (policy === "suspend") suspendDetached(record);
    else if (policy === "shutdown") {
      const child = spawn("virsh", ["-q", "-c", LIBVIRT_URI, "shutdown", record.name], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    }
  });
}
