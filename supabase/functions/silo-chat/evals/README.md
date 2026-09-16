# Ask SILO model evaluations

**Nothing in this directory runs in CI, and nothing in it is a test.**

The deterministic suites next door (`evidence-scope.test.mjs`,
`handler.test.mjs`, `prompt.test.mjs`) assert what the CODE does: what the
handler computes, what it puts in front of the model, what it writes to the
audit row. They pass or fail the same way every time, need no secrets and no
network, and they are the reason those controls can be relied on.

They cannot answer the question this directory exists for: **given the
evidence, does the model still mislabel it?** That is a property of a model's
reasoning, it is not deterministic, and asserting on it inside a unit suite
would produce a test that goes red for reasons unrelated to the change being
reviewed.

So the two are kept apart, on purpose. A green CI run says the controls are
wired. It says nothing about answer quality, and no PR should claim otherwise
on the strength of it.

## Cost and credentials — read before running

`evidence-scope.eval.mjs` makes **real, paid calls to the Anthropic API**. It
needs `ANTHROPIC_API_KEY` in the environment. At the default of 3 runs across 7
cases that is 21 requests, each carrying the full Ask SILO system prompt
(~25-30k input tokens) plus a scripted transcript. `--baseline` doubles it by
running the control arm as well.

Do not run it on someone's behalf without saying first that it costs money.

```
ANTHROPIC_API_KEY=... node supabase/functions/silo-chat/evals/evidence-scope.eval.mjs
ANTHROPIC_API_KEY=... node supabase/functions/silo-chat/evals/evidence-scope.eval.mjs --runs 5 --baseline
ANTHROPIC_API_KEY=... node supabase/functions/silo-chat/evals/evidence-scope.eval.mjs --case combined-spend --json
```

## What it actually exercises, and what it does not

It builds the REAL system prompt out of `index.ts` (the same constants the
prompt suite scrapes) and hands the model a SCRIPTED transcript: a user
question, then tool results rendered by the REAL `renderQueryResult` over the
frozen fixtures in `evidence-fixtures.mjs`. The model writes the answer. The
answer is then graded.

That isolates the step this change is about — writing claims from evidence
already gathered — and makes it repeatable, which a live run against the
deployed function is not: the model would write its own SQL, against data that
moves, and a failure could not be told apart from a data change.

What it therefore does NOT cover: whether the model chooses good SQL, whether
it calls `describe_relations` when it should, tool-loop behaviour, timeouts,
and anything about the deployed function. `--baseline` is the closest thing to
a causal claim available here: same model, same transcript, envelope and scope
rules removed.

## Grading

Every case is graded by deterministic checks over the answer text — a required
phrase, a forbidden pairing, a number that must not appear under a given label.
There is no model judge: a judge would need its own validation, and the failures
being tested for are specific enough to state literally.

The checks are necessarily approximate. A case can fail on wording that is
actually fine, and can pass on wording that is subtly wrong. Read the recorded
answers (`--json`) rather than trusting the score, and treat the result as
evidence about a direction, not a certificate.

## Reporting a run

State the model id, the number of runs, the date, whether the baseline arm was
run, and the per-case pass counts. A single run of a single case is an anecdote.
