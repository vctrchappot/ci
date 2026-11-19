import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Runs a suite's commands one by one, so the log and the job summary show how long each took. The caller hands over
// the same multi-line string it used to give to `bash -c`; when that string is not simply one command per line
// (variables, `cd`, loops, a line that continues on the next) it is run as one block exactly as before.
//   COMMANDS="pnpm lint\npnpm test" SUITE=verify node run.mjs

// A line that changes the shell's state, or opens a construct, only makes sense together with the lines after it.
const STATEFUL = /^(export|set|cd|source|\.|unset|alias|shopt|trap|function|if|for|while|until|case|\{|\()(\s|$)|^[A-Za-z_][A-Za-z0-9_]*=\S*$|<<-?\s*['"]?\w/;

/**
 * Splits a block of shell commands into one command per line. Comment and empty lines are dropped, a trailing
 * backslash joins the next line. `single` is true when the block must stay in one piece.
 * @param {string} text
 * @returns {{ commands: string[], single: boolean }}
 */
export function splitCommands(text) {
  const commands = [];
  let pending = "";
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!pending && (line === "" || line.startsWith("#"))) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    commands.push(`${pending}${line}`.trim());
    pending = "";
  }
  if (pending.trim()) commands.push(pending.trim());
  return { commands, single: commands.some((command) => STATEFUL.test(command)) };
}

const bash = (args, options = {}) => spawnSync("bash", args, { encoding: "utf8", ...options });

/** True when `bash -n` accepts the line on its own, so `a &&` or an unclosed quote fall back to one block. */
export function isComplete(command) {
  return bash(["-n", "-c", command]).status === 0;
}

/** @param {number} seconds */
export function formatSeconds(seconds) {
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  const rounded = Math.round(seconds);
  return rounded >= 60 ? `${Math.floor(rounded / 60)} min ${String(rounded % 60).padStart(2, "0")} s` : `${rounded} s`;
}

/**
 * Markdown for the job summary.
 * @param {string} suite
 * @param {{ command: string, seconds: number | null, status: number | null }[]} rows
 */
export function summaryTable(suite, rows) {
  const total = rows.reduce((sum, row) => sum + (row.seconds ?? 0), 0);
  const cell = (command) => `\`${command.replace(/\s+/g, " ").replaceAll("|", "\\|").replaceAll("`", "'")}\``;
  const lines = [`### ${suite || "commands"}: ${formatSeconds(total)}`, "", "| Command | Time | Result |", "| --- | ---: | --- |"];
  for (const row of rows) {
    const result = row.status === null ? "not run" : row.status === 0 ? "passed" : `failed (${row.status})`;
    lines.push(`| ${cell(row.command)} | ${row.seconds === null ? "" : formatSeconds(row.seconds)} | ${result} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** Runs one command through bash with the same flags the suites always used. Returns its exit code and duration. */
function execute(command) {
  const started = process.hrtime.bigint();
  const result = bash(["-eo", "pipefail", "-c", command], { stdio: "inherit" });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  return { status: result.status ?? 1, seconds };
}

function main() {
  const suite = process.env.SUITE ?? "";
  const text = process.env.COMMANDS ?? "";
  const { commands, single } = splitCommands(text);
  if (!commands.length) {
    console.log("No commands to run.");
    return 0;
  }

  // One block: the old behaviour. Only the total is timed.
  const oneBlock = single || !commands.every(isComplete);
  const units = oneBlock ? [text] : commands;
  if (oneBlock) console.log("The commands depend on each other, so they run as one block and only the total is timed.");

  const rows = units.map((command) => ({ command: oneBlock ? `${commands.length} commands as one block` : command, seconds: null, status: null }));
  let exit = 0;
  for (const [index, command] of units.entries()) {
    console.log(`\n▶ ${oneBlock ? rows[index].command : command}`);
    const { status, seconds } = execute(command);
    rows[index].seconds = seconds;
    rows[index].status = status;
    console.log(status === 0 ? `✓ ${formatSeconds(seconds)}` : `✗ exit ${status} after ${formatSeconds(seconds)}`);
    if (status !== 0) {
      console.log(`::error title=${suite || "commands"} failed::${rows[index].command.replace(/\s+/g, " ").slice(0, 200)} exited with ${status}`);
      exit = status;
      break;
    }
  }

  const table = summaryTable(suite, rows);
  console.log(`\n${table}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  return exit;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
