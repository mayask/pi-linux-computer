import { spawn } from "node:child_process";

export interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface RunOptions {
  input?: Buffer | string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  if (options.signal?.aborted) {
    reject(new Error(`${command} aborted`));
    return promise;
  }
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env ?? process.env,
    cwd: options.cwd,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;
  let settled = false;

  const finish = (error?: Error, result?: RunResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (error) reject(error);
    else resolve(result!);
  };
  const onAbort = () => {
    child.kill("SIGTERM");
    finish(new Error(`${command} aborted`));
  };
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs)
    : undefined;

  options.signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.on("error", (error) => finish(error));
  child.on("close", (code) => {
    const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 255 };
    if (timedOut) finish(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    else finish(undefined, result);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  return promise;
}

/** Run and throw with stderr on non-zero exit. */
export async function runChecked(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
    throw new Error(`${command} ${args[0] ?? ""} failed (${result.exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export async function which(command: string): Promise<string | undefined> {
  const result = await run("sh", ["-c", `command -v ${shellQuote(command)}`]).catch(() => undefined);
  const path = result?.stdout.toString("utf8").trim();
  return result?.exitCode === 0 && path ? path : undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(new Error("aborted"));
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(new Error("aborted"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}
