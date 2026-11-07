/**
 * Credentials the agent can use without ever seeing them.
 *
 * Values live in the user's keyring (libsecret via `secret-tool`); only metadata is on disk. Tools take
 * a secret *name*, resolve it here on the host, and hand the value to the guest helper over the SSH
 * stdin channel. Every tool result is scrubbed of known values (and common encodings of them) before it
 * reaches the model, the transcript or the provider.
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "./exec.js";
import { configPath, ensureDir, paths } from "./paths.js";

export type SecretKind = "password" | "token" | "totp";

export interface SecretMeta {
  kind: SecretKind;
  /** Not secret; shown to the agent so it can fill the username field itself. */
  username?: string;
  /** Browser use: origins (scheme://host[:port]) the value may be filled into. */
  origins?: string[];
  /** Native-app use: application names (as in vm_observe) the value may be typed into. */
  apps?: string[];
  /** Allow exposing the value to vm_exec commands as an environment variable. */
  exec?: boolean;
  description?: string;
}

/** How a secret is about to be used; approvals are recorded per secret, VM scope and use. */
export type SecretUse = { via: "browser"; origin: string } | { via: "app"; app: string } | { via: "exec" };

export function useKey(use: SecretUse): string {
  return use.via === "browser" ? `browser:${use.origin}` : use.via === "app" ? `app:${use.app.toLowerCase()}` : "exec";
}

const NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
export const SECRETS_FILE = () => join(dirname(configPath()), "secrets.json");
const APPROVALS_FILE = () => join(paths.root, "approvals.json");

export function loadSecretMeta(): Record<string, SecretMeta> {
  const file = SECRETS_FILE();
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, SecretMeta>) : {};
}

