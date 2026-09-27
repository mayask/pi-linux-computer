# pi-linux-computer

A Pi package for driving graphical Linux VMs through SSH. It exposes structured AT-SPI observation, semantic actions, screenshots, and remote shell execution. The normal path works with text-only models; screenshots are a fallback.

## Current scope

- X11 desktops, including XRDP Xorg sessions
- Key-authenticated SSH transport
- GTK/GNOME accessibility through AT-SPI
- Semantic action with `xdotool` coordinate/keyboard fallback
- Multiple named VM targets

Wayland-native input and browser-specific DOM automation are future adapters.

## Tools

- `linux_vm_observe` — compact accessibility tree and visible text
- `linux_vm_act` — invoke, focus, click, type, key, scroll, or wait
- `linux_vm_screenshot` — PNG fallback for vision-capable models
- `linux_vm_exec` — remote shell over SSH

## VM dependencies

```bash
sudo apt install python3-pyatspi at-spi2-core xdotool scrot wmctrl openssh-server
```

The target desktop session must expose `DISPLAY`, `XAUTHORITY`, and its user D-Bus socket. XRDP creates an Xorg session suitable for this.

## Configuration

Copy `examples/targets.example.json` to:

```text
~/.config/pi-linux-computer/targets.json
```

The top-level object may be the target map directly, or:

```json
{
  "defaultTarget": "debian13",
  "targets": {
    "debian13": {}
  }
}
```

Private keys and passwords are not stored in this configuration. SSH host-key checking is mandatory through `knownHostsFile`.

## Install into Pi

```bash
pi install /absolute/path/to/pi-linux-computer
```

Reload a running Pi session with `/reload`. Use `/linux-computer` to inspect loaded targets.

For one new Pi process without installation:

```bash
pi -e /absolute/path/to/pi-linux-computer
```

## Development acceptance test

The initial acceptance task is entirely text-driven:

1. Observe the desktop with AT-SPI.
2. Locate or launch Terminal.
3. Focus the terminal and type `uname -a`.
4. Observe again.
5. Read the command output from the terminal's accessible text.

No screenshot should be needed.

## Security

The extension runs with the same permissions as Pi. A target with passwordless sudo grants the extension root-equivalent control inside that VM. Keep forwarding bound to localhost, protect SSH private keys, use dedicated accounts/keys, and review third-party changes before loading them.
