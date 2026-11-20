import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "../actions/scope/scope.mjs";
import { changedSince, parseCaller, plan } from "../scripts/local.mjs";

const script = fileURLToPath(new URL("../scripts/local.mjs", import.meta.url));
const policy = JSON.parse(readFileSync(new URL("../examples/randr.ci.json", import.meta.url), "utf8"));
const hasBash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";

const CALLER = `name: CI
on:
  push:
    branches: [main]
jobs:
  ci:
    uses: vctrchappot/ci/.github/workflows/node-app.yml@v1
    with:
      default-branch: main
      node-version: "20"
      verify: |
        pnpm lint
        # a comment
        pnpm test
      ui: |
        pnpm build
      backend: ""
  other:
    runs-on: ubuntu-latest
    steps:
      - run: echo unrelated
`;

test("the caller's commands and inputs are read from the workflow", () => {
  const caller = parseCaller(CALLER);
  assert.equal(caller.defaultBranch, "main");
  assert.equal(caller.inputs["node-version"], "20");
  assert.equal(caller.commands.verify, "pnpm lint\n# a comment\npnpm test");
  assert.equal(caller.commands.ui, "pnpm build");
  assert.equal("backend" in caller.commands, false, "an empty suite has no command");
});

test("with: may come before uses:, and a plain scalar command works", () => {
  const caller = parseCaller(`jobs:\n  ci:\n    with:\n      verify: pnpm lint && pnpm test\n    uses: vctrchappot/ci/.github/workflows/node-app.yml@v1\n`);
  assert.equal(caller.commands.verify, "pnpm lint && pnpm test");
});

test("a workflow that does not call the shared pipeline is not a caller", () => {
  assert.equal(parseCaller("jobs:\n  x:\n    runs-on: ubuntu-latest\n"), null);
});

test("the plan matches the scope decision and leaves out suites without a command", () => {
  const commands = { verify: "a", ui: "b" };
  const files = ["app/page.tsx"];
  const rows = plan({ files, policy, commands, force: false });
  const expected = decide(files, policy).suites;
  assert.deepEqual(
    rows.map((row) => [row.name, row.run]),
    [["verify", expected.verify], ["ui", expected.ui], ["backend", false]],
  );
  assert.match(rows.find((row) => row.name === "backend").why, /no command/);
});

test("a critical path or an unknown base runs everything that has a command", () => {
  const commands = { verify: "a", ui: "b", backend: "c" };
  assert.ok(plan({ files: ["pnpm-lock.yaml"], policy, commands }).every((row) => row.run));
  assert.ok(plan({ files: null, policy, commands }).every((row) => row.run));
  assert.ok(plan({ files: ["README.md"], policy, commands }).every((row) => !row.run), "docs only runs nothing");
});

test("--full forces every suite with a command", () => {
  assert.ok(plan({ files: ["README.md"], policy, commands: { verify: "a", ui: "b" }, force: true }).filter((row) => row.run).length === 2);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ci-local-"));
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), CALLER.replace('verify: |\n        pnpm lint\n        # a comment\n        pnpm test', 'verify: |\n        echo verify-ran').replace("pnpm build", "echo ui-ran"));
  writeFileSync(
    join(dir, ".github", "ci.json"),
    JSON.stringify({ version: 1, ignore: ["**/*.md"], critical: [".github/**"], verifyOnly: ["lib/**"], suites: { verify: ["**"], ui: ["app/**"], backend: ["functions/**"] } }),
  );
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "a.js"), "1");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  return { dir, git };
}

test("changes since the default branch include commits, edits and new files", () => {
  const { dir, git } = repo();
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "page.tsx"), "x");
  git("add", "-A");
  git("commit", "-q", "-m", "page");
  writeFileSync(join(dir, "lib", "a.js"), "2");
  writeFileSync(join(dir, "lib", "new.js"), "3");
  const change = changedSince(dir, { defaultBranch: "main" });
  assert.deepEqual(change.files.sort(), ["app/page.tsx", "lib/a.js", "lib/new.js"]);
});

const local = (dir, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });

test("a change that only touches lib/ runs verify and leaves ui out", { skip: !hasBash && "bash is not available" }, () => {
  const { dir } = repo();
  writeFileSync(join(dir, "lib", "a.js"), "2");
  const result = local(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /run\s+verify/);
  assert.match(result.stdout, /skip\s+ui\s+not needed/);
  assert.match(result.stdout, /verify-ran/);
  assert.doesNotMatch(result.stdout, /ui-ran/);
});

test("--dry-run prints the plan and runs nothing", () => {
  const { dir } = repo();
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "page.tsx"), "x");
  const result = local(dir, "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /run\s+ui/);
  assert.doesNotMatch(result.stdout, /ui-ran/);
});

test("a failing suite stops the run with its exit code", { skip: !hasBash && "bash is not available" }, () => {
  const { dir } = repo();
  const file = join(dir, ".github", "workflows", "ci.yml");
  writeFileSync(file, readFileSync(file, "utf8").replace("echo verify-ran", "exit 4"));
  writeFileSync(join(dir, "lib", "a.js"), "2");
  const result = local(dir, "--full");
  assert.equal(result.status, 4);
  assert.match(result.stdout, /verify failed/);
  assert.doesNotMatch(result.stdout, /=== ui ===/);
});

test("outside a connected repository it explains what is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-local-none-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const result = local(dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no workflow/);
  assert.equal(local(dir, "--nope").status, 2);
});

