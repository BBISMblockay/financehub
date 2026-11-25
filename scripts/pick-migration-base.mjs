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
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA; WORKFLOW_FILE,
 * BRANCH (default main), PUSH_BEFORE (github.event.before).
 * Prints the base SHA on stdout, notes on stderr. Never fails the run: with
 * nothing usable it prints nothing and the caller falls back.
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

async function lastSuccessSha() {
  if (!token || !repo) return null;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs`
    + `?branch=${encodeURIComponent(branch)}&status=success&per_page=1`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) { console.error(`could not read this workflow's run history: HTTP ${res.status}`); return null; }
    const body = await res.json();
    return body?.workflow_runs?.[0]?.head_sha || null;
  } catch (err) {
    console.error(`could not read this workflow's run history: ${err?.message || err}`);
    return null;
  }
}

const picked = chooseBase({
  lastSuccessSha: await lastSuccessSha(),
  pushBefore: process.env.PUSH_BEFORE,
  isAncestor,
});
if (picked.note) console.error(picked.note);
console.error(`base source: ${picked.source}`);
if (picked.base) process.stdout.write(picked.base);
