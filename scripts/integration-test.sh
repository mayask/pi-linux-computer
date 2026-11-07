#!/usr/bin/env bash
# End-to-end test against a real throwaway VM: create, drive GUI/terminal/browser, hand-off, copy,
# snapshot/revert, destroy. Needs KVM + libvirt on the host; builds the base image if missing.
set -euo pipefail
project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cli=(node "$project_dir/dist/cli.js")
export LINUX_COMPUTER_SCOPE="test:integration-$$"
work=$(mktemp -d)
# Isolated secrets metadata; keyring entries and approvals are removed on exit.
export LINUX_COMPUTER_CONFIG="$work/config/config.json"
secret="lc-test-$$/login"
value="Zq7-$RANDOM$RANDOM-vault-$$"
cleanup() {
  "${cli[@]}" secret rm "$secret" >/dev/null 2>&1 || true
  "${cli[@]}" destroy "$LINUX_COMPUTER_SCOPE" --yes >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
cd "$work"

# Everything a model would see (results, errors, progress) is appended to agent-visible.log.
tool() { "${cli[@]}" tool "$1" "${2:-"{}"}" 2>&1 | tee -a "$work/agent-visible.log"; }
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
terminal=$(grep -oP '\[\K[0-9/]+(?=\] terminal "Terminal")' <<<"$tree" | head -1)
expect "type into terminal" "type" "$(tool vm_act "{\"action\":\"type\",\"nodeId\":\"$terminal\",\"text\":\"printf \\\"CAPTURE_%s\\\\n\\\" OK; seq 1 500 | tail -1\\n\"}")"
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
mkdir -p site && cat > site/server.py <<'EOF'
import http.server, os, sys, urllib.parse
port, expected = int(sys.argv[1]), os.environ.get("EXPECTED", "")
FORM = b"<title>login</title><form method=post><input name=user placeholder=user><input type=password name=pw placeholder=password><button>Sign in</button></form>"
class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, body):
        self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self.reply(FORM)
    def do_POST(self):
        form = urllib.parse.parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
        ok = bool(expected) and form.get("pw", [""])[0] == expected
        self.reply(b"<title>result</title>" + (b"LOGIN OK" if ok else b"LOGIN FAILED"))
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
EOF
tool vm_copy '{"direction":"to_vm","source":"site","destination":"."}' >/dev/null
printf %s "$value" | "${cli[@]}" secret add "$secret" --username tester --origin http://127.0.0.1:8000 --app zenity --exec >/dev/null
expect "secrets listed without value" "user=tester" "$(tool vm_secrets '{"action":"list"}')"
expect "use needs approval" "needs the user's approval" "$(tool vm_exec "{\"command\":\"true\",\"secretEnv\":{\"EXPECTED\":\"$secret\"}}" || true)"
"${cli[@]}" secret approve "$secret" --scope "$LINUX_COMPUTER_SCOPE" --use exec >/dev/null
"${cli[@]}" secret approve "$secret" --scope "$LINUX_COMPUTER_SCOPE" --use browser:http://127.0.0.1:8000 >/dev/null
# Even an approval cannot widen a secret past its allowed origins.
"${cli[@]}" secret approve "$secret" --scope "$LINUX_COMPUTER_SCOPE" --use browser:http://127.0.0.1:8001 >/dev/null
tool vm_exec "{\"command\":\"python3 site/server.py 8000\",\"background\":true,\"secretEnv\":{\"EXPECTED\":\"$secret\"}}" >/dev/null
tool vm_exec '{"command":"python3 site/server.py 8001","background":true}' >/dev/null
expect "exec output scrubbed" "«secret:$secret»" "$(tool vm_exec "{\"command\":\"echo plain=\$EXPECTED; printf %s \\\"\$EXPECTED\\\" | base64\",\"secretEnv\":{\"EXPECTED\":\"$secret\"}}")"
sleep 1
tool vm_browser '{"action":"navigate","url":"http://127.0.0.1:8000/"}' >/dev/null
tool vm_browser '{"action":"fill","selector":"input[name=user]","text":"tester"}' >/dev/null
expect "fill secret on allowed origin" "filled" "$(tool vm_browser "{\"action\":\"fill\",\"selector\":\"input[name=pw]\",\"secret\":\"$secret\"}")"
expect "eval blocked after secret fill" "eval is disabled" "$(tool vm_browser '{"action":"eval","expression":"document.querySelector(\"input[name=pw]\").value"}' || true)"
tool vm_browser '{"action":"elements"}' >/dev/null
tool vm_observe '{"app":"chromium"}' >/dev/null
tool vm_browser '{"action":"click","selector":"button"}' >/dev/null
sleep 1
expect "login with secret succeeded" "LOGIN OK" "$(tool vm_browser '{"action":"text"}')"
tool vm_browser '{"action":"navigate","url":"http://127.0.0.1:8001/"}' >/dev/null
expect "other origin refused" "not allowed on http://127.0.0.1:8001" "$(tool vm_browser "{\"action\":\"fill\",\"selector\":\"input[name=pw]\",\"secret\":\"$secret\"}" || true)"

terminal_node=$(tool vm_observe '{"window":"lc-test","find":"terminal"}' | grep -oP '\[\K[0-9/]+(?=\] terminal)' | head -1)
expect "native app not on allow list refused" "not allowed in application" "$(tool vm_act "{\"action\":\"type\",\"nodeId\":\"$terminal_node\",\"secret\":\"$secret\"}" || true)"
"${cli[@]}" secret approve "$secret" --scope "$LINUX_COMPUTER_SCOPE" --use app:zenity >/dev/null
tool vm_exec '{"command":"zenity --password --title=lc-secret > ~/zenity.out","background":true}' >/dev/null
sleep 2
password_node=$(tool vm_observe '{"app":"zenity"}' | grep -oP '\[\K[0-9/]+(?=\] (password )?text "" editable)' | head -1)
expect "type secret into native password field" "«secret:$secret»" "$(tool vm_act "{\"action\":\"type\",\"nodeId\":\"$password_node\",\"secret\":\"$secret\"}")"
tool vm_act '{"action":"key","key":"Return"}' >/dev/null
sleep 1
expect "native app received the secret (scrubbed on read)" "«secret:$secret»" "$(tool vm_exec '{"command":"cat ~/zenity.out"}')"

encoded=$(printf %s "$value" | base64)
if grep -qF -e "$value" -e "$encoded" "$work/agent-visible.log"; then
  echo "FAIL secret value appeared in agent-visible output" >&2
  exit 1
fi
echo "ok   secret never in agent-visible output ($(wc -l <"$work/agent-visible.log") lines checked)"

# boot_id changes only on reboot; a resume from saved state keeps it (wall-clock uptime shifts).
boot_id() { "${cli[@]}" tool vm_exec '{"command":"cat /proc/sys/kernel/random/boot_id"}' 2>/dev/null | head -1; }
boot=$(boot_id)
"${cli[@]}" suspend "$LINUX_COMPUTER_SCOPE" >/dev/null
expect "resume keeps running state" "$boot" "$(boot_id)"

echo "integration test passed"
