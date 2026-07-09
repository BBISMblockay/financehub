// scripts/generate-insights.mjs — nightly Action Items & Insights digest.
//
// For each company: pulls structured findings from compute_silo_insights()
// (SQL rules engine — see the migration for what counts as a finding),
// then asks an LLM to synthesize them into a short prioritized narrative.
// The model is given ONLY the findings JSON and instructed not to invent
// any fact beyond it — the findings themselves (not the prose) are the
// source of truth, and the UI renders both side by side.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.INSIGHTS_MODEL || 'claude-sonnet-5';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SYSTEM_PROMPT = `You write a short daily business briefing for an internal retail operations dashboard called SILO.

You will be given a JSON array of findings, each with: domain (sales/inventory/purchasing/planning/ar/ap), severity (critical/warning/info), title, detail, metric, link_href.

Rules:
- Use ONLY the facts in the findings. Never invent a number, name, or claim that isn't present in the JSON.
- Do not discuss data reconciliation, syncing, or tie-outs — that's not what this briefing is for.
- Write in plain business English, second person ("Reorder X", "Follow up with Y"), like a sharp operations manager giving a 60-second briefing.
- Group by priority: critical findings first, then warning, then info. Skip a group entirely if it has no findings.
- If there are zero findings, write one sentence saying nothing needs attention right now.
- Keep it under 220 words total. No markdown headers, no bullet-point dashes — short paragraphs or a simple numbered list is fine.
- Do not mention "findings", "JSON", "the data provided", or otherwise refer to your own inputs — just write the briefing.`;

async function callAnthropic(findings) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(findings) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('').trim();
}

async function main() {
  const { data: companies, error } = await supabase
    .from('entities')
    .select('id, title')
    .eq('entity_type', 'company');
  if (error) throw new Error(`entities load failed: ${error.message}`);

  if (!ANTHROPIC_API_KEY) {
    console.log('[insights] ANTHROPIC_API_KEY not set — storing findings without a narrative for all companies.');
  }

  let hadError = false;
  for (const company of companies || []) {
    try {
      const { data: findings, error: findErr } = await supabase.rpc('compute_silo_insights', {
        p_company_entity_id: company.id,
      });
      if (findErr) throw new Error(`compute_silo_insights failed: ${findErr.message}`);

      let narrative = null;
      let model = null;
      if (ANTHROPIC_API_KEY) {
        try {
          narrative = await callAnthropic(findings || []);
          model = MODEL;
        } catch (err) {
          console.error(`[insights] ${company.title}: narrative generation failed — ${err.message}`);
        }
      }

      const { error: upsertErr } = await supabase.from('silo_insights_digest').upsert({
        company_entity_id: company.id,
        generated_at: new Date().toISOString(),
        findings: findings || [],
        narrative,
        model,
      }, { onConflict: 'company_entity_id' });
      if (upsertErr) throw new Error(`digest upsert failed: ${upsertErr.message}`);

      console.log(`[ok] ${company.title}: ${findings?.length || 0} findings${narrative ? ', narrative written' : ''}`);
    } catch (err) {
      hadError = true;
      console.error(`[error] ${company.title}: ${err.message || err}`);
    }
  }

  if (hadError) process.exit(1);
}

main().catch((err) => {
  console.error('[insights] fatal', err);
  process.exit(1);
});
