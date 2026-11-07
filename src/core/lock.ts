import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "./exec.js";
import { ensureDir, paths } from "./paths.js";

const held = new Map<string, Promise<unknown>>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Serialize work on one key across tool calls, sessions and harness processes. The lock is a
 * directory holding the owner's pid; a lock whose owner died is taken over.
 */
export async function withLock<T>(key: string, fn: () => Promise<T>, timeoutMs = 60 * 60_000): Promise<T> {
  const previous = held.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const dir = join(ensureDir(join(paths.run, "locks")), key);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        mkdirSync(dir);
        writeFileSync(join(dir, "pid"), String(process.pid));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner = 0;
        try {
          owner = Number(readFileSync(join(dir, "pid"), "utf8"));
        } catch {
          // Owner is between mkdir and writing its pid.
        }
        if (owner && !alive(owner)) {
          rmSync(dir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${key} held by pid ${owner}`);
        await sleep(500);
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  held.set(key, current);
  try {
    return await current;
  } finally {
    if (held.get(key) === current) held.delete(key);
  }
}
