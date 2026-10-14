// Runner for report_email_schedules rows that are due. Invokes
// report-email-deliver once per schedule with the cron secret.
//
// It CLAIMS each row before invoking: next_run_at is advanced with a
// compare-and-swap on its current value, and a row whose swap loses is skipped.
// Without that claim two runs that overlap -- a workflow_dispatch during a
// scheduled run, or the same slot retried -- both select the same due row and
// both deliver, so recipients get the export twice. next_run_at is the lease,
// which is why the edge function no longer writes it: whoever claims the row
// owns the next slot, whether the delivery then succeeds or fails.

import { createClient } from '@supabase/supabase-js';
import { claimSchedule } from './lib/report-email-deliver-core.mjs';

// Read at call time, not at import time, so the claim helper below is testable
// without a live project in the environment.
const env = () => ({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  cronSecret: process.env.REPORT_EMAIL_CRON_SECRET || '',
});

async function main() {
  const { url, key, cronSecret } = env();
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  if (!cronSecret) {
    console.log('[report-email] REPORT_EMAIL_CRON_SECRET unset — skipping (safe no-op)');
    return;
  }
  const fnBase = `${url.replace(/\/$/, '')}/functions/v1/report-email-deliver`;
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const now = new Date();
  const { data: due, error } = await sb.from('report_email_schedules')
    .select('id, name, next_run_at, cadence_preset, timezone')
    .eq('is_active', true)
    .eq('is_paused', false)
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now.toISOString());
  if (error) throw new Error(error.message);
  if (!due?.length) {
    console.log('[report-email] no schedules due');
    return;
  }
  let failed = false;
  for (const row of due) {
    try {
      if (!await claimSchedule(sb, row, now)) {
        console.log(`[report-email] skip ${row.id} — claimed by another run`);
        continue;
      }
      const res = await fetch(fnBase, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          apikey: key,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[report-email]', e?.message || e);
    process.exit(1);
  });
}
