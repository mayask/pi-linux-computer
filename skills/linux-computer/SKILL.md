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
7. Use `linux_vm_screenshot` only when the accessibility tree lacks required information or visual appearance matters.
8. Never infer a destructive confirmation from stale state. Re-observe immediately before confirming destructive actions.

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
5. Observe and read the terminal text through AT-SPI.

## Fallback order

Use this order to minimize cost and ambiguity:

1. AT-SPI accessibility tree
2. Application API, D-Bus, or shell when appropriate
3. OCR when available
4. Screenshot and vision
5. Raw coordinates only after visually or semantically locating the target
