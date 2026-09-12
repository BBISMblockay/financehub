// Opt-in external API contract probe. No Supabase access, OAuth refresh, or production URL.
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  makeDocNumber, qboQueryForDocNumber, buildApprovedPayload, compareJournalEntry,
} from '../supabase/functions/quickbooks-post-journal/posting-core.mjs';

const SANDBOX = 'https://sandbox-quickbooks.api.intuit.com';
const safeId = value => typeof value === 'string' && /^\d+$/.test(value);
const fault = code => Object.assign(new Error(code), { safeCode: code });
const errorCode = error => error?.safeCode || 'transport_or_response_error';

export async function runSandboxValidation({
  run = false, env = process.env, fetchImpl = globalThis.fetch, onProgress = () => {},
} = {}) {
  const result = { status: 'blocked', scope: 'qbo_sandbox_contract', cleanup: 'not_needed', requests: [] };
  if (!run) return { ...result, code: 'run_opt_in_required' };
  const realm = env.QBO_SANDBOX_REALM_ID?.trim();
  const token = env.QBO_SANDBOX_ACCESS_TOKEN?.trim();
  if (!realm || !token) return { ...result, code: 'sandbox_credentials_missing',
    required_env: ['QBO_SANDBOX_REALM_ID', 'QBO_SANDBOX_ACCESS_TOKEN'] };
  if (!safeId(realm)) return { ...result, code: 'sandbox_realm_invalid' };
  if (/[\r\n]/.test(token)) return { ...result, code: 'sandbox_token_invalid' };

  const runId = randomUUID();
  const docNumber = makeDocNumber(createHash('sha256').update(runId).digest('hex'));
  result.doc_number = docNumber;
  result.run_id = runId;
  result.status = 'failed';
  let payload;
  let knownId;
  let createAttempted = false;
  let validated = false;
  let stage = 'account_lookup';

  async function request(label, path, body) {
    const url = new URL(`${SANDBOX}/v3/company/${realm}/${path}`);
    url.searchParams.set('minorversion', '75');
    const event = { step: label, method: body ? 'POST' : 'GET' };
    result.requests.push(event);
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: event.method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      event.http_status = response.status;
      const trace = response.headers.get('intuit_tid');
      if (trace && /^[a-f0-9-]{16,128}$/i.test(trace) && trace !== token) event.intuit_tid = trace;
      if (!response.ok) throw fault(`http_${response.status}`);
      const data = await response.json();
      if (!data || typeof data !== 'object' || data.Fault) throw fault('qbo_response_invalid');
      return data;
    } catch (error) {
      // Never return raw Intuit bodies, account names, token values, or fetch errors.
      event.error = errorCode(error);
      throw fault(event.error);
    }
  }

  async function queryEntries(label) {
    const data = await request(label, `query?query=${encodeURIComponent(qboQueryForDocNumber(docNumber))}`);
    if (!data.QueryResponse || typeof data.QueryResponse !== 'object' || Array.isArray(data.QueryResponse)) {
      throw fault('query_response_invalid');
    }
    const rows = data.QueryResponse.JournalEntry;
    if (rows === undefined) return [];
    if (!Array.isArray(rows)) throw fault('query_entries_invalid');
    return rows;
  }

  function owns(entry, requireDoc = true) {
    return entry && safeId(entry.Id)
      && (!requireDoc || entry.DocNumber === docNumber)
      && entry.PrivateNote === payload.PrivateNote && entry.TxnDate === payload.TxnDate
      && compareJournalEntry(payload, entry);
  }

  async function recoverId(label) {
    const found = await queryEntries(label);
    if (found.length !== 1 || !owns(found[0])) throw fault('unique_owned_entry_not_found');
    if (knownId && knownId !== found[0].Id) throw fault('recovery_id_mismatch');
    knownId = found[0].Id;
    result.journal_entry_id = knownId;
    return found[0];
  }

  try {
    const data = await request(stage, `query?query=${encodeURIComponent('select * from Account where Active = true maxresults 1000')}`);
    if (!Array.isArray(data.QueryResponse?.Account)) throw fault('account_response_invalid');
    const accounts = data.QueryResponse.Account.filter(a => a.Active === true && safeId(a.Id))
      .sort((a, b) => a.Id.length - b.Id.length || a.Id.localeCompare(b.Id));
    const bank = accounts.find(a => a.AccountType === 'Bank');
    const expense = accounts.find(a => a.AccountType === 'Expense');
    if (!bank || !expense) throw fault('eligible_sandbox_accounts_missing');
    payload = buildApprovedPayload({ schema_version: 1, payload: {
      TxnDate: new Date().toISOString().slice(0, 10),
      PrivateNote: `SILO PR 670 sandbox validation ${runId}. Synthetic one-cent entry; delete after validation.`,
      ...(bank.CurrencyRef?.value ? { CurrencyRef: { value: bank.CurrencyRef.value } } : {}),
      Line: [
        { Amount: 0.01, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: {
          PostingType: 'Debit', AccountRef: { value: expense.Id },
        } },
        { Amount: 0.01, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: {
          PostingType: 'Credit', AccountRef: { value: bank.Id },
        } },
      ],
    } }, docNumber);
    stage = 'precreate_absence';
    if ((await queryEntries(stage)).length) throw fault('doc_number_already_exists');
    // Emit only synthetic recovery coordinates before the sole create attempt,
    // so a terminated CLI run can still be located without repeating the POST.
    onProgress({ event: 'before_create', environment: 'sandbox', run_id: runId, doc_number: docNumber });
    stage = 'create';
    createAttempted = true;
    result.cleanup = 'required';
    try {
      const created = (await request(stage, 'journalentry', payload)).JournalEntry;
      if (!safeId(created?.Id)) throw fault('create_response_missing_id');
      knownId = created.Id;
      result.journal_entry_id = knownId;
      result.create_outcome = 'confirmed';
    } catch (error) {
      result.create_outcome = 'unknown';
      result.create_error = errorCode(error);
    }
    stage = 'exact_doc_number_recovery';
    await recoverId(stage);
    if (result.create_outcome === 'unknown') result.create_outcome = 'recovered';
    stage = 'readback';
    const readback = (await request(stage, `journalentry/${knownId}`)).JournalEntry;
    if (!owns(readback) || readback.Id !== knownId) throw fault('readback_mismatch');
    validated = true;
  } catch (error) {
    result.failure = { step: stage, code: errorCode(error) };
  } finally {
    if (createAttempted) {
      try {
        if (!knownId) await recoverId('cleanup_recovery');
        const current = (await request('cleanup_read', `journalentry/${knownId}`)).JournalEntry;
        // A create response can identify our JE even if QBO mangled DocNumber;
        // still require its exact nonce, date and lines before deleting that Id.
        if (!owns(current, false) || current.Id !== knownId || !safeId(current.SyncToken)) {
          throw fault('cleanup_ownership_not_verified');
        }
        const deleted = (await request('delete', 'journalentry?operation=delete', {
          Id: knownId, SyncToken: current.SyncToken,
        })).JournalEntry;
        if (deleted?.Id !== knownId || deleted.status !== 'Deleted') throw fault('delete_not_confirmed');
        if ((await queryEntries('cleanup_absence')).length) throw fault('cleanup_entry_still_exists');
        result.cleanup = 'verified_absent';
      } catch (error) {
        result.cleanup_error = errorCode(error);
      }
    }
  }
  if (validated && result.cleanup === 'verified_absent') result.status = 'passed';
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const result = args.some(arg => arg !== '--run')
    ? { status: 'blocked', code: 'unsupported_argument', usage: 'node scripts/qbo-sandbox-validation.mjs --run' }
    : await runSandboxValidation({ run: args.includes('--run'),
      onProgress: event => process.stderr.write(`${JSON.stringify(event)}\n`) });
  if (result.code === 'run_opt_in_required') {
    result.usage = 'Set QBO_SANDBOX_REALM_ID and QBO_SANDBOX_ACCESS_TOKEN through your secret manager, then run: node scripts/qbo-sandbox-validation.mjs --run';
    result.effect = 'Creates one synthetic balanced $0.01 JE in Intuit sandbox, validates recovery/readback, then deletes it and verifies absence.';
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
}
