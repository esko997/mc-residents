#!/usr/bin/env bash
# Keep the real names of people who play on the server out of the published
# repository. Residents' notes are imported from the hosts as they wrote them,
# and tests like to borrow a familiar name, so this runs after every import
# and before every push.
#
#   tools/scrub-private-names.sh --check          exit 1 if a private name is in any tracked or new file of the checkout
#   tools/scrub-private-names.sh --apply [path…]  replace them under the paths (default: the whole repository)
#   tools/scrub-private-names.sh --pre-push       as a git pre-push hook: reads "<ref> <sha> <remote ref> <remote sha>"
#                                                 lines on stdin and checks what the push would PUBLISH: every pushed
#                                                 tip's tree, and every line added by a commit the remote lacks
#
# --check looks at files, --pre-push at commits: a name that was committed and
# then removed only from the working files is still caught before it leaves.
#
# The mapping is NOT in the repository: ~/.config/mc-residents/private-names
# (or $PRIVATE_NAMES_FILE), one "Real=Alias" per line, whole words; the name as
# written, ALL CAPS and all lower case are each matched and replaced in kind.
# Blank lines and # comments are ignored. Without that file every mode fails
# rather than pass silently.
#
# Only this checkout is rewritten. The residents' own notes on their hosts stay
# true: a resident who met someone should still know their real name.
set -euo pipefail

mode=${1:-}; shift || true
map=${PRIVATE_NAMES_FILE:-$HOME/.config/mc-residents/private-names}
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root"

case $mode in --check|--apply|--pre-push) ;; *) echo "usage: $0 --check | --apply [path…] | --pre-push" >&2; exit 2 ;; esac
[ -r "$map" ] || { echo "private-names file not found: $map" >&2; exit 2; }

names=() aliases=()
while IFS='=' read -r real alias; do
  [[ -z $real || $real == \#* ]] && continue
  [[ $real =~ ^[A-Za-z0-9_]+$ && $alias =~ ^[A-Za-z0-9_]+$ ]] || { echo "bad line in $map (expected Real=Alias, letters, digits, _)" >&2; exit 2; }
  names+=("$real"); aliases+=("$alias")
done < "$map"
[ ${#names[@]} -gt 0 ] || { echo "no names in $map" >&2; exit 2; }

pattern=(); for name in "${names[@]}"; do pattern+=(-e "$name"); done
# Tracked files plus new ones that are not ignored; text files only.
list() { git ls-files -co --exclude-standard -z -- "$@" | xargs -0 -r grep -Ilwi "${pattern[@]}" -- 2>/dev/null || true; }

if [ "$mode" = --check ]; then
  found=$(list .)
  [ -z "$found" ] && { echo "no private names in the working tree (${#names[@]} checked)"; exit 0; }
  # Names are not echoed: only where to look.
  echo "private names found in:" >&2; echo "$found" | sed 's/^/  /' >&2
  exit 1
fi

if [ "$mode" = --pre-push ]; then
  zero=0000000000000000000000000000000000000000; bad=0
  while read -r _ref sha _remote_ref remote_sha; do
    [ -n "${sha:-}" ] && [ "$sha" != "$zero" ] || continue   # a deleted ref publishes nothing
    # 1. The tree at the pushed tip: what a visitor of that branch sees.
    in_tree=$(git grep -lIwi "${pattern[@]}" "$sha" -- 2>/dev/null | sed "s/^$sha://" || true)
    if [ -n "$in_tree" ]; then bad=1; echo "private names in the tree of ${sha:0:10}:" >&2; echo "$in_tree" | sed 's/^/  /' >&2; fi
    # 2. Lines added by commits the remote does not have yet (history is public too).
    if [ "$remote_sha" = "$zero" ]; then range=("$sha" --not --remotes); else range=("$remote_sha..$sha"); fi
    while read -r commit; do
      [ -n "$commit" ] || continue
      # Counted, not `grep -q`: under pipefail an early exit kills the producer and reads as "not found".
      added=$(git show --no-color --format= --unified=0 "$commit" | grep -a '^+' | grep -av '^+++ ' | grep -acwi "${pattern[@]}" || true)
      said=$(git show --no-color --no-patch --format=%B "$commit" | grep -acwi "${pattern[@]}" || true)
      if [ "${added:-0}" != 0 ] || [ "${said:-0}" != 0 ]; then
        bad=1; echo "private names added by commit ${commit:0:10} ($(git show --no-patch --format=%s "$commit" | cut -c1-60))" >&2
      fi
    done < <(git rev-list "${range[@]}")
  done
  [ "$bad" = 0 ] && exit 0
  echo "push refused: rewrite those commits (or the files) before publishing." >&2
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