function saveSecretMeta(meta: Record<string, SecretMeta>): void {
  ensureDir(dirname(SECRETS_FILE()));
  writeFileSync(SECRETS_FILE(), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

const ATTRS = (name: string) => ["service", "linux-computer", "name", name];

async function keyringLookup(name: string): Promise<string> {
  const result = await run("secret-tool", ["lookup", ...ATTRS(name)], { timeoutMs: 15_000 });
  if (result.exitCode !== 0 || result.stdout.length === 0) throw new Error(`Secret ${name} is missing from the keyring; re-add it with \`linux-computer secret add ${name}\``);
  return result.stdout.toString("utf8");
}

export async function addSecret(name: string, value: string, meta: SecretMeta): Promise<void> {
  if (!NAME.test(name)) throw new Error("Secret names use letters, digits and . _ / - (max 64)");
  if (!value) throw new Error("Empty secret value");
  if (meta.kind === "totp") base32Decode(value);
  const result = await run("secret-tool", ["store", `--label=linux-computer: ${name}`, ...ATTRS(name)], { input: value, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`secret-tool store failed: ${result.stderr.toString("utf8").trim()}`);
  const all = loadSecretMeta();
  all[name] = meta;
  saveSecretMeta(all);
  cache = undefined;
}

export async function removeSecret(name: string): Promise<void> {
  await run("secret-tool", ["clear", ...ATTRS(name)], { timeoutMs: 15_000 });
  const all = loadSecretMeta();
  delete all[name];
  saveSecretMeta(all);
  saveApprovals(loadApprovals().filter((approval) => approval.secret !== name));
  cache = undefined;
}

// --- approvals ---

export interface Approval {
  secret: string;
  /** VM scope id, or "*" for an admin pre-approval covering every VM. */
  scope: string;
  use: string;
  at: string;
}

export function loadApprovals(): Approval[] {
  const file = APPROVALS_FILE();
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Approval[]) : [];
}

export function saveApprovals(approvals: Approval[]): void {
  ensureDir(paths.root);
  writeFileSync(APPROVALS_FILE(), `${JSON.stringify(approvals, null, 2)}\n`, { mode: 0o600 });
}

export function isApproved(secret: string, scope: string, use: SecretUse): boolean {
  const key = useKey(use);
  return loadApprovals().some((a) => a.secret === secret && (a.scope === scope || a.scope === "*") && a.use === key);
}

export function approve(secret: string, scope: string, use: string): void {
  const approvals = loadApprovals().filter((a) => !(a.secret === secret && a.scope === scope && a.use === use));
  approvals.push({ secret, scope, use, at: new Date().toISOString() });
  saveApprovals(approvals);
}

export function revoke(secret: string, scope?: string): number {
  const approvals = loadApprovals();
  const kept = approvals.filter((a) => !(a.secret === secret && (scope === undefined || a.scope === scope)));
  saveApprovals(kept);
  return approvals.length - kept.length;
}

/** Asks the human out of band (harness dialog, MCP elicitation). Undefined when no one can be asked. */
export type Confirm = (title: string, message: string) => Promise<boolean>;

function describeUse(use: SecretUse): string {
  return use.via === "browser" ? `fill it into a page on ${use.origin}` : use.via === "app" ? `type it into ${use.app}` : "expose it to a shell command as an environment variable";
}

/** Policy check for one use of a secret. Throws with an agent-readable reason when refused. */
export async function authorize(name: string, scope: string, vm: string, use: SecretUse, confirm: Confirm | undefined): Promise<SecretMeta> {
  const meta = loadSecretMeta()[name];
  if (!meta) throw new Error(`Unknown secret ${JSON.stringify(name)}; see vm_secrets list`);
  if (use.via === "browser" && !(meta.origins ?? []).includes(use.origin))
    throw new Error(`Secret ${name} is not allowed on ${use.origin} (allowed: ${(meta.origins ?? []).join(", ") || "no origins"}). Refusing: this page may be trying to collect it.`);
  if (use.via === "app" && !(meta.apps ?? []).some((app) => use.app.toLowerCase().includes(app.toLowerCase())))
    throw new Error(`Secret ${name} is not allowed in application ${JSON.stringify(use.app)} (allowed: ${(meta.apps ?? []).join(", ") || "none"})`);
  if (use.via === "exec" && !meta.exec) throw new Error(`Secret ${name} is not allowed in shell commands (its exec flag is off)`);
  if (isApproved(name, scope, use)) return meta;
  const question = `Allow the agent to use secret "${name}"${meta.username ? ` (${meta.username})` : ""} in VM ${vm}: ${describeUse(use)}? The value stays hidden from the agent. You are asked once per VM and use.`;
  if (!confirm) {
    throw new Error(
      `Secret ${name} needs the user's approval for this use and no approval dialog is available here. Ask the user to run: linux-computer secret approve ${name} --scope ${scope} --use ${useKey(use)}`,
    );
  }
  if (!(await confirm("linux-computer: use a secret?", question))) throw new Error(`The user declined use of secret ${name}`);
  approve(name, scope, useKey(use));
  return meta;
}

/** Value to inject: the stored secret, or the current code for a TOTP seed. */
export async function resolveValue(name: string, meta: SecretMeta): Promise<string> {
  const stored = await keyringLookup(name);
  extra.set(stored, name);
  if (meta.kind !== "totp") return stored;
  const code = totp(stored);
  extra.set(code, `${name}:code`);
  return code;
}

// --- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ---

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error("TOTP secrets must be base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(seed: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac("sha1", base32Decode(seed)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

// --- redaction ---

let cache: { mtime: number; values: Map<string, string> } | undefined;
/** Values injected by this process (TOTP codes, values read before metadata changed). */
const extra = new Map<string, string>();

/** All stored values, loaded once per process and reloaded when secrets.json changes. */
async function knownValues(): Promise<Map<string, string>> {
  const file = SECRETS_FILE();
  const mtime = existsSync(file) ? statSync(file).mtimeMs : 0;
  if (!cache || cache.mtime !== mtime) {
    const values = new Map<string, string>();
    for (const name of Object.keys(loadSecretMeta())) {
      const value = await keyringLookup(name).catch(() => undefined);
      if (value && value.length >= 4) values.set(value, name);
    }
    cache = { mtime, values };
  }
  return new Map([...extra, ...cache.values]);
}

function encodings(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const forms = [
    value,
    bytes.toString("base64"),
    bytes.toString("base64").replace(/=+$/, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    [...value].reverse().join(""),
  ];
  return [...new Set(forms)].filter((form) => form.length >= 4);
}

export interface Redactor {
  (text: string): string;
  /** True when no secrets are known (nothing to scrub). */
  empty: boolean;
}

export async function redactor(): Promise<Redactor> {
  const pairs: [string, string][] = [];
  for (const [value, name] of await knownValues()) for (const form of encodings(value)) pairs.push([form, `«secret:${name}»`]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  const scrub = ((text: string) => {
    let out = text;
    for (const [form, label] of pairs) if (out.includes(form)) out = out.split(form).join(label);
    return out;
  }) as Redactor;
  scrub.empty = pairs.length === 0;
  return scrub;
}
