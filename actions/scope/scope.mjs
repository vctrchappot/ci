import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Decides which CI suites a change set needs, and whether a push to the default branch can skip them because the
// identical tree already passed on its pull request. Reads .github/ci.json. Fails safe: anything unknown runs everything.
//   node actions/scope/scope.mjs         (inside a GitHub Actions job, after a full checkout)

/** Glob to RegExp: `**` crosses folders, `*` and `?` stay inside one, `{a,b}` alternates. */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) out += "\\{";
      else {
        const parts = glob.slice(i + 1, end).split(",");
        out += `(?:${parts.map((part) => globToRegExp(part).source.slice(1, -1)).join("|")})`;
        i = end;
      }
    } else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Does `file` match a list of globs where a leading `!` takes files back out (last match wins)? */
export function matches(file, globs = []) {
  let hit = false;
  for (const glob of globs) {
    const negated = glob.startsWith("!");
    if (globToRegExp(negated ? glob.slice(1) : glob).test(file)) hit = !negated;
  }
  return hit;
}

/**
 * Which suites a change set needs. Critical paths and files nobody has classified run everything.
 * `verify` is the cheap suite (format, lint, types, unit tests) and runs for every change that is not ignored.
 * @param {string[]} files changed paths
 * @param {{ignore?: string[], critical?: string[], verifyOnly?: string[], suites: Record<string, string[]>}} policy
 * @param {{force?: boolean}} options
 */
export function decide(files, policy, { force = false } = {}) {
  const names = Object.keys(policy.suites);
  const flags = (value) => Object.fromEntries(names.map((name) => [name, value]));
  if (force) return { suites: flags(true), critical: false, reason: "forced" };
  if (files.length === 0) return { suites: flags(true), critical: false, reason: "empty diff: running everything" };
  const relevant = files.filter((file) => !matches(file, policy.ignore));
  if (relevant.length === 0) return { suites: flags(false), critical: false, reason: "ignored files only" };
  const critical = relevant.find((file) => matches(file, policy.critical));
  if (critical) return { suites: flags(true), critical: true, reason: `critical: ${critical}` };
  const scoped = names.filter((name) => name !== "verify");
  const unclassified = relevant.find(
    (file) => !matches(file, policy.verifyOnly) && !scoped.some((name) => matches(file, policy.suites[name])),
  );
  if (unclassified) return { suites: flags(true), critical: false, reason: `unclassified: ${unclassified}` };
  const suites = flags(false);
  suites.verify = true;
  for (const name of scoped) suites[name] = relevant.some((file) => matches(file, policy.suites[name]));
  return { suites, critical: false, reason: "path groups" };
}

const run = (command, args) => spawnSync(command, args, { encoding: "utf8" });
const out = (command, args) => {
  const result = run(command, args);
  return result.status === 0 ? result.stdout.trim() : null;
};

/** The tree-already-verified lookup for pushes to the default branch. Returns { skip, reason }. */
export function verifiedTreeVerdict({ repo, sha, before, tree, criticalChanged }) {
  if (criticalChanged) return { skip: false, reason: "critical path changed" };
  if (!before || /^0+$/.test(before)) return { skip: false, reason: "no previous commit" };
  const gate = out("gh", [
    "api",
    `repos/${repo}/commits/${before}/check-runs?per_page=100`,
    "--jq",
    // Called as a reusable workflow, the gate job is reported as "<caller job> / check".
    '[.check_runs[] | select((.name=="check" or (.name|endswith(" / check"))) and .status=="completed")] | sort_by(.completed_at) | last | .conclusion',
  ]);
  if (gate !== "success") return { skip: false, reason: `previous commit's gate was ${gate || "unknown"}` };
  const heads = out("gh", ["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", ".[].head.sha"]);
  if (!heads) return { skip: false, reason: "no pull request found for this commit" };
  for (const head of heads.split("\n")) {
    const found = out("gh", [
      "api",
      `repos/${repo}/commits/${head}/statuses?per_page=100`,
      "--jq",
      '.[] | select(.context=="ci/verified-tree" and .state=="success") | .description',
    ]);
    if (found?.split("\n").includes(`tree:${tree}`)) {
      return { skip: true, reason: `tree ${tree.slice(0, 10)} passed on PR head ${head.slice(0, 10)}` };
    }
  }
  return { skip: false, reason: "tree was not verified on a pull request" };
}

function main() {
  const env = process.env;
  const outputs = {};
  const write = () => {
    const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
    console.log(lines.join("\n"));
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  };
  const everything = (reason) => {
    Object.assign(outputs, { verify: true, ui: true, backend: true, skip: false, tree: "", reason });
    write();
  };
  try {
    const policyPath = env.POLICY || ".github/ci.json";
    if (!existsSync(policyPath)) return everything("no .github/ci.json");
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    const event = env.GITHUB_EVENT_NAME;
    const onDefaultBranch = event === "push" && env.GITHUB_REF === `refs/heads/${env.DEFAULT_BRANCH || "master"}`;
    const labels = (env.PR_LABELS || "").split(",");
    const force = env.CI_FULL === "1" || labels.includes("ci:full");
    const base = event === "pull_request" ? env.PR_BASE : env.PUSH_BEFORE;
    const usable = base && !/^0+$/.test(base) && run("git", ["cat-file", "-e", `${base}^{commit}`]).status === 0;
    const files = usable ? out("git", ["diff", "--name-only", base, "HEAD"])?.split("\n").filter(Boolean) : null;
    if (!files) return everything("no usable base commit");
    const verdict = decide(files, policy, { force });
    const tree = out("git", ["rev-parse", "HEAD^{tree}"]) ?? "";
    Object.assign(outputs, verdict.suites, { skip: false, tree, reason: verdict.reason });
    if (onDefaultBranch) {
      // Pushes to the default branch used to run everything again. They may skip only if this exact tree passed on a PR.
      const lookup = verifiedTreeVerdict({
        repo: env.GITHUB_REPOSITORY,
        sha: env.GITHUB_SHA,
        before: base,
        tree,
        criticalChanged: verdict.critical || force,
      });
      const enforce = env.CI_SKIP_VERIFIED === "1";
      console.log(
        `verified-tree: ${lookup.skip ? "WOULD SKIP" : "run"} (${lookup.reason}) ${enforce ? "[enforced]" : "[shadow: running everything anyway]"}`,
      );
      Object.assign(outputs, { verify: true, ui: true, backend: true, reason: lookup.reason });
      if (lookup.skip && enforce) Object.assign(outputs, { verify: false, ui: false, backend: false, skip: true });
    }
    write();
  } catch (error) {
    console.error(`scope failed, running everything: ${error?.message ?? error}`);
    everything("scope error");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
