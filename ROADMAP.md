# Roadmap

Goal: CI/CD that runs efficiently across **repositories**, **agents** and **devices**, with one set of rules and no
work repeated. Order matters: each phase uses what the one before it measured or built.

## Phase 0: measure (done)

- Scope decision per change (`actions/scope`), one install per job, drafts cost nothing.
- Every command is timed; the job summary shows where the minutes go (PR #1).
- Skip of already verified trees exists but only logs `WOULD SKIP` (shadow mode).

## Phase 1: stop re-running what passed (repositories)

| Item | Done when |
| --- | --- |
| Review shadow-mode logs on connected repos | Count of `WOULD SKIP` vs `run`, and the reasons, written down |
| Pilot `CI_SKIP_VERIFIED=1` on one repo | A merge push skips, `ci / check` stays green, a critical-path change still runs everything |
| Roll out to the other connected repos | Variable set everywhere; unsetting it is the rollback |
| Use the timing tables | Slowest commands per suite identified; path groups in `ci.json` narrowed where a suite is too broad |
| `usage.mjs` flags outdated callers | Report lists callers without concurrency, without `ready_for_review`, or not pinned to `@v1` |

## Phase 2: same checks locally (agents)

Status: built (`scripts/local.mjs`, `scripts/local.sh`, `onboard.sh --refresh`). Remaining: roll the refresh out to the connected repos once `v1` carries the local runner.

| Item | Done when |
| --- | --- |
| Local runner (`ci/local.mjs`) | Diffs against the default branch, imports `decide()` from `scope.mjs`, reads the commands from `ci.yml`, runs only the needed suites through `run.mjs` |
| Agent instructions point to it | `docs/agent-snippet.md` and the `onboard.sh` AGENTS block say "run the local runner, then push once" |
| `onboard.sh --refresh` | Updates the managed `ci:begin`/`ci:end` block in every connected repo without touching anything else |

Rule: a local pass is never CI proof. The skip keeps relying on the server-side `ci/verified-tree` status.

## Phase 3: every device (devices)

| Item | Done when |
| --- | --- |
| Windows works | Local runner and `onboard.sh` run in Git Bash on Windows, with a clear error when `bash` is missing |
| Tests for the local runner | Same fixtures as `scope.test.mjs`, proving local and CI scope agree |
| Fix stale references (done) | `templates/ci.yml.tpl` mention and the `scripts/ci/scope.mjs` path comment corrected |

## Phase 4: only if the numbers ask for it

- Self-hosted runners through the existing `runner` input, if billed minutes in `usage.mjs` remain the problem after Phase 1.
- Cross-run caching beyond `ui-cache-dir` and `backend-cache-dir`, guided by the timing tables.
- Python or other non-Node support in `onboard.sh` (today it stops without a `package.json`).

## Release handling

Fixes ship by moving the `v1` tag; a breaking change gets `v2`. Phases 1 to 3 are all compatible with `v1`.
