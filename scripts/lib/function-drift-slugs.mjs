/**
 * Which paths under supabase/functions/ belong to a FUNCTION, for
 * scripts/check-function-drift.mjs.
 *
 * A slug is the directory name: supabase/functions/<slug>/<file>. A file
 * sitting directly under supabase/functions/ belongs to no function --
 * supabase/functions/CLAUDE.md is the directory's own rules document -- and
 * reading its name as a slug reported "supabase/functions/CLAUDE.md exists on
 * main but is not deployed (a deploy is owed)" on every single run from the
 * day that file was added, which held the Deployment drift check red by
 * itself and buried the real drift underneath it.
 *
 * Its own module so the rule is testable: check-function-drift.mjs calls the
 * Management API at import time and cannot be imported by a unit test.
 */
export const FN_DIR = 'supabase/functions';

/** The function slug a repo path belongs to, or null when it belongs to none. */
export function slugOfPath(path) {
  const parts = String(path || '').split('/');
  if (parts.length <= 3) return null;
  if (`${parts[0]}/${parts[1]}` !== FN_DIR) return null;
  return parts[2] || null;
}

/** Every function slug the repo has source for, from `git ls-files` output. */
export function slugsFromLsFiles(lsFilesOutput) {
  return new Set(String(lsFilesOutput || '').split('\n').map(slugOfPath).filter(Boolean));
}
