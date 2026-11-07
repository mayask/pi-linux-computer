import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Settings } from "./config.js";
import { domainXml } from "./domain-xml.js";
import { runChecked, sleep, which } from "./exec.js";
import { destroyDomain, domainState, virsh } from "./libvirt.js";
import { withLock } from "./lock.js";
import { ensureDir, paths } from "./paths.js";
import { ensureClientKey } from "./ssh.js";

/** Bump whenever guest/provision.sh changes in a way existing bases should not be reused for. */
export const PROVISION_VERSION = 4;
export const GUEST_USER = "agent";

export interface BaseInfo {
  id: string;
  disk: string;
  hostKeyAlias: string;
  provisionVersion: number;
  /** Everything that determines the image contents; a base is reused only for an identical recipe. */
  recipe: string;
  createdAt: string;
  sourceImage: string;
}

function recipeOf(settings: Settings): string {
  return JSON.stringify({ provision: PROVISION_VERSION, image: settings.imageUrl, packages: [...settings.extraPackages].sort() });
}

export type Progress = (message: string) => void;

const provisionScript = new URL("../../guest/provision.sh", import.meta.url);

export function listBases(): BaseInfo[] {
  if (!existsSync(paths.bases)) return [];
  return readdirSync(paths.bases)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(paths.bases, file), "utf8")) as BaseInfo)
    .filter((base) => existsSync(base.disk))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Newest base matching the current provisioning script, source image and extra packages. */
export function currentBase(settings: Settings): BaseInfo | undefined {
  const recipe = recipeOf(settings);
  return listBases()
    .filter((base) => base.recipe === recipe)
    .at(-1);
}

async function sha512(file: string): Promise<string> {
  const hash = createHash("sha512");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function download(url: string, dest: string, progress: Progress, signal?: AbortSignal): Promise<void> {
  const sumsUrl = new URL("SHA512SUMS", url).toString();
  const fileName = url.split("/").at(-1)!;
  const sums = await (await fetch(sumsUrl, { signal })).text();
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === fileName)?.[0];
  if (!expected) throw new Error(`No checksum for ${fileName} in ${sumsUrl}`);

  if (existsSync(dest) && (await sha512(dest)) === expected) return;
  progress(`downloading ${url}`);
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(part));
  if ((await sha512(part)) !== expected) {
    rmSync(part, { force: true });
    throw new Error(`Checksum mismatch for ${url}`);
  }
  renameSync(part, dest);
}

async function isoTool(): Promise<string[]> {
  for (const tool of ["genisoimage", "mkisofs"]) {
    const path = await which(tool);
    if (path) return [path];
  }
  const xorriso = await which("xorriso");
  if (xorriso) return [xorriso, "-as", "mkisofs"];
  throw new Error("Building the base image needs genisoimage, mkisofs or xorriso on the host");
}

function userData(clientPub: string, hostKey: string, hostPub: string, settings: Settings): string {
  const indent = (text: string, spaces: number) =>
    text
      .trimEnd()
      .split("\n")
      .map((line) => " ".repeat(spaces) + line)
      .join("\n");
  const script = readFileSync(provisionScript, "utf8");
  return `#cloud-config
hostname: linux-computer
timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
ssh_pwauth: false
disable_root: true
users:
  - name: ${GUEST_USER}
    gecos: Agent
    shell: /bin/bash
    groups: [sudo, audio, video, plugdev, dialout]
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: false
    ssh_authorized_keys:
      - ${clientPub.trim()}
chpasswd:
  expire: false
  users:
    - { name: ${GUEST_USER}, password: ${GUEST_USER}, type: text }
ssh_deletekeys: true
ssh_genkeytypes: []
ssh_keys:
  ed25519_private: |
${indent(hostKey, 4)}
  ed25519_public: ${hostPub.trim()}
write_files:
  - path: /usr/local/sbin/linux-computer-provision
    permissions: "0755"
    content: |
${indent(script, 6)}
runcmd:
  - [env, "LC_EXTRA_PACKAGES=${settings.extraPackages.join(" ")}", /usr/local/sbin/linux-computer-provision]
power_state:
  mode: poweroff
  condition: true
  timeout: 30
`;
}

function readTail(file: string, from: number): { text: string; size: number } {
  if (!existsSync(file)) return { text: "", size: from };
  const size = statSync(file).size;
  if (size <= from) return { text: "", size };
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    return { text: buffer.toString("utf8"), size };
  } finally {
    closeSync(fd);
  }
}

