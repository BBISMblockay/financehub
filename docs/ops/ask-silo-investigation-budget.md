# Ask SILO investigation budget and partial answers

The handler could force a final answer at its existing request limit while the
chat client discarded the response's partial-status fields. The client renders,
recovers, and saves the answer text, so a flag outside that text was insufficient.

## Behavior

- Forced answers receive a deterministic **Partial answer** prefix before both
  the audit insert and the response. Existing clients retain the label through
  history, recovery, and saved answer text.
- `diagnostics.context.partial` and `partial_reason` record the forced-stop
  status. False means no forced stop, not proof every requested check completed.
  The existing audit `status = 'ok'` remains delivery status.
- At the first eligible loop boundary at or after 45 seconds, general chat gets
  one checkpoint with tools enabled: prioritize requested areas not yet measured
  and reuse existing evidence. Truncated prose continuations and concept
  workflows are excluded.
- The existing 95-second tool cutoff, 125-second continuation cutoff, and
  20-round cap remain. A checkpoint cannot guarantee a slow query finishes
  within the gateway limit.
- General analysis guidance asks for a first pass across requested measures,
  compatible dates and units, measured coverage, and explicit missing evidence.
  Discovering a table is not measuring its facts; units, orders, attributed
  purchases, subscriber outcomes, and return cohorts remain distinct.

## Verification and limits

The handler tests use only synthetic data, a simulated clock, and mocked
model/database calls. They cover checkpoint timing and single delivery, tools
remaining available, forced final answers, matching response/audit text,
ordinary completion, continuation and concept exceptions, company-switch
refusal, and audit failure/fallback. Removing the prefix, delaying the
checkpoint beyond the cutoff, or removing stored partial status fails tests.

Prompt assertions verify the guidance reaches ordinary chat. They do not prove
the model follows it. The checkpoint is guidance, not a metric-validation engine
or a guarantee of complete investigation.

After deployment, ask a multi-part launch comparison and inspect its actual
queries and answer: are the requested measures checked, the date windows
compatible, and the units matched? Distinguish return-date totals from returns
linked to the launch order cohort. Missing attribution linkage or coverage may
still prevent a recommendation. Do not count mocked tests as proof of live
recommendation quality.

## Deployment

No new migration, catalog refresh, secret, or configuration is required.
Deploy `silo-chat` via `deploy-edge-function.yml` after merge. Merge does not
deploy. The existing diagnostics-column migration remains a prerequisite for
structured audit diagnostics; its missing-column fallback still retains the
partial label in the answer.
