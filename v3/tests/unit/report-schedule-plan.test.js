/* What a schedule does, in words (v3/js/report-schedule-plan.js).
 *
 * Every assertion here is about a claim shown to a person, and most of them
 * are about a claim NOT being made:
 *
 *   * "Sent" is never "Delivered". SILO hands the mail to a provider and is
 *     told nothing afterwards, so the strongest honest word is "Sent".
 *   * the time someone picks is the EARLIEST a send can leave, because the
 *     runner is a cron with fixed slots -- so the panel says a window.
 *   * a failure says what to do next, and whether it will retry on its own,
 *     which is read from is_paused rather than guessed.
 *   * a cadence is parsed, never matched against a list of names, so the four
 *     presets 20261120040000 adds compute the right weekday.
 *
 * The parser is deliberately written twice -- here for the UI, and in
 * report-email-schedule.js, which the runner-agreement test loads ALONE in a
 * bare global and which therefore cannot read a sibling script. The first
 * assertion below is that the two agree, which is the only thing that makes
 * that duplication safe.
 */
'use strict';

// Plain assert, not assert/strict: lib/load.js evaluates these modules in a
// node VM, so their arrays and objects come from another realm and
// deepStrictEqual fails on the prototype rather than on the values.
const assert = require('assert');
const { loadV3 } = require('../lib/load');

const g = loadV3(['report-schedule-plan.js', 'report-email-schedule.js']);
const PL = g.SiloReportSchedulePlan;
const S = g.SiloReportEmailSchedule;

const ZONE = 'America/Los_Angeles';
const ZONE_LABEL = 'Pacific Time (US & Canada)';

// ── The matrix, and the two parsers that must agree about it ─────────────
{
  const matrix = [];
  for (const f of PL.FREQUENCIES) for (const t of PL.DELIVERY_TIMES) matrix.push(PL.presetFor(f.id, t.id));
  assert.deepEqual(matrix.slice().sort(), [
    'daily_0600', 'daily_0700',
    'month_first_0600', 'month_first_0700',
    'monday_0600', 'monday_0700',
    'weekdays_0600', 'weekdays_0700',
  ].sort(), 'four frequencies x two delivery times, and nothing else');

  // Only the two times the delivery runner can actually hit. 13:00/14:00 UTC
  // is 6:00/7:00 Pacific under PDT and 14:00/15:00 under PST, so both are
  // covered all year; 18:00 UTC is 11:00 in summer and 10:00 in winter, which
  // is why no third time is offered. Adding one means adding a cron slot
  // first, so this is asserted rather than left to a reviewer to notice.
  assert.deepEqual(PL.DELIVERY_TIMES.map((t) => t.id), ['0600', '0700']);
  assert.deepEqual([...PL.RUNNER_SLOTS_UTC], [13, 14, 15, 18, 23]);

  for (const preset of matrix.concat(['', null, 'weekdays', 'weekdays_7', 'weekdays_9999',
    'fortnightly_0700', 'weekdays_0700x', 'WEEKDAYS_0700'])) {
    const a = PL.parsePreset(preset);
    const b = S.parseCadence(preset);
    assert.deepEqual(a, b, `the UI and the cadence module disagree about ${JSON.stringify(preset)}`);
  }
  assert.equal(PL.parsePreset('weekdays_9999'), null, 'an impossible time is not a cadence');
  assert.equal(PL.parsePreset('fortnightly_0700'), null, 'an unknown frequency is not a cadence');
  // A half it does not know falls back rather than composing a value the
  // CHECK would refuse at save time.
  assert.equal(PL.presetFor('fortnightly', '0300'), 'weekdays_0700');
}

