// Wake the existing durable worker, never run a long import inside an Edge request.
// Caller RLS + admin gate authorizes one existing Meta job; no caller-selected
// repository, ref, workflow or credential crosses this boundary.
const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
export function createHandler({ service, userClientFor, dispatch, log = () => {} }) {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const { data: auth, error: authError } = await service.auth.getUser(token);
    if (authError || !auth?.user) return json({ error: 'Unauthorized' }, 401);
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    if (!/^[0-9a-f-]{36}$/i.test(body?.job_id || '')) return json({ error: 'Invalid job' }, 400);
    const user = userClientFor(authHeader);
    // Mandatory caller-token read engages the Data API MFA/integration gate.
    const { data: job, error } = await user.from('integration_bootstrap_jobs')
      .select('id, company_entity_id, connection_id, integration, status')
      .eq('id', body.job_id).maybeSingle();
    if (error || !job) return json({ error: 'Job unavailable in this workspace' }, 404);
    const { data: admin, error: adminError } = await user.rpc('is_admin_user');
    if (adminError || admin !== true) return json({ error: 'Admin required' }, 403);
    if (job.integration !== 'meta_ads') return json({ error: 'Only Meta initial imports are supported' }, 400);
    if (job.status !== 'pending') return json({ requested: false, status: job.status });
    if (!dispatch) return json({ requested: false, fallback: true, error: 'Immediate import worker is not configured; import remains queued' }, 503);
    const { data: reserved, error: reserveError } = await service.rpc('reserve_bootstrap_dispatch', { p_job_id: job.id });
    if (reserveError) return json({ requested: false, fallback: true, error: 'Could not reserve import dispatch; import remains queued' }, 503);
    if (!reserved) return json({ requested: false, status: 'already_requested_or_inactive' });
    try {
      await dispatch(job.id);
      return json({ requested: true, status: 'dispatch_requested' }, 202);
    } catch (err) {
      log('Bootstrap dispatch failed', String(err?.message || err));
      return json({ requested: false, fallback: true, error: 'Could not start worker immediately; import remains queued for automatic retry' }, 503);
    }
  };
}
export function githubDispatcher({ token, fetchImpl = fetch }) {
  if (!token) return null;
  return async (jobId) => {
    const response = await fetchImpl('https://api.github.com/repos/BBISMblockay/financehub/actions/workflows/integration-bootstrap.yml/dispatches', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ ref: 'main', inputs: { job_id: jobId, max_jobs: '1' } }),
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 204) throw new Error(`GitHub dispatch HTTP ${response.status}`);
  };
}
