---
name: linux-computer
description: Control configured Linux VM desktops through SSH, AT-SPI accessibility, keyboard/mouse actions, and screenshots. Use when asked to operate, inspect, test, or automate a graphical Linux VM.
---

# Linux computer use

Use the `linux_vm_*` tools for configured VM targets.

## Operating policy

1. Prefer `linux_vm_exec` when the task is fundamentally command-line, file, package, service, or diagnostic work.
2. When visible desktop interaction is requested, call `linux_vm_observe` first.
3. Select controls by current node ID, role, name, state, and accessible actions.
4. Prefer `invoke`, `focus`, and `set_text` over coordinate clicks.
5. Use `type` and `key` when an application does not expose an editable AT-SPI interface.
6. Observe again after every state-changing action. Node IDs may become stale whenever the interface changes.
7. Use `linux_vm_terminal_capture` for complete retained output from the last visible terminal command. Do not rerun a command merely to recover its output.
8. Use `linux_vm_screenshot` only when the accessibility tree lacks required information or visual appearance matters.
9. Never infer a destructive confirmation from stale state. Re-observe immediately before confirming destructive actions.

## Common GUI sequence

To launch an application when it is not present in the tree:

1. Send `Super_L` with `linux_vm_act` action `key`.
2. Send the application name with action `type`.
3. Send `Return` with action `key`.
4. Wait briefly and observe again.

For terminal commands that the user explicitly wants typed visibly:

1. Observe and locate the terminal.
2. Focus or click its terminal node.
3. Type the command.
4. Send `Return`.
5. Use `linux_vm_terminal_capture` to recover the command and complete retained output, including off-screen scrollback.

For terminals managed by the agent, start or attach to a named tmux session so output can be captured without touching the clipboard:

```bash
tmux new -A -s pi-agent
```

`linux_vm_terminal_capture` in `auto` mode prefers a single active attached tmux pane. For an existing non-tmux terminal, it uses semantic Select All/copy, restores the previous text clipboard, and never reruns the command.

## Fallback order

Use this order to minimize cost and ambiguity:

1. Direct command or managed PTY output when the agent initiated the command
2. `tmux capture-pane` through `linux_vm_terminal_capture`
3. AT-SPI accessibility tree
4. Clipboard-preserving terminal capture for an existing non-tmux session
5. Application API, D-Bus, or shell when appropriate
6. OCR when available
7. Screenshot and vision
8. Raw coordinates only after visually or semantically locating the target
