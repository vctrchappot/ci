#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Actions minutes per repository, from the jobs of the recent runs, and which private repositories are not yet
// connected to the shared pipeline. Needs an authenticated gh. Public repositories are free and are left out.
//   node scripts/usage.mjs [--owner <login>] [--days 7]
// "billed" rounds every job up to a whole minute, which is how Actions bills (reported by GitHub users; the current
// billing docs do not state it). "raw" is the actual run time and the lower bound.

const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const days = Number(option("--days", "7"));
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const gh = async (...a) => {
  try {
    return (await exec("gh", a, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (a[0] === "api" && /404|409/.test(String(error.stderr))) return "";
    throw new Error(`gh ${a.join(" ")}: ${String(error.stderr || error.message).trim()}`);
  }
};
const json = async (...a) => JSON.parse((await gh(...a)) || "null");

/** Run `task` over `items` with at most `limit` in flight. */
async function pool(items, limit, task) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

const owner = option("--owner", (await gh("api", "user", "--jq", ".login")).trim());
const repos = (await json("repo", "list", owner, "--limit", "200", "--json", "name,isPrivate,isArchived")).filter(
  (repo) => repo.isPrivate && !repo.isArchived,
);

async function repoUsage({ name }) {
  const slug = `${owner}/${name}`;
  const runs = (
    await gh("api", "--paginate", `repos/${slug}/actions/runs?per_page=100&created=>=${since}`, "--jq", ".workflow_runs[].id")
  )
    .split("\n")
    .filter(Boolean);
  let raw = 0;
  let billed = 0;
  let jobs = 0;
  await pool(runs, 8, async (id) => {
    const rows = await gh(
      "api",
      `repos/${slug}/actions/runs/${id}/jobs?per_page=100`,
      "--jq",
      '.jobs[] | select(.started_at and .completed_at and .conclusion != "skipped") | ((.completed_at|fromdate) - (.started_at|fromdate))',
    );
    for (const line of rows.split("\n").filter(Boolean)) {
      const seconds = Number(line);
      raw += seconds / 60;
      billed += Math.ceil(seconds / 60);
      jobs++;
    }
  });
  let shared = "-";
  if (runs.length) {
    const files = (await gh("api", `repos/${slug}/contents/.github/workflows`, "--jq", ".[].path")).split("\n").filter(Boolean);
    let uses = false;
    for (const path of files) {
      const body = Buffer.from((await gh("api", `repos/${slug}/contents/${path}`, "--jq", ".content")).trim(), "base64").toString();
      if (/vctrchappot\/ci\/\.github\/workflows\//.test(body)) uses = true;
    }
    shared = uses ? "yes" : "NO";
  }
  return { name, runs: runs.length, jobs, raw: Math.round(raw), billed, shared };
}

const rows = (await pool(repos, 4, repoUsage)).filter((row) => row.runs > 0).sort((a, b) => b.billed - a.billed);
const total = rows.reduce((sum, row) => ({ raw: sum.raw + row.raw, billed: sum.billed + row.billed }), { raw: 0, billed: 0 });
const pad = (value, width) => String(value).padStart(width);
console.log(`Actions minutes of private repositories of ${owner}, runs created since ${since} (${days} days)\n`);
console.log(`${"repository".padEnd(24)} ${pad("runs", 5)} ${pad("jobs", 5)} ${pad("raw", 6)} ${pad("billed", 7)}  shared pipeline`);
for (const row of rows) {
  console.log(`${row.name.padEnd(24)} ${pad(row.runs, 5)} ${pad(row.jobs, 5)} ${pad(row.raw, 6)} ${pad(row.billed, 7)}  ${row.shared}`);
}
console.log(`${"total".padEnd(24)} ${pad("", 5)} ${pad("", 5)} ${pad(total.raw, 6)} ${pad(total.billed, 7)}`);
const missing = rows.filter((row) => row.shared === "NO").map((row) => row.name);
if (missing.length) console.log(`\nNot on the shared pipeline: ${missing.join(", ")}\n  onboard: scripts/onboard.sh ${owner}/<name>`);
