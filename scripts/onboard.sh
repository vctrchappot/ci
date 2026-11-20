#!/usr/bin/env bash
# Connect a Node repository to the shared CI pipeline (vctrchappot/ci).
#
#   onboard.sh --dir .            write the files into this working tree (new repos, or inside an existing clone)
#   onboard.sh owner/name         clone the repository, write the files on branch ci/onboard and open a pull request
#   add --force to overwrite an existing .github/workflows/ci.yml or .github/ci.json
#   add --refresh to only update the CI note (the ci:begin block) in AGENTS.md / CLAUDE.md of an already connected repository
#
# Needs: bash, git, node. The remote mode also needs an authenticated gh. Nothing is deleted: existing workflows stay.
# Without a clone:  gh api repos/vctrchappot/ci/contents/scripts/onboard.sh --jq .content | base64 -d | bash -s -- --dir .
set -euo pipefail

CI_REPO="vctrchappot/ci"
CI_REF="v1"

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "onboard: $*" >&2; exit 1; }

dir=""; repo=""; force=0; refresh=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="${2:-}"; shift 2 ;;
    --force) force=1; shift ;;
    --refresh) refresh=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) repo="$1"; shift ;;
  esac
done
[ -n "$dir" ] || [ -n "$repo" ] || { usage; exit 2; }
command -v node >/dev/null || die "node is required"

AGENTS_BLOCK='<!-- ci:begin (managed by vctrchappot/ci scripts/onboard.sh) -->

## CI

This repository runs its checks through the shared pipeline in `vctrchappot/ci` (`.github/workflows/ci.yml` calls it).

- Run the checks locally before you push; do not rely on CI to find problems. `gh api repos/vctrchappot/ci/contents/scripts/local.sh --jq .content | base64 -d | bash -s --` runs only the suites this change needs (add `--dry-run` to see the plan). A local pass does not replace `ci / check`.
- Push once per goal. Open pull requests as drafts and mark them ready when the work is done: drafts cost no CI minutes.
- Which suites run is decided by `.github/ci.json` (path groups and critical paths). A file or folder nobody classified runs everything; add it to a suite there.
- Do not edit the shared workflow logic in this repository. Change `.github/ci.json` or the commands in `.github/workflows/ci.yml`, or change `vctrchappot/ci`.
- Label `ci:full` (or the repository variable `CI_FULL=1`) forces every suite. The result to require on a branch is `ci / check`.
<!-- ci:end -->'

# write_notes <dir> <any|existing>: the agent-facing note. AGENTS.md always (CLAUDE.md too when it exists and does not
# just import AGENTS.md); with "existing" only files that already carry the managed block, and nothing else is touched.
write_notes() {
  local root="$1" mode="$2" target before
  noted=0
  for target in "$root/AGENTS.md" "$root/CLAUDE.md"; do
    if [ "$mode" = existing ]; then
      [ -f "$target" ] && grep -q 'ci:begin' "$target" || continue
    elif [ "$target" != "$root/AGENTS.md" ] && ! { [ -f "$target" ] && ! grep -q '@AGENTS.md' "$target"; }; then
      continue
    fi
    before="$(cat "$target" 2>/dev/null || true)"
    BLOCK="$AGENTS_BLOCK" node -e '
      const fs = require("fs"), f = process.argv[1], block = process.env.BLOCK;
      const old = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      const re = /<!-- ci:begin[\s\S]*?<!-- ci:end -->/;
      fs.writeFileSync(f, re.test(old) ? old.replace(re, () => block) : (old ? old.replace(/\n*$/, "\n\n") : "") + block + "\n");
    ' "$target"
    if [ "$before" = "$(cat "$target")" ]; then echo "onboard: the CI note in $(basename "$target") is already current"
    else echo "onboard: updated the CI note in $(basename "$target")"; fi
    noted=1
  done
}

