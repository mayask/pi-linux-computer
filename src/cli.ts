#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { runMcpServer } from "./adapters/mcp-server.js";
import { buildBase, currentBase, deleteBase, listBases } from "./core/base-image.js";
import { loadSettings } from "./core/config.js";
import { domainState } from "./core/libvirt.js";
import { configPath, paths } from "./core/paths.js";
import { processScope } from "./core/scope.js";
import { TOOLS } from "./core/tools.js";
import {
  describeStatus,
  destroyVm,
  endpointFor,
  ensureRunning,
  findVm,
  listVms,
  openViewer,
  orphanedVms,
  setControl,
  stopVm,
  suspendVm,
  vmStatus,
  type VmRecord,
} from "./core/vm.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const USAGE = `linux-computer ${version} — per-session Linux desktop VMs for coding agents

Usage:
  linux-computer mcp                        Run the MCP server on stdio (scope: $LINUX_COMPUTER_SCOPE or cwd)
  linux-computer list                       All VMs with state and owner
  linux-computer status <vm>                Details of one VM (name or scope)
  linux-computer start|view|suspend|stop <vm>
  linux-computer ssh <vm> [command…]        Shell into a VM as the agent user
  linux-computer user|agent <vm> [message]  Hand input control to the user / back to the agent
  linux-computer destroy <vm> --yes         Delete a VM and its disk
  linux-computer gc [--yes]                 Destroy VMs whose agent session transcript was deleted
  linux-computer base [list|build|prune]    Manage golden base images
  linux-computer tool <name> [json]         Call a tool directly (scope: $LINUX_COMPUTER_SCOPE or cwd)

State: ${paths.root}
Config: ${configPath()}`;

function requireVm(name: string | undefined): VmRecord {
  if (!name) throw new Error("Which VM? See `linux-computer list`.");
  const record = findVm(name);
  if (!record) throw new Error(`No VM ${name}. See \`linux-computer list\`.`);
  return record;
}

const log = (message: string) => console.error(message);

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const settings = loadSettings();
  switch (command) {
    case "mcp":
      await runMcpServer(version);
      return 0;
    case "list": {
      const vms = listVms();
      if (!vms.length) console.log("no VMs");
      for (const vm of vms) {
        const state = await domainState(vm.name).catch(() => "?");
        const orphan = vm.sessionFile && !existsSync(vm.sessionFile) ? "  (session deleted)" : "";
        console.log(`${vm.name.padEnd(34)} ${state.padEnd(10)} ${vm.control?.holder === "user" ? "user " : "     "} ${vm.scope}  ${vm.cwd ?? ""}${orphan}`);
      }
      return 0;
    }
    case "status":
      console.log(describeStatus(await vmStatus(requireVm(args[0]))));
      return 0;
    case "start":
      console.log(describeStatus(await vmStatus((await ensureRunning(requireVm(args[0]), settings, log)).record)));
      return 0;
    case "view": {
      const ready = await ensureRunning(requireVm(args[0]), { ...settings, openViewer: false }, log);
      console.log(await openViewer(ready.record, settings));
      return 0;
    }
    case "suspend":
      console.log(await suspendVm(requireVm(args[0])));
      return 0;
    case "stop":
      console.log(await stopVm(requireVm(args[0]), args.includes("--force")));
      return 0;
    case "user":
    case "agent": {
      const ready = await ensureRunning(requireVm(args[0]), { ...settings, openViewer: command === "user" && settings.openViewer }, log);
      const control = await setControl(ready, command, args.slice(1).join(" "), "user");
      console.log(`control: ${control.holder}`);
      return 0;
    }
    case "ssh": {
      const ready = await ensureRunning(requireVm(args[0]), { ...settings, openViewer: false }, log);
      const endpoint = await endpointFor(ready.record);
      const tty = args.length > 1 ? [] : ["-t"];
      return spawnSync("ssh", [...endpoint.options, ...tty, endpoint.destination, ...args.slice(1)], { stdio: "inherit" }).status ?? 1;
    }
    case "destroy": {
      const record = requireVm(args[0]);
      if (!args.includes("--yes")) throw new Error(`This deletes ${record.name} and its disk permanently. Re-run with --yes.`);
      console.log(await destroyVm(record));
      return 0;
    }
    case "gc": {
      const orphans = orphanedVms();
      if (!orphans.length) console.log("no orphaned VMs");
      for (const vm of orphans) console.log(args.includes("--yes") ? await destroyVm(vm) : `would destroy ${vm.name} (${vm.sessionFile} is gone); re-run with --yes`);
      return 0;
    }
    case "base": {
      const action = args[0] ?? "list";
      if (action === "build") {
        const base = await buildBase(settings, log);
        console.log(`${base.id}  ${base.disk}`);
      } else if (action === "prune") {
        const inUse = new Set(listVms().map((vm) => vm.base));
        const current = currentBase(settings)?.id;
        for (const base of listBases()) {
          if (base.id === current || inUse.has(base.id)) continue;
          deleteBase(base.id);
          console.log(`deleted ${base.id}`);
        }
      } else {
        const current = currentBase(settings)?.id;
        for (const base of listBases()) {
          const users = listVms().filter((vm) => vm.base === base.id).length;
          console.log(`${base.id === current ? "*" : " "} ${base.id}  v${base.provisionVersion}  ${users} VM(s)  ${base.createdAt}`);
        }
        if (!current) console.log("no current base; it is built automatically on first use (`linux-computer base build` to do it now)");
      }
      return 0;
    }
    case "tool": {
      const tool = TOOLS.find((candidate) => candidate.name === args[0]);
      if (!tool) throw new Error(`Unknown tool ${args[0] ?? ""}; tools: ${TOOLS.map((t) => t.name).join(", ")}`);
      const scope = processScope("cli", process.cwd());
      const result = await tool.execute(JSON.parse(args[1] ?? "{}") as Record<string, unknown>, { scope, cwd: process.cwd(), progress: log });
      for (const part of result.content) console.log(part.type === "text" ? part.text : `<${part.mimeType} ${Math.round((part.data.length * 3) / 4)} bytes>`);
      return result.isError ? 1 : 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case "--version":
      console.log(version);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
