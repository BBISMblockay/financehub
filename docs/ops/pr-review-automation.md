# PR review automation — observed behaviour

What the ChatGPT review automation and the Claude wake-up wiring ACTUALLY do,
recorded from live runs. The protocol that consumes this lives in
`.claude/skills/steward/SKILL.md`; this file is the evidence it reads.

Fill each section in from the first PR that completes the full loop. Until a
section is filled, the steward skill treats that behaviour as unverified.

## Reviewer marker format

Configured (per Blake, 2026-09-14), not yet observed on a live PR:

```
<!-- silo-pr-review-v1 cycle=1 head=FULL_SHA status=complete -->
```

An HTML comment, so it never shows in GitHub's rendered view; read the raw
comment body. `status` is one of `running` (wait), `complete` (the review),
`blocked` (terminal, slot consumed, blocker stated in the comment). Paste the
first real marker comment here verbatim once seen, with a link.

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
