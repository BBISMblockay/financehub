// The Find city A/B workflow (scripts/affiliate-customer-city-ab.mjs) sends
// customers' names and cities to the search provider, so it must exclude
// exactly whom Find excludes: the do-not-contact list (addresses and
// domains, subdomains too) and the company's own people.
//
// Mutations (CI runs each and requires a failure):
//   AB_MUTATION=nosup   the do-not-contact list is ignored
//   AB_MUTATION=noteam  the company's own people are sampled
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MUT = process.env.AB_MUTATION || '';
const MUTS = {
  nosup: ["suppressed(r.email_lc) || isTeam(r.email_lc)", 'isTeam(r.email_lc)'],
  noteam: ["suppressed(r.email_lc) || isTeam(r.email_lc)", 'suppressed(r.email_lc)'],
};
if (MUT && !MUTS[MUT]) throw new Error(`unknown mutation ${MUT}`);
let src = fs.readFileSync(path.join(ROOT, 'scripts/affiliate-customer-city-ab.mjs'), 'utf8');
if (MUT) {
  const [from, to] = MUTS[MUT];
  if (!src.includes(from)) { console.error(`stale mutation ${MUT}`); process.exit(3); }
  src = src.replace(from, to);
}
// Run the copy from scripts/ so its ./lib import resolves.
const tmp = path.join(ROOT, 'scripts', `.ab-test-${process.pid}.mjs`);
fs.writeFileSync(tmp, src);
let M;
try { M = await import(pathToFileURL(tmp).href); } finally { fs.rmSync(tmp, { force: true }); }
const L = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/affiliate-customer-scan-core.mjs')).href);

const rows = [
  { customer_key: 'ok', email_lc: 'emily@gmail.com', name_lc: 'emily durrance' },
  { customer_key: 'dnc', email_lc: 'blocked@gmail.com', name_lc: 'bo blocked' },
  { customer_key: 'dncdom', email_lc: 'x@mail.agency.test', name_lc: 'al agency' },
  { customer_key: 'staff', email_lc: 'pat@brand.test', name_lc: 'pat staff' },
  { customer_key: 'nocity', email_lc: 'nc@gmail.com', name_lc: 'nora city' },
  { customer_key: 'noname', email_lc: 'nn@gmail.com', name_lc: '' },
];
const city = new Map(rows.map((r) => [r.email_lc, 'Phoenix, AZ']));
city.delete('nc@gmail.com');
const guards = {
  suppressed: L.suppressionFilter([{ kind: 'email', value_normalized: 'blocked@gmail.com' }, { kind: 'domain', value_normalized: 'agency.test' }]),
  isTeam: L.teamFilter(['boss@brand.test']),
};
const got = M.eligiblePeople(rows, city, guards, 50).map((p) => p.key);
assert.deepEqual(got, ['ok'], 'only an eligible customer with a name and a city is searched');
assert.equal(M.eligiblePeople(rows, city, guards, 0).length, 0, 'the limit holds');
assert.equal(L.suppressionFilter([{ kind: 'domain', value_normalized: 'agency.test' }])('a@agency.test'), true);
assert.equal(L.suppressionFilter([])('a@b.c'), false);
console.log('affiliate-customer-city-ab: passed');
