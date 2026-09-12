import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the shipped composer and its actual Save/Review event callbacks.
// Only the DOM and Supabase transport are fakes; no composer helpers are copied.
const source = await readFile(new URL('../../v2/je-composer.js', import.meta.url), 'utf8');
const copy = (value) => structuredClone(value);
const chart = [
  { qbo_account_id: 'expense', name: 'Expense', account_type: 'Expense', connection_id: 'qbo-one' },
  { qbo_account_id: 'cash', name: 'Cash', account_type: 'Bank', connection_id: 'qbo-one' },
];
const seeds = [
  { accountId: 'expense', postingType: 'Debit', amount: 35 },
  { accountId: 'cash', postingType: 'Credit', amount: 35 },
];
const original = {
  id: 'existing', company_entity_id: 'company-one', entry_date: '2026-08-31',
  memo: 'Original draft', source_context: 'accounting-export:2026-08', status: 'draft',
  qbo_connection_id: 'qbo-one', accounting_source: 'shopify_monthly', accounting_source_ref: '2026-08',
};
const originalLines = seeds.map((line, i) => ({
  id: `line-${i}`, adjustment_id: 'existing', company_entity_id: 'company-one',
  qbo_account_id: line.accountId, posting_type: line.postingType, amount: line.amount,
  line_no: i + 1,
}));

async function composer({ accounts = chart, lines = seeds, error = null, resume = false,
  referenceError = null } = {}) {
  const ids = new Map();
  class Element {
    constructor() { this.listeners = new Map(); this.children = []; this.value = ''; this.disabled = false; }
    set innerHTML(value) {
      this.html = value;
      for (const [, id] of value.matchAll(/\bid="([^"]+)"/g)) ids.set(id, new Element());
    }
    get innerHTML() { return this.html || ''; }
    querySelector(selector) { return ids.get(selector.slice(1)); }
    appendChild(child) { this.children.push(child); if (child.id) ids.set(child.id, child); }
    addEventListener(event, callback) { this.listeners.set(event, callback); }
    removeEventListener(event) { this.listeners.delete(event); }
    remove() { this.removed = true; }
    contains(child) { return this.children.includes(child) && !child.removed; }
  }
  const document = {
    createElement: () => new Element(), getElementById: (id) => ids.get(id),
    head: new Element(), body: new Element(), addEventListener() {}, removeEventListener() {},
  };
  const headers = [copy(original)];
  const storedLines = copy(originalLines);
  const writes = [];
  const staged = [];
  const references = {
    quickbooks_accounts: accounts.map((account) => ({ is_active: true, ...account })),
    quickbooks_locations: [], quickbooks_customers: [], quickbooks_vendors: [],
  };
  const db = {
    from(table) {
      let operation = 'select', payload, single = false;
      const filters = [];
      const query = {
        select() { return query; }, order() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        update(value) { operation = 'update'; payload = value; return query; },
        insert(value) { operation = 'insert'; payload = value; return query; },
        delete() { operation = 'delete'; return query; },
        single() { single = true; return query; },
        then(resolve, reject) {
          const run = () => {
            if (operation === 'select') {
              if (referenceError && table === 'quickbooks_accounts') return { data: null, error: referenceError };
              const rows = references[table]
                || (table === 'journal_adjustment_lines' ? storedLines : headers);
              const data = rows.filter((row) => filters.every(([key, value]) => row[key] === value));
              return { data: copy(single ? data[0] : data), error: null };
            }
            writes.push({ table, operation, payload: copy(payload), filters: copy(filters) });
            if (table === 'journal_adjustments') {
              if (error) return { data: null, error };
              if (operation === 'insert') {
                const header = { id: 'new-draft', status: 'draft', ...copy(payload) };
                headers.push(header);
                return { data: { id: header.id }, error: null };
              }
              for (const header of headers.filter((row) => filters.every(([k, v]) => row[k] === v))) {
                Object.assign(header, payload);
              }
              return { data: null, error: null };
            }
            if (operation === 'delete') {
              for (let i = storedLines.length - 1; i >= 0; i--) {
                if (filters.every(([key, value]) => storedLines[i][key] === value)) storedLines.splice(i, 1);
              }
            } else storedLines.push(...copy(payload));
            return { data: null, error: null };
          };
          return Promise.resolve().then(run).then(resolve, reject);
        },
      };
      return query;
    },
    rpc() { throw new Error('Staging must not approve or post'); },
  };
  const window = {};
  vm.runInNewContext(source, {
    window, document, setTimeout() {},
    fetch() { throw new Error('Staging must not reach QuickBooks'); },
    confirm() { throw new Error('Staging must not request posting confirmation'); },
  }, { filename: 'v2/je-composer.js' });
  window.SiloJE.open({
    db, companyId: 'company-one', context: 'accounting-export:2026-08',
    accountingSource: 'shopify_monthly', accountingSourceRef: '2026-08',
    adjustmentId: resume ? 'existing' : undefined,
    prefill: { entryDate: '2026-08-31', memo: 'New generated entry', lines },
    onStaged: (id) => staged.push(id),
  });
  await new Promise(setImmediate);
  return {
    ids, writes, staged, headers, storedLines,
    message: () => ids.get('jeMsg').textContent,
    async click(id) {
      const element = ids.get(id);
      assert.equal(element.disabled, false, `${id} should be actionable for the fixture`);
      await element.listeners.get('click')({ target: element });
    },
  };
}

const duplicate = {
  code: '23505', message: 'duplicate key value violates unique constraint "uq_journal_adjustments_active_source"',
};
let checks = 0;
async function test(name, fn) {
  await fn();
  checks++;
  console.log(`ok - ${name}`);
}

