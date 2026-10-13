import assert from 'node:assert/strict';
import {
  rowsToCsv,
  defaultQueryIndex,
  queryIndicesForSchedule,
  renderSubject,
  cadenceLabel,
} from '../lib/report-email-deliver-core.mjs';

assert.equal(defaultQueryIndex(['select 1 from information_schema.tables', 'select 2 as n']), 1);
assert.deepEqual(queryIndicesForSchedule({ target_kind: 'report', query_indices: [0, 2] }, { queries_run: ['a', 'b', 'c'] }), [0, 2]);
assert.match(renderSubject(null, { title: 'Daily Sales', company: 'Acme', date: '2026-10-13' }), /Daily Sales/);
assert.equal(cadenceLabel('weekdays_0700'), 'Weekdays 7:00');
const csv = rowsToCsv([{ a: 1, b: 'x,y' }]);
assert.match(csv, /^a,b/);
assert.match(csv, /"x,y"/);
console.log('report-email-deliver.test.mjs ok');
