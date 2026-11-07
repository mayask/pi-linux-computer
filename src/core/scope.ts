import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Scope } from "./vm.js";

/**
 * omp and pi store a subagent's transcript at `<parent transcript without .jsonl>/<name>.jsonl`.
 * Walking up that layout finds the top-level session, so subagents share their parent's VM while
 * every top-level session (including forks, which get their own file) has its own.
 */
export function rootSessionFile(sessionFile: string): string {
  let current = sessionFile;
  for (;;) {
    const parent = `${dirname(current)}.jsonl`;
    if (!existsSync(parent)) return current;
    current = parent;
  }
}

/** Session id from the transcript header (`{"type":"session","id":...}` within the first lines). */
function headerId(sessionFile: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, "r");
    const buffer = Buffer.alloc(16384);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, read).toString("utf8").split("\n").slice(0, 8)) {
      try {
        const entry = JSON.parse(line) as { type?: string; id?: string };
        if (entry.type === "session" && entry.id) return entry.id;
      } catch {
        // Partial or non-JSON line.
      }
    }
  } catch {
    // Unreadable transcript: fall back to the caller's id.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

export function sessionScope(harness: string, cwd: string, sessionId: string, sessionFile: string | undefined): Scope {
  const root = sessionFile ? rootSessionFile(sessionFile) : undefined;
  const id = (root && headerId(root)) || sessionId;
  return { id: `${harness}:${id}`, label: basename(cwd) || "vm", harness, cwd, sessionFile: root };
}

/** Scope for harnesses without session identity (MCP): explicit LINUX_COMPUTER_SCOPE, else the project directory. */
export function processScope(harness: string, cwd: string): Scope {
  const explicit = process.env.LINUX_COMPUTER_SCOPE;
  if (explicit) return { id: explicit.includes(":") ? explicit : `${harness}:${explicit}`, label: basename(cwd) || "vm", harness, cwd };
  const dir = realpathSync(cwd);
  return { id: `dir:${dir}`, label: basename(dir) || "vm", harness, cwd: dir };
}