// ── Saveable before the migration lands ─────────────────────────────────
// 20261120040000 widens the CHECK. Until it is applied the panel can still
// offer the matrix, as long as it can say which value works today -- a
// Postgres constraint name is not an answer a merchant can act on.
{
  assert.deepEqual([...PL.LEGACY_PRESETS].sort(),
    ['daily_0600', 'monday_0700', 'month_first_0700', 'weekdays_0700'].sort());
  for (const p of PL.LEGACY_PRESETS) {
    assert.equal(PL.isLegacyPreset(p), true);
    assert.equal(PL.legacyFallbackFor(p), null, 'a saveable preset needs no fallback');
  }
  assert.equal(PL.legacyFallbackFor('weekdays_0600'), 'weekdays_0700');
  assert.equal(PL.legacyFallbackFor('daily_0700'), 'daily_0600');
  assert.equal(PL.legacyFallbackFor('monday_0600'), 'monday_0700');
  assert.equal(PL.legacyFallbackFor('month_first_0600'), 'month_first_0700');
  assert.equal(PL.legacyFallbackFor('nonsense'), null);

  const said = S.cadenceRefusalMessage('monday_0600', 'violates check constraint "report_email_schedules_cadence_preset_check"');
  assert.match(said, /not available on this workspace yet/);
  assert.match(said, /Every Monday · 7:00 AM/, 'and names the time that does work');
  assert.doesNotMatch(said, /check constraint/, 'Postgres’s own words are not an instruction');
  assert.equal(S.isCadenceRefusal('violates check constraint "report_email_schedules_cadence_preset_check"'), true);
  assert.equal(S.isCadenceRefusal('new row violates row-level security policy'), false,
    'a permission refusal must not be reported as a pending migration');
}

// ── The sentence ────────────────────────────────────────────────────────
{
  assert.equal(
    PL.sentence({
      frequency: 'monday', time: '0700', timezone: ZONE, timezoneLabel: ZONE_LABEL,
      periodLabel: 'Last week', reportTitle: 'Sales by day',
    }),
    'Every Monday at 7:00 AM Pacific Time (US & Canada), send last week of Sales by day.',
  );
  assert.equal(
    PL.sentence({ frequency: 'weekdays', time: '0600', timezone: ZONE, timezoneLabel: ZONE_LABEL,
      periodLabel: '', reportTitle: 'Open purchase orders' }),
    'Every weekday at 6:00 AM Pacific Time (US & Canada), send Open purchase orders.',
    'a report with no date window is not given an invented period',
  );
  assert.equal(
    PL.sentence({ frequency: 'month_first', time: '0700', timezone: ZONE, timezoneLabel: ZONE_LABEL,
      periodLabel: 'Last month', reportTitle: '' }),
    'On the 1st of each month at 7:00 AM Pacific Time (US & Canada), send last month.',
  );
  assert.equal(PL.sentence({ frequency: 'nope', time: '0700' }), '',
    'no sentence at all rather than one with a blank in it');
  // The zone is DATA: with no label the IANA name is made readable, and no
  // zone name is written in the module.
  assert.equal(PL.zoneWords(ZONE, ZONE_LABEL), ZONE_LABEL);
  assert.equal(PL.zoneWords('America/New_York', ''), 'New York time');
  assert.equal(PL.zoneWords('', ''), '');
}

// ── The window a send really leaves in ──────────────────────────────────
{
  // 14:00 UTC is a slot, so a 7:00 Pacific send under PST leaves on time.
  assert.equal(PL.runnerSlotAfter('2026-11-23T14:00:00.000Z'), '2026-11-23T14:05:00.000Z');
  assert.equal(PL.slotDelayMinutes('2026-11-23T14:00:00.000Z'), 5);
  // 16:00 UTC is not a slot: the next one is 18:05, two hours later. This is
  // the honest cost of a cron runner, and the panel says so rather than
  // implying a send at the minute someone picked.
  assert.equal(PL.runnerSlotAfter('2026-11-23T16:00:00.000Z'), '2026-11-23T18:05:00.000Z');
  assert.equal(PL.slotDelayMinutes('2026-11-23T16:00:00.000Z'), 125);
  // Past the last slot of the day, it rolls to the first of the next.
  assert.equal(PL.runnerSlotAfter('2026-11-23T23:30:00.000Z'), '2026-11-24T13:05:00.000Z');
  assert.equal(PL.runnerSlotAfter('not-a-date'), null);
  assert.equal(PL.slotDelayMinutes(''), null, 'an unknown instant claims no window');

  const onTime = PL.firstSendSentence('2026-11-23T14:00:00.000Z', { timezone: ZONE, timezoneLabel: ZONE_LABEL });
  assert.match(onTime, /^First send: Monday, November 23 at 6:00 AM Pacific Time \(US & Canada\)\.$/,
    onTime);
  const late = PL.firstSendSentence('2026-11-23T16:00:00.000Z', { timezone: ZONE, timezoneLabel: ZONE_LABEL });
  assert.match(late, /leaves within about 2 hours of that/, late);
  assert.equal(PL.firstSendSentence('', {}), '');
  // The date is shown in the COMPANY's zone, not the reader's: a schedule set
  // in company time would otherwise read differently to two colleagues.
  assert.match(PL.inZone('2026-11-23T14:00:00.000Z', 'Asia/Tokyo'), /November 23 at 11:00 PM/);
}

