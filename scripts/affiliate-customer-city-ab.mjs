#!/usr/bin/env node
// A/B test for Your Customers -> Find: does putting the customer's city in
// the search text find MORE of the right accounts, or fewer?
//
// The 2026-11-24 audit saw 13% matched with the city vs 29% without (n=39,
// not the same people). This runs BOTH searches for the SAME customers, so
// the only difference is the city.
//
// READ ONLY against SILO: reads one company's customers and writes nothing.
// It spends at the search provider: two standard-queue searches per
// customer (~$0.0006 each, so 300 customers is about $0.36). Manual only:
// .github/workflows/affiliate-customer-city-ab.yml.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATAFORSEO_LOGIN,
// DATAFORSEO_PASSWORD, AB_COMPANY_ENTITY_ID (required; no company is built
// in), AB_SAMPLE (default 300, max 800), AB_MIN_ORDERS (default 3).

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  personName, buildScanTask, judgeResults, scorePick, createSerpQueue, COMPANY_SCAN_SCOPE,
  companyMinFollowers, companyTerms, LIKELY_SCORE, suppressionFilter, teamFilter,
} from './lib/affiliate-customer-scan-core.mjs';

/**
 * Who may be searched, the same rule as Find: a name, an email, a city, not
 * on the do-not-contact list, not one of the company's own people. Pure, so
 * it is tested (scripts/tests/affiliate-customer-city-ab.test.mjs).
 */
