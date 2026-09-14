# PR review automation — observed behaviour

What the ChatGPT review automation and the Claude wake-up wiring ACTUALLY do,
recorded from live runs. The protocol that consumes this lives in
`.claude/skills/steward/SKILL.md`; this file is the evidence it reads.

Everything below marked **observed** comes from PR #690
(https://github.com/BBISMblockay/financehub/pull/690), the first PR through
the loop. Everything marked **unverified** has not yet happened on a live PR
and the steward skill treats it as unproven.

## Reviewer marker format — observed

Comment https://github.com/BBISMblockay/financehub/pull/690#issuecomment-5658124936,
raw body at creation (02:21:12 UTC, 62 seconds after the PR opened):

```
SILO automated review — cycle 1/2 — reviewing 2b8dd206f44443d95cdebf0c2eafea930fb9cca1

<!-- silo-pr-review-v1 cycle=1 head=2b8dd206f44443d95cdebf0c2eafea930fb9cca1 status=running -->
```

Matches the configured layout character for character. Posted under the
`BBISMblockay` login (Blake's own), so author-based identification would not
distinguish it from Claude's posts or Blake's.

**The reviewer finalises by editing the SAME comment in place.** At 02:23:40
UTC the body of comment 5658124936 became the full review, ending in:

```
<!-- silo-pr-review-v1 cycle=1 head=2b8dd206f44443d95cdebf0c2eafea930fb9cca1 status=complete -->
```

Same comment id, `created_at` unchanged, `updated_at` moved. A comment id
therefore never identifies a review; `(comment id, cycle, head, status)` plus
`updated_at` does, and the raw body must be re-read on every wake. This is
finding P2 of that review, and the reason the skill dedupes by tuple.

`status=blocked` — **unverified** (not yet seen on a live PR).

## Cycle accounting — partly observed

- Cycle 1 fired on the PR as opened, about one minute after creation.
- Cycle 2 fired on the first push after review one (`running` at 02:27:38,
  72 seconds after the push; `complete` at 02:30:30 by in-place edit of
  comment 5658166038) — observed.
- Whether a `blocked` attempt posts a marker and consumes a cycle —
  **unverified**.

## Wake-up wiring — observed

All times UTC, from PR #690 on 2026-09-14. The session was subscribed with
`subscribe_pr_activity` immediately after `create_pull_request`, and a
`send_later` check-in was armed for 60 minutes out.

| Event | Happened at | Session woken at | Lag |
|---|---|---|---|
| PR opened | 02:20:10 | — | — |
| `subscription.created` | — | 02:20:15 | ~5 s after open |
| Reviewer comment created (`running`) | 02:21:12 | 02:21:14 | 2 s |
| Reviewer comment edited (`complete`) | 02:23:40 | 02:23:41 | 1 s |
| Correction push `133561c` | 02:26:26 | — | — |
| Cycle 2 comment created (`running`) | 02:27:38 | 02:27:40 | 2 s |
| Cycle 2 comment edited (`complete`) | 02:30:30 | 02:30:31 | 1 s |
| Hourly `send_later` check-in | armed for 03:21 | — | never needed; cancelled after the readiness report |

So the PR event path delivers `issue_comment.created` AND
`issue_comment.edited`, both within seconds. The check-in remains the
fallback for events GitHub does not deliver (CI success, merge-conflict
transitions, dropped webhooks).

## First full loop

| PR | Opened | Cycle 1 marker | Cycle 2 marker | Final status | Notes |
|----|--------|----------------|----------------|--------------|-------|
| #690 | 2026-09-14 02:20 UTC, head `2b8dd20` | `complete` 02:23:40 on `2b8dd20`, 2 findings (P1, P2), both valid, fixed in `133561c` | `complete` 02:30:30 on `133561c`, 2 findings (both P1: same-second claim order, release tombstone), both valid, fixed in the commit after | Needs additional independent review | first live run; all four findings were against the skill's own claim fallback; the final commit is unreviewed by construction |
| #692 | 2026-09-14 04:49 UTC, head `f0d76c0` | `complete` 04:53:55 on `f0d76c0`, 4 findings (2 P1, 2 P2), all valid, fixed in `d8c571a` | `complete` 05:08 on `d8c571a`, 2 findings (P1 valid: late upserts from an older run; P2 disputed: `20260909300000` already pins the baseline helper to Pacific, verify's `seo_baseline_business_timezone` enforces it, boundary test added) | Needs additional independent review | second live run; the PR-event path fired on `issue_comment.created`, `.edited` and `check_suite.completed` within seconds each time; the hourly check-in never had to fire and was cancelled after the report. Claim released by a `released` tombstone comment (no comment-edit tool in the harness) |

## Protocol traces

The skill is prose, so its "tests" are traces: the sequence of reads and
posts a run makes in each scenario, checked against the Step 2 rules. Each
of these was the failure mode of the version reviewed in cycle 1, or the
scenario the reviewer asked to be validated.

### Trace A — `running` then `complete` on an unchanged head, two separate runs

1. Run 1 wakes on `issue_comment.created`. Reads raw comments. Sees marker
   `(5658124936, 1, 2b8dd20, running)`. Step 2.4: `running` → do NOT claim,
   re-arm check-in, end. **No claim posted.**
2. Run 2 wakes on `issue_comment.edited`. Reads raw comments. Same comment
   id, tuple now `(5658124936, 1, 2b8dd20, complete)` with a newer
   `updated_at`: not a duplicate. Step 2.4: `complete` → implementation
   work. Step 2.5: reads claims, finds none active for `2b8dd20`, posts its
   own, re-reads, is the oldest, proceeds.
3. Run 2 fixes, pushes, edits its claim to `released`, ends.

The version reviewed in cycle 1 had Run 1 post a claim at its step 2 and exit
at its step 5 without releasing; Run 2 then lost to that claim and exited, and
the push that would have made the claim stale could never happen.

### Trace B — same comment id, `running` then `blocked`

Same as Trace A up to step 2, with `blocked` in the tuple. Step 2.4: terminal,
cycle spent. If the stated blocker is fixable in scope → claim (2.5) → fix →
push → release. If not → readiness report with the blocker under Findings.
Never re-armed as a wait.

### Trace C — unchanged duplicate delivery

Run 1 handled `(5658124936, 1, 2b8dd20, complete, updated_at=02:23:40)`. A
redelivered event carries the same tuple and the same `updated_at`. Step 2.3:
duplicate, skipped. No second claim, no second batch.

### Trace D — concurrent claimants, including the same second

Runs X and Y both wake on the `complete` edit within the same second. Both
read claims (none active), both post `active` claims for `2b8dd20`. Both
re-read and rebuild effective records. Ordering is `(created_at, numeric
comment id)` ascending and exactly the minimum proceeds:

| Case | X's claim | Y's claim | Winner | Why |
|---|---|---|---|---|
| different seconds | 02:24:53, id 100 | 02:24:54, id 101 | X | earlier `created_at` |
| same second | 02:24:53, id 100 | 02:24:53, id 101 | X | tie on `created_at`, lower comment id |
| same second, Y posted first | 02:24:53, id 101 | 02:24:53, id 100 | Y | lower comment id, whichever session posted it |

The loser releases its claim and ends. The version reviewed in cycle 2
said only "older", which is undefined on a same-second tie and let both
proceed. If either field is unreadable on any competitor, the run fails
closed: releases, posts one comment to Blake, ends. If Y instead found X's
effective record to be two hours old with no push since, Y posts a handoff
comment to Blake naming X's run id and does not proceed.

### Trace E — normal exit without a push

A run claims, evaluates, and finds every finding disputed or out of scope.
It posts the summary comment, releases its claim, re-arms the check-in,
ends. The claim does not survive the run.

### Trace F — release by tombstone, then a new wake on the same head

Comment editing is unavailable (true of the session that ran PR #690: no
comment-edit tool). Run X posts `steward-claim run=X cycle=1 head=H
status=active` (comment 5658148625), does its work, and releases by posting
a SECOND comment `steward-claim run=X cycle=1 head=H status=released`
(comment 5658158449). A later run Y wakes on the same head H with no push in
between (Trace E's no-push case, or a duplicate event). Y reduces claims to
one effective record per `(run id, cycle, head)`: for run X the record with
the greatest `(updated_at, comment id)` is 5658158449, status `released`.
X is therefore not a competitor, and Y proceeds under Trace D's ordering
among the remaining `active` records (none). The version reviewed in cycle 2
treated every `active` comment independently, so Y would have seen
5658148625 as live and blocked or handed off instead.
