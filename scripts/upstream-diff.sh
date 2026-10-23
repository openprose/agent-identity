#!/bin/bash
# Show how this instance differs from the template it was made from, and fail
# if anything but instance configuration has drifted. Run in an instance repo
# with the template as the `upstream` remote:
#
#   git remote add upstream <template repo URL>   # once
#   scripts/upstream-diff.sh                       # before and after merging
#
# Instance-only files (never present in the template) are listed in
# INSTANCE_FILES; everything else should match upstream after a merge. Code
# changes belong in the template, then flow down with `git merge upstream/main`.
set -euo pipefail
INSTANCE_FILES=(worker/wrangler.toml INSTANCE.md)
remote=${1:-upstream}
git fetch --quiet "$remote"
base="$remote/main"
drift=()
while IFS= read -r path; do
  keep=""
  for allowed in "${INSTANCE_FILES[@]}"; do [ "$path" = "$allowed" ] && keep=1; done
  [ -n "$keep" ] || drift+=("$path")
done < <(git diff --name-only "$base" HEAD)
behind=$(git rev-list --count "HEAD..$base" 2>/dev/null || echo "?")
echo "template commits not yet merged: $behind"
if [ "${#drift[@]}" -gt 0 ]; then
  echo "files that differ from the template (move these changes upstream, or merge $base):"
  printf '  %s\n' "${drift[@]}"
  exit 1
fi
echo "only instance configuration differs from the template."
