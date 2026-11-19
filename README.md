# ci

One shared GitHub Actions pipeline for Node repositories. Each repository keeps a ~20 line caller and a path policy; the
logic (which checks a change needs, when a push to the default branch can skip work, the single gate to require) lives here.
This repository is public and holds no secrets, so private repositories of the same account can call it without any setup.

## What it does

- **Scope:** `.github/ci.json` in the calling repo maps path groups to suites (`verify`, `ui`, `backend`). Critical paths
  (workflows, lockfiles, rules, auth) and files nobody classified run everything. Any error in the scope step runs everything.
- **One install per job, one build per run.** Suites replace many small jobs that each installed and built.
- **Skip what already passed:** a pull request records the tree it tested (commit status `ci/verified-tree`). The push to the
  default branch after the merge skips its suites only if that exact tree passed, the previous commit's gate was green and no
  critical path changed. Off until the repository variable `CI_SKIP_VERIFIED=1`; before that it logs `WOULD SKIP` and runs everything.
- **Drafts cost nothing.** Marking a pull request ready runs the checks.
- **Force everything:** label `ci:full` or repository variable `CI_FULL=1`.
- **One result to require:** `ci / check` (required on a branch protection rule, which a private repository only gets with GitHub Pro).

## Connect a repository

```bash
# inside a working tree (new repositories, or an existing clone): writes the files, you commit them
gh api repos/vctrchappot/ci/contents/scripts/onboard.sh --jq .content | base64 -d | bash -s -- --dir .

# an existing repository on GitHub: clones, writes the files on branch ci/onboard, opens a pull request
gh api repos/vctrchappot/ci/contents/scripts/onboard.sh --jq .content | base64 -d | bash -s -- vctrchappot/<name>
```

It detects pnpm, yarn or npm and the usual scripts (`format:check`, `lint`, `typecheck`, `test`, `build`), writes
`.github/workflows/ci.yml`, a safe default `.github/ci.json` (everything runs until you narrow the groups) and a note for coding
agents in `AGENTS.md` (and `CLAUDE.md` when it exists). It never deletes existing workflows; it lists the ones that now duplicate it.

## Files

| Path | Purpose |
| --- | --- |
| `.github/workflows/node-app.yml` | the reusable workflow: scope, verify, ui, backend, check |
| `actions/scope` | decides the suites (`scope.mjs`, no dependencies) |
| `actions/setup` | Node, package manager cache, locked install (pnpm, yarn or npm) |
| `actions/gate` | fails on failed or cancelled suites, records the verified tree |
| `examples/randr.ci.json` | a real policy, also the fixture of the tests |
| `scripts/onboard.sh` | connect a repository |
| `scripts/usage.mjs` | Actions minutes per private repository and which ones are not connected |
| `docs/agent-snippet.md` | two lines for your user-level agent instructions |

## Policy file

```json
{
  "version": 1,
  "ignore": ["docs/**", "**/*.md", "!CHANGELOG.md"],
  "critical": [".github/**", "package.json", "pnpm-lock.yaml"],
  "verifyOnly": ["tests/*.test.mjs"],
  "suites": { "verify": ["**"], "ui": ["app/**", "components/**"], "backend": ["functions/**"] }
}
```

Globs: `**` crosses folders, `*` and `?` stay in one, `{a,b}` alternates, a leading `!` takes files back out. A changed file that is
neither in `verifyOnly` nor in a `ui`/`backend` group counts as unclassified and runs every suite. A suite without a command in the
caller is skipped.

## Versions and rollback

Callers pin `@v1`. Fixes are released by moving the `v1` tag; breaking changes get `v2`. To roll every repository back, move `v1`
to the previous commit. Third-party actions are pinned to exact versions.

## Usage report

```bash
node scripts/usage.mjs --days 7
```

Needs an authenticated `gh`. "billed" rounds each job up to a whole minute (the usual billing behaviour; not stated in the
current docs), "raw" is the real run time.

## Limits

- A personal account cannot force repositories to use this; every repository opts in with its caller. The usage report lists
  the ones that did not.
- The skip helps only when the pull request was up to date with the default branch when it merged.
- Anyone who can push to a repository could post a fake `ci/verified-tree` status, which is no wider than their right to push.
- Self-test: `npm test` (scope logic). The workflows themselves are exercised by the repositories that call them.
