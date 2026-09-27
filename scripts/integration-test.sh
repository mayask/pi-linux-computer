#!/usr/bin/env bash
set -euo pipefail

config="${PI_LINUX_COMPUTER_CONFIG:-$HOME/.config/pi-linux-computer/targets.json}"
project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

eval "$(python3 - "$config" <<'PY'
import json, os, shlex, sys
with open(os.path.expanduser(sys.argv[1]), encoding='utf-8') as f:
    raw=json.load(f)
targets=raw.get('targets', raw)
name=raw.get('defaultTarget') or next(iter(targets))
t=targets[name]
for key, value in {
    'TARGET_NAME': name,
    'HOST': t['host'],
    'PORT': str(t.get('port', 22)),
    'USER': t['user'],
    'KEY': os.path.expanduser(t['identityFile']),
    'KNOWN': os.path.expanduser(t['knownHostsFile']),
    'DISPLAY_VALUE': t['display'],
    'XAUTHORITY_VALUE': t['xauthority'],
    'DBUS_VALUE': t['dbusAddress'],
    'HELPER': t.get('helperPath', f"/home/{t['user']}/.local/share/pi-linux-computer/linux_computer.py"),
}.items(): print(f'{key}={shlex.quote(value)}')
PY
)"

ssh_args=(-i "$KEY" -p "$PORT" -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN" "$USER@$HOST")
remote_dir=${HELPER%/*}
ssh "${ssh_args[@]}" "umask 077; mkdir -p '$remote_dir'; cat > '$HELPER'; chmod 700 '$HELPER'" < "$project_dir/remote/linux_computer.py"
printf '%s' '{"operation":"ping","params":{}}' | ssh "${ssh_args[@]}" "DISPLAY='$DISPLAY_VALUE' XAUTHORITY='$XAUTHORITY_VALUE' DBUS_SESSION_BUS_ADDRESS='$DBUS_VALUE' python3 '$HELPER'"
printf '%s' '{"operation":"snapshot","params":{"maxDepth":8,"maxNodes":300,"includeText":true}}' | ssh "${ssh_args[@]}" "DISPLAY='$DISPLAY_VALUE' XAUTHORITY='$XAUTHORITY_VALUE' DBUS_SESSION_BUS_ADDRESS='$DBUS_VALUE' python3 '$HELPER'" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("snapshot revision={} nodes={} truncated={}".format(d["revision"], len(d["nodes"]), d["truncated"]))'
echo "integration test passed for $TARGET_NAME"
