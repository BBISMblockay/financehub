/* Print the commit .github/workflows/auto-apply-migrations.yml should diff
 * against to find the migrations a merge still owes.
 *
 * WHY NOT JUST github.event.before. The workflow carries a `concurrency`
 * group, and a group with `cancel-in-progress: false` still drops a QUEUED
 * run when a third arrives (scripts/CLAUDE.md). If the dropped run was merge
 * B's, nothing would ever look at B's migrations again: merge C diffs only
 * C's own push. So the base is the head of the LAST SUCCESSFUL run of this
 * workflow, which makes the next run catch up everything merged since -- a
 * cancelled run, a failed run and a lost delivery all heal the same way.
 * (Caught by the automated review on PR #1405, cycle 1.)
 *
 * Still "only on new": nothing merged before the last successful apply is
 * ever looked at, and a version already in schema_migrations is skipped.
 *
 * An unreadable run history is NOT the same answer as "no successful run
 * yet": with A succeeded, B's run cancelled and the Actions API answering 403
 * for C, falling back to this push would make C apply only C, succeed, and
 * move the base permanently past B's migration. So a lookup that fails exits
 * non-zero and the run stops; the last successful run stays where it is and
 * the next push catches up (automated review, PR #1406).
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA; WORKFLOW_FILE,
 * BRANCH (default main), PUSH_BEFORE (github.event.before).
 * Prints the base SHA on stdout, notes on stderr. Exit 0 with a base, 0 with
 * no base (nothing usable, the caller falls back), 3 when the history could
 * not be read.
 */
import { execFileSync } from 'node:child_process';
import { chooseBase } from './lib/apply-migrations-core.mjs';

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const headSha = process.env.GITHUB_SHA;
const workflowFile = process.env.WORKFLOW_FILE || 'auto-apply-migrations.yml';
const branch = process.env.BRANCH || 'main';

const isAncestor = (sha) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, headSha || 'HEAD'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
};

async function lookupLastSuccess() {
  // No token and no repo is the local case, not a failure to read: there is
  // no history to consult, and the caller's own fallbacks apply.
  if (!token || !repo) return { ok: true, sha: null };
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs`
    + `?branch=${encodeURIComponent(branch)}&status=success&per_page=1`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, sha: body?.workflow_runs?.[0]?.head_sha || null };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

const picked = chooseBase({
  lookup: await lookupLastSuccess(),
  pushBefore: process.env.PUSH_BEFORE,
  isAncestor,
});
if (picked.note) console.error(picked.note);
console.error(`base source: ${picked.source}`);
if (picked.source === 'unreadable') process.exit(3);
if (picked.base) process.stdout.write(picked.base);
