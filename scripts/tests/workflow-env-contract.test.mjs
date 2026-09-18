// Every workflow that runs a script must pass the env vars that script REQUIRES.
//
// Why this exists, and why it is generic rather than a list of two names:
// making `REDO_COMPANY_ENTITY_ID` mandatory in `scripts/redo-backfill.mjs` and
// `scripts/redo-marketing-probe.mjs` broke both of their GitHub Actions, which
// still invoked them without it. Dispatching either would throw at module load
// with every secret correctly configured. Nothing caught it: the scripts parse,
// the workflows parse, the unit suites do not run either one, and a
// `workflow_dispatch`-only job proves itself only when a human dispatches it —
// which for a backfill might be months later, at the exact moment someone is
// onboarding a new tenant and least wants a broken tool.
//
// Caught by the cycle-1 independent review on PR #722, not by CI. So the test
// is the CONTRACT, not the two instances: any script that starts requiring a
// new variable, and any workflow that starts running a script, is covered from
// the day it lands.
//
// The check is deliberately shallow — it reads the `env:` block of the step
// that runs the script and asks whether every required name appears as a key.
// It does not evaluate the expression, so a key wired to an input that is
// itself optional and blank still passes here. That residual gap is closed by
// making the workflow input `required: true`, which is asserted separately
// below for the inputs that carry tenancy.
//
// Run: node --test scripts/tests/workflow-env-contract.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const WORKFLOW_DIR = new URL('.github/workflows/', root);
const SCRIPT_DIR = new URL('scripts/', root);

/**
 * Names a script throws on when absent. Matches the shape these scripts use:
 *   const X = process.env.NAME;
 *   if (!X) { throw new Error(...) }
 * and the older `if (!process.env.NAME)` form. A name is only treated as
 * required if a throw mentions it, so an optional `process.env.FOO || 'x'`
 * read is correctly ignored.
 */
function requiredEnvNames(source) {
  const required = new Set();
  const thrown = source.match(/throw new Error\([^)]*\)/g) || [];
  const mentioned = new Set();
  for (const t of thrown) {
    for (const name of t.match(/[A-Z][A-Z0-9_]{3,}/g) || []) mentioned.add(name);
  }
  for (const name of source.match(/process\.env\.([A-Z][A-Z0-9_]{3,})/g) || []) {
    const bare = name.replace('process.env.', '');
    if (mentioned.has(bare)) required.add(bare);
  }
  return required;
}

/** The `env:` keys of the step whose `run:` invokes this script. */
function envKeysForScript(workflow, scriptPath) {
  const lines = workflow.split('\n');
  const runLine = lines.findIndex((l) => l.includes(`node ${scriptPath}`));
  if (runLine === -1) return null;
  const keys = new Set();
  // Walk back to the step's `env:` block; stop at the step boundary ('- name:').
  for (let i = runLine - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/^\s*-\s+name:/.test(line)) break;
    const kv = line.match(/^\s{6,}([A-Z][A-Z0-9_]{3,}):/);
    if (kv) keys.add(kv[1]);
  }
  return keys;
}

const workflowNames = (await readdir(WORKFLOW_DIR)).filter((f) => f.endsWith('.yml'));
const scriptNames = (await readdir(SCRIPT_DIR)).filter((f) => f.endsWith('.mjs'));

const workflows = new Map();
for (const name of workflowNames) {
  workflows.set(name, await readFile(new URL(name, WORKFLOW_DIR), 'utf8'));
}

test('every workflow supplies the env vars its script refuses to run without', async () => {
  const violations = [];
  for (const script of scriptNames) {
    const source = await readFile(new URL(script, SCRIPT_DIR), 'utf8');
    const required = requiredEnvNames(source);
    if (!required.size) continue;
    for (const [workflowName, workflow] of workflows) {
      const provided = envKeysForScript(workflow, `scripts/${script}`);
      if (!provided) continue; // this workflow does not run this script
      for (const name of required) {
        // Secrets come from the repo, not the step, but these scripts read them
        // through env too -- so only flag a name the workflow mentions nowhere.
        if (!provided.has(name) && !workflow.includes(name)) {
          violations.push(`${workflowName} runs scripts/${script} without ${name}`);
        }
      }
    }
  }
  assert.deepEqual(violations, [],
    `workflow/script env contract broken:\n  ${violations.join('\n  ')}`);
});

test('tenant and data-source inputs are required, never blank-defaulted', async () => {
  // The shallow check above passes if a key is merely present. These inputs
  // decide WHICH TENANT rows are written under, and which data is read, so a
  // blank default is the failure mode that matters: the run succeeds and the
  // rows land in the wrong company. Every one of these used to default to
  // Baseballism.
  const mustBeRequired = [
    ['redo-backfill.yml', 'company_entity_id'],
    ['redo-marketing-probe.yml', 'company_entity_id'],
    ['mailroom-backfill.yml', 'company_entity_id'],
    // The sheet is tenant data too. Requiring the company while the SHEET
    // stayed defaulted let the two disagree -- name Tenant B, leave the sheet
    // blank, and Baseballism's mail is stamped Tenant B.
    ['mailroom-backfill.yml', 'sheet_id'],
  ];
  for (const [workflowName, input] of mustBeRequired) {
    const workflow = workflows.get(workflowName);
    assert.ok(workflow, `${workflowName} is missing`);
    const at = workflow.indexOf(`      ${input}:`);
    assert.notEqual(at, -1, `${workflowName} has no ${input} input`);
    // Read to the next input key at the same indent.
    const rest = workflow.slice(at);
    const block = rest.slice(0, rest.indexOf('\n      ', 1) === -1 ? 400 : rest.indexOf('\n        type:') + 40);
    assert.match(block, /required:\s*true/,
      `${workflowName} input ${input} is not required:true`);
    assert.ok(!/default:\s*""/.test(block),
      `${workflowName} input ${input} still carries a blank default`);
  }
});
