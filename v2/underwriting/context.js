/** This page reuses the existing finance gate and company-scoped read APIs.
 * The URL being unlisted is not an authorization mechanism. */
/** A failure is DEFINITIVE when the server answered and the answer excludes
 * this person (signed out, disabled, no company, no finance/exec gate, a
 * different company than before). It is TRANSIENT when a read did not come
 * back at all (network blip, a 5xx, a laptop waking before Wi-Fi). The page
 * clears the scenario only on a definitive failure; a transient one keeps the
 * unsaved inputs and offers a retry, the same stance ensureActiveCompany()
 * takes toward a failed profile read (pages/config.js). */
const fail = (message, transient = false) => Object.assign(new Error(message), { transient });
// PostgREST answers "no such row" as an error (PGRST116). That is the server
// speaking, not a dropped connection: a profile that does not exist is definitive.
const missingRow = (error) => error?.code === 'PGRST116';
export async function readContext(db, cfg) {
  const auth = await db.auth.getUser();
  if (auth.error) throw fail('SILO could not confirm your sign-in. Check your connection and retry.', true);
  if (!auth.data?.user) throw fail('Sign in to SILO to open this workspace.');
  const user = auth.data.user;
  const profile = await db.from('profiles').select('id,name,email,role,is_active,active_company_id').eq('id', user.id).single();
  if (profile.error && !missingRow(profile.error)) throw fail('Your current company could not be verified. Check your connection and retry.', true);
  if (!profile.data) throw fail('Your SILO profile could not be found. Sign in again.');
  if (profile.data.is_active !== true) throw fail('An active SILO account is required.');
  if (!profile.data.active_company_id) throw fail('Choose an active company in SILO first.');
  const company = await cfg.ensureActiveCompany(db);
  if (!company?.id || company._staleReconcile || company.id !== profile.data.active_company_id) throw fail('Company context changed or could not be verified. Refresh to continue.');
  const [finance, exec] = await Promise.all([db.rpc('can_manage_journal_entries'), db.rpc('is_exec_or_owner')]);
  if (!(finance.data === true || exec.data === true)) {
    // A gate that did not answer is not a gate that said no.
    if (finance.error || exec.error) throw fail('SILO could not confirm your finance access. Check your connection and retry.', true);
    throw fail('Finance or executive access is required for this company.');
  }
  // Company changes are account-wide. Re-read after the asynchronous gates.
  const confirmed = await db.from('profiles').select('active_company_id,is_active').eq('id', user.id).single();
  if (confirmed.error && !missingRow(confirmed.error)) throw fail('Your company could not be re-verified. Check your connection and retry.', true);
  if (!confirmed.data) throw fail('Your SILO profile could not be found. Sign in again.');
  if (confirmed.data.is_active !== true || confirmed.data.active_company_id !== company.id) throw fail('Your company changed during verification. Refresh to continue.');
  return {user, profile: profile.data, company, key: `${user.id}:${company.id}`};
}

/** Last request wins; stale responses never repaint a different company. */
export function createLoadGuard() {
  let generation = 0;
  let controller;
  return {
    begin() { controller?.abort(); controller = new AbortController(); return {generation: ++generation, signal: controller.signal}; },
    current(ticket) { return ticket.generation === generation && !ticket.signal.aborted; },
    invalidate() { generation++; controller?.abort(); },
  };
}
