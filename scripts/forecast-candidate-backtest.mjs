// scripts/forecast-candidate-backtest.mjs — reproduce the RETROSPECTIVE score
// of Candidate_YoY_Shift_v1 from source data.
//
// It writes NOTHING. It executes scripts/sql/forecast_candidate_backtest.sql
// through chat_run_readonly_query (SELECT-only, read-only transaction) and
// prints the result. The forecast at each cutoff comes from
// public.forecast_yoy_shift_v1 -- the same single definition the runner
// freezes -- so this cannot drift away from what production would compute.
//
// THE NUMBER IS NOT PROSPECTIVE PERFORMANCE. Measured against production on
// 2026-09-17 for Youth at the 1-month horizon:
//     2026-03-01 .. 2026-08-01   (6 cutoffs)   WAPE 20.2%   bias -13.9%
//     2025-09-01 .. 2026-08-01  (12 cutoffs)   WAPE 37.5%   bias -33.8%
//     2024-01-01 .. 2026-08-01  (31 cutoffs)   WAPE 49.6%   bias -44.9%
// The default range below is the first of those, because it is the figure the
// specification asked to be reproduced -- not because it is the fair one.
//
// Run:  node scripts/forecast-candidate-backtest.mjs
// Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FC_COMPANY_ID
// Optional: FC_BACKTEST_FROM, FC_BACKTEST_TO (month starts)

import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
// The binder lives in the core lib so the unit suite can drive its refusals
// without this script's env preconditions running first.
import { bindBacktestSql, UUID_RE, MONTH_START_RE } from './lib/forecast-candidate-core.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COMPANY_ID = process.env.FC_COMPANY_ID || '';
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
if (!COMPANY_ID) throw new Error('Set FC_COMPANY_ID to the company to backtest');
if (!UUID_RE.test(COMPANY_ID)) throw new Error(`FC_COMPANY_ID is not a uuid: ${COMPANY_ID}`);

const FROM = process.env.FC_BACKTEST_FROM || '2026-03-01';
const TO = process.env.FC_BACKTEST_TO || '2026-08-01';
if (!MONTH_START_RE.test(FROM)) throw new Error(`FC_BACKTEST_FROM must be a month start: ${FROM}`);
if (!MONTH_START_RE.test(TO)) throw new Error(`FC_BACKTEST_TO must be a month start: ${TO}`);

const template = await readFile(new URL('./sql/forecast_candidate_backtest.sql', import.meta.url), 'utf8');
const sql = bindBacktestSql(template, { company: COMPANY_ID, from: FROM, to: TO });

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data, error } = await db.rpc('chat_run_readonly_query', { query: sql, p_offset: 0 });
if (error) throw new Error(`backtest query failed: ${error.message}`);

const row = (Array.isArray(data) ? data[0] : data?.rows?.[0]) || null;
if (!row) throw new Error('backtest returned no rows');

console.log(`\nCandidate_YoY_Shift_v1 — RETROSPECTIVE backtest, ${FROM} .. ${TO}`);
for (const [k, v] of Object.entries(row)) console.log(`  ${k.padEnd(34)} ${v}`);
console.log('\nThis is a retrospective score over cutoffs that had already happened.');
console.log('It is NOT the candidate\'s prospective performance and must not be quoted as such.');
console.log('Prospective forecasts live in forecast_candidate_ledger and stay');
console.log('PROSPECTIVE — NOT SCORED until their 30-day cycle matures.');
