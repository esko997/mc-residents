#!/usr/bin/env bash
# Keep the real names of people who play on the server out of the published
# repository. Residents' notes are imported from the hosts as they wrote them,
# and tests like to borrow a familiar name, so this runs after every import
# and before every push.
#
#   tools/scrub-private-names.sh --check          exit 1 if a private name is in any tracked or new file
#   tools/scrub-private-names.sh --apply [path…]  replace them under the paths (default: the whole repository)
#
# The mapping is NOT in the repository: ~/.config/mc-residents/private-names
# (or $PRIVATE_NAMES_FILE), one "Real=Alias" per line, whole words; the name as
# written, ALL CAPS and all lower case are each matched and replaced in kind.
# Blank lines and # comments are ignored. Without that file --check fails
# rather than pass silently.
#
# Only this checkout is rewritten. The residents' own notes on their hosts stay
# true: a resident who met someone should still know their real name.
set -euo pipefail

mode=${1:-}; shift || true
map=${PRIVATE_NAMES_FILE:-$HOME/.config/mc-residents/private-names}
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root"

case $mode in --check|--apply) ;; *) echo "usage: $0 --check | --apply [path…]" >&2; exit 2 ;; esac
[ -r "$map" ] || { echo "private-names file not found: $map" >&2; exit 2; }

names=() aliases=()
while IFS='=' read -r real alias; do
  [[ -z $real || $real == \#* ]] && continue
  [[ $real =~ ^[A-Za-z0-9_]+$ && $alias =~ ^[A-Za-z0-9_]+$ ]] || { echo "bad line in $map (expected Real=Alias, letters, digits, _)" >&2; exit 2; }
  names+=("$real"); aliases+=("$alias")
done < "$map"
[ ${#names[@]} -gt 0 ] || { echo "no names in $map" >&2; exit 2; }

# Tracked files plus new ones that are not ignored; text files only.
pattern=(); for name in "${names[@]}"; do pattern+=(-e "$name"); done
list() { git ls-files -co --exclude-standard -z -- "$@" | xargs -0 -r grep -Ilwi "${pattern[@]}" -- 2>/dev/null || true; }

if [ "$mode" = --check ]; then
  found=$(list .)
  [ -z "$found" ] && { echo "no private names in the working tree (${#names[@]} checked)"; exit 0; }
  # Names are not echoed: only where to look.
  echo "private names found in:" >&2; echo "$found" | sed 's/^/  /' >&2
  exit 1
fi

changed=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  for i in "${!names[@]}"; do
    real=${names[$i]} alias=${aliases[$i]}
    sed -i "s/\\b${real}\\b/${alias}/g; s/\\b${real^^}\\b/${alias^^}/g; s/\\b${real,,}\\b/${alias,,}/g" -- "$file"
  done
  changed=$((changed + 1)); echo "  rewrote $file"
done < <(list "${@:-.}")
echo "$changed file(s) rewritten"
