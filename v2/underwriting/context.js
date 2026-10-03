/** This page reuses the existing finance gate and company-scoped read APIs.
 * The URL being unlisted is not an authorization mechanism. */
export async function readContext(db, cfg) {
  const auth = await db.auth.getUser();
  if (auth.error || !auth.data?.user) throw new Error('Sign in to SILO to open this workspace.');
  const user = auth.data.user;
  const profile = await db.from('profiles').select('id,name,email,role,is_active,active_company_id').eq('id', user.id).single();
  if (profile.error || !profile.data) throw new Error('Your current company could not be verified. Refresh to try again.');
  if (profile.data.is_active !== true) throw new Error('An active SILO account is required.');
  if (!profile.data.active_company_id) throw new Error('Choose an active company in SILO first.');
  const company = await cfg.ensureActiveCompany(db);
  if (!company?.id || company._staleReconcile || company.id !== profile.data.active_company_id) throw new Error('Company context changed or could not be verified. Refresh to continue.');
  const [finance, exec] = await Promise.all([db.rpc('can_manage_journal_entries'), db.rpc('is_exec_or_owner')]);
  if ((finance.error && exec.error) || !(finance.data === true || exec.data === true)) throw new Error('Finance or executive access is required for this company.');
  // Company changes are account-wide. Re-read after the asynchronous gates.
  const confirmed = await db.from('profiles').select('active_company_id,is_active').eq('id', user.id).single();
  if (confirmed.error || confirmed.data?.is_active !== true || confirmed.data.active_company_id !== company.id) throw new Error('Your company changed during verification. Refresh to continue.');
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
