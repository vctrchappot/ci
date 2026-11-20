import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditCaller } from "../scripts/caller-audit.mjs";

const onboard = new URL("../scripts/onboard.sh", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const hasBash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";

test("a file that does not call the shared pipeline is not audited", () => {
  assert.equal(auditCaller("name: x\njobs: {}\n"), null);
});

test("the caller onboard.sh writes today has nothing to flag", { skip: !hasBash && "bash is not available" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-"));
  writeFileSync(join(dir, "package.json"), '{"scripts":{"test":"x"}}');
  assert.equal(spawnSync("bash", [onboard, "--dir", dir], { encoding: "utf8" }).status, 0);
  assert.deepEqual(auditCaller(readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8")), []);
});

test("an old caller is flagged for everything it lacks", () => {
  const old = `on:\n  pull_request:\njobs:\n  ci:\n    uses: vctrchappot/ci/.github/workflows/node-app.yml@main\n    with: { verify: "npm test" }\n`;
  const findings = auditCaller(old);
  assert.equal(findings.length, 4);
  assert.match(findings[0], /@main/);
  assert.ok(findings.some((f) => /concurrency/.test(f)));
  assert.ok(findings.some((f) => /ready_for_review/.test(f)));
  assert.ok(findings.some((f) => /statuses/.test(f)));
});

test("cancelling every run, the default branch included, is flagged; cancelling only pull request runs is not", () => {
  const head = "on:\n  pull_request:\n    types: [ready_for_review]\npermissions:\n  statuses: write\n";
  const job = "jobs:\n  ci:\n    uses: vctrchappot/ci/.github/workflows/node-app.yml@v1\n";
  const everything = auditCaller(`${head}concurrency:\n  group: ci-\${{ github.ref }}\n  cancel-in-progress: true\n${job}`);
  assert.equal(everything.length, 1);
  assert.match(everything[0], /default branch/);
  const onlyPulls = auditCaller(`${head}concurrency:\n  group: ci-\${{ github.sha }}\n  cancel-in-progress: \${{ github.event_name == 'pull_request' }}\n${job}`);
  assert.deepEqual(onlyPulls, []);
});
