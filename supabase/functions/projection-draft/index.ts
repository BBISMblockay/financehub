// projection-draft — propose daily revenue projections from a company's own
// history, for a person to accept in /testing/projections-v2.html.
//
// It reads and answers. It never writes: the page upserts what the person
// accepts, under that person's RLS, exactly as a typed number would be. So the
// worst a confused or prompt-injected answer can do is propose numbers that
// are then shown as a diff and discarded.
//
// Authorization is the caller's JWT and RLS. There is no service-role client
// in this function at all, and the FIRST thing it does with the caller's token
// is a PostgREST read whose error aborts the request — which is what the
// two-step-login and third-party-token rules in supabase/functions/CLAUDE.md
// require of a function that then does work of its own.
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  SYSTEM_PROMPT, TOOL, buildUserMessage, clampRows, indexActuals, readToolUse, validateRequest,
} from './draft-lib.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = Deno.env.get('CHAT_MODEL') || 'claude-sonnet-5';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });

/** One model call's worth of location-days. Keeps the answer inside max_tokens. */
const CELLS_PER_CALL = 200;
const MAX_MODEL_CALLS = 6;
const TIME_BUDGET_MS = 90_000;
const PAGE = 1000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  const startedAt = Date.now();

  try {
    if (!ANTHROPIC_API_KEY) return reply({ error: 'AI drafting is not configured for this project yet.' }, 503);

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return reply({ error: 'Not authenticated' }, 401);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    // First read, with the caller's token: the active company's own locations.
    // RLS decides what comes back, and its error ends the request.
    const { data: locRows, error: locErr } = await caller
      .from('locations')
      .select('id, location_code, location_name, store_type, is_active')
      .eq('is_active', true)
      .order('location_name', { ascending: true });
    if (locErr) return reply({ error: locErr.message }, 403);
    const locations = locRows || [];
    if (!locations.length) return reply({ error: 'This workspace has no active locations to plan.' }, 400);

    const body = await req.json().catch(() => ({}));
    const v = validateRequest(body, locations.map((l: { id: number }) => l.id));
    if ('error' in v) return reply({ error: v.error }, 400);
    const { from, to, dates, locationIds, instruction, onlyEmptyDays } = v;
    const picked = locations.filter((l: { id: number }) => locationIds.some((id) => String(id) === String(l.id)));

    // The plan as stored, so "only the empty days" means the stored truth and
    // not whatever the browser believed when it opened the drawer.
    const { data: planRows, error: planErr } = await caller
      .from('revenue_projections')
      .select('projection_date, location_id, projected_sales')
      .eq('scenario', 'active')
      .gte('projection_date', from).lte('projection_date', to)
      .range(0, 20000);
    if (planErr) return reply({ error: planErr.message }, 403);
    const existing = new Map<string, number>();
    for (const r of planRows || []) {
      existing.set(`${r.location_id}|${String(r.projection_date).slice(0, 10)}`, Number(r.projected_sales) || 0);
    }

    // Actual net sales per location per day for the two years behind the
    // period, through the shared report engine as the caller. The locations ->
    // sales_by_day join is silo_location_slug(), the one definition of it.
    const earliest = new Date(new Date(`${from}T00:00:00Z`).getTime() - (728 + 70) * 86400000)
      .toISOString().slice(0, 10);
    const sql = `select l.id as location_id, s.day_date::text as day_date, sum(s.total_net_sales) as net
      from public.sales_by_day_verification_v s
      join public.locations l
        on public.silo_location_slug(coalesce(nullif(l.location_code, ''), l.location_name)) = s.location_tag
      where s.day_date between '${earliest}'::date and '${to}'::date
      group by 1, 2 order by 2, 1`;
    const histRows: unknown[] = [];
    for (let offset = 0; offset < PAGE * 60; offset += PAGE) {
      const { data, error } = await caller.rpc('chat_run_readonly_query', { query: sql, p_offset: offset });
      if (error) return reply({ error: 'Sales history could not be read: ' + error.message }, 400);
      if (!Array.isArray(data)) return reply({ error: 'Sales history could not be read' }, 400);
      histRows.push(...data);
      if (data.length < PAGE) break;
    }
    const actuals = indexActuals(histRows as { location_id: number; day_date: string; net: number }[]);

    const { data: launchRows } = await caller
      .from('launch_calendar')
      .select('launch_date, title, product_title, launch_type')
      .gte('launch_date', from).lte('launch_date', to)
      .range(0, 5000);
    const launches = new Map<string, string[]>();
    for (const r of launchRows || []) {
      const d = String(r.launch_date || '').slice(0, 10);
      const t = String(r.title || r.product_title || r.launch_type || '').trim();
      if (!d || !t) continue;
      if (!launches.has(d)) launches.set(d, []);
      launches.get(d)!.push(t);
    }

    // Locations are drafted in batches so each model call answers inside its
    // token ceiling. A batch that cannot be reached inside the time budget is
    // reported as not drafted rather than left to look like a zero plan.
    const perBatch = Math.max(1, Math.floor(CELLS_PER_CALL / dates.length)) || 1;
    const batches: typeof picked[] = [];
    for (let i = 0; i < picked.length; i += perBatch) batches.push(picked.slice(i, i + perBatch));

    const proposed: unknown[] = [];
    const rationales: string[] = [];
    let dropped = 0, calls = 0, notDrafted = 0;
    for (const batch of batches) {
      if (calls >= MAX_MODEL_CALLS || Date.now() - startedAt > TIME_BUDGET_MS) {
        notDrafted += batch.length; continue;
      }
      calls++;
      const userMessage = buildUserMessage({
        from, to, dates, locations: batch, actuals, launches, existing,
        onlyEmptyDays, instruction,
      });
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 8192,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: [TOOL],
          tool_choice: { type: 'tool', name: TOOL.name },
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error('[projection-draft] model call failed', res.status, detail.slice(0, 300));
        if (!proposed.length) return reply({ error: `The drafting model answered ${res.status}. Try again shortly.` }, 502);
        notDrafted += batch.length; continue;
      }
      const message = await res.json();
      if (message?.stop_reason === 'max_tokens') {
        // A cut-off answer is a partial list of days, not a finished plan.
        notDrafted += batch.length; continue;
      }
      const { rationale, rows } = readToolUse(message);
      const clamped = clampRows(rows, { dates, locationIds: batch.map((l: { id: number }) => l.id), existing, onlyEmptyDays });
      proposed.push(...clamped.rows);
      dropped += clamped.dropped.length;
      if (rationale) rationales.push(rationale);
    }

    if (!proposed.length) {
      return reply({
        error: notDrafted
          ? 'The draft did not come back in time. Try one location, or a shorter period.'
          : 'The draft proposed nothing for these days.',
      }, 502);
    }

    let rationale = rationales.join(' ');
    if (notDrafted) rationale += ` ${notDrafted} location${notDrafted === 1 ? '' : 's'} were not drafted in this pass — run it again for those.`;
    if (dropped) rationale += ` ${dropped} proposed row${dropped === 1 ? '' : 's'} were outside the period or already planned and were dropped.`;

    return reply({
      rows: proposed,
      rationale: rationale.trim(),
      model: MODEL,
      period: { from, to },
      locations_drafted: picked.length - notDrafted,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (e) {
    console.error('[projection-draft]', e);
    return reply({ error: 'The draft could not be built: ' + ((e as Error)?.message || String(e)) }, 500);
  }
});
