// Public early-access intake. Only this service-role path may add a lead.
// No session, tenant creation, invitation, message, or billing side effect.
export const ALLOWED_ORIGINS = new Set([
  'https://get-silo.com',
  'https://www.get-silo.com',
  'https://silo-baseballism.com',
]);
export const MAX_BODY_BYTES = 4096;
const BODY_TIMEOUT_MS = 5000;
const FIELD_LIMITS = { name: 120, company_name: 200, email: 254 };
const INVALID = 'Please check your details and try again.';
const UNAVAILABLE = 'We could not save your request. Please try again shortly.';

type Dependencies = {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  fetch?: typeof globalThis.fetch;
};
type Lead = { name: string; company_name: string; email: string };
class InputError extends Error {
  status: number;
  constructor(status: number) { super(INVALID); this.status = status; }
}

function validEmail(email: string): boolean {
  if (email.length > FIELD_LIMITS.email || /[^\x21-\x7e]/.test(email)) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

function validate(value: unknown): Lead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(400);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['name', 'company_name', 'email', 'website'].includes(key))) throw new InputError(400);
  if (row.website !== undefined && (typeof row.website !== 'string' || row.website !== '')) throw new InputError(400);
  const result = {} as Lead;
  for (const key of ['name', 'company_name', 'email'] as const) {
    if (typeof row[key] !== 'string') throw new InputError(400);
    const raw = row[key] as string;
    // Reject before trim: a pasted control character must not disappear silently.
    if (/[\p{Cc}\p{Cf}]/u.test(raw)) throw new InputError(400);
    const text = raw.trim();
    if (!text || Array.from(text).length > FIELD_LIMITS[key]) throw new InputError(400);
    result[key] = text;
  }
  result.email = result.email.toLowerCase();
  if (!validEmail(result.email)) throw new InputError(400);
  return result;
}

async function readBody(req: Request): Promise<unknown> {
  const length = req.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new InputError(413);
  if (!req.body) throw new InputError(400);
  const reader = req.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InputError(408)), BODY_TIMEOUT_MS);
  });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), expired]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new InputError(413);
      chunks.push(value);
    }
    const payload = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
    catch { throw new InputError(400); }
  } finally {
    clearTimeout(timer);
    // Do not await an untrusted producer's cancel promise.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// The per-address quota key: an HMAC under the service key, domain-separated,
// so the database holds no address and the key cannot be rebuilt without it.
async function emailKey(email: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`silo:onboarding-interest:email:v1:${email}`));
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
}

export function createHandler(deps: Dependencies) {
  const fetcher = deps.fetch ?? globalThis.fetch;
  return async function handler(req: Request): Promise<Response> {
    const origin = req.headers.get('origin') ?? '';
    const allowed = ALLOWED_ORIGINS.has(origin);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      ...(allowed ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, apikey',
        'Access-Control-Expose-Headers': 'Retry-After',
      } : {}),
    };
    const reply = (body: object, status: number, extra = {}) =>
      new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
    if (!allowed) return reply({ error: 'Request not allowed.' }, 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return reply({ error: 'Use POST.' }, 405, { Allow: 'POST, OPTIONS' });
    if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return reply({ error: INVALID }, 415);
    }
    let lead: Lead;
    try { lead = validate(await readBody(req)); }
    catch (error) { return reply({ error: INVALID }, error instanceof InputError ? error.status : 400); }
    if (!deps.supabaseUrl || !deps.serviceRoleKey) return reply({ error: UNAVAILABLE }, 503);
    try {
      // IP headers are intentionally ignored: there is no verified trusted-proxy
      // contract here. Database global caps remain effective against spoofed IPs.
      const result = await fetcher(`${deps.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/submit_onboarding_interest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: deps.serviceRoleKey,
          Authorization: `Bearer ${deps.serviceRoleKey}`,
        },
        body: JSON.stringify({
          p_name: lead.name,
          p_company_name: lead.company_name,
          p_email: lead.email,
          p_email_key: await emailKey(lead.email, deps.serviceRoleKey),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!result.ok) return reply({ error: UNAVAILABLE }, 503);
      const outcome = await result.json();
      if (outcome?.accepted === true && outcome?.retry_after_seconds === 0) {
        return reply({ ok: true }, 200);
      }
      if (outcome?.accepted === false && Number.isInteger(outcome?.retry_after_seconds) &&
          outcome.retry_after_seconds > 0 && outcome.retry_after_seconds <= 86400) {
        return reply({ error: 'Please wait before trying again.' }, 429, { 'Retry-After': String(outcome.retry_after_seconds) });
      }
      return reply({ error: UNAVAILABLE }, 503);
    } catch {
      // Deliberately do not log request data, hashes, credentials, or DB errors.
      return reply({ error: UNAVAILABLE }, 503);
    }
  };
}
