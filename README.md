# pi-linux-computer

[![CI](https://github.com/mayask/pi-linux-computer/actions/workflows/ci.yml/badge.svg)](https://github.com/mayask/pi-linux-computer/actions/workflows/ci.yml)

A [Pi](https://github.com/earendil-works/pi) package for operating graphical Linux machines over SSH. It exposes Linux desktop accessibility as compact text, performs semantic UI actions, captures full terminal output, and uses screenshots only as a fallback.

This is an MVP. It is designed for X11 desktops and has been tested on Debian 13 with a GNOME XRDP session. It should work on other distributions and desktop environments when the dependencies below are available and applications expose AT-SPI accessibility information.

## Why

A model does not need to process a screenshot for every desktop action. `pi-linux-computer` uses:

1. AT-SPI roles, names, states, text, actions, and bounds
2. Semantic actions such as focus, invoke, and set text
3. X11 keyboard and pointer input when an accessible action is unavailable
4. `tmux` or clipboard-preserving terminal capture for complete scrollback
5. Screenshots only for genuinely visual content

This gives text-only models a useful computer-use interface and reduces image-token usage for vision-capable models.

## Tools

| Tool | Purpose |
|---|---|
| `linux_vm_observe` | Return a compact AT-SPI accessibility tree, visible text, node IDs, and windows |
| `linux_vm_act` | Invoke, focus, click, type, press keys, scroll, or wait |
| `linux_vm_terminal_capture` | Capture the last visible terminal command and its complete retained output without rerunning it |
| `linux_vm_screenshot` | Return a PNG when accessibility data is insufficient |
| `linux_vm_exec` | Run commands over key-authenticated SSH |

The package also includes a `linux-computer` skill that teaches Pi to prefer semantic and text-based operations.

## Supported environments

### Good fit

- X11 or XRDP/Xorg desktop sessions
- Debian, Ubuntu, Fedora, Arch, and similar distributions with AT-SPI packages
- GNOME/GTK applications
- Qt applications that expose AT-SPI correctly
- Direct SSH, forwarded localhost ports, VPN addresses, or LAN addresses
- GNOME Terminal and similar accessible terminals
- Any terminal running a managed `tmux` session for reliable scrollback capture

### Current limitations

- Wayland-native keyboard and pointer injection is not implemented.
- Canvas, games, video, images, and inaccessible custom widgets still require screenshots or application-specific APIs.
- Clipboard fallback preserves plain text, not every possible clipboard MIME type.
- Terminal command-boundary detection expects a conventional shell prompt ending in `$ ` or `# `. Managed `tmux` plus ordinary Bash/Zsh prompts works best.
- The extension controls an existing desktop session. It does not currently create the desktop or launch an RDP/VNC viewer.

## Requirements

### On the Pi host

- Pi
- Node.js 20 or newer
- OpenSSH client
- Key-based SSH access to the target

### Inside each target

- Python 3.8 or newer
- OpenSSH server
- AT-SPI Python bindings
- An active X11 desktop session
- `xdotool`, `wmctrl`, `scrot`, `xclip`, and `tmux`

Debian/Ubuntu:

```bash
sudo apt update
sudo apt install python3-pyatspi at-spi2-core xdotool scrot wmctrl xclip tmux openssh-server
sudo systemctl enable --now ssh
```

Fedora:

```bash
sudo dnf install python3-pyatspi at-spi2-core xdotool scrot wmctrl xclip tmux openssh-server
sudo systemctl enable --now sshd
```

Arch Linux:

```bash
sudo pacman -S python-pyatspi at-spi2-core xdotool scrot wmctrl xclip tmux openssh
sudo systemctl enable --now sshd
```

Package names can differ on derivative distributions.

## Quick start

### 1. Establish SSH access

Create a dedicated key on the Pi host:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/linux-vm-agent_ed25519
ssh-copy-id -i ~/.ssh/linux-vm-agent_ed25519.pub -p 2222 vmagent@127.0.0.1
```

The example uses a localhost-forwarded VM SSH port. Replace the host and port when the target has a directly reachable address.

Optionally use a dedicated known-hosts file:

```bash
ssh-keyscan -p 2222 127.0.0.1 > ~/.ssh/linux-vm-known_hosts
```

Verify the fingerprint through a trusted channel before accepting it.

If `identityFile` or `knownHostsFile` is omitted from configuration, normal OpenSSH key discovery and `~/.ssh/known_hosts` are used. Host-key checking remains enabled.

### 2. Start an X11 desktop session

Use an existing Xorg console session, VNC/Xvnc desktop, or XRDP Xorg session. For a headless GNOME VM, XRDP is often the easiest option:

```bash
sudo apt install xrdp xorgxrdp
sudo systemctl enable --now xrdp
```

Log in to the desktop once and keep that session running. If you want to watch Pi operate, keep an RDP, VNC, or SPICE viewer attached to the same session.

### 3. Discover the session values

Run inside the target as the desktop user:

```bash
id -u
pgrep -a Xorg
printf 'XAUTHORITY=%s\n' "$XAUTHORITY"
printf 'DBUS_SESSION_BUS_ADDRESS=%s\n' "$DBUS_SESSION_BUS_ADDRESS"
```

Typical XRDP values are:

```text
DISPLAY=:10
XAUTHORITY=/home/vmagent/.Xauthority
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus
```

Confirm AT-SPI access from SSH:

```bash
DISPLAY=:10 \
XAUTHORITY=/home/vmagent/.Xauthority \
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
python3 -c 'import pyatspi; d=pyatspi.Registry.getDesktop(0); print(d.name, d.childCount)'
```

### 4. Configure targets

Create `~/.config/pi-linux-computer/targets.json` on the Pi host:

```json
{
  "defaultTarget": "linux-vm",
  "targets": {
    "linux-vm": {
      "host": "127.0.0.1",
      "port": 2222,
      "user": "vmagent",
      "identityFile": "~/.ssh/linux-vm-agent_ed25519",
      "knownHostsFile": "~/.ssh/linux-vm-known_hosts",
      "display": ":10",
      "xauthority": "/home/vmagent/.Xauthority",
      "dbusAddress": "unix:path=/run/user/1001/bus"
    }
  }
}
```

See [`examples/targets.example.json`](examples/targets.example.json).

Configuration reference:

| Field | Required | Description |
|---|---:|---|
| `host` | yes | SSH hostname or address |
| `port` | no | SSH port; defaults to `22` |
| `user` | yes | SSH and desktop-session user |
| `identityFile` | no | Private key; normal SSH discovery is used when omitted |
| `knownHostsFile` | no | Dedicated known-hosts file; normal SSH configuration is used when omitted |
| `display` | yes | X11 display, such as `:0` or `:10` |
| `xauthority` | yes | Xauthority file for the desktop user |
| `dbusAddress` | yes | Desktop user's session bus address |
| `helperPath` | no | Remote helper location; defaults to `.local/share/pi-linux-computer/linux_computer.py` |

Set `PI_LINUX_COMPUTER_CONFIG` to use another configuration path.

### 5. Install the Pi package

```bash
pi install git:github.com/mayask/pi-linux-computer
```

Reload an existing Pi session:

```text
/reload
```

Run `/linux-computer` to display configured targets.

For local development:

```bash
git clone https://github.com/mayask/pi-linux-computer.git ~/src/pi-linux-computer
pi install ~/src/pi-linux-computer
```

### 6. Try it

Example requests:

```text
Open Terminal in linux-vm, run uname -a visibly, and read the result without a screenshot.
```

```text
Inspect the current desktop and tell me which windows and actionable controls are visible.
```

```text
Capture the full output of the last terminal command, including off-screen scrollback.
```

## Terminal capture

`linux_vm_terminal_capture` never reruns the command.

In `auto` mode it:

1. Uses `tmux capture-pane` when exactly one active attached tmux pane is available.
2. Otherwise finds the focused terminal through AT-SPI.
3. Invokes its semantic **Select All** action.
4. Copies the retained scrollback.
5. Restores the previous plain-text clipboard.
6. Extracts the last command and output using shell prompt boundaries.

For terminals managed by Pi, start a named tmux session:

```bash
tmux new -A -s pi-agent
```

When several panes exist, specify one explicitly through the tool's `tmuxPane` argument, for example `pi-agent:0.0`.

Large output is bounded before being sent to the model. The complete output is stored inside the target at:

```text
~/.local/share/pi-linux-computer/captures/last-command-output.txt
```

The file is created with mode `0600`.

## How it works

The extension runs on the Pi host and invokes a small stateless Python helper over SSH. The helper is uploaded automatically to the configured `helperPath` and is replaced when its content hash changes.

```text
Pi model
   │ structured tools
Pi extension
   │ key-authenticated SSH
remote Python helper
   ├── AT-SPI observation/actions
   ├── xdotool X11 fallback
   ├── tmux/clipboard terminal capture
   └── scrot screenshot fallback
```

No daemon, inbound guest API, or password is required. The only network requirement is working SSH access from the Pi host.

## Troubleshooting

### `No visible terminal was found through AT-SPI`

Ensure the terminal is running in the configured display and the SSH user is the same user who owns that desktop session.

### `python3: No module named pyatspi`

Install the distribution's PyAT-SPI package. It is usually named `python3-pyatspi` or `python-pyatspi`.

### `Can't open display` or actions do nothing

Verify `display`, `xauthority`, and ownership of the Xauthority file. Test with:

```bash
DISPLAY=:10 XAUTHORITY=/home/vmagent/.Xauthority xdotool getdisplaygeometry
```

### AT-SPI returns no applications

Verify the session D-Bus address and run the AT-SPI test from the quick start. Some minimal window managers do not start the accessibility bus automatically.

### `Host key verification failed`

Correct `knownHostsFile`, update the host key after independently verifying it, or omit the field to use normal OpenSSH configuration.

### The model sees too much accessibility output

Lower `maxDepth` or `maxNodes`. Application/focused-window filtering and delta snapshots are planned improvements.

### GUI actions work but I cannot watch them

The tools operate the configured guest display; they do not open a viewer on the host. Attach an RDP, VNC, or SPICE client to that same session and keep it running.

## Development

```bash
git clone https://github.com/mayask/pi-linux-computer.git
cd pi-linux-computer
npm ci
npm run typecheck
```

The remote integration test uses your configured default target and changes terminal selection briefly while preserving its text clipboard:

```bash
npm run test:remote
```

The test verifies:

- SSH/helper deployment
- AT-SPI connectivity and snapshots
- Clipboard-preserving terminal capture
- Explicit tmux-pane capture

## Security

The extension runs with the same host permissions as Pi and can execute commands as the configured SSH user. If that user has passwordless sudo, anyone controlling Pi effectively has root access inside the target.

Recommended precautions:

- Use a dedicated VM account and SSH key.
- Keep forwarded ports bound to localhost or use a trusted VPN.
- Keep SSH host-key checking enabled.
- Do not expose XRDP, VNC, or SSH directly to the public internet.
- Treat accessibility text, terminal scrollback, screenshots, and clipboard contents as potentially sensitive.
- Review extension updates before loading them.

## License

MIT
