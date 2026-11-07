export const METADATA_NS = "https://github.com/mayask/linux-computer/vm/1";

function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&apos;").replaceAll('"', "&quot;");
}

export interface DomainSpec {
  name: string;
  title: string;
  description: string;
  memoryMiB: number;
  vcpus: number;
  disk: string;
  width: number;
  height: number;
  /** Build-time only: cloud-init seed ISO. */
  seedIso?: string;
  /** Build-time only: serial console log file. */
  serialLog?: string;
  metadata?: Record<string, string>;
}

/**
 * Desktop VM: virtio disk/net/gpu, passt user networking (no host ports), a VNC display on a private
 * unix socket the user can attach to at any time, and an AF_VSOCK device the host reaches SSH through.
 */
export function domainXml(spec: DomainSpec): string {
  const metadata = Object.entries(spec.metadata ?? {})
    .map(([key, value]) => `      <lc:${key}>${esc(value)}</lc:${key}>`)
    .join("\n");
  const seed = spec.seedIso
    ? `
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='${esc(spec.seedIso)}'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>`
    : "";
  const serial = spec.serialLog
    ? `
    <serial type='file'>
      <source path='${esc(spec.serialLog)}'/>
      <target port='0'/>
    </serial>`
    : `
    <serial type='pty'>
      <target port='0'/>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>`;
  return `<domain type='kvm'>
  <name>${esc(spec.name)}</name>
  <title>${esc(spec.title)}</title>
  <description>${esc(spec.description)}</description>
  <metadata>
    <lc:vm xmlns:lc='${METADATA_NS}'>
${metadata}
    </lc:vm>
  </metadata>
  <memory unit='MiB'>${spec.memoryMiB}</memory>
  <vcpu placement='static'>${spec.vcpus}</vcpu>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='host-passthrough' check='none' migratable='on'/>
  <clock offset='utc'>
    <timer name='rtc' tickpolicy='catchup'/>
    <timer name='pit' tickpolicy='delay'/>
    <timer name='hpet' present='no'/>
  </clock>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <pm>
    <suspend-to-mem enabled='no'/>
    <suspend-to-disk enabled='no'/>
  </pm>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' cache='writeback' discard='unmap'/>
      <source file='${esc(spec.disk)}'/>
      <target dev='vda' bus='virtio'/>
    </disk>${seed}
    <controller type='usb' model='qemu-xhci' ports='15'/>
    <interface type='user'>
      <backend type='passt'/>
      <model type='virtio'/>
    </interface>${serial}
    <input type='tablet' bus='usb'/>
    <input type='keyboard' bus='usb'/>
    <graphics type='vnc'>
      <listen type='socket'/>
    </graphics>
    <video>
      <model type='virtio' heads='1' primary='yes'>
        <resolution x='${spec.width}' y='${spec.height}'/>
      </model>
    </video>
    <vsock model='virtio'>
      <cid auto='yes'/>
    </vsock>
    <rng model='virtio'>
      <backend model='random'>/dev/urandom</backend>
    </rng>
    <memballoon model='virtio'/>
  </devices>
</domain>
`;
}
