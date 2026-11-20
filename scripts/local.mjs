import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../actions/scope/scope.mjs";

// Runs the checks a change needs on this machine, with the same decision and the same runner as the shared pipeline:
// scope.mjs picks the suites from .github/ci.json, the commands come from the caller workflow, run.mjs times them.
//   node scripts/local.mjs [--dry-run] [--full] [--base <ref>] [--suite <name>]...
// A local pass is a fast check before you push, never a replacement for the `ci / check` result.

const runScript = fileURLToPath(new URL("../actions/run/run.mjs", import.meta.url));
const SUITES = ["verify", "ui", "backend"];

const indentOf = (line) => line.match(/^\s*/)[0].length;
const isBlank = (line) => line.trim() === "";

/** Value of a plain or quoted YAML scalar on one line. */
function scalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'")) return value.slice(1, value.lastIndexOf("'")).replaceAll("''", "'");
  return value.replace(/\s+#.*$/, "");
}

/**
 * Reads the `with:` inputs of the job that calls node-app.yml. Understands what onboard.sh writes and the usual
 * variations (block scalars `|` and `>`, quoted values), not YAML in general. Returns null when no caller job is found.
 * @param {string} text workflow file
 * @returns {{ defaultBranch: string | null, commands: Record<string, string>, inputs: Record<string, string> } | null}
 */
export function parseCaller(text) {
  const lines = String(text).split(/\r?\n/);
  const uses = lines.findIndex((line) => /^\s*uses:\s*\S*node-app\.yml@/.test(line));
  if (uses === -1) return null;
  const jobIndent = indentOf(lines[uses]);
  let first = uses;
  while (first > 0 && (isBlank(lines[first - 1]) || indentOf(lines[first - 1]) >= jobIndent)) first--;
  let last = uses;
  while (last + 1 < lines.length && (isBlank(lines[last + 1]) || indentOf(lines[last + 1]) >= jobIndent)) last++;

  const withAt = lines.findIndex((line, i) => i >= first && i <= last && indentOf(line) === jobIndent && /^\s*with:\s*$/.test(line));
  const inputs = {};
  if (withAt !== -1) {
    let i = withAt + 1;
    while (i <= last && isBlank(lines[i])) i++;
    const entryIndent = i <= last ? indentOf(lines[i]) : 0;
    for (; i <= last; i++) {
      const line = lines[i];
      if (isBlank(line) || line.trim().startsWith("#")) continue;
      if (indentOf(line) < entryIndent) break;
      if (indentOf(line) > entryIndent) continue;
      const match = line.trim().match(/^([\w-]+):\s*(.*)$/);
      if (!match) continue;
      const [, key, rest] = match;
      const style = rest.trim().match(/^([|>])[+-]?\s*(#.*)?$/);
      if (!style) {
        inputs[key] = scalar(rest);
        continue;
      }
      const body = [];
      while (i + 1 <= last && (isBlank(lines[i + 1]) || indentOf(lines[i + 1]) > entryIndent)) body.push(lines[++i]);
      const margin = Math.min(...body.filter((l) => !isBlank(l)).map(indentOf), Infinity);
      const dedented = body.map((l) => (isBlank(l) ? "" : l.slice(margin))).join("\n").replace(/\n+$/, "");
      inputs[key] = style[1] === ">" ? dedented.split("\n").filter(Boolean).join(" ") : dedented;
    }
  }
  const commands = Object.fromEntries(SUITES.filter((name) => inputs[name]?.trim()).map((name) => [name, inputs[name]]));
  return { defaultBranch: inputs["default-branch"] || null, commands, inputs };
}

/** The caller workflow of this repository: the first file under .github/workflows that uses node-app.yml. */
export function findCaller(root) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const caller = parseCaller(readFileSync(join(dir, file), "utf8"));
    if (caller) return { file: join(".github", "workflows", file), ...caller };
  }
  return null;
}

const git = (cwd, args) => {
  const result = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};

/**
 * Where this branch left the default branch, then everything that differs from there: commits, staged and unstaged
 * changes and new files. Returns null when there is no base to compare with.
 * @returns {{ base: string, ref: string, files: string[] } | null}
 */
