import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/onboard.sh", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const bash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
const options = { skip: bash.stdout?.trim() !== "ok" && "bash is not available" };

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "onboard-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
const onboard = (dir) => spawnSync("bash", [script, "--dir", dir], { encoding: "utf8" });

test("onboarding detects npm and the scripts that exist", options, () => {
  const dir = project({ "package.json": '{"scripts":{"lint":"x","test":"y","build":"z"}}', "package-lock.json": "" });
  assert.equal(onboard(dir).status, 0);
  const workflow = readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /node-app\.yml@v1/);
  assert.match(workflow, /npm run lint\n\s+npm run test/);
  assert.match(workflow, /ui: \|\n\s+npm run build/);
  assert.ok(!/format:check|typecheck/.test(workflow));
  assert.equal(JSON.parse(readFileSync(join(dir, ".github/ci.json"), "utf8")).version, 1);
  assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /ci:begin/);
});

test("onboarding twice changes nothing and keeps one note", options, () => {
  const dir = project({ "package.json": '{"scripts":{"test":"y"}}', "pnpm-lock.yaml": "", "CLAUDE.md": "# Mine\n" });
  onboard(dir);
  const first = readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8");
  onboard(dir);
  assert.equal(readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8"), first);
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    assert.equal(readFileSync(join(dir, file), "utf8").split("ci:begin").length - 1, 1, file);
  }
  assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf8"), /^# Mine/);
  assert.match(first, /pnpm test/);
});

test("a directory without package.json is refused and left untouched", options, () => {
  const dir = project({ "README.md": "x" });
  const result = onboard(dir);
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(join(dir, ".github")));
});

test("scripts an old workflow ran, and its Node version, are not silently dropped", options, () => {
  const dir = project({
    "package.json": '{"scripts":{"lint":"x","test":"y","e2e":"z"}}',
    "package-lock.json": "",
    ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n      - run: npm run e2e\n",
  });
  const result = spawnSync("bash", [script, "--dir", dir, "--force"], { encoding: "utf8" });
  assert.match(result.stderr, /do not: e2e/);
  const workflow = readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /TODO\(onboard\).*e2e/);
  assert.match(workflow, /node-version: "24"/);
});
