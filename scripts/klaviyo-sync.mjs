// scripts/klaviyo-sync.mjs -- Klaviyo campaigns and flows (email + SMS) into
// klaviyo_messages / klaviyo_message_performance / klaviyo_flow_daily. The
// logic lives in scripts/lib/klaviyo-sync-core.mjs (syncKlaviyoConnection);
// this file only loads connections and sets the exit code.
//
// Nightly (klaviyo-sync.yml): every klaviyo_connections row that is both
// is_active and sync_enabled, a trailing KLAVIYO_DAYS_BACK (default 60) days
// ending yesterday in the ACCOUNT's timezone, overwritten. Klaviyo does not
// document how far it restates conversions; 60 days is Redo's measured answer
// for the same question and costs little, because a report's cost scales with
// the range, not with the number of campaigns in it.
//
// Backfill: set KLAVIYO_START (and optionally KLAVIYO_END); the window is cut
// into <=365-day chunks (Klaviyo's reporting limit), newest first.
//
// Dry run: KLAVIYO_DRY_RUN=true fetches and reports counts, writing nothing.
//
// Credentials: the key or OAuth tokens on the klaviyo_connections row itself.
// The only repo secrets needed are Supabase's, plus KLAVIYO_CLIENT_ID /
// KLAVIYO_CLIENT_SECRET if any connection uses OAuth -- a private-key
// connection needs neither.
//
// A company whose key lacks a scope, whose key is rejected, or whose OAuth
// grant is gone is recorded `skipped` in sync_jobs and does NOT fail the run:
// that is a configuration state for one company, not an outage for the rest.

import { createClient } from '@supabase/supabase-js';
import { effectiveDaysBack, syncKlaviyoConnection } from './lib/klaviyo-sync-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const ONLY_COMPANY_ID = process.env.KLAVIYO_COMPANY_ID || '';
// Passed to effectiveDaysBack as `requested`: BLANK when nobody asked, which
// is how the nightly is told apart from Integration Bootstrap setting 365 on
// purpose. Defaulting it to '60' here would make the two indistinguishable,
// and the per-connection override then swallowed the bootstrap's year --
// measured on production 2026-11-09, where a first sync asked for 365 days
// and stored 60.
const DAYS_BACK = process.env.KLAVIYO_DAYS_BACK || '';
const START = process.env.KLAVIYO_START || '';
const END = process.env.KLAVIYO_END || '';
const DRY_RUN = String(process.env.KLAVIYO_DRY_RUN || '').toLowerCase() === 'true';
const CLIENT_ID = process.env.KLAVIYO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.KLAVIYO_CLIENT_SECRET || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CONNECTION_COLUMNS = [
  'id', 'company_entity_id', 'auth_mode', 'api_key', 'access_token', 'refresh_token',
  'token_expires_at', 'oauth_scope', 'reauth_required_at', 'klaviyo_account_id',
  'account_timezone', 'conversion_metric_id', 'days_back', 'meta',
].join(', ');

async function main() {
  // sync_enabled is checked here and not only in the core: connecting an
  // account is not consent to sync it, the same rule the ad platforms and
  // windsor_linked_accounts follow.
  let q = supabase.from('klaviyo_connections')
    .select(CONNECTION_COLUMNS)
    .eq('is_active', true)
    .eq('sync_enabled', true);
  if (ONLY_COMPANY_ID) q = q.eq('company_entity_id', ONLY_COMPANY_ID);
  const { data: connections, error } = await q;
  if (error) throw new Error(`klaviyo_connections load failed: ${error.message}`);
  if (!connections?.length) {
    console.log('[klaviyo] no active klaviyo_connections with sync_enabled');
    return;
  }

  let failed = false;
  for (const connection of connections) {
    try {
      const out = await syncKlaviyoConnection({
        supabase,
        connection,
        // A per-connection days_back wins over the workflow's default, so one
        // company can be pulled deeper without changing the schedule for all.
        daysBack: effectiveDaysBack({
          requested: DAYS_BACK,
          connectionDaysBack: connection.days_back,
          startDate: START,
        }),
        startDate: START,
        endDate: END,
        dryRun: DRY_RUN,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        log: console.log,
      });
      console.log(`[klaviyo] ${connection.company_entity_id}: `
        + (out.skipped ? `skipped (${out.skipped})` : `${out.window.startDate}..${out.window.endDate} ok${out.dry_run ? ' (dry run)' : ''}`));
    } catch (err) {
      failed = true;
      console.error(`[error] ${connection.company_entity_id}: ${err?.message || err}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error('[klaviyo] fatal', err);
  process.exit(1);
});
