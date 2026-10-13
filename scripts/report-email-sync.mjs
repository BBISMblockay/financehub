// Nightly (and manual) runner for report_email_schedules due rows.
// Invokes report-email-deliver per schedule with a cron secret.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const cronSecret = process.env.REPORT_EMAIL_CRON_SECRET || '';
const fnBase = `${url?.replace(/\/$/, '')}/functions/v1/report-email-deliver`;

if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
if (!cronSecret) {
  console.log('[report-email] REPORT_EMAIL_CRON_SECRET unset — skipping (safe no-op)');
  process.exit(0);
}

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  const now = new Date().toISOString();
  const { data: due, error } = await sb.from('report_email_schedules')
    .select('id, name, next_run_at')
    .eq('is_active', true)
    .eq('is_paused', false)
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now);
  if (error) throw new Error(error.message);
  if (!due?.length) {
    console.log('[report-email] no schedules due');
    return;
  }
  let failed = false;
  for (const row of due) {
    try {
      const res = await fetch(fnBase, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'x-silo-report-email-cron': cronSecret,
        },
        body: JSON.stringify({ schedule_id: row.id, trigger: 'schedule' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      console.log(`[report-email] ok ${row.id} ${row.name || ''} rows=${body.rows ?? '?'}`);
    } catch (err) {
      failed = true;
      console.error(`[report-email] fail ${row.id}: ${err?.message || err}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error('[report-email]', e?.message || e);
  process.exit(1);
});