export async function buildBase(settings: Settings, progress: Progress, signal?: AbortSignal): Promise<BaseInfo> {
  ensureDir(paths.bases);
  ensureDir(paths.cache);
  return await withLock("base-build", async () => {
    const existing = currentBase(settings);
    if (existing) return existing;

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
    const id = `debian13-v${PROVISION_VERSION}-${stamp.toLowerCase()}`;
    const source = join(paths.cache, settings.imageUrl.split("/").at(-1)!);
    await download(settings.imageUrl, source, progress, signal);

    const work = ensureDir(join(paths.bases, `${id}.build`));
    const disk = join(paths.bases, `${id}.qcow2`);
    const tmpDisk = join(work, "disk.qcow2");
    const log = join(work, "serial.log");
    const buildName = `lc-build-${id}`;
    try {
      progress("preparing disk");
      await runChecked("qemu-img", ["convert", "-q", "-O", "qcow2", source, tmpDisk]);
      await runChecked("qemu-img", ["resize", "-q", tmpDisk, `${settings.diskGiB}G`]);

      const hostKeyFile = join(work, "ssh_host_ed25519_key");
      await runChecked("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `linux-computer-${id}`, "-f", hostKeyFile]);
      const hostPub = readFileSync(`${hostKeyFile}.pub`, "utf8");
      const clientPub = readFileSync(`${await ensureClientKey()}.pub`, "utf8");

      const seedDir = ensureDir(join(work, "seed"));
      writeFileSync(join(seedDir, "meta-data"), `instance-id: ${id}\nlocal-hostname: linux-computer\n`);
      writeFileSync(join(seedDir, "user-data"), userData(clientPub, readFileSync(hostKeyFile, "utf8"), hostPub, settings));
      const seedIso = join(work, "seed.iso");
      const [tool, ...toolArgs] = await isoTool();
      await runChecked(tool!, [...toolArgs, "-quiet", "-output", seedIso, "-volid", "cidata", "-joliet", "-rock", join(seedDir, "user-data"), join(seedDir, "meta-data")]);

      const xmlPath = join(work, "domain.xml");
      writeFileSync(
        xmlPath,
        domainXml({
          name: buildName,
          title: "linux-computer base image build",
          description: `Provisioning ${id}`,
          memoryMiB: Math.max(settings.memoryMiB, 4096),
          vcpus: Math.max(settings.vcpus, 4),
          disk: tmpDisk,
          width: settings.width,
          height: settings.height,
          seedIso,
          serialLog: log,
        }),
      );
      progress("booting build VM (installs the desktop; takes several minutes)");
      await virsh(["create", xmlPath]);

      let offset = 0;
      let lastProgress = "";
      const deadline = Date.now() + 45 * 60_000;
      while ((await domainState(buildName)) !== "missing") {
        if (Date.now() > deadline) throw new Error(`Base build timed out; serial log: ${log}`);
        await sleep(3000, signal);
        const tail = readTail(log, offset);
        offset = tail.size;
        for (const match of tail.text.matchAll(/LC-PROGRESS: ([^\r\n]+)/g)) {
          // The console mirrors cloud-init's stdout, so each line can arrive twice.
          if (match[1] !== lastProgress) progress(match[1]!);
          lastProgress = match[1]!;
        }
      }
      const serial = readFileSync(log, "utf8");
      if (!serial.includes("LC_PROVISION_OK")) {
        const lines = serial.split("\n").slice(-40).join("\n");
        throw new Error(`Base provisioning failed. Serial log ${log}:\n${lines}`);
      }

      renameSync(tmpDisk, disk);
      chmodSync(disk, 0o444);
      const hostKeyAlias = `linux-computer-${id}`;
      writeFileSync(paths.knownHosts, `${hostKeyAlias} ${hostPub.trim().split(" ").slice(0, 2).join(" ")}\n`, { flag: "a", mode: 0o600 });
      const info: BaseInfo = {
        id,
        disk,
        hostKeyAlias,
        provisionVersion: PROVISION_VERSION,
        recipe: recipeOf(settings),
        createdAt: new Date().toISOString(),
        sourceImage: settings.imageUrl,
      };
      writeFileSync(join(paths.bases, `${id}.json`), JSON.stringify(info, null, 2));
      rmSync(work, { recursive: true, force: true });
      progress(`base image ${id} ready`);
      return info;
    } catch (error) {
      await destroyDomain(buildName).catch(() => undefined);
      throw error;
    }
  });
}

export function deleteBase(id: string): void {
  const manifest = join(paths.bases, `${id}.json`);
  const info = JSON.parse(readFileSync(manifest, "utf8")) as BaseInfo;
  chmodSync(info.disk, 0o644);
  rmSync(info.disk, { force: true });
  rmSync(manifest, { force: true });
}
