import { run, runChecked, type RunOptions } from "./exec.js";

/** Rootless per-user libvirt: no sudo, VMs owned by the invoking user, state under ~/.config/libvirt. */
export const LIBVIRT_URI = process.env.LINUX_COMPUTER_LIBVIRT_URI ?? "qemu:///session";

export type DomainState = "running" | "paused" | "shut off" | "pmsuspended" | "crashed" | "in shutdown" | "missing" | string;

export async function virsh(args: string[], options: RunOptions = {}): Promise<string> {
  const result = await runChecked("virsh", ["-q", "-c", LIBVIRT_URI, ...args], { timeoutMs: 120_000, ...options });
  return result.stdout.toString("utf8");
}

export async function domainState(name: string): Promise<DomainState> {
  const result = await run("virsh", ["-q", "-c", LIBVIRT_URI, "domstate", name], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString("utf8");
    if (/failed to get domain|Domain not found/i.test(stderr)) return "missing";
    throw new Error(`virsh domstate ${name} failed: ${stderr.trim()}`);
  }
  return result.stdout.toString("utf8").trim();
}

export async function hasManagedSave(name: string): Promise<boolean> {
  const out = await virsh(["dominfo", name]);
  return /Managed save:\s+yes/i.test(out);
}

export async function defineDomain(xmlPath: string): Promise<void> {
  await virsh(["define", xmlPath]);
}

export async function startDomain(name: string): Promise<void> {
  await virsh(["start", name]);
}

/** Save RAM + device state to disk and stop; the next start resumes exactly where it was. */
export async function managedSave(name: string): Promise<void> {
  await virsh(["managedsave", name], { timeoutMs: 300_000 });
}

export async function shutdownDomain(name: string): Promise<void> {
  await virsh(["shutdown", name, "--mode", "acpi"]);
}

export async function destroyDomain(name: string): Promise<void> {
  await virsh(["destroy", name]);
}

export async function undefineDomain(name: string): Promise<void> {
  await virsh(["undefine", name, "--managed-save", "--snapshots-metadata", "--nvram"]).catch(async () => {
    await virsh(["undefine", name, "--managed-save", "--snapshots-metadata"]);
  });
}

export async function liveXml(name: string): Promise<string> {
  return await virsh(["dumpxml", name]);
}

/** `vnc+unix:///path/vnc.sock` style display URI of a running domain. */
export async function vncSocket(name: string): Promise<string | undefined> {
  const xml = await liveXml(name);
  const match = /<graphics type='vnc'[^>]*?(?:socket='([^']+)')?[^>]*>([\s\S]*?)<\/graphics>/.exec(xml);
  if (!match) return undefined;
  if (match[1]) return match[1];
  return /<listen type='socket' socket='([^']+)'/.exec(match[2] ?? "")?.[1];
}

export async function vsockCid(name: string): Promise<number | undefined> {
  const xml = await liveXml(name);
  const cid = /<vsock[\s\S]*?<cid[^>]*address='(\d+)'/.exec(xml)?.[1];
  return cid ? Number(cid) : undefined;
}

export async function screenshot(name: string, file: string): Promise<void> {
  await virsh(["screenshot", name, "--file", file], { timeoutMs: 30_000 });
}

export async function snapshotCreate(name: string, snapshot: string, description: string): Promise<void> {
  await virsh(["snapshot-create-as", name, snapshot, description, "--atomic"], { timeoutMs: 600_000 });
}

export async function snapshotRevert(name: string, snapshot: string): Promise<void> {
  await virsh(["snapshot-revert", name, snapshot], { timeoutMs: 600_000 });
}

export async function snapshotDelete(name: string, snapshot: string): Promise<void> {
  await virsh(["snapshot-delete", name, snapshot], { timeoutMs: 600_000 });
}

export async function snapshotList(name: string): Promise<{ name: string; created: string; state: string }[]> {
  const out = await virsh(["snapshot-list", name]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s{2,}/);
      return { name: parts[0] ?? "", created: parts[1] ?? "", state: parts[2] ?? "" };
    });
}

export async function listDomainNames(): Promise<string[]> {
  const out = await virsh(["list", "--all", "--name"]);
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}
