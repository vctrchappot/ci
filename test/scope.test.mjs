import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decide, globToRegExp, matches } from "../actions/scope/scope.mjs";

const policy = JSON.parse(readFileSync(new URL("../examples/randr.ci.json", import.meta.url), "utf8"));
const run = (...files) => decide(files, policy);
const on = (result) =>
  Object.entries(result.suites)
    .filter(([, value]) => value)
    .map(([name]) => name)
    .sort()
    .join(",");

test("globs: ** crosses folders, * does not, braces alternate", () => {
  assert.ok(globToRegExp("docs/**").test("docs/a/b.md"));
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(globToRegExp("**/*.md").test("a/b/c.md"));
  assert.ok(!globToRegExp("tests/*.mjs").test("tests/a/b.mjs"));
  assert.ok(globToRegExp("tests/{a,b}.mjs").test("tests/b.mjs"));
  assert.ok(!globToRegExp("a.b").test("axb"));
});

test("globs: a later negation takes a file back out", () => {
  assert.ok(matches("docs/x.md", ["**/*.md"]));
  assert.ok(!matches("CHANGELOG.md", ["**/*.md", "!CHANGELOG.md"]));
});

test("documentation only runs nothing", () => {
  assert.equal(on(run("docs/roadmap.md", "README.md")), "");
});

test("the changelog is code, because the build reads it", () => {
  assert.equal(on(run("CHANGELOG.md")), "ui,verify");
});

test("frontend only skips the backend suite", () => {
  assert.equal(on(run("app/page.tsx", "components/button.tsx")), "ui,verify");
});

test("functions only skip the UI suite", () => {
  assert.equal(on(run("functions/proposals.js")), "backend,verify");
});

test("a unit test file needs only the cheap suite", () => {
  assert.equal(on(run("tests/randr.test.mjs")), "verify");
});

test("a mixed change runs the union", () => {
  assert.equal(on(run("app/page.tsx", "functions/index.js")), "backend,ui,verify");
});

test("critical paths run everything", () => {
  for (const file of [
    ".github/workflows/check.yml",
    "pnpm-lock.yaml",
    "package.json",
    "firestore.rules",
    "firebase.json",
    "functions/gateway/index.js",
  ]) {
    const result = run("docs/a.md", file);
    assert.equal(on(result), "backend,ui,verify", file);
    assert.ok(result.critical, file);
  }
});

test("a file nobody classified runs everything", () => {
  const result = run("scripts/release.mjs");
  assert.equal(on(result), "backend,ui,verify");
  assert.match(result.reason, /unclassified/);
});

test("an empty diff and a forced run both run everything", () => {
  assert.equal(on(run()), "backend,ui,verify");
  assert.equal(on(decide(["docs/a.md"], policy, { force: true })), "backend,ui,verify");
});

test("the policy is well formed", () => {
  assert.equal(policy.version, 1);
  assert.deepEqual(Object.keys(policy.suites), ["verify", "ui", "backend"]);
});
