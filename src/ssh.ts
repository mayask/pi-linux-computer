import { spawn } from "node:child_process";
import type { TargetConfig } from "./config.js";

export interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sshArgs(target: TargetConfig): string[] {
  return [
    "-i", target.identityFile,
    "-p", String(target.port ?? 22),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${target.knownHostsFile}`,
    `${target.user}@${target.host}`,
  ];
}

export async function sshRun(
  target: TargetConfig,
  command: string,
  options: { input?: Buffer | string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", [...sshArgs(target), command], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const finish = (error?: Error, result?: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("SSH operation aborted"));
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
      if (settled) return;
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code ?? 255,
      };
      if (timedOut) finish(new Error(`SSH operation timed out after ${options.timeoutMs}ms`));
      else finish(undefined, result);
    });

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

export function desktopEnvironment(target: TargetConfig): string {
  return [
    `DISPLAY=${shellQuote(target.display)}`,
    `XAUTHORITY=${shellQuote(target.xauthority)}`,
    `DBUS_SESSION_BUS_ADDRESS=${shellQuote(target.dbusAddress)}`,
  ].join(" ");
}
