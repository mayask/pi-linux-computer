#!/usr/bin/env bash
# End-to-end test against a real throwaway VM: create, drive GUI/terminal/browser, hand-off, copy,
# snapshot/revert, destroy. Needs KVM + libvirt on the host; builds the base image if missing.
set -euo pipefail
project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cli=(node "$project_dir/dist/cli.js")
export LINUX_COMPUTER_SCOPE="test:integration-$$"
work=$(mktemp -d)
cleanup() {
  "${cli[@]}" destroy "$LINUX_COMPUTER_SCOPE" --yes >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
cd "$work"

tool() { "${cli[@]}" tool "$1" "${2:-"{}"}" 2>/dev/null; }
expect() {
  local name=$1 needle=$2 output=$3
  if [[ "$output" != *"$needle"* ]]; then
    printf 'FAIL %s: expected %q in:\n%s\n' "$name" "$needle" "$output" >&2
    exit 1
  fi
  echo "ok   $name"
}

npm --prefix "$project_dir" run --silent build
expect "boot on demand" "state: running" "$(tool vm_lifecycle '{"action":"start"}')"
expect "guest network" "200" "$(tool vm_exec '{"command":"curl -s -o /dev/null -w %{http_code} https://deb.debian.org/"}')"

tool vm_exec '{"command":"xfce4-terminal --title=lc-test","background":true}' >/dev/null
sleep 3
tree=$(tool vm_observe '{"window":"lc-test"}')
expect "accessibility tree" 'terminal "Terminal"' "$tree"
expect "type into terminal" "type" "$(tool vm_act '{"action":"type","text":"printf \"CAPTURE_%s\\n\" OK; seq 1 500 | tail -1\n"}')"
sleep 1
capture=$(tool vm_terminal_capture '{"strategy":"clipboard"}')
expect "terminal capture output" "CAPTURE_OK" "$capture"
expect "terminal capture scrollback" "500" "$capture"
expect "ocr" "CAPTURE_OK" "$(tool vm_screen_text)"

tool vm_browser '{"action":"open","url":"data:text/html,<title>lc</title><button onclick=\"document.title=1+1\">Add</button>"}' >/dev/null
elements=$(tool vm_browser '{"action":"elements"}')
expect "browser elements" '[0] button "Add"' "$elements"
tool vm_browser '{"action":"click","element":0}' >/dev/null
expect "browser click + eval" "2" "$(tool vm_browser '{"action":"eval","expression":"document.title"}')"

expect "hand to user" "The user has control" "$(tool vm_control '{"to":"user","message":"integration test"}')"
expect "input blocked for agent" "user has control" "$("${cli[@]}" tool vm_act '{"action":"key","key":"Escape"}' 2>&1 || true)"
expect "observe allowed" "control: USER" "$(tool vm_observe '{"maxNodes":20}')"
expect "hand back" "The agent has control" "$(tool vm_control '{"to":"agent"}')"

mkdir -p src && echo payload > src/file.txt
tool vm_copy '{"direction":"to_vm","source":"src","destination":"copied"}' >/dev/null
tool vm_copy '{"direction":"from_vm","source":"copied/src","destination":"back"}' >/dev/null
expect "copy round trip" "payload" "$(cat back/src/file.txt)"

tool vm_lifecycle '{"action":"snapshot","name":"before"}' >/dev/null
tool vm_exec '{"command":"rm -rf copied"}' >/dev/null
tool vm_lifecycle '{"action":"revert","name":"before"}' >/dev/null
expect "snapshot revert" "file.txt" "$(tool vm_exec '{"command":"ls copied/src"}')"

boot=$(tool vm_exec '{"command":"uptime -s"}')
"${cli[@]}" suspend "$LINUX_COMPUTER_SCOPE" >/dev/null
expect "resume keeps running state" "$(head -1 <<<"$boot")" "$(tool vm_exec '{"command":"uptime -s"}')"

echo "integration test passed"