export function changedSince(cwd, { defaultBranch, base } = {}) {
  const candidates = base ? [base] : [defaultBranch && `origin/${defaultBranch}`, defaultBranch, "origin/HEAD", "origin/main", "origin/master", "main", "master"].filter(Boolean);
  for (const ref of candidates) {
    const point = git(cwd, ["merge-base", "HEAD", ref]);
    if (!point) continue;
    const tracked = git(cwd, ["diff", "--name-only", point]);
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
    if (tracked === null || untracked === null) return null;
    const files = [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))];
    return { base: point, ref, files };
  }
  return null;
}

/** Which suites to run, and why the others are left out. Pure, so it can be tested without git. */
export function plan({ files, policy, commands, force }) {
  const verdict = policy ? decide(files ?? [], policy, { force }) : { suites: Object.fromEntries(SUITES.map((name) => [name, true])), reason: "no .github/ci.json: running everything" };
  const reason = files === null ? "no base commit to compare with: running everything" : verdict.reason;
  const everything = files === null ? Object.fromEntries(SUITES.map((name) => [name, true])) : verdict.suites;
  return SUITES.map((name) => {
    if (!commands[name]) return { name, run: false, why: "no command in the caller workflow", reason };
    if (everything[name] !== true) return { name, run: false, why: "not needed for this change", reason };
    return { name, run: true, why: "", reason };
  });
}

function parseArgs(argv) {
  const options = { dryRun: false, full: false, base: null, suites: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--full") options.full = true;
    else if (arg === "--base") options.base = argv[++i] ?? "";
    else if (arg === "--suite") options.suites.push(argv[++i] ?? "");
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (options.base === "") throw new Error("--base needs a ref");
  const unknown = options.suites.find((name) => !SUITES.includes(name));
  if (unknown !== undefined) throw new Error(`--suite takes one of ${SUITES.join(", ")}`);
  return options;
}

const HELP = `Run the checks this change needs, like the shared CI would.

  node local.mjs [--dry-run] [--full] [--base <ref>] [--suite verify|ui|backend]...

  --dry-run   print the plan, run nothing
  --full      run every suite that has a command
  --base      compare with this ref instead of the merge base with the default branch
  --suite     run only this suite (repeatable), if the change needs it`;

/** @returns {number} exit code */
export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`local: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    console.error("local: not inside a git repository");
    return 2;
  }
  const caller = findCaller(root);
  if (!caller) {
    console.error("local: no workflow under .github/workflows calls vctrchappot/ci (node-app.yml). Connect the repository first: see the README of vctrchappot/ci.");
    return 2;
  }
  const policyPath = join(root, ".github", "ci.json");
  let policy = null;
  if (existsSync(policyPath)) {
    try {
      policy = JSON.parse(readFileSync(policyPath, "utf8"));
    } catch (error) {
      console.error(`local: .github/ci.json is not valid JSON (${error.message}); running everything, as the pipeline does`);
    }
  }
  const change = changedSince(root, { defaultBranch: caller.defaultBranch, base: options.base });
  const rows = plan({ files: change?.files ?? null, policy, commands: caller.commands, force: options.full }).map((row) =>
    options.suites.length && !options.suites.includes(row.name) && row.run ? { ...row, run: false, why: "not selected with --suite" } : row,
  );

  console.log(change ? `local: ${change.files.length} changed file(s) since ${change.ref} (${change.base.slice(0, 10)}), commands from ${caller.file}` : `local: no base to compare with, commands from ${caller.file}`);
  console.log(`local: ${rows[0].reason}`);
  for (const row of rows) console.log(`  ${row.run ? "run " : "skip"} ${row.name.padEnd(8)} ${row.run ? "" : row.why}`.trimEnd());
  if (options.dryRun) return 0;
  if (spawnSync("bash", ["-c", "true"]).status !== 0) {
    console.error("local: bash is required to run the commands (on Windows: Git Bash must be on PATH)");
    return 2;
  }
  const todo = rows.filter((row) => row.run);
  if (!todo.length) {
    console.log("local: nothing to run");
    return 0;
  }
  const started = Date.now();
  for (const row of todo) {
    console.log(`\n=== ${row.name} ===`);
    const result = spawnSync(process.execPath, [runScript], { cwd: root, stdio: "inherit", env: { ...process.env, SUITE: row.name, COMMANDS: caller.commands[row.name] } });
    if (result.status !== 0) {
      console.log(`\nlocal: ${row.name} failed. Fix it before you push; later suites were not run.`);
      return result.status ?? 1;
    }
  }
  console.log(`\nlocal: ${todo.map((row) => row.name).join(", ")} passed in ${Math.round((Date.now() - started) / 1000)} s. CI still decides: wait for \`ci / check\`.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
