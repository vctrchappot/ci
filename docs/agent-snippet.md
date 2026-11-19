# Agent snippet

Paste this into your **user-level** agent instructions, so an agent that starts in an empty folder or a repository
that has no CI yet still knows the pipeline:

- Claude Code: `~/.claude/CLAUDE.md`
- Codex: `~/.codex/AGENTS.md`
- Cursor: Settings > Rules > User Rules

```markdown
## CI

For a Node repository without `.github/workflows/ci.yml` calling `vctrchappot/ci`, run once in the repository root:
`gh api repos/vctrchappot/ci/contents/scripts/onboard.sh --jq .content | base64 -d | bash -s -- --dir .`
and commit the files it writes. Push once per goal, open pull requests as drafts, mark them ready when done.
Run the project's own checks locally first. Details: https://github.com/vctrchappot/ci
```

Repositories that were connected by `onboard.sh` already carry the same rules in their `AGENTS.md`, so this snippet only
matters for repositories that are not connected yet.
