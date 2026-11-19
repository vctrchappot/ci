import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatSeconds, isComplete, splitCommands, summaryTable } from "../actions/run/run.mjs";

const script = fileURLToPath(new URL("../actions/run/run.mjs", import.meta.url));
const hasBash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
const options = { skip: !hasBash && "bash is not available" };

test("one command per line; blanks and comments are dropped", () => {
  const { commands, single } = splitCommands("pnpm lint\n\n  # not a command\npnpm test  \r\npnpm build");
  assert.deepEqual(commands, ["pnpm lint", "pnpm test", "pnpm build"]);
  assert.equal(single, false);
});

test("a trailing backslash joins the next line", () => {
  assert.deepEqual(splitCommands("pnpm test \\\n  --run\npnpm build").commands, ["pnpm test --run", "pnpm build"]);
});

test("commands that depend on each other stay one block", () => {
  for (const block of ["export A=1\npnpm test", "cd app\npnpm test", "FOO=bar\npnpm test", "set -x\npnpm test", "for f in a b; do\necho $f\ndone", "cat <<EOF\nx\nEOF"]) {
    assert.equal(splitCommands(block).single, true, block);
  }
  assert.equal(splitCommands("CI=1 pnpm test\nNODE_ENV=test pnpm build").single, false, "a prefix assignment belongs to its own command");
});

test("a line that is not a complete command is detected", options, () => {
  assert.equal(isComplete("pnpm lint && pnpm test"), true);
  assert.equal(isComplete("pnpm lint &&"), false);
  assert.equal(isComplete('echo "open'), false);
});

test("durations read naturally", () => {
  assert.equal(formatSeconds(0.04), "0.0 s");
  assert.equal(formatSeconds(3.26), "3.3 s");
  assert.equal(formatSeconds(41.4), "41 s");
  assert.equal(formatSeconds(292), "4 min 52 s");
  assert.equal(formatSeconds(120), "2 min 00 s");
});

test("the summary names every command with its result and escapes table syntax", () => {
  const table = summaryTable("ui", [
    { command: "pnpm build", seconds: 51.2, status: 0 },
    { command: "a | b", seconds: 3, status: 2 },
    { command: "pnpm landing:audit", seconds: null, status: null },
  ]);
  assert.match(table, /### ui: 54 s/);
  assert.match(table, /\| `pnpm build` \| 51 s \| passed \|/);
  assert.match(table, /\| `a \\\| b` \| 3\.0 s \| failed \(2\) \|/);
  assert.match(table, /\| `pnpm landing:audit` \| {2}\| not run \|/);
});

function run(commands) {
  const dir = mkdtempSync(join(tmpdir(), "ci-run-"));
  const summary = join(dir, "summary.md");
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, COMMANDS: commands, SUITE: "demo", GITHUB_STEP_SUMMARY: summary } });
  let written = "";
  try { written = readFileSync(summary, "utf8"); } catch { /* nothing written */ }
  return { ...result, summary: written };
}

test("commands run in order, each is timed and the summary lands in the job summary", options, () => {
  const result = run("echo one\necho two");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /▶ echo one[\s\S]*one[\s\S]*✓[\s\S]*▶ echo two/);
  assert.match(result.summary, /### demo/);
  assert.match(result.summary, /`echo one`.*passed/);
  assert.match(result.summary, /`echo two`.*passed/);
});

test("a failing command stops the suite, keeps its exit code and marks the rest as not run", options, () => {
  const result = run("echo one\nexit 3\necho never");
  assert.equal(result.status, 3);
  assert.doesNotMatch(result.stdout, /^never$/m);
  assert.match(result.stdout, /::error title=demo failed::exit 3 exited with 3/);
  assert.match(result.summary, /`exit 3`.*failed \(3\)/);
  assert.match(result.summary, /`echo never`.*not run/);
});

test("a pipeline fails on its first failing part, as with bash -eo pipefail", options, () => {
  assert.equal(run("false | cat").status, 1);
});

test("dependent commands run as one block and still behave like before", options, () => {
  const result = run("export GREETING=hi\necho $GREETING");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /run as one block/);
  assert.match(result.stdout, /^hi$/m);
  assert.match(result.summary, /2 commands as one block/);
});

test("an empty command string is a no-op", options, () => {
  const result = run("  \n# only a comment\n");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No commands to run/);
});
