#!/usr/bin/env bash
# Run the checks a change needs on this machine, with the same scope logic and runner as the shared pipeline.
#   gh api repos/vctrchappot/ci/contents/scripts/local.sh --jq .content | base64 -d | bash -s -- [--dry-run] [--full]
# or save this file and run it inside a connected repository. Needs: bash, git, node and an authenticated gh.
# CI_REF picks the version of vctrchappot/ci (default v1). The three files are cached for a day.
set -euo pipefail

CI_REPO="vctrchappot/ci"
ref="${CI_REF:-v1}"
dest="${XDG_CACHE_HOME:-$HOME/.cache}/vctrchappot-ci/$ref"
files="scripts/local.mjs actions/scope/scope.mjs actions/run/run.mjs"

stale=0
for f in $files; do
  [ -s "$dest/$f" ] && [ -z "$(find "$dest/$f" -mmin +1440 2>/dev/null)" ] || stale=1
done
if [ "$stale" = 1 ]; then
  command -v gh >/dev/null || { echo "local: gh is required to fetch the runner" >&2; exit 2; }
  for f in $files; do
    mkdir -p "$dest/$(dirname "$f")"
    gh api "repos/$CI_REPO/contents/$f?ref=$ref" --jq .content | base64 -d > "$dest/$f.tmp"
    mv "$dest/$f.tmp" "$dest/$f"
  done
fi
exec node "$dest/scripts/local.mjs" "$@"