# write_files <dir> <default-branch>
write_files() {
  local root="$1" branch="$2"
  [ -f "$root/package.json" ] || die "no package.json in $root: only Node projects are supported so far"
  mkdir -p "$root/.github/workflows"

  # package manager and which of the usual scripts exist
  local pm run
  if [ -f "$root/pnpm-lock.yaml" ]; then pm=pnpm; run="pnpm"
  elif [ -f "$root/yarn.lock" ]; then pm=yarn; run="yarn"
  else pm=npm; run="npm run"; fi
  has_script() { node -e 'const s=require(process.argv[1]).scripts||{};process.exit(s[process.argv[2]]?0:1)' "$root/package.json" "$1"; }

  local verify="" ui=""
  for s in format:check lint typecheck test; do
    has_script "$s" && verify="${verify}        ${run} ${s}"$'\n'
  done
  if [ -z "$verify" ]; then
    echo "onboard: warning: no format:check, lint, typecheck or test script in package.json; edit the verify commands" >&2
    verify="        echo 'add the checks of this project here'"$'\n'
  fi
  has_script build && ui="      ui: |"$'\n'"        ${run} build"$'\n'

  # What the existing workflows do that the new caller would silently drop: the Node version, and package.json scripts
  # they run that are not among the commands above (end-to-end tests, export builds, ...).
  local covered="build" detected nodever uncovered todo="" nodeline=""
  for s in format:check lint typecheck test; do has_script "$s" && covered="$covered $s"; done
  detected="$(node - "$root" $covered <<'JS'
const fs = require("fs"), path = require("path");
const [root, ...covered] = process.argv.slice(2);
const scripts = Object.keys(require(path.join(root, "package.json")).scripts || {});
const dir = path.join(root, ".github/workflows");
let text = "";
if (fs.existsSync(dir)) {
  for (const file of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const body = fs.readFileSync(path.join(dir, file), "utf8");
    // Our own caller (from an earlier run) is not "an old workflow".
    if (!body.includes("vctrchappot/ci/.github/workflows/")) text += body + "\n";
  }
}
const used = new Set();
for (const m of text.matchAll(/\b(?:npm run|npm|pnpm run|pnpm|yarn run|yarn)\s+([\w:.-]+)/g)) used.add(m[1]);
console.log((text.match(/node-version:\s*["']?(\d+)/) || [])[1] || "");
console.log([...used].filter((name) => scripts.includes(name) && !covered.includes(name)).join(" "));
JS
)"
  nodever="$(printf '%s\n' "$detected" | sed -n 1p)"
  uncovered="$(printf '%s\n' "$detected" | sed -n 2p)"
  [ -n "$nodever" ] && [ "$nodever" != 22 ] && nodeline="      node-version: \"${nodever}\""$'\n'
  if [ -n "$uncovered" ]; then
    todo="# TODO(onboard): the old workflows also ran these scripts, which are not covered below: ${uncovered}. Add them to verify, ui or backend."
    echo "onboard: warning: existing workflows run scripts the new caller does not: ${uncovered}. Add them to ci.yml before removing the old workflow." >&2
  fi

  local workflow="$root/.github/workflows/ci.yml" policy="$root/.github/ci.json"
  if [ -f "$workflow" ] && [ "$force" = 0 ]; then
    echo "onboard: $workflow exists, left alone (use --force to replace it)" >&2
  else
    cat >"$workflow" <<EOF
name: CI

# Thin caller: the logic lives in ${CI_REPO}. Edit the commands below or .github/ci.json, not the shared workflow.
# The result to require on a branch is \`ci / check\`.
${todo}
on:
  push:
    branches: [${branch}]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  checks: read
  pull-requests: read
  statuses: write

concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    uses: ${CI_REPO}/.github/workflows/node-app.yml@${CI_REF}
    with:
      default-branch: ${branch}
${nodeline}      verify: |
${verify}${ui}
EOF
    # drop the blank line the heredoc leaves when there is no ui block
    node -e 'const f=process.argv[1],fs=require("fs");fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/\n+$/,"\n"))' "$workflow"
  fi

  if [ -f "$policy" ] && [ "$force" = 0 ]; then
    echo "onboard: $policy exists, left alone" >&2
  else
    # Safe default: every non-docs change runs every suite. Narrow it once you know the project's layout.
    cat >"$policy" <<'EOF'
{
  "version": 1,
  "ignore": ["docs/**", "**/*.md", "!CHANGELOG.md"],
  "critical": [".github/**", "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"],
  "verifyOnly": [],
  "suites": {
    "verify": ["**"],
    "ui": ["**"],
    "backend": ["**"]
  }
}
EOF
  fi

  write_notes "$root" any

  echo "onboard: wrote .github/workflows/ci.yml, .github/ci.json and the CI note (package manager: $pm)"
  local other
  other="$(ls "$root/.github/workflows" 2>/dev/null | grep -v '^ci\.yml$' || true)"
  if [ -n "$other" ]; then
    echo "onboard: these workflows still run next to the shared pipeline; remove the ones that now duplicate it:" >&2
    echo "$other" | sed 's/^/  - /' >&2
  fi
}

if [ -n "$dir" ]; then
  [ -d "$dir" ] || die "$dir is not a directory"
  root="$(cd "$dir" && pwd)"
  if [ "$refresh" = 1 ]; then
    write_notes "$root" existing
    [ "$noted" = 1 ] || echo "onboard: no CI note found in AGENTS.md or CLAUDE.md; run without --refresh to connect this repository"
    exit 0
  fi
  branch="$(git -C "$root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
  [ -n "$branch" ] || branch="$(git -C "$root" branch --show-current 2>/dev/null || true)"
  write_files "$root" "${branch:-main}"
  echo "onboard: review the files and commit them with your change."
  exit 0
fi

command -v gh >/dev/null || die "gh is required for the remote mode"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
gh repo clone "$repo" "$work/repo" -- --quiet
branch="$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name)"
if [ "$refresh" = 1 ]; then
  git -C "$work/repo" checkout -q -b ci/refresh-note
  write_notes "$work/repo" existing
  [ "$noted" = 1 ] || die "$repo has no CI note to refresh; run without --refresh to connect it"
  git -C "$work/repo" diff --quiet && { echo "onboard: the CI note of $repo is already current"; exit 0; }
  git -C "$work/repo" commit -q -am "Update the CI note for coding agents

Refreshed from https://github.com/${CI_REPO} (scripts/onboard.sh --refresh). Only the managed ci:begin block changed."
  git -C "$work/repo" push -q -u origin ci/refresh-note
  gh pr create --repo "$repo" --base "$branch" --head ci/refresh-note --draft     --title "Update the CI note for coding agents"     --body "Refreshes the managed CI block in AGENTS.md / CLAUDE.md from [${CI_REPO}](https://github.com/${CI_REPO}). Nothing else changes."
  exit 0
fi
git -C "$work/repo" checkout -q -b ci/onboard
write_files "$work/repo" "$branch"
git -C "$work/repo" add -A
git -C "$work/repo" diff --cached --quiet && die "nothing to commit: $repo already looks onboarded"
git -C "$work/repo" commit -q -m "Run the checks through the shared CI pipeline

Adds the thin caller workflow, .github/ci.json and an AGENTS.md note. See https://github.com/${CI_REPO}."
git -C "$work/repo" push -q -u origin ci/onboard
gh label create ci:full --repo "$repo" --color BFD4F2 --description "Force every CI suite" --force >/dev/null
gh pr create --repo "$repo" --base "$branch" --head ci/onboard \
  --title "Run the checks through the shared CI pipeline" \
  --body "Adds the thin caller for [${CI_REPO}](https://github.com/${CI_REPO}), a default \`.github/ci.json\` (every non-docs change runs every suite until you narrow the path groups) and an AGENTS.md note for coding agents.

Check the commands in \`.github/workflows/ci.yml\`, and remove old workflows that now duplicate it. The branch protection to require \`ci / check\` needs GitHub Pro on a private repository."
