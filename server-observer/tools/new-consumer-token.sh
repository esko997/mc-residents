#!/usr/bin/env bash
# Creates one observer consumer credential.
#   new-consumer-token.sh <token-file> <consumer-name> <scope>[,<scope>...] [resident]
# Writes a random token (mode 0600, refuses to overwrite) to <token-file> on the machine that
# will USE it, and prints the JSON consumer entry for config/resident_observer.json on the server.
# The server stores only the sha256; the token itself never appears in output or in the config.
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $0 <token-file> <consumer-name> <scopes: residents,facilities,library,status | self> [resident-name]" >&2
  exit 2
fi
file=$1 name=$2 scopes=$3 resident=${4:-}

[[ $name =~ ^[A-Za-z0-9_-]{1,32}$ ]] || { echo "consumer name: 1-32 of A-Z a-z 0-9 _ -" >&2; exit 2; }
IFS=, read -r -a list <<<"$scopes"
for s in "${list[@]}"; do
  case $s in residents|facilities|library|status|self) ;; *) echo "unknown scope: $s" >&2; exit 2;; esac
done
if [[ ",$scopes," == *,self,* ]]; then
  [[ -n $resident ]] || { echo "scope self needs a resident name" >&2; exit 2; }
  [[ ",$scopes," != *,residents,* && ",$scopes," != *,facilities,* && ",$scopes," != *,library,* ]] || { echo "self cannot be combined with residents/facilities/library" >&2; exit 2; }
elif [[ -n $resident ]]; then
  echo "a resident name is only allowed with scope self" >&2; exit 2
fi
[[ ! -e $file ]] || { echo "$file exists; refusing to overwrite" >&2; exit 1; }

umask 077
mkdir -p "$(dirname "$file")"
token=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
printf '%s\n' "$token" >"$file"
chmod 600 "$file"
hash=$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)
unset token

json_scopes=$(printf '"%s",' "${list[@]}"); json_scopes=${json_scopes%,}
if [[ -n $resident ]]; then
  printf '{ "name": "%s", "tokenSha256": "%s", "scopes": [%s], "resident": "%s" }\n' "$name" "$hash" "$json_scopes" "$resident"
else
  printf '{ "name": "%s", "tokenSha256": "%s", "scopes": [%s] }\n' "$name" "$hash" "$json_scopes"
fi
echo "token written to $file (0600); add the line above to the server's consumers list" >&2
