// Ask SILO: the page's half of ANSWER DELIVERY (v2/silo-chat.html).
//
// The server can finish an answer and still leave the user looking at their
// own question. On 2026-10-27 the edge function was doing that itself (it
// refused the forced final answer at a 0ms deadline -- fixed in #1040, with
// real handler tests). What is left is the delivery path on this page, and it
// has two failure modes that no server test can reach:
//
//   1. THE WINDOW. A long answer is collected by request id. If the page gives
//      up before the server's own budget is spent, it throws away an answer
//      that is about to land. The window therefore has to be ONE constant: the
//      network-failure path carried a second, hardcoded 290_000 and was left
//      behind when the server's budget moved, which is exactly the bug.
//   2. THE RELOAD. The request id lived only in a closure, so a reload -- or a
//      phone suspending the tab, which is the same thing here -- lost the only
//      handle on an answer that silo_chat_responses already holds.
//
// These are SOURCE-TEXT assertions, and that is worth stating plainly: they
// prove the wiring is present and that a second hardcoded window has not crept
// back, not that the browser behaves. The page is one inline script with no
// harness to drive it; when one exists, the reload round-trip belongs there.
//
// Run: node --test scripts/tests/ask-silo-answer-delivery.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const page = await readFile(new URL('../../v2/silo-chat.html', import.meta.url), 'utf8');

test('one waiting window, named once and used everywhere', () => {
  assert.match(page, /const WAIT_FOR_ANSWER_MS = [\d_]+;/);
  // Both paths that wait for a late answer read the same constant.
  assert.match(page, /collectDeferredResponse\(requestId, askedAt, isCurrent\)/);
  assert.match(page, /untilMs: askedAt \+ WAIT_FOR_ANSWER_MS/);
  // No second, hardcoded window. 290_000 and 300_000 are the two that were
  // there; any bare five-or-six-figure millisecond window here is the bug.
  assert.doesNotMatch(page, /asked(At|_at) \+ \d/);
});

test('the window outlasts the server, which stops at its safe line plus a floored final answer', () => {
  const worst = serverWorstCaseMs();
  const wait = Number(page.match(/const WAIT_FOR_ANSWER_MS = ([\d_]+);/)[1].replace(/_/g, ''));
  assert.ok(worst < wait,
    `the page gives up at ${wait}ms, before the server's ${worst}ms worst case`);
});

// GATEWAY_SAFE_MS + MIN_FINAL_CALL_MS, read from the function rather than
// copied, so moving the server's budget without moving the page's fails here.
function serverWorstCaseMs() {
  const lib = readFileSync(new URL('../../supabase/functions/silo-chat/budget-lib.mjs', import.meta.url), 'utf8');
  const num = (name) => {
    const m = lib.match(new RegExp(`export const ${name} = ([\\d_]+);`));
    assert.ok(m, `${name} is not exported from budget-lib.mjs any more`);
    return Number(m[1].replace(/_/g, ''));
  };
  return num('GATEWAY_SAFE_MS') + num('MIN_FINAL_CALL_MS');
}

test('the in-flight request id survives a reload', () => {
  // Written down before the request can be lost, and stored inside the history
  // blob so it inherits that blob's identity scoping rather than needing its
  // own purge.
  assert.match(page, /pendingTurn = \{ request_id: requestId, asked_at: askedAt \};\s*\n\s*saveHistoryToSession\(\);/);
  assert.match(page, /messages: history,\s*\n\s*pending: pendingTurn,/);
  // And dropped once the turn is resolved, so the next load does not re-poll
  // for an answer already on screen.
  assert.match(page, /if \(pendingTurn\?\.request_id === requestId\) \{\s*\n\s*pendingTurn = null;/);
});

test('a restored conversation only resumes one that is actually waiting', () => {
  // The last turn being the assistant's means the question was answered before
  // the reload, whatever id the blob still carries.
  assert.match(page, /saved\.messages\[saved\.messages\.length - 1\]\?\.role === 'user'/);
  assert.match(page, /restoredPending = p && typeof p\.request_id === 'string'/);
});

test('boot resumes the pending answer without blocking the page on it', () => {
  const boot = page.slice(page.indexOf('if (restoredPending) {'));
  assert.match(boot, /^if \(restoredPending\) \{/);
  // Not awaited: the resume polls for minutes.
  assert.doesNotMatch(boot.slice(0, 300), /await resumePendingAnswer/);
  assert.match(boot.slice(0, 300), /\n\s*resumePendingAnswer\(pending\);/);
});

test('the resume cannot swallow an error or strand the composer', () => {
  const fn = page.slice(page.indexOf('async function resumePendingAnswer'));
  const body = fn.slice(0, fn.indexOf('// "Try again" on a retryable error bubble'));
  // A `return` inside finally discards whatever was thrown AND skips
  // re-enabling the composer. It was written that way once. Comments are
  // stripped first, or the comment saying so matches.
  const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code.slice(code.indexOf('} finally {')), /\breturn\b/);
  assert.match(body, /el\('btnSend'\)\.disabled = false;/);
});
