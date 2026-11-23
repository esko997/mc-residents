#!/usr/bin/env bash
# Generate on the consumer; only the printed hash record goes to the hub.
set -euo pipefail
if [[ $# != 3 ]]; then
  echo 'usage: new-commons-token.sh <token-file> <name> <resident|caretaker>' >&2
  exit 2
fi
python3 - "$@" <<'PY'
import hashlib, json, os, re, secrets, sys
path, name, role = sys.argv[1:]
if not re.fullmatch(r'\w{1,40}', name, flags=re.ASCII) or role not in ('resident', 'caretaker'):
    raise SystemExit('Invalid name or role')
if role == 'resident' and not re.fullmatch(r'\w{1,16}', name, flags=re.ASCII):
    raise SystemExit('Resident name must be a Minecraft player name')
path = os.path.expanduser(path)
os.makedirs(os.path.dirname(os.path.abspath(path)), mode=0o700, exist_ok=True)
token = secrets.token_urlsafe(32)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as target:
    os.fchmod(target.fileno(), 0o600)
    target.write(token)
    target.flush()
    os.fsync(target.fileno())
print(json.dumps({'name': name, 'role': role, 'sha256': hashlib.sha256(token.encode()).hexdigest()}))
PY
