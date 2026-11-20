// What is missing in a repository's caller workflow, compared with what scripts/onboard.sh writes today.
// Pure, so usage.mjs can use it and the tests can pin it. Returns a list of short findings; empty means up to date.

/**
 * @param {string} body text of a workflow file that calls vctrchappot/ci
 * @returns {string[] | null} null when the file does not call the shared pipeline
 */
export function auditCaller(body) {
  const uses = String(body).match(/uses:\s*vctrchappot\/ci\/\.github\/workflows\/[\w.-]+@(\S+)/);
  if (!uses) return null;
  const findings = [];
  if (uses[1] !== "v1") findings.push(`pinned to @${uses[1]} (expected @v1)`);
  if (!/^concurrency:/m.test(body)) findings.push("no concurrency group (superseded pull request runs are not cancelled)");
  else if (/cancel-in-progress:\s*true\s*$/m.test(body)) {
    findings.push("cancel-in-progress is true on the default branch too (cancelled commits are never verified; limit it to pull requests)");
  }
  if (!/ready_for_review/.test(body)) findings.push("no ready_for_review trigger (drafts never run once marked ready)");
  if (!/statuses:\s*write/.test(body)) findings.push("no statuses: write (verified-tree is not recorded)");
  return findings;
}
