import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  MAX_ATTACHMENT_BYTES,
  STORAGE_BUCKET,
  cadenceLabel,
  defaultQueryIndex,
  fetchAllRows,
  queryIndicesForSchedule,
  renderSubject,
  resolveSql,
  isTransientDeliveryError,
  rowsToCsv,
  sanitizeFilename,
} from './lib/report-email-deliver-core.mjs';

// Anything interpolated into the email body -- a schedule name, a report title,
// a company name -- is text an admin typed, and the body is HTML.
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-silo-report-email-cron',
  'Content-Type': 'application/json',
};

const FROM_FALLBACK = 'SILO <noreply@silo-baseballism.com>';

function utf8Base64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function resolveSender(db, companyId, actorEmail) {
  try {
    const { data, error } = await db.rpc('resolve_notification_sender', {
      p_company_entity_id: companyId,
      p_purpose: 'report_email',
      p_actor_email: actorEmail ?? null,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.from_header) return { from: FROM_FALLBACK, replyTo: actorEmail ?? null };
    return { from: row.from_header, replyTo: row.reply_to ?? actorEmail ?? null };
  } catch {
    return { from: FROM_FALLBACK, replyTo: actorEmail ?? null };
  }
}

async function signCreatorJwt(jwtSecret, supabaseUrl, creatorId, expSeconds = 600) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const b64url = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url({
    sub: creatorId,
    role: 'authenticated',
    aud: 'authenticated',
    iss: `${supabaseUrl.replace(/\/$/, '')}/auth/v1`,
    iat: now,
    exp: now + expSeconds,
  });
  const sigInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(sigInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${sigInput}.${sigB64}`;
}

// RLS scopes every read to active_company_id(), which reads
// profiles.active_company_id -- a PERSISTED column, not a session value. So
// running the export as the schedule's creator means repointing that column at
// the schedule's company, and the first version of this function never put it
// back: a creator who belongs to two companies would find SILO showing the
// other company's data every morning after the cron ran, with nothing to
// explain it. Read the old value, set it only if it differs, and restore it in
// a finally block whatever the export does.
async function clientForScheduleRun(serviceDb, env, schedule, userJwt) {
  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;
  let token = userJwt;
  if (!token) {
    const secret = env.SUPABASE_JWT_SECRET || env.JWT_SECRET;
    if (!secret) throw new Error('SUPABASE_JWT_SECRET not configured for scheduled delivery');
    token = await signCreatorJwt(secret, url, schedule.created_by);
  }
  const client = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const actorId = userJwt ? null : schedule.created_by;
  let previousCompanyId = null;
  let changed = false;
  if (actorId) {
    const { data: prof } = await serviceDb.from('profiles')
      .select('active_company_id').eq('id', actorId).maybeSingle();
    previousCompanyId = prof?.active_company_id ?? null;
  }
  if (previousCompanyId !== schedule.company_entity_id) {
    const { error: coErr } = await client.rpc('set_active_company', { p_entity_id: schedule.company_entity_id });
    if (coErr) throw new Error(`set_active_company: ${coErr.message}`);
    changed = true;
  }

  const restore = async () => {
    if (!changed || !actorId) return;
    // Service role, not the minted token: the minted JWT may have expired by
    // now, and a failed restore must not mask the export's own error.
    const { error } = await serviceDb.from('profiles')
      .update({ active_company_id: previousCompanyId }).eq('id', actorId);
    if (error) console.error('[report-email-deliver] restore active_company_id', error.message);
  };
  return { client, restore };
}

async function loadReportTargets(serviceDb, schedule) {
  if (schedule.target_kind === 'report') {
    const { data: report, error } = await serviceDb.from('silo_chat_saved_reports')
      .select('id, title, queries_run, parameters, columns_metadata, company_entity_id, source')
      .eq('id', schedule.report_id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!report) throw new Error('Report not found');
    const indices = queryIndicesForSchedule(schedule, report);
    return indices.map((qi) => ({ report, queryIndex: qi, label: report.title }));
  }
  const { data: widgets, error: wErr } = await serviceDb.from('dashboard_widgets')
    .select('report_id, query_index, title, visual_type')
    .eq('dashboard_id', schedule.dashboard_id)
    .not('report_id', 'is', null)
    .order('sort_order');
  if (wErr) throw new Error(wErr.message);
  const out = [];
  for (const w of widgets || []) {
    if (w.visual_type === 'section' || w.visual_type === 'answer') continue;
    const { data: report, error } = await serviceDb.from('silo_chat_saved_reports')
      .select('id, title, queries_run, parameters, columns_metadata, company_entity_id, source')
      .eq('id', w.report_id).maybeSingle();
    if (error || !report) continue;
    const qi = Number.isFinite(w.query_index) ? w.query_index : defaultQueryIndex(report.queries_run || []);
    out.push({ report, queryIndex: qi, label: w.title || report.title });
  }
  if (!out.length) throw new Error('Dashboard has no exportable report widgets');
  return out;
}

async function mergeParameterState(serviceDb, schedule) {
  let state = { ...(schedule.parameter_state || {}) };
  if (schedule.filter_view_id) {
    const { data: view } = await serviceDb.from('dashboard_filter_views')
      .select('filter_state').eq('id', schedule.filter_view_id).maybeSingle();
    if (view?.filter_state) state = { ...view.filter_state, ...state };
  }
  if (schedule.target_kind === 'dashboard' && schedule.dashboard_id) {
    const { data: dash } = await serviceDb.from('dashboards')
      .select('filter_state').eq('id', schedule.dashboard_id).maybeSingle();
    if (dash?.filter_state) state = { ...dash.filter_state, ...state };
  }
  return state;
}

async function sendResend(env, sender, to, subject, html, attachments) {
  const key = env.RESEND_API_KEY || '';
  if (!key) return { sent: false, reason: 'RESEND_API_KEY not set' };
  const body = { from: sender.from, to, subject, html };
  if (sender.replyTo) body.reply_to = sender.replyTo;
  if (attachments?.length) body.attachments = attachments;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('[report-email-deliver] resend', res.status, t);
    return { sent: false, reason: `resend ${res.status}` };
  }
  return { sent: true };
}

export function createReportEmailDeliverHandler(deps = {}) {
  const env = deps.env ?? Deno.env.toObject();

  return async function handler(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: CORS });

    const cronSecret = env.REPORT_EMAIL_CRON_SECRET || '';
    const cronHeader = req.headers.get('x-silo-report-email-cron') || '';
    const authHeader = req.headers.get('authorization') || '';
    const userJwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const isCron = cronSecret && cronHeader === cronSecret;

    let body;
    try { body = await req.json(); } catch { body = {}; }
    const scheduleId = body.schedule_id;
    const trigger = body.trigger || (isCron ? 'schedule' : 'manual');
    if (!scheduleId) return new Response(JSON.stringify({ error: 'schedule_id required' }), { status: 400, headers: CORS });

    // Refuse before anything is read: the unauthenticated 404-vs-not-found
    // difference was an existence oracle for schedule ids.
    if (!isCron && !userJwt) {
      return new Response(JSON.stringify({ error: 'authorization required' }), { status: 401, headers: CORS });
    }

    const serviceDb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: schedule, error: sErr } = await serviceDb.from('report_email_schedules')
      .select('*').eq('id', scheduleId).maybeSingle();
    if (sErr || !schedule) {
      return new Response(JSON.stringify({ error: 'schedule not found' }), { status: 404, headers: CORS });
    }

    if (!isCron) {
      const userClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${userJwt}` } },
      });
      const { data: userData } = await userClient.auth.getUser();
      const uid = userData?.user?.id;
      if (!uid) return new Response(JSON.stringify({ error: 'invalid session' }), { status: 401, headers: CORS });
      // This read is the two-step-login gate for this function
      // (supabase/functions/CLAUDE.md): it goes to PostgREST with the CALLER's
      // token, so the pre-request hook refuses an enrolled user's aal1 session
      // here, before the service-role work below. It must therefore fail CLOSED
      // on an error, not just on a missing row -- the first version read only
      // `data` and let the error fall on the floor.
      const { data: mem, error: memErr } = await userClient.from('entity_memberships')
        .select('role').eq('entity_id', schedule.company_entity_id).eq('user_id', uid).maybeSingle();
      if (memErr) {
        const code = String(memErr.code || '') === 'mfa_required' || /mfa/i.test(memErr.message || '') ? 403 : 503;
        return new Response(JSON.stringify({ error: memErr.message || 'authorization check failed' }), { status: code, headers: CORS });
      }
      if (!mem || !['owner_admin', 'admin'].includes(mem.role)) {
        return new Response(JSON.stringify({ error: 'admin required' }), { status: 403, headers: CORS });
      }
    }

    const { data: runRow, error: runErr } = await serviceDb.from('report_email_runs').insert({
      schedule_id: schedule.id,
      company_entity_id: schedule.company_entity_id,
      status: 'running',
      trigger_kind: trigger === 'test' ? 'test' : (isCron ? 'schedule' : 'manual'),
    }).select('id').single();
    if (runErr) {
      return new Response(JSON.stringify({ error: runErr.message }), { status: 500, headers: CORS });
    }
    const runId = runRow.id;

    try {
      const paramState = await mergeParameterState(serviceDb, schedule);
      const targets = await loadReportTargets(serviceDb, schedule);
      const run = await clientForScheduleRun(serviceDb, env, schedule, isCron ? null : userJwt);

      const attachments = [];
      let totalRows = 0;
      try {
        for (const t of targets) {
          const sql = resolveSql(t.report, t.queryIndex, paramState);
          const rows = await fetchAllRows(run.client, sql);
          totalRows += rows.length;
          const csv = rowsToCsv(rows);
          const fn = `${sanitizeFilename(t.label)}${targets.length > 1 ? `-q${t.queryIndex}` : ''}.csv`;
          attachments.push({ filename: fn, content: utf8Base64(csv) });
        }
      } finally {
        await run.restore();
      }

      const bytes = attachments.reduce((s, a) => s + (a.content?.length || 0) * 0.75, 0);
      let deliveryMode = 'attachment';
      let storagePaths = [];
      if (bytes > MAX_ATTACHMENT_BYTES) {
        deliveryMode = 'storage_link';
        storagePaths = [];
        for (const a of attachments) {
          const path = `${schedule.company_entity_id}/${schedule.id}/${runId}/${a.filename}`;
          const bin = Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0));
          const { error: upErr } = await serviceDb.storage.from(STORAGE_BUCKET).upload(path, bin, {
            contentType: 'text/csv', upsert: true,
          });
          if (upErr) throw new Error(`storage upload: ${upErr.message}`);
          storagePaths.push(path);
        }
        attachments.length = 0;
      }

      const { data: recipients, error: rErr } = await serviceDb.rpc('resolve_report_email_recipients', {
        p_schedule_id: schedule.id,
      });
      if (rErr) throw new Error(rErr.message);
      const emails = [...new Set((recipients || []).map((r) => r.email).filter(Boolean))];
      if (!emails.length) throw new Error('No recipients resolved');

      const { data: company } = await serviceDb.from('entities').select('title').eq('id', schedule.company_entity_id).maybeSingle();
      const title = schedule.name || targets[0]?.report?.title || 'Report';
      const subject = renderSubject(schedule.subject_template, {
        title,
        company: company?.title || 'Company',
        date: new Date().toISOString().slice(0, 10),
      });

      let html = `<p>Your scheduled SILO report export is attached.</p><p><strong>${escHtml(title)}</strong> · ${escHtml(cadenceLabel(schedule.cadence_preset))}</p><p>${totalRows.toLocaleString()} rows exported across ${targets.length} file(s).</p>`;
      if (deliveryMode === 'storage_link' && storagePaths.length) {
        const links = [];
        for (const p of storagePaths) {
          const { data: signed } = await serviceDb.storage.from(STORAGE_BUCKET).createSignedUrl(p, 60 * 60 * 24 * 7);
          if (signed?.signedUrl) links.push(`<li><a href="${escHtml(signed.signedUrl)}">${escHtml(p.split('/').pop())}</a> (7 days)</li>`);
        }
        html += `<p>Files were too large for email. Download:</p><ul>${links.join('')}</ul>`;
      }

      let actorEmail = null;
      if (!isCron && userJwt) {
        const { data: u } = await createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${userJwt}` } },
        }).auth.getUser();
        actorEmail = u?.user?.email ?? null;
      }
      const sender = await resolveSender(serviceDb, schedule.company_entity_id, actorEmail);
      const send = await sendResend(env, sender, emails, subject, html, attachments.length ? attachments : undefined);
      if (!send.sent) throw new Error(send.reason || 'email not sent');

      // next_run_at is deliberately NOT written here. The sync script claims a
      // due row by advancing it (claimSchedule in report-email-deliver-core),
      // and that claim is what stops two overlapping runs delivering twice; a
      // second writer here would hand the slot back and send again.
      await serviceDb.from('report_email_schedules').update({
        last_run_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq('id', schedule.id);

      await serviceDb.from('report_email_runs').update({
        finished_at: new Date().toISOString(),
        status: 'succeeded',
        total_rows: totalRows,
        attachment_count: deliveryMode === 'storage_link' ? 0 : targets.length,
        delivery_mode: deliveryMode,
        storage_paths: storagePaths.length ? storagePaths : null,
        recipient_count: emails.length,
      }).eq('id', runId);

      return new Response(JSON.stringify({
        ok: true, run_id: runId, rows: totalRows, recipients: emails.length, delivery_mode: deliveryMode,
      }), { status: 200, headers: CORS });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('[report-email-deliver]', msg);
      // Pause only on a fault the SCHEDULE owns -- a query that no longer
      // parses, a deleted report, no resolvable recipients. Pausing on a
      // Resend 429, a statement timeout or a missing secret turns one bad
      // minute into a feature that silently stopped, and nobody is told it
      // paused. A transient failure keeps last_error and tries again next slot.
      const transient = isTransientDeliveryError(msg);
      await serviceDb.from('report_email_schedules').update({
        last_error: msg.slice(0, 500),
        is_paused: trigger !== 'test' && !transient,
        updated_at: new Date().toISOString(),
      }).eq('id', schedule.id);
      await serviceDb.from('report_email_runs').update({
        finished_at: new Date().toISOString(),
        status: 'failed',
        error_message: msg.slice(0, 2000),
      }).eq('id', runId);
      return new Response(JSON.stringify({ error: msg, run_id: runId }), { status: 500, headers: CORS });
    }
  };
}
