#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { runMcpServer } from "./adapters/mcp-server.js";
import { buildBase, currentBase, deleteBase, listBases } from "./core/base-image.js";
import { loadSettings } from "./core/config.js";
import { domainState } from "./core/libvirt.js";
import { configPath, paths } from "./core/paths.js";
import { processScope } from "./core/scope.js";
import { addSecret, approve, loadApprovals, loadSecretMeta, removeSecret, revoke, type SecretKind, type SecretMeta } from "./core/secrets.js";
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
  linux-computer secret add <name> [--kind password|token|totp] [--username U]
                 [--origin https://site]… [--app name]… [--exec] [--description D]
                                            Store a credential (value prompted, or read from stdin)
  linux-computer secret list|rm <name>|approvals
  linux-computer secret approve <name> --scope <scope|*> --use browser:<origin>|app:<name>|exec
  linux-computer secret revoke <name> [--scope <scope>]

State: ${paths.root}
Config: ${configPath()}`;

function requireVm(name: string | undefined): VmRecord {
  if (!name) throw new Error("Which VM? See `linux-computer list`.");
  const record = findVm(name);
  if (!record) throw new Error(`No VM ${name}. See \`linux-computer list\`.`);
  return record;
}

const log = (message: string) => console.error(message);

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Secret value: typed without echo on a terminal, otherwise the whole of stdin (trailing newline dropped). */
async function readSecretValue(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let value = "";
  const onData = (data: Buffer) => {
    for (const char of data.toString("utf8")) {
      if (char === "\r" || char === "\n") return resolve(value);
      if (char === "\u0003") return reject(new Error("cancelled"));
      if (char === "\u007f") value = value.slice(0, -1);
      else value += char;
    }
  };
  process.stdin.on("data", onData);
  try {
    return await promise;
  } finally {
    process.stdin.off("data", onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
}

function options(args: string[], name: string): string[] {
  return args.flatMap((arg, i) => (arg === `--${name}` && args[i + 1] !== undefined ? [args[i + 1]!] : []));
}

async function secretCommand(args: string[]): Promise<number> {
  const [action = "list", name] = args;
  switch (action) {
    case "list":
      for (const [secret, meta] of Object.entries(loadSecretMeta())) console.log(`${secret}  ${JSON.stringify(meta)}`);
      return 0;
    case "add": {
      if (!name) throw new Error("secret add <name>");
      const kind = (options(args, "kind")[0] ?? "password") as SecretKind;
      if (!["password", "token", "totp"].includes(kind)) throw new Error("--kind is password, token or totp");
      const meta: SecretMeta = { kind };
      const username = options(args, "username")[0];
      const description = options(args, "description")[0];
      const origins = options(args, "origin").map((origin) => new URL(origin).origin);
      const apps = options(args, "app");
      if (username) meta.username = username;
      if (origins.length) meta.origins = origins;
      if (apps.length) meta.apps = apps;
      if (args.includes("--exec")) meta.exec = true;
      if (description) meta.description = description;
      if (!origins.length && !apps.length && !meta.exec) throw new Error("Say where the secret may be used: --origin, --app and/or --exec");
      await addSecret(name, await readSecretValue(`Value for ${name} (hidden): `), meta);
      console.log(`stored ${name} in the keyring`);
      return 0;
    }
    case "rm":
      if (!name) throw new Error("secret rm <name>");
      await removeSecret(name);
      console.log(`removed ${name}`);
      return 0;
    case "approvals":
      for (const a of loadApprovals()) console.log(`${a.secret}  ${a.scope}  ${a.use}  ${a.at}`);
      return 0;
    case "approve": {
      const scope = options(args, "scope")[0];
      const use = options(args, "use")[0];
      if (!name || !scope || !use) throw new Error("secret approve <name> --scope <scope|*> --use browser:<origin>|app:<name>|exec");
      if (!loadSecretMeta()[name]) throw new Error(`Unknown secret ${name}`);
      approve(name, scope, use.startsWith("browser:") ? `browser:${new URL(use.slice(8)).origin}` : use.startsWith("app:") ? use.toLowerCase() : use);
      console.log(`approved ${name} for ${use} in ${scope}`);
      return 0;
    }
    case "revoke":
      if (!name) throw new Error("secret revoke <name>");
      console.log(`revoked ${revoke(name, options(args, "scope")[0])} approval(s)`);
      return 0;
    default:
      throw new Error(`Unknown secret action ${action}`);
  }
}

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
    case "secret":
      return await secretCommand(args);
    case "tool": {
      const tool = TOOLS.find((candidate) => candidate.name === args[0]);
      if (!tool) throw new Error(`Unknown tool ${args[0] ?? ""}; tools: ${TOOLS.map((t) => t.name).join(", ")}`);
      const scope = processScope("cli", process.cwd());
      const confirm = process.stdin.isTTY ? (title: string, message: string) => ask(`${title}\n${message} [y/N] `).then((a) => /^y(es)?$/i.test(a.trim())) : undefined;
      const result = await tool.execute(JSON.parse(args[1] ?? "{}") as Record<string, unknown>, { scope, cwd: process.cwd(), progress: log, confirm });
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
