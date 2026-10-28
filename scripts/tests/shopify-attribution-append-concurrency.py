"""Real PostgreSQL 17 concurrency tests. Owns an isolated, network-less Docker container.
No host ports, mounted production files, credentials or production endpoints.
Run: python scripts/tests/shopify-attribution-append-concurrency.py
"""
import json
import pathlib
import select
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
IMAGE = 'postgres:17@sha256:31ba9c94a03ada9988f2bb493a22a75eef3a185884533e5cdbcd498ea835b08f'
NAME = 'silo-append-test-' + uuid.uuid4().hex[:10]
CO = '00000000-0000-0000-0000-000000000001'
CONN = '00000000-0000-0000-0000-000000000003'

def docker(*args, **kwargs):
    return subprocess.run(['docker', *args], text=True, capture_output=True, check=True, **kwargs)

def command():
    return ['docker', 'exec', '-i', NAME, 'psql', '-U', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']

def sql(query):
    result = subprocess.run(command(), input=query, text=True, capture_output=True)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()

def quoted(value):
    return "'" + str(value).replace("'", "''") + "'"

def js(value):
    return quoted(json.dumps(value)) + '::jsonb'

def evidence(order, codes=None):
    obj = {'order': {'id': 'gid://shopify/Order/' + order, 'customerJourneySummary': {'ready': True}}, 'allocations': {'30': {'channel': 'Original'}}}
    if codes is not None:
        obj['order']['discountCodes'] = codes
    return obj

def payload(day, order, codes=None):
    return {'kind': 'day', 'day': day, 'currency': 'USD', 'timezone': 'UTC', 'collected_at': '2026-01-10T00:00:00Z', 'orders': [{'order_id': order, 'evidence': evidence(order, codes)}], 'ledger': [{'order_id': order, 'net_cents': 100, 'total_cents': 120}], 'net_cents': 100, 'total_cents': 120}

def append(data, run=None):
    return f"select append_shopify_attribution('{CO}','{CONN}','test.myshopify.com','{run or uuid.uuid4()}',{js(data)});"

def publish(day, order, codes=None):
    data = payload(day, order, codes)
    return f"select publish_shopify_attribution_day('{CONN}',{quoted(day)},'USD','UTC',{js(data['ledger'])},{js(data['orders'])},100,120,'2026-01-20T00:00:00Z');"

def start(query, app, hold=False):
    process = subprocess.Popen(command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    process.stdin.write(('\\o /dev/null\n' if hold else '') + f"set application_name={quoted(app)}; begin; set role service_role;\n" + query + ('\n\\o\n\\echo HELD\n' if hold else '\ncommit;\n'))
    process.stdin.flush()
    if not hold:
        process.stdin.close()
    else:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            # psql flushes query output; read all emitted lines until the sentinel.
            if select.select([process.stdout], [], [], 0.2)[0]:
                if process.stdout.readline().strip() == 'HELD':
                    return process
            if process.poll() is not None:
                raise AssertionError(process.stderr.read())
        raise AssertionError('holder never reached synchronization point')
    return process

def release(process, commit=True):
    process.stdin.write('commit;\n' if commit else 'rollback;\n')
    process.stdin.close()
    process.wait(timeout=15)
    assert process.returncode == 0, process.stderr.read()

def finish(process, success=True):
    process.wait(timeout=20)
    output, error = process.stdout.read(), process.stderr.read()
    assert (process.returncode == 0) == success, (output, error)
    return output if success else error

def blocked(app):
    for _ in range(40):
        if sql(f"select count(*) from pg_stat_activity where application_name={quoted(app)} and wait_event_type='Lock';") == '1':
            return
        time.sleep(0.05)
    raise AssertionError('contender did not block on a PostgreSQL lock: ' + app)

def codes(order):
    return json.loads(sql(f"select evidence#>'{{order,discountCodes}}' from shopify_attribution_orders where order_id={quoted(order)};"))

def count(table):
    return int(sql(f'select count(*) from {table};'))

try:
    docker('run', '--detach', '--rm', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', IMAGE)
    for _ in range(60):
        try:
            logs = docker('logs', NAME)
            if 'PostgreSQL init process complete' not in logs.stdout + logs.stderr:
                time.sleep(0.2)
                continue
            docker('exec', NAME, 'pg_isready', '-U', 'postgres')
            break
        except subprocess.CalledProcessError:
            time.sleep(0.2)
    sql("""create role anon;create role authenticated;create role service_role bypassrls;
create table entities(id uuid primary key);
create table shopify_connections(id uuid primary key,company_entity_id uuid,shop_domain text,is_active boolean,sync_enabled boolean);
create function active_company_id() returns uuid language sql as $$select null::uuid$$;
create function attach_stamp_company_entity_id_triggers() returns void language sql as $$select$$;
create table sync_jobs(id uuid primary key,company_entity_id uuid,connection_id uuid,job_type text constraint sync_jobs_job_type_check check(job_type=any(array['test_connection'::text])),status text,params jsonb,result jsonb,started_at timestamptz,finished_at timestamptz);
grant select,update on shopify_connections to service_role;grant all on sync_jobs to service_role;
""")
    for filename in ['20261007014722_silo_attribution_evidence.sql', '20261028205139_attribution_additive_history.sql']:
        sql((ROOT / 'supabase/migrations' / filename).read_text())
    sql(f"insert into entities values('{CO}');insert into shopify_connections values('{CONN}','{CO}','test.myshopify.com',true,true);")
    print(sql('select version();'), flush=True)

    a = start(publish('2026-01-01', '1'), 'publisher-first', True)
    b = start(append(payload('2026-01-01', '1', ['NEW'])), 'append-waits')
    blocked('append-waits'); release(a)
    assert 'existing_day' in finish(b)
    assert sql("select evidence#>'{order,discountCodes}' is null from shopify_attribution_orders where order_id='1';") == 't'
    print('PASS publisher-first: identical existing day skipped without evidence refresh', flush=True)

    a = start(append(payload('2026-01-02', '2', ['KEPT'])), 'append-first', True)
    b = start(publish('2026-01-02', '2'), 'publisher-waits')
    blocked('publisher-waits'); release(a); finish(b)
    assert codes('2') == ['KEPT']
    print('PASS append-first: concurrent old publisher preserves backfilled codes', flush=True)

    fill = {'kind': 'codes', 'collected_at': '2026-01-10T00:00:00Z', 'orders': [{'order_id': '1', 'discount_codes': []}]}
    a = start(append(fill), 'code-fill', True)
    b = start(publish('2026-01-03', '1'), 'shared-order-waits')
    blocked('shared-order-waits'); release(a); finish(b)
    assert codes('1') == []
    print('PASS different-day publisher: order-row lock preserves measured empty array', flush=True)

    data = payload('2026-01-04', '4', ['SAME']); run = str(uuid.uuid4())
    receipts = count('sync_jobs')
    a = start(append(data, run), 'receipt-owner', True)
    b = start(append(data, run), 'receipt-replay')
    blocked('receipt-replay'); release(a); finish(b)
    assert count('sync_jobs') == receipts + 1
    assert sql("select count(*) from shopify_attribution_days where day='2026-01-04';") == '1'
    print('PASS concurrent identical run: one atomic receipt and one day', flush=True)

    a = start(append(payload('2026-01-05', '5', ['SHARED'])), 'new-order-owner', True)
    b = start(append(payload('2026-01-06', '5', ['SHARED'])), 'unique-key-waits')
    blocked('unique-key-waits'); release(a); finish(b)
    assert sql("select count(*) from shopify_attribution_orders where order_id='5';") == '1'
    assert sql("select count(*) from shopify_attribution_days where day in ('2026-01-05','2026-01-06');") == '2'
    print('PASS concurrent distinct days sharing a new order: one preserved evidence row', flush=True)

    a = start(f"update shopify_connections set is_active=false where id='{CONN}';", 'disconnect', True)
    b = start(append(payload('2026-01-07', '7')), 'eligibility-waits')
    blocked('eligibility-waits'); release(a)
    assert 'eligibility mismatch' in finish(b, False)
    assert sql("select count(*) from shopify_attribution_days where day='2026-01-07';") == '0'
    sql(f"update shopify_connections set is_active=true where id='{CONN}';")
    print('PASS disconnect-first: blocked apply rechecks eligibility and writes nothing', flush=True)

    data = payload('2026-01-08', '8', ['RETRY']); run = str(uuid.uuid4())
    a = start(f"select pg_advisory_xact_lock(hashtextextended('{CONN}'||'2026-01-08',0));", 'day-lock', True)
    b = start(append(data, run), 'timeout-waits')
    blocked('timeout-waits')
    assert 'lock timeout' in finish(b, False)
    assert sql(f"select count(*) from sync_jobs where id='{run}';") == '0'
    release(a, False)
    assert 'applied' in sql('set role service_role;' + append(data, run))
    assert codes('8') == ['RETRY']
    print('PASS lock timeout: rollback has no receipt; same artifact replays successfully', flush=True)

    a = start(publish('2026-01-09', '9', ['FIRST']), 'conflict-owner', True)
    b = start(append(payload('2026-01-10', '9', ['SECOND'])), 'conflict-waits')
    blocked('conflict-waits'); release(a)
    assert 'Existing code conflict' in finish(b, False)
    assert codes('9') == ['FIRST']
    assert sql("select count(*) from shopify_attribution_days where day='2026-01-10';") == '0'
    print('PASS conflicting publisher-first evidence: append rolls back absent day', flush=True)
    # Deliberately reverse the old publisher's order locking to force a cycle.
    # Either victim is safe; replaying the same append run must converge.
    data = {'kind': 'codes', 'collected_at': '2026-01-10T00:00:00Z', 'orders': [{'order_id': '1', 'discount_codes': []}, {'order_id': '2', 'discount_codes': ['KEPT']}]}
    run = str(uuid.uuid4())
    a = start("select order_id from shopify_attribution_orders where connection_id='" + CONN + "' and order_id='2' for update;", 'reverse-publisher', True)
    b = start(append(data, run), 'deadlock-append')
    blocked('deadlock-append')
    ledger = [{'order_id': '2', 'net_cents': 100, 'total_cents': 120}, {'order_id': '1', 'net_cents': 0, 'total_cents': 0}]
    orders = [{'order_id': order, 'evidence': evidence(order)} for order in ['2', '1']]
    a.stdin.write(f"select publish_shopify_attribution_day('{CONN}','2026-01-11','USD','UTC',{js(ledger)},{js(orders)},100,120,'2026-01-25T00:00:00Z');\ncommit;\n")
    a.stdin.close()
    a.wait(timeout=20); b.wait(timeout=20)
    outcomes = [(p.returncode, p.stderr.read()) for p in [a, b]]
    assert sum(code == 0 for code, error in outcomes) == 1, outcomes
    assert any('deadlock detected' in error for code, error in outcomes), outcomes
    assert 'applied' in sql('set role service_role;' + append(data, run))
    assert codes('1') == [] and codes('2') == ['KEPT']
    assert sql(f"select count(*) from sync_jobs where id='{run}';") == '1'
    print('PASS forced publisher/append deadlock: victim rolls back; same run replays safely', flush=True)
    print('PASS all nine isolated PostgreSQL multi-session scenarios', flush=True)
finally:
    subprocess.run(['docker', 'rm', '--force', NAME], capture_output=True, check=False)
