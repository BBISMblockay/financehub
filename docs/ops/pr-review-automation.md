# PR review automation — observed behaviour

What the ChatGPT review automation and the Claude wake-up wiring ACTUALLY do,
recorded from live runs. The protocol that consumes this lives in
`.claude/skills/steward/SKILL.md`; this file is the evidence it reads.

Fill each section in from the first PR that completes the full loop. Until a
section is filled, the steward skill treats that behaviour as unverified.

## Reviewer marker format

Not yet observed. Expected: every automation comment contains
`silo-pr-review-v1` plus a cycle number, the head SHA reviewed, and a status
(`running` = reservation, `complete` = the review). Paste one real marker
comment here verbatim once seen, with which fields sat where.

## Cycle accounting

Not yet observed. Record: did a blocked/failed attempt post a marker and
consume a cycle? Did the second cycle fire on the first push after review
one, or on every push?

## Wake-up wiring

Not yet observed. Record, per PR: did a `subscribe_pr_activity` event wake
the session, did the hourly `send_later` check-in, or both? Which arrived
first, and how long after the reviewer's `complete` comment?

## First full loop

| PR | Opened | Cycle 1 marker | Cycle 2 marker | Final status | Notes |
|----|--------|----------------|----------------|--------------|-------|
| — | — | — | — | — | not yet run |