// ── What arrives ────────────────────────────────────────────────────────
{
  assert.match(PL.CONTENTS_LINE, /CSV attachment/);
  assert.match(PL.CONTENTS_LINE, /download link/, 'and what happens when it is too large');
  assert.match(PL.CONTENTS_LINE, /7 days/);
  assert.match(PL.CONTENTS_SHORT, /CSV attachment/);
}

// ── What happened last time ─────────────────────────────────────────────
{
  assert.equal(PL.statusLabel({ last_run_at: '2026-11-20T14:05:00Z', status: 'succeeded' }), 'Sent');
  assert.equal(PL.statusLabel({ last_run_at: '2026-11-20T14:05:00Z', last_run_status: 'succeeded' }), 'Sent');
  assert.equal(PL.statusLabel({ last_run_at: '2026-11-20T14:05:00Z', status: 'failed' }), 'Failed');
  assert.equal(PL.statusLabel({ status: 'running' }), 'Sending');
  assert.equal(PL.statusLabel({}), 'Not sent yet');
  assert.equal(PL.statusTone({ last_run_at: 'x', status: 'succeeded' }), 'pos');
  assert.equal(PL.statusTone({ last_run_at: 'x', status: 'failed' }), 'neg');
  // The one word this module must never produce, in any state.
  for (const row of [{ status: 'succeeded', last_run_at: 'x' }, { status: 'failed', last_run_at: 'x' },
    { status: 'running' }, {}, { last_run_at: 'x' }]) {
    assert.doesNotMatch(PL.statusLabel(row), /deliver/i,
      'SILO is never told the mail was delivered, so it never says so');
  }
  assert.match(PL.SENT_MEANING, /handed the email to the mail provider/);
  assert.match(PL.SENT_MEANING, /not told/);
}

// ── A failure, in plain language, with the next step ────────────────────
{
  const cases = [
    ['No recipients resolved', /Nobody to send it to/, /Add at least one recipient/],
    ['relation "sales_v" does not exist', /query no longer runs/, /Advanced Builder/],
    ['canceling statement due to statement timeout', /took too long/, /Narrow the reporting period/],
    ['resend 429', /could not hand the email to the mail provider/, /Nothing to fix on your side/],
    ['mfa_required', /sign-in check refused/, /Nothing to fix on your side/],
    ['storage upload failed', /could not be stored for download/, /Nothing to fix/],
    ['report not found', /report this schedule points at is gone/, /still exists/],
  ];
  for (const [message, headline, next] of cases) {
    const why = PL.explainFailure(message, { paused: false });
    assert.match(why.headline, headline, message);
    assert.match(why.next, next, message);
    assert.equal(why.detail, message, 'the original message is kept, never replaced');
  }
  // An unrecognised failure is not given an invented cause.
  const unknown = PL.explainFailure('something nobody has seen before', {});
  assert.equal(unknown.headline, 'The last send failed.');
  assert.equal(unknown.detail, 'something nobody has seen before');
  assert.equal(PL.explainFailure('', {}), null);
  assert.equal(PL.explainFailure(null, {}), null);

  // Whether it tries again on its own is read from is_paused, because the
  // delivery side pauses ONLY for a fault the schedule owns and leaves
  // everything else to retry. Telling someone to wait for a retry that will
  // never come is the worst version of this message.
  assert.equal(PL.explainFailure('resend 429', { paused: false }).retries, true);
  assert.match(PL.explainFailure('resend 429', { paused: false }).state, /still on and will try again/);
  assert.equal(PL.explainFailure('No recipients resolved', { paused: true }).retries, false);
  assert.match(PL.explainFailure('No recipients resolved', { paused: true }).state, /will not try again/);

  // Paused by a person, or paused by a failure? The pair answers it, and the
  // Schedules view says which.
  assert.equal(PL.pauseReason({ is_paused: false, last_error: 'x' }), null);
  assert.equal(PL.pauseReason({ is_paused: true, last_error: 'No recipients resolved' }), 'failure');
  assert.equal(PL.pauseReason({ is_paused: true, last_error: null }), 'person');
}

console.log('Schedule plan: cadence matrix, both parsers, the sentence, the delivery window, '
  + 'honest status and plain-language failures passed.');
