# Changelog

## 0.4.0

### Added

- Credentials the agent uses without seeing them: `linux-computer secret add|list|rm|approve|revoke|approvals`, values in the GNOME keyring, metadata in `~/.config/linux-computer/secrets.json`.
- `vm_secrets list`; `secret` parameter on `vm_browser fill` and `vm_act type`; `secretEnv` on `vm_exec`. TOTP secrets fill the current code.
- Use binding (browser origins, native apps, shell opt-in) and first-use approval per VM and place through the harness UI (omp/pi `ui.confirm`, MCP elicitation); CLI pre-approval otherwise.
- Central scrubbing of stored values and common encodings from every tool result, detail, progress message and error.

### Changed

- `vm_browser eval` is refused on a page after a secret was filled into it; `elements` omits password field values.
- `vm_act type` sends text to xdotool on stdin instead of argv; helper command errors name only the program, not its arguments.
- Base image (provision v4) disables the Chromium and Firefox password managers; existing VMs keep their base.

## 0.3.0

Harness-agnostic rewrite with managed per-session VMs. Package renamed to `linux-computer`.

### Added

- Managed VMs: each agent session gets its own Debian 13 + XFCE desktop VM, created on first use as a qcow2 overlay of a golden base image built automatically from the official cloud image. Rootless libvirt (`qemu:///session`), passt networking, no host ports.
- Persistence: VMs live until destroyed. Session end suspends the VM to disk (`onSessionEnd`), the next call resumes it with apps still open. Snapshots with `vm_lifecycle snapshot/revert`.
- Session scoping for omp and pi from the session transcript; subagents share their parent's VM, forks and new sessions get their own.
- Always-visible display: a VNC viewer opens on the host when a VM starts; the agent drives the same screen the user sees.
- Control hand-off (`vm_control`, `/vm user|agent`): the user takes over through an agreed hand-off, agent input is refused until the user clicks "Hand back to agent" in the VM.
- MCP server (`linux-computer mcp`) for opencode, Claude Code, Codex, Cursor and other MCP clients.
- Admin CLI: `list`, `status`, `start`, `view`, `suspend`, `stop`, `ssh`, `destroy`, `gc`, `base`, `tool`.
- `vm_screen_text` (tesseract OCR with bounds), `vm_browser` (Chromium DevTools: elements, click, fill, eval, navigate, text), `vm_copy` (streamed tar), USB passthrough actions.
- `vm_observe` filters (`app`, `window`, `focusedWindow`, `find`), hidden-subtree pruning and compact output without implied states or anonymous layout containers.
- `vm_exec` sets the desktop session environment and supports `background=true` for GUI apps and servers.
- `npm run test:vm`: end-to-end test against a throwaway VM.

### Changed

- Tools renamed from `linux_vm_*` to `vm_*`; `target` now selects an optional external SSH machine instead of being required.
- `vm_act click` performs a real pointer click at the node's center; `invoke` keeps the accessible-action path. `invoke` also tries check/uncheck/toggle/select by default, and scroll honors `x`/`y`/`nodeId`.
- Configuration moved to `~/.config/linux-computer/config.json` (`targets` holds former `targets.json` entries; `display`, `xauthority`, `dbusAddress` are optional because the guest helper discovers the desktop session).
- One multiplexed SSH connection per guest instead of a handshake per call.
- Requires Node.js 22+.

### Removed

- `~/.config/pi-linux-computer/targets.json`, `PI_LINUX_COMPUTER_CONFIG` and `helperPath`.
