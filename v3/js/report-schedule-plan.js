/* ============================================================================
   SILO v3 — what a schedule does, in words
   --------------------------------------------------------------------------
   Pure. No DOM, no Supabase, so node can execute every decision.

   This module exists because the schedule panel used to be a form over the
   storage shape: one "How often" dropdown whose four options each baked in an
   hour, a period picker, a wall of recipient checkboxes, and nothing anywhere
   that said what would actually arrive, when, or carrying what. Someone who
   has never written SQL cannot check their own work against that.

   Everything here answers one of four questions a person asks before they
   press Save, and each answer is derived from stored state rather than typed
   into the UI twice:

     * WHEN will it send?            frequency x delivery time, in words
     * WHAT WINDOW will it cover?    the reporting period, separately
     * WHAT ARRIVES?                 data in the mail, or a link to it
     * WHAT HAPPENED LAST TIME?      and, if it failed, what to do next

   Two rules this file is built to keep:

   1. Delivery TIME and the reporting PERIOD are different decisions. "Every
      Monday at 7:00 AM" is when the mail leaves; "last week" is what it
      covers. They were one control, and a reader could not tell which one a
      date was describing.
   2. Never claim more than the system knows. SILO hands the mail to a
      provider and learns nothing afterwards -- there is no webhook, no
      per-recipient receipt -- so the strongest honest word is "Sent", never
      "Delivered". And the runner is a cron with fixed slots, so the time a
      person picks is the EARLIEST a send can leave, not a guarantee.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ── When ──────────────────────────────────────────────────────────────
     A cadence_preset is `<frequency>_<HHMM>` in the company's business
     timezone (20261013180000, matrix completed by 20261120040000). The two
     halves are offered as two controls and recombined here, so the storage
     shape stays exactly what the delivery side already parses. */

  const FREQUENCIES = Object.freeze([
    { id: 'weekdays', label: 'Every weekday', phrase: 'Every weekday' },
    { id: 'daily', label: 'Every day', phrase: 'Every day' },
    { id: 'monday', label: 'Every Monday', phrase: 'Every Monday' },
    { id: 'month_first', label: 'First of the month', phrase: 'On the 1st of each month' },
  ]);

  /* Only the times the delivery runner can actually hit.

     `report-email-sync.yml` is a GitHub Actions cron at `5 13,14,15,18,23 * * *`
     and it selects every schedule whose next_run_at has PASSED. 13:00/14:00 UTC
     is 6:00/7:00 Pacific under PDT; 14:00/15:00 is 6:00/7:00 under PST. So both
     of these times are covered the whole year round. The later slots are
     catch-ups and are NOT offered as times: 18:00 UTC is 11:00 Pacific in
     summer and 10:00 in winter, so an hour named from them would be an hour
     wrong for half the year. Adding a time here means adding a cron slot that
     covers it under both offsets first. */
  const DELIVERY_TIMES = Object.freeze([
    { id: '0600', label: '6:00 AM', hour: 6, minute: 0 },
    { id: '0700', label: '7:00 AM', hour: 7, minute: 0 },
  ]);

  /* The slots the runner wakes in, UTC hours, with its five-minute offset.
     Used to tell someone the window their mail leaves in, instead of implying
     a send at the minute they picked. */
  const RUNNER_SLOTS_UTC = Object.freeze([13, 14, 15, 18, 23]);
  const RUNNER_SLOT_MINUTE = 5;

  const DEFAULT_FREQUENCY = 'weekdays';
  const DEFAULT_TIME = '0700';
  /* The four values that existed before 20261120040000. A workspace whose
     database has not had that migration applied can still save these, so the
     panel can fall back to them instead of refusing to save at all. */
  const LEGACY_PRESETS = Object.freeze([
    'weekdays_0700', 'daily_0600', 'monday_0700', 'month_first_0700',
  ]);

  function parsePreset(preset) {
    const m = /^([a-z_]+)_(\d{2})(\d{2})$/.exec(String(preset || ''));
    if (!m) return null;
    const [, frequency, hh, mm] = m;
    if (!FREQUENCIES.some((f) => f.id === frequency)) return null;
    const hour = Number(hh);
    const minute = Number(mm);
    if (hour > 23 || minute > 59) return null;
    return { frequency, time: `${hh}${mm}`, hour, minute };
  }

  /** `weekdays` + `0600` -> `weekdays_0600`. Unknown halves fall back to the
   *  defaults rather than composing a preset the CHECK would refuse. */
  function presetFor(frequency, time) {
    const f = FREQUENCIES.some((x) => x.id === frequency) ? frequency : DEFAULT_FREQUENCY;
    const t = DELIVERY_TIMES.some((x) => x.id === time) ? time : DEFAULT_TIME;
    return `${f}_${t}`;
  }

  /** True when this preset predates the cadence matrix, so it is saveable on
   *  a database that has not had 20261120040000 applied. */
  function isLegacyPreset(preset) { return LEGACY_PRESETS.includes(String(preset || '')); }

  /** The preset closest to the one asked for that a pre-matrix database will
   *  accept: same frequency, the hour that frequency originally shipped with.
   *  Returns null when the preset is already saveable. */
  function legacyFallbackFor(preset) {
    if (isLegacyPreset(preset)) return null;
    const parsed = parsePreset(preset);
    if (!parsed) return null;
    return LEGACY_PRESETS.find((p) => parsePreset(p).frequency === parsed.frequency) || null;
  }

  const timeLabel = (time) => DELIVERY_TIMES.find((t) => t.id === time)?.label || '';
  const frequencyPhrase = (frequency) => FREQUENCIES.find((f) => f.id === frequency)?.phrase || '';

  /* ── Timezone in words ─────────────────────────────────────────────────
     The label comes from `supported_business_timezones.label` ("Pacific Time
     (US & Canada)"), which is DATA, so no zone name is written here. A zone
     with no label falls back to the IANA name's last segment, which reads
     better than the whole path. */
  function zoneWords(tzName, label) {
    const clean = String(label || '').trim();
    if (clean) return clean;
    const name = String(tzName || '').trim();
    if (!name) return '';
    return name.split('/').pop().replace(/_/g, ' ');
  }

  /* ── The sentence ──────────────────────────────────────────────────────
     "Every Monday at 7:00 AM Pacific Time (US & Canada), send last week's
     Daily Sales." One line that a person can check against what they meant.
     The period comes in as a label already decided by the period picker, so
     this file never re-derives what a window means. */
  function sentence(plan) {
    const p = plan || {};
    const when = frequencyPhrase(p.frequency);
    const at = timeLabel(p.time);
    if (!when || !at) return '';
    const zone = zoneWords(p.timezone, p.timezoneLabel);
    const head = `${when} at ${at}${zone ? ` ${zone}` : ''}`;
    const period = String(p.periodLabel || '').trim();
    const title = String(p.reportTitle || '').trim();
    const what = [period ? period.toLowerCase() : '', title].filter(Boolean).join(' of ');
    if (!what) return `${head}, send this report.`;
    return `${head}, send ${what}.`;
  }

  /* ── First send, and the window it really leaves in ───────────────────── */

  const WEEKDAY_MONTH = {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  };

  /** A date formatted in the company's zone, not the reader's: a schedule is
   *  set in company time and showing it in the reader's would make the same
   *  schedule read differently to two colleagues. */
  function inZone(iso, tz, opts) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('en-US', { ...(opts || WEEKDAY_MONTH), timeZone: tz || 'UTC' });
    } catch (_) {
      return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    }
  }

  /**
   * The first runner slot at or after an instant.
   *
   * next_run_at is the moment a schedule becomes DUE; the runner then picks it
   * up in its next slot. Without this a panel saying "7:00 AM" implies a send
   * at 7:00, and the mail arrives whenever Actions got round to it -- which for
   * a non-Pacific zone can be hours. Returns null when the instant is
   * unreadable, and never fabricates a slot.
   */
  function runnerSlotAfter(iso) {
    const due = new Date(iso);
    if (!iso || Number.isNaN(due.getTime())) return null;
    for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
      for (const hour of RUNNER_SLOTS_UTC) {
        const slot = new Date(Date.UTC(
          due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate() + dayOffset,
          hour, RUNNER_SLOT_MINUTE, 0,
        ));
        if (slot.getTime() >= due.getTime()) return slot.toISOString();
      }
    }
    return null;
  }

  /**
   * How late the first send can be, in whole minutes, because the runner wakes
   * on fixed slots. Zero means the slot lands on the due minute. Null when it
   * cannot be worked out, which the UI must treat as "do not claim a window".
   */
  function slotDelayMinutes(iso) {
    const slot = runnerSlotAfter(iso);
    if (!slot) return null;
    return Math.round((new Date(slot).getTime() - new Date(iso).getTime()) / 60000);
  }

  /**
   * "First send: Monday, November 24 at 7:00 AM Pacific Time (US & Canada)."
   * Plus, when the runner's slot is materially later than the time picked, the
   * truth about that: it is the difference between a promise and a window.
   */
  function firstSendSentence(nextRunIso, opts) {
    const o = opts || {};
    const when = inZone(nextRunIso, o.timezone);
    if (!when) return '';
    const zone = zoneWords(o.timezone, o.timezoneLabel);
    const late = slotDelayMinutes(nextRunIso);
    const tail = (late != null && late >= 15)
      ? ` SILO checks for due reports a few times a day, so this one leaves within about ${
        late < 60 ? `${late} minutes` : `${Math.round(late / 60)} hour${Math.round(late / 60) === 1 ? '' : 's'}`} of that.`
      : '';
    return `First send: ${when}${zone ? ` ${zone}` : ''}.${tail}`;
  }

  /* ── What arrives ──────────────────────────────────────────────────────
     The delivery side attaches the export as CSV, and switches to signed
     download links when the files are too large for mail (handler.mjs,
     `delivery_mode`). So the answer to "does the email contain the data or a
     link to it" is "the data, unless it is too big" -- and the link is to the
     file, not to the report page. Said once, here, so the panel and the
     schedules table cannot describe it differently. */
  const CONTENTS_LINE = 'The email carries the full export as a CSV attachment. '
    + 'If the file is too large for email, SILO attaches nothing and sends a download link that works for 7 days.';

  const CONTENTS_SHORT = 'CSV attachment (download link if too large)';

  /* ── What happened last time ───────────────────────────────────────────── */

  /** The run status in a word. Never "Delivered": SILO hands the mail to a
   *  provider and is told nothing after that, so a 2xx from the provider is
   *  the most it knows. A schedule that has never run says so rather than
   *  showing an empty cell beside an empty date. */
  function statusLabel(row) {
    const r = row || {};
    if (!r.last_run_at && !r.status) return 'Not sent yet';
    const status = String(r.status || r.last_run_status || '');
    if (status === 'succeeded') return 'Sent';
    if (status === 'failed') return 'Failed';
    if (status === 'running') return 'Sending';
    return r.last_run_at ? 'Sent' : 'Not sent yet';
  }

  function statusTone(row) {
    const label = statusLabel(row);
    if (label === 'Failed') return 'neg';
    if (label === 'Sent') return 'pos';
    return '';
  }

  /** Why "Sent" is the honest word, for the tooltip on the status cell. */
  const SENT_MEANING = 'Sent means SILO handed the email to the mail provider and it was accepted. '
    + 'SILO is not told whether each person opened it or whether their mail server bounced it.';

  /**
   * A delivery failure in plain language, with the next step.
   *
   * Matched on the stored `last_error` / `error_message`, which is the
   * delivery side's own text. Order matters: the specific causes first, a
   * truthful fallback last that shows the original message rather than
   * inventing a cause. `retries` says whether the schedule is still running --
   * it is derived from is_paused, because the delivery side pauses only for a
   * fault the schedule owns and leaves everything else to retry.
   */
  const FAILURE_RULES = [
    {
      test: /no recipients resolved|no one to send/i,
      headline: 'Nobody to send it to.',
      next: 'Add at least one recipient, then resume the schedule.',
    },
    {
      test: /undeclared|token|parse|syntax|relation .* does not exist|no stored sql|column .* does not exist/i,
      headline: 'The report’s query no longer runs.',
      next: 'Open the report and check it still returns rows. A query that needs editing has to be fixed in Advanced Builder.',
    },
    {
      test: /report not found|deleted|archived/i,
      headline: 'The report this schedule points at is gone.',
      next: 'Point the schedule at a report that still exists, or delete the schedule.',
    },
    {
      test: /statement timeout|timed out|timeout/i,
      headline: 'The report took too long to run.',
      next: 'Narrow the reporting period or add a filter, then send a test.',
    },
    {
      test: /resend|email not set|RESEND|not configured|not set/i,
      headline: 'SILO could not hand the email to the mail provider.',
      next: 'Nothing to fix on your side. SILO tries again at the next send.',
    },
    {
      test: /mfa_required|authenticator app|two-step/i,
      headline: 'SILO’s own sign-in check refused the scheduled run.',
      next: 'Nothing to fix on your side. SILO tries again at the next send.',
    },
    {
      test: /storage upload/i,
      headline: 'The export was built but could not be stored for download.',
      next: 'Nothing to fix on your side. SILO tries again at the next send.',
    },
  ];

  function explainFailure(message, opts) {
    const text = String(message || '').trim();
    if (!text) return null;
    const paused = !!(opts && opts.paused);
    const hit = FAILURE_RULES.find((r) => r.test.test(text));
    const headline = hit ? hit.headline : 'The last send failed.';
    const next = hit ? hit.next : 'Send a test to see the same error while you are watching, or check the report still runs.';
    return {
      headline,
      next,
      /* Whether it will try again on its own. The delivery side pauses only
         for a fault the schedule owns; anything else keeps going. Reading
         is_paused is how the UI tells "switched off by a person" from
         "switched off by a failure". */
      retries: !paused,
      state: paused
        ? 'This schedule is paused, so it will not try again until someone resumes it.'
        : 'This schedule is still on and will try again at the next send.',
      detail: text,
    };
  }

  /** Paused by a person, or paused because a send failed? The delivery side
   *  only ever pauses on the schedule's own fault, and it writes last_error
   *  when it does, so the pair answers it. */
  function pauseReason(row) {
    const r = row || {};
    if (!r.is_paused) return null;
    return r.last_error ? 'failure' : 'person';
  }

  global.SiloReportSchedulePlan = {
    FREQUENCIES, DELIVERY_TIMES, RUNNER_SLOTS_UTC, RUNNER_SLOT_MINUTE,
    DEFAULT_FREQUENCY, DEFAULT_TIME, LEGACY_PRESETS,
    CONTENTS_LINE, CONTENTS_SHORT, SENT_MEANING,
    parsePreset, presetFor, isLegacyPreset, legacyFallbackFor,
    timeLabel, frequencyPhrase, zoneWords,
    sentence, inZone, runnerSlotAfter, slotDelayMinutes, firstSendSentence,
    statusLabel, statusTone, explainFailure, pauseReason,
  };
}(typeof window !== 'undefined' ? window : globalThis));