export function eligiblePeople(rows, city, { suppressed, isTeam }, limit) {
  const out = [];
  for (const r of rows || []) {
    if (out.length >= limit) break;
    if (!r?.email_lc || !city.has(r.email_lc) || suppressed(r.email_lc) || isTeam(r.email_lc)) continue;
    const person = personName(r.name_lc, r.first_name_lc, r.last_name_lc);
    if (!person) continue;
    out.push({ key: r.customer_key, email: r.email_lc, city: city.get(r.email_lc), person });
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const env = process.env;
if (isMain) await main();

async function main() {
const need = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'AB_COMPANY_ENTITY_ID'];
const missing = need.filter((k) => !env[k]);
if (missing.length) { console.error(`Missing: ${missing.join(', ')}`); process.exit(1); }
const COMPANY = env.AB_COMPANY_ENTITY_ID.trim();
if (!/^[0-9a-f-]{36}$/i.test(COMPANY)) { console.error('AB_COMPANY_ENTITY_ID must be a uuid'); process.exit(1); }
const SAMPLE = Math.max(10, Math.min(800, Math.floor(Number(env.AB_SAMPLE) || 300)));
const MIN_ORDERS = Math.max(1, Math.floor(Number(env.AB_MIN_ORDERS) || 3));
const NEVER = ['unsubscribed', 'redacted'];
const RUN_MS = 25 * 60_000;
const started = Date.now();

const { createClient } = await import('@supabase/supabase-js');
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const queue = createSerpQueue({ credentials: { login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = (a, n = 100) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function guards() {
  const { data: sup, error: sErr } = await db.from('affiliate_suppressions').select('kind, value_normalized').eq('company_entity_id', COMPANY).limit(5000);
  if (sErr) throw new Error(`do-not-contact list: ${sErr.message}`);
  const { data: members, error: mErr } = await db.from('entity_memberships').select('user_id').eq('entity_id', COMPANY).limit(5000);
  if (mErr) throw new Error(`team: ${mErr.message}`);
  const emails = [];
  for (const ids of chunks((members || []).map((m) => m.user_id).filter(Boolean))) {
    const { data: ps, error: pErr } = await db.from('profiles').select('email').in('id', ids);
    if (pErr) throw new Error(`team: ${pErr.message}`);
    for (const x of ps || []) if (x.email) emails.push(x.email);
  }
  return { suppressed: suppressionFilter(sup || []), isTeam: teamFilter(emails) };
}

async function sample() {
  const g = await guards();
  const { data: ent } = await db.from('entities').select('meta').eq('id', COMPANY).maybeSingle();
  const { data: progs } = await db.from('affiliate_programs').select('niche, audience_notes').eq('company_entity_id', COMPANY).eq('status', 'active').limit(50);
  const out = [];
  for (let page = 0; page < 20 && out.length < SAMPLE; page += 1) {
    const { data: rows, error } = await db.from('company_customer_profiles')
      .select('customer_key, email_lc, name_lc, first_name_lc, last_name_lc')
      .eq('company_entity_id', COMPANY).gte('order_count', MIN_ORDERS)
      .or(`email_consent_state.is.null,email_consent_state.not.in.(${NEVER.join(',')})`)
      .order('last_order_at', { ascending: false, nullsFirst: false })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`customers: ${error.message}`);
    if (!rows?.length) break;
    const named = rows.filter((r) => r.email_lc && personName(r.name_lc, r.first_name_lc, r.last_name_lc));
    const city = new Map();
    for (const emails of chunks(named.map((r) => r.email_lc), 200)) {
      const { data: cs, error: cErr } = await db.from('shopify_customers').select('email_lc, city, province_code')
        .eq('company_entity_id', COMPANY).in('email_lc', emails);
      if (cErr) throw new Error(`cities: ${cErr.message}`);
      for (const c of cs || []) {
        if (!c.city || !String(c.city).trim() || city.has(c.email_lc)) continue;
        const st = /^[A-Za-z]{2}$/.test(String(c.province_code || '').trim()) ? `, ${String(c.province_code).trim().toUpperCase()}` : '';
        city.set(c.email_lc, `${String(c.city).trim()}${st}`);
      }
    }
    out.push(...eligiblePeople(named, city, g, SAMPLE - out.length));
  }
  return { people: out, minFollowers: companyMinFollowers(ent?.meta), terms: companyTerms(ent?.meta, progs || []) };
}

async function run() {
  const { people, minFollowers, terms } = await sample();
  console.log(`Sample: ${people.length} customers with a city (asked for ${SAMPLE}).`);
  if (!people.length) { console.log('Nobody to test.'); return; }
  const jobs = [];
  for (const p of people) for (const arm of ['name', 'name_city']) {
    jobs.push({ p, arm, task: buildScanTask(p.person, arm === 'name_city' ? p.city : null, COMPANY_SCAN_SCOPE) });
  }
  for (const part of chunks(jobs)) {
    const acks = await queue.post(part.map((j) => ({ task: j.task })));
    part.forEach((j, i) => { j.id = acks[i]?.id || null; j.cost = Number(acks[i]?.cost) || 0; if (!j.id) j.result = { state: 'refused', code: acks[i]?.code }; });
  }
  await sleep(Number(env.AB_FIRST_WAIT_MS ?? 60_000));
  let open = jobs.filter((j) => j.id && !j.result);
  while (open.length && Date.now() - started < RUN_MS) {
    for (const j of open) {
      try { const r = await queue.get(j.id); if (r.state !== 'pending') j.result = r; } catch (e) { /* next round */ }
    }
    open = jobs.filter((j) => j.id && !j.result);
    if (open.length) { console.log(`${open.length} searches still out`); await sleep(30_000); }
  }
  const at = new Date().toISOString();
  const arms = { name: [], name_city: [] };
  for (const j of jobs) {
    const res = j.result || { state: 'timeout' };
    let status = res.state === 'ready' ? null : 'error';
    let score = null; let pick = null;
    if (!status) {
      const v = judgeResults({ items: res.items || [], person: j.p.person, program: COMPANY_SCAN_SCOPE, minFollowers, collectedAt: at });
      status = v.status; pick = v.pick || null;
      if (pick) score = scorePick({ pick, person: j.p.person, email: j.p.email, city: j.p.city, terms }).score;
    }
    arms[j.arm].push({ key: j.p.key, status, score, url: pick?.profile_url || null, cost: j.cost });
  }
  const sum = (rows) => {
    const n = rows.length;
    const c = (f) => rows.filter(f).length;
    const matched = c((r) => ['found', 'below', 'no_count'].includes(r.status));
    return {
      n, matched, ambiguous: c((r) => r.status === 'ambiguous'), none: c((r) => r.status === 'none'), failed: c((r) => r.status === 'error'),
      over_bar: c((r) => r.status === 'found'), likely: c((r) => r.score !== null && r.score >= LIKELY_SCORE),
      likely_over_bar: c((r) => r.status === 'found' && r.score >= LIKELY_SCORE),
      cost: Math.round(rows.reduce((a, r) => a + r.cost, 0) * 10000) / 10000,
    };
  };
  const A = sum(arms.name); const B = sum(arms.name_city);
  const byKey = new Map(arms.name.map((r) => [r.key, r]));
  let same = 0; let onlyName = 0; let onlyCity = 0; let differ = 0;
  for (const r of arms.name_city) {
    const a = byKey.get(r.key);
    if (a?.url && r.url) { if (a.url === r.url) same += 1; else differ += 1; } else if (a?.url) onlyName += 1; else if (r.url) onlyCity += 1;
  }
  const pct = (x, n) => (n ? `${Math.round((x / n) * 1000) / 10}%` : '—');
  const line = (label, k) => `| ${label} | ${A[k]} (${pct(A[k], A.n)}) | ${B[k]} (${pct(B[k], B.n)}) |`;
  const md = [
    `## Find: name vs name + city (${people.length} customers, same people both ways)`, '',
    '| | Name only | Name + city |', '|---|---|---|',
    line('Matched an account', 'matched'), line('Several possible', 'ambiguous'), line('No account', 'none'), line('Failed', 'failed'),
    line('Over the follower bar', 'over_bar'), line('Likely (score 70+)', 'likely'), line('Likely and over the bar', 'likely_over_bar'),
    `| Spend | $${A.cost} | $${B.cost} |`, '',
    `Same account both ways: ${same}. Different account: ${differ}. Found only by name: ${onlyName}. Found only with the city: ${onlyCity}.`,
  ].join('\n');
  console.log(md);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

await run().catch((e) => { console.error(e?.message || e); process.exit(1); });
}
