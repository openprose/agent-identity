#!/bin/bash
# Show how this instance differs from the template release it is based on, and
# fail if anything but instance configuration has drifted. Run in an instance
# repo with the template as the `upstream` remote (see UPGRADING.md):
#
#   scripts/upstream-diff.sh             # compare with upstream/main
#   scripts/upstream-diff.sh v0.2.0      # compare with the release tag you merged
#
# Instance-only files (never present in the template) are listed in
# INSTANCE_FILES; everything else should match the template after a merge.
# Code changes belong in the template, then flow down with a merge.
set -euo pipefail
INSTANCE_FILES=(worker/wrangler.toml INSTANCE.md)
base=${1:-upstream/main}
git fetch --quiet --tags upstream
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "unknown ref: $base" >&2; exit 2; }
drift=()
while IFS= read -r path; do
  keep=""
  for allowed in "${INSTANCE_FILES[@]}"; do [ "$path" = "$allowed" ] && keep=1; done
  [ -n "$keep" ] || drift+=("$path")
done < <(git diff --name-only "$base" HEAD)
behind=$(git rev-list --count "HEAD..upstream/main" 2>/dev/null || echo "?")
echo "template commits on upstream/main not yet merged: $behind"
if [ "${#drift[@]}" -gt 0 ]; then
  echo "files that differ from $base (move these changes upstream, or merge $base):"
  printf '  %s\n' "${drift[@]}"
  exit 1
fi
echo "only instance configuration differs from $base."
