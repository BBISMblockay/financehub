process.on('uncaughtException', (error) => { console.error('\nFAILED:', error.message); process.exit(1); });
process.on('unhandledRejection', (error) => { console.error('\nFAILED:', error?.message || error); process.exit(1); });

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from './finance-db/node_modules/@electric-sql/pglite/dist/index.js';

const root = new URL('../../', import.meta.url);
const migrationUrl = new URL('supabase/migrations/20260922023803_pause_legacy_slack_notifications.sql', root);
const functionUrl = new URL('supabase/functions/notify-slack/index.ts', root);
const db = new PGlite();
let checks = 0;
const test = async (name, fn) => { await fn(); checks += 1; console.log(`ok ${checks} - ${name}`); };

await db.exec(`
  create schema cron;
  create table cron.job(jobid bigint primary key, jobname text, command text);
  create function cron.unschedule(p_job_id bigint) returns boolean
  language plpgsql as $$
  begin
    delete from cron.job where jobid = p_job_id;
    return found;
  end $$;

  create table public.payment_requests(id bigint);
  create table public.po_headers(id bigint, status text);
  create table public.product_samples(id bigint);
  create table public.launch_tasks(id bigint);
  create table public.launch_calendar(id bigint);
  create table public.launch_comments(id bigint);

  create function public.legacy_slack_trigger() returns trigger
  language plpgsql as $$ begin return new; end $$;
  create function public.sample_notify_trigger() returns trigger
  language plpgsql as $$ begin return new; end $$;

  create function public.notify_slack_payment_request() returns trigger language plpgsql as $$ begin return new; end $$;
  create function public.notify_slack_po_created() returns trigger language plpgsql as $$ begin return new; end $$;
  create function public.notify_slack_po_sent() returns trigger language plpgsql as $$ begin return new; end $$;
  create function public.notify_slack_sample_created() returns trigger language plpgsql as $$ begin return new; end $$;
  create function public.notify_slack_task_created() returns trigger language plpgsql as $$ begin return new; end $$;
  create function public.notify_slack_launch_created() returns trigger language plpgsql as $$ begin return new; end $$;
  create function public.notify_slack_launch_comment() returns trigger language plpgsql as $$ begin return new; end $$;
  create function public.send_daily_slack_summary() returns void language sql as $$ select $$;

  create trigger trg_slack_payment_request after insert on public.payment_requests for each row execute function public.notify_slack_payment_request();
  create trigger trg_slack_po_created after insert on public.po_headers for each row execute function public.notify_slack_po_created();
  create trigger trg_slack_po_sent after update of status on public.po_headers for each row execute function public.notify_slack_po_sent();
  create trigger trg_slack_sample_created after insert on public.product_samples for each row execute function public.notify_slack_sample_created();
  create trigger trg_slack_task_created after insert on public.launch_tasks for each row execute function public.notify_slack_task_created();
  create trigger trg_slack_launch_created after insert on public.launch_calendar for each row execute function public.notify_slack_launch_created();
  create trigger trg_slack_launch_comment after insert on public.launch_comments for each row execute function public.notify_slack_launch_comment();

  -- This newer trigger must survive because it still sends tenant-aware email.
  create trigger trg_sample_notify after insert on public.product_samples for each row execute function public.sample_notify_trigger();
  insert into cron.job values
    (1, 'silo-daily-slack-summary', 'select public.send_daily_slack_summary();'),
    (2, 'unrelated-job', 'select 1');
`);

const migration = await readFile(migrationUrl, 'utf8');
await db.exec(migration);

await test('all seven shared Slack triggers are gone', async () => {
  const result = await db.query(`select tgname from pg_trigger where not tgisinternal and tgname like 'trg_slack_%'`);
  assert.deepEqual(result.rows, []);
});

await test('the tenant-aware sample notification trigger remains', async () => {
  const result = await db.query(`select tgname from pg_trigger where not tgisinternal and tgname='trg_sample_notify'`);
  assert.equal(result.rows.length, 1);
});

await test('only the Slack cron is unscheduled', async () => {
  const result = await db.query(`select jobname from cron.job order by jobid`);
  assert.deepEqual(result.rows.map((row) => row.jobname), ['unrelated-job']);
});

await test('legacy database functions are retired', async () => {
  const result = await db.query(`select proname from pg_proc where proname like 'notify_slack_%' or proname='send_daily_slack_summary'`);
  assert.deepEqual(result.rows, []);
});

await test('the migration is safe to run again', async () => {
  await db.exec(migration);
  const result = await db.query(`select jobname from cron.job order by jobid`);
  assert.deepEqual(result.rows.map((row) => row.jobname), ['unrelated-job']);
});

await test('the checked-in endpoint cannot deliver to Slack', async () => {
  const source = await readFile(functionUrl, 'utf8');
  assert.doesNotMatch(source, /hooks\.slack\.com|SLACK_URL|fetch\s*\(/);
  assert.match(source, /legacy_slack_paused/);
});

await db.close();
console.log(`${checks} legacy Slack pause checks passed.`);