for (const resume of [false, true]) {
  for (const button of ['jeSaveDraft', 'jeStage']) {
    await test(`${button}: ${resume ? 'resumed update' : 'new insert'} duplicate preserves the existing entry`, async () => {
      const page = await composer({ error: duplicate, resume });
      await page.click(button);
      assert.match(page.message(), /2026-08.*draft, approved, or posted/);
      assert.match(page.message(), /Open the existing entry under Adjustments/);
      assert.doesNotMatch(page.message(), /23505|uq_journal_adjustments_active_source/);
      assert.deepEqual(page.headers, [original]);
      assert.deepEqual(page.storedLines, originalLines);
      assert.deepEqual(page.staged, []);
      assert.equal(page.writes.length, 1);
      assert.equal(page.writes[0].operation, resume ? 'update' : 'insert');
      assert.equal(page.ids.get('jeEdit').hidden, false);
      // A second click must still attempt the same operation, not assume the
      // duplicate belongs to this composer and overwrite the existing draft.
      await page.click(button);
      assert.equal(page.writes[1].operation, resume ? 'update' : 'insert');
      assert.deepEqual(page.storedLines, originalLines);
    });
  }
}

await test('unrelated unique violation keeps its own error', async () => {
  const page = await composer({ error: { code: '23505', message: 'duplicate key violates "journal_adjustments_pkey"' } });
  await page.click('jeSaveDraft');
  assert.match(page.message(), /journal_adjustments_pkey/);
  assert.doesNotMatch(page.message(), /already exists|Open the existing entry/);
});

await test('constraint name alone does not reclassify a non-unique error', async () => {
  const page = await composer({ error: { ...duplicate, code: '42501' } });
  await page.click('jeSaveDraft');
  assert.match(page.message(), /uq_journal_adjustments_active_source/);
  assert.doesNotMatch(page.message(), /already exists/);
});

await test('empty active chart has a sync instruction and performs no write', async () => {
  const page = await composer({ accounts: [] });
  await page.click('jeSaveDraft');
  assert.match(page.message(), /No active QuickBooks accounts.*Sync accounts in Integrations/);
  assert.doesNotMatch(page.message(), /mixes accounts|one QuickBooks connection/);
  assert.deepEqual(page.writes, []);
});

await test('one missing chart account identifies the line before writing a partial draft', async () => {
  const page = await composer({ lines: [seeds[0], { ...seeds[1], accountId: 'retired-cash' }] });
  await page.click('jeStage');
  assert.match(page.message(), /line 2 \(retired-cash\).*not in the active QuickBooks chart/);
  assert.doesNotMatch(page.message(), /mixes accounts/);
  assert.deepEqual(page.writes, []);
});

await test('blank account in Save draft asks for the line selection', async () => {
  const page = await composer({ lines: [seeds[0], { ...seeds[1], accountId: '' }] });
  await page.click('jeSaveDraft');
  assert.match(page.message(), /Select an account for line 2/);
  assert.deepEqual(page.writes, []);
});

await test('actual mixed connections have a separate explanation', async () => {
  const page = await composer({ accounts: [chart[0], { ...chart[1], connection_id: 'qbo-two' }] });
  await page.click('jeStage');
  assert.match(page.message(), /mixes accounts from different QuickBooks connections/);
  assert.doesNotMatch(page.message(), /not in the active QuickBooks chart|No active QuickBooks accounts/);
  assert.deepEqual(page.writes, []);
});

await test('an account without a connection is not classified as a mixed connection', async () => {
  const page = await composer({ accounts: [chart[0], { ...chart[1], connection_id: null }] });
  await page.click('jeSaveDraft');
  assert.match(page.message(), /line 2 has no QuickBooks connection/);
  assert.deepEqual(page.writes, []);
});

await test('colliding QBO account IDs never silently choose the first connection', async () => {
  const page = await composer({ accounts: [...chart, { ...chart[1], connection_id: 'qbo-two' }] });
  await page.click('jeSaveDraft');
  assert.match(page.message(), /line 2 appears in more than one QuickBooks connection/);
  assert.deepEqual(page.writes, []);
});

await test('failed chart read is reported with its actual cause', async () => {
  const page = await composer({ referenceError: { message: 'permission denied for table quickbooks_accounts' } });
  assert.match(page.message(), /QuickBooks accounts could not be loaded: permission denied/);
  assert.deepEqual(page.writes, []);
});

await test('valid Save draft preserves connection and producer identity without approving', async () => {
  const page = await composer();
  await page.click('jeSaveDraft');
  assert.match(page.message(), /Saved as a draft/);
  assert.deepEqual(page.staged, ['new-draft']);
  assert.equal(page.headers[1].qbo_connection_id, 'qbo-one');
  assert.equal(page.headers[1].accounting_source, 'shopify_monthly');
  assert.equal(page.headers[1].accounting_source_ref, '2026-08');
  assert.equal(page.storedLines.filter((line) => line.adjustment_id === 'new-draft').length, 2);
  assert.deepEqual(page.headers[0], original);
});

await test('valid Review renders the saved rows before enabling approval', async () => {
  const page = await composer();
  await page.click('jeStage');
  assert.equal(page.ids.get('jeEdit').hidden, true);
  assert.equal(page.ids.get('jePost').disabled, false);
  assert.match(page.ids.get('jeReview').innerHTML, /New generated entry/);
  assert.match(page.ids.get('jeReview').innerHTML, /Expense/);
  assert.deepEqual(page.staged, ['new-draft']);
});

console.log(`${checks} executed composer regression checks passed`);
