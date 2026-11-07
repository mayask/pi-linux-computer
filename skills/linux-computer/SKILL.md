---
name: linux-computer
description: Use this session's private Linux desktop VM (Debian 13, XFCE, Firefox, Chromium) to build, run and test apps end to end through the vm_* tools — accessibility-tree observation, semantic input, OCR, DOM-level browser control, terminal capture, snapshots, and hand-off to the user. Use when asked to test a GUI or web app, operate a desktop, or work in an isolated Linux machine.
---

# Linux computer use

Every agent session owns one VM. It is created on the first vm_* call (a few seconds; the first base image build on a machine takes about two minutes), keeps its disk and running apps across turns and harness restarts, is suspended to disk when the session ends, and resumes exactly where it was. Subagents share their parent's VM. Nothing is deleted unless the user asks for `vm_lifecycle destroy`.

The user can watch the same screen live (`vm_lifecycle view`, opened automatically) and take part.

## Reading the screen (cheapest first)

1. `vm_exec` output for anything you started from the shell.
2. `vm_terminal_capture` for output in a visible terminal (tmux pane or Select All copy; never rerun the command).
3. `vm_browser text|elements|eval` for pages in Chromium.
4. `vm_observe` for any app: accessibility tree as text. Narrow it with `app`, `window`, `focusedWindow`, `find`.
5. `vm_screen_text` (OCR) for canvases, images, games, inaccessible widgets.
6. `vm_screenshot` only when appearance matters (layout, colors, rendering).

## Acting

- Take node ids from a fresh `vm_observe`; ids are paths and go stale when the UI changes.
- `vm_act click` is a real pointer click at the node's center; `invoke` runs the accessible action without the pointer (useful off-screen; some widgets ignore it). `set_text` replaces editable text; `type`/`key` send keystrokes.
- Observe again after every state change; re-observe right before anything destructive.
- Launch apps with `vm_exec background=true` (e.g. `firefox-esr URL`, `xfce4-terminal`, your built binary). Foreground commands that leave processes running never return.
- Web apps: `vm_browser open` starts Chromium; `elements` numbers interactive elements for `click`/`fill`; `eval` runs JavaScript. Firefox goes through `vm_observe`/`vm_act`.
- Move code with `vm_copy` (tar stream, `exclude` for node_modules/target/.git). Keep the host repo as the source of truth.

## Working with the user

Never fight the user for keyboard and mouse. When the user should try something in the VM:

1. Agree on it in chat.
2. `vm_control to=user message="what to check"` (optionally `waitSeconds`). The VM shows a dialog; agent input is refused until control returns.
3. The user clicks "Hand back to agent" in the VM, or tells you in chat; then `vm_control to=agent`.
4. Observe before acting again: the screen may have changed.

## Safety nets

- `vm_lifecycle snapshot name=...` before risky steps; `revert` to undo (disk and memory).
- USB passthrough (`usb_list`, `usb_attach device=vendor:product`) takes the device away from the host; ask first.
