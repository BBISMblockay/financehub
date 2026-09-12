import assert from 'node:assert/strict';
import test from 'node:test';
import { runSandboxValidation } from '../qbo-sandbox-validation.mjs';

const token = 'SYNTHETIC_SECRET_DO_NOT_LOG';
const env = { QBO_SANDBOX_REALM_ID: '123456789', QBO_SANDBOX_ACCESS_TOKEN: token };

function fixture(options = {}) {
  let entry = null;
  let creates = 0;
  let deletes = 0;
  let journalQueries = 0;
  let reads = 0;
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, 'https://sandbox-quickbooks.api.intuit.com');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(url.searchParams.get('minorversion'), '75');
    if (options.accountError && url.pathname.endsWith('/query')) {
      return new Response(`${token} raw account names`, { status: 401 });
    }
    if (url.pathname.endsWith('/query')) {
      const query = url.searchParams.get('query');
      if (options.accountsMissing && query.includes('from Account')) return Response.json({ QueryResponse: { Account: [] } });
      if (query.includes('from Account')) return Response.json({ QueryResponse: { Account: [
        { Id: '9', Name: 'Private Bank', Active: true, AccountType: 'Bank' },
        { Id: '2', Name: 'Private Expense', Active: true, AccountType: 'Expense' },
        { Id: '1', Name: 'Forbidden AP', Active: true, AccountType: 'Accounts Payable' },
      ] } });
      journalQueries++;
      assert.match(query, /^select \* from JournalEntry where DocNumber = 'SILO-[A-F0-9]{16}' maxresults 2$/);
      if (options.preexisting && journalQueries === 1) return Response.json({ QueryResponse: { JournalEntry: [{ Id: '999' }] } });
      if (options.queryFailure && creates && !deletes) return new Response(token, { status: 500 });
      if (options.absenceFailure && deletes) return new Response(token, { status: 500 });
      if (options.malformedAbsence && deletes) return Response.json({});
      if (options.arrayAbsence && deletes) return Response.json({ QueryResponse: [] });
      let rows = entry ? [structuredClone(entry)] : [];
      if (options.multiple && entry) rows.push({ ...entry, Id: '456' });
      if (options.wrongMarker && rows.length) rows[0].PrivateNote = 'Another run';
      return Response.json({ QueryResponse: { JournalEntry: rows } });
    }
    if (url.pathname.endsWith('/journalentry') && url.searchParams.get('operation') === 'delete') {
      deletes++;
      assert.equal(creates, 1);
      assert.deepEqual(JSON.parse(init.body), { Id: '123', SyncToken: '0' });
      if (options.deleteFailure) return new Response(token, { status: 500 });
      entry = null;
      return Response.json({ JournalEntry: { Id: '123', status: 'Deleted' } });
    }
    if (url.pathname.endsWith('/journalentry')) {
      creates++;
      assert.equal(creates, 1, 'must never blindly repeat a create');
      const payload = JSON.parse(init.body);
      assert.equal(payload.DocNumber.length, 21);
      assert.deepEqual(payload.Line.map(x => x.Amount), [0.01, 0.01]);
      assert.deepEqual(payload.Line.map(x => x.JournalEntryLineDetail.AccountRef.value), ['2', '9']);
      if (!options.missingEntry) entry = { ...payload, Id: '123', SyncToken: '0' };
      if (options.timeout) throw new Error(`${token} unsafe network detail`);
      if (options.malformedCreate) return Response.json({});
      return Response.json({ JournalEntry: entry });
    }
    if (url.pathname.endsWith('/journalentry/123')) {
      reads++;
      if (options.readFailure && reads === 1) return new Response(token, { status: 500 });
      const copy = structuredClone(entry);
      if (options.wrongReadAccount && reads === 1) copy.Line[0].JournalEntryLineDetail.AccountRef.value = '777';
      return Response.json({ JournalEntry: copy });
    }
    throw new Error('Unexpected path');
  };
  return {
    run: () => runSandboxValidation({ run: true, env: { ...env, ...options.env }, fetchImpl }),
    state: () => ({ creates, deletes, entry, calls }),
  };
}

test('opt-in and missing sandbox credentials block without network or production fallback', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected'); };
  assert.equal((await runSandboxValidation({ env, fetchImpl })).code, 'run_opt_in_required');
  assert.equal((await runSandboxValidation({ run: true, env: { QBO_ACCESS_TOKEN: token }, fetchImpl })).code, 'sandbox_credentials_missing');
  assert.equal((await runSandboxValidation({ run: true, env: { ...env, QBO_SANDBOX_REALM_ID: '../production' }, fetchImpl })).code, 'sandbox_realm_invalid');
  assert.equal(calls, 0);
});

test('one cent create, exact recovery query, readback and confirmed cleanup pass', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'passed');
  assert.equal(result.cleanup, 'verified_absent');
  assert.equal(result.doc_number.length, 21);
  assert.equal(f.state().creates, 1);
  assert.equal(f.state().deletes, 1);
  assert.equal(f.state().entry, null);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes('Private Bank'));
});

for (const option of ['timeout', 'malformedCreate']) {
  test(`${option} after create recovers the existing JE without another POST`, async () => {
    const f = fixture({ [option]: true });
    const result = await f.run();
    assert.equal(result.status, 'passed');
    assert.equal(result.create_outcome, 'recovered');
    assert.equal(f.state().creates, 1);
    assert.equal(f.state().deletes, 1);
  });
}

test('preexisting DocNumber blocks before create and never deletes', async () => {
  const f = fixture({ preexisting: true });
  assert.equal((await f.run()).status, 'failed');
  assert.equal(f.state().creates, 0);
  assert.equal(f.state().deletes, 0);
});

for (const option of ['multiple', 'wrongMarker', 'missingEntry']) {
  test(`ambiguous create with ${option} cannot claim pass or delete an unowned JE`, async () => {
    const f = fixture({ timeout: true, [option]: true });
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.cleanup, 'required');
    assert.equal(f.state().creates, 1);
    assert.equal(f.state().deletes, 0);
    assert.ok(!JSON.stringify(result).includes(token));
  });
}

for (const option of ['queryFailure', 'readFailure', 'wrongReadAccount', 'deleteFailure', 'absenceFailure', 'malformedAbsence', 'arrayAbsence']) {
  test(`${option} never becomes a passing validation`, async () => {
    const f = fixture({ [option]: true });
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.equal(f.state().creates, 1);
    assert.ok(!JSON.stringify(result).includes(token));
    if (['queryFailure', 'readFailure', 'wrongReadAccount'].includes(option)) {
      assert.equal(result.cleanup, 'verified_absent');
    } else assert.equal(result.cleanup, 'required');
  });
}

test('HTTP errors redact the raw response and stop before creation', async () => {
  const f = fixture({ accountError: true });
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.equal(f.state().creates, 0);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes('raw account names'));
});

test('no eligible sandbox accounts stops before creation', async () => {
  const f = fixture({ accountsMissing: true });
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, 'eligible_sandbox_accounts_missing');
  assert.equal(f.state().creates, 0);
});

test('production environment and base URL inputs cannot override the sandbox host', async () => {
  const f = fixture({ env: { QBO_BASE_URL: 'https://quickbooks.api.intuit.com', QBO_ENVIRONMENT: 'production' } });
  assert.equal((await f.run()).status, 'passed');
  assert.ok(f.state().calls.every(call => call.url.origin === 'https://sandbox-quickbooks.api.intuit.com'));
});
