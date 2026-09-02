/* Assertions for the v3 suites.
 *
 * Deliberately tiny and dependency-free. The unit suites must run with
 * nothing installed -- `node v3/tests/run.js --unit` on a clean checkout --
 * because a test you cannot run without a working npm install is a test
 * nobody runs. */
'use strict';

function createReporter(suiteName) {
  let pass = 0;
  let fail = 0;
  const failures = [];

  /** Assert a condition. `detail` is printed only on failure. */
  function ok(name, cond, detail) {
    if (cond) {
      pass += 1;
      if (process.env.V3_TEST_VERBOSE) console.log('  ok   ' + name);
    } else {
      fail += 1;
      failures.push(name);
      console.log('  FAIL ' + name + (detail ? '\n        ' + detail : ''));
    }
  }

  /** Run `fn`, counting a throw as a failure with its message. */
  function test(name, fn) {
    try { fn(); pass += 1; if (process.env.V3_TEST_VERBOSE) console.log('  ok   ' + name); }
    catch (err) {
      fail += 1;
      failures.push(name);
      console.log('  FAIL ' + name + '\n        ' + (err && err.message ? err.message : String(err)));
    }
  }

  const eq = (actual, expected, msg) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${msg ? msg + ': ' : ''}expected ${e}, got ${a}`);
  };
  const has = (haystack, needle, msg) => {
    if (!String(haystack).includes(needle)) {
      throw new Error(`${msg ? msg + ': ' : ''}expected to contain ${JSON.stringify(needle)}\n        got: ${haystack}`);
    }
  };
  const not = (haystack, needle, msg) => {
    if (String(haystack).includes(needle)) {
      throw new Error(`${msg ? msg + ': ' : ''}expected NOT to contain ${JSON.stringify(needle)}\n        got: ${haystack}`);
    }
  };
  const truthy = (v, msg) => { if (!v) throw new Error(msg || 'expected truthy'); };

  function summary() {
    const total = pass + fail;
    console.log(`\n  ${suiteName}: ${pass}/${total} passed` + (fail ? ` — ${fail} FAILED` : ''));
    return { suite: suiteName, pass, fail, total, failures };
  }

  return { ok, test, eq, has, not, truthy, summary, get pass() { return pass; }, get fail() { return fail; } };
}

module.exports = { createReporter };
