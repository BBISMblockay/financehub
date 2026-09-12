# Finance database regressions

Run from the repository root:

```sh
npm ci --prefix scripts/tests/finance-db
node scripts/tests/finance-v1-database.test.mjs
```

The pinned PGlite engine runs actual PostgreSQL SQL, `pgcrypto`, PL/pgSQL,
constraints, grants and RLS in a disposable in-memory database. It cannot connect
to Supabase or QBO and contains only synthetic UUIDs, accounts and transactions.
The finance schema is loaded from the repository's unmodified dependency
migrations and the draft controls migration; `bootstrap.sql` supplies only the
minimal unrelated auth/company/catalog foundation.

This verifies PostgreSQL behavior, including JSON numeric scale, role switches,
approval immutability, source binding, and void/reopen behavior. It does not run
the full production migration chain, PostgREST, a deployed Edge Function, Intuit,
or concurrent independent PostgreSQL sessions. Those deployment/integration
checks remain separate gates.

Mutation checks restore the original broken hash call path or the actual old
void SQL definition; each command must fail its ordinary regression assertion:

```sh
FINANCE_DB_MUTATION=roundtrip-hash node scripts/tests/finance-v1-database.test.mjs
FINANCE_DB_MUTATION=legacy-void node scripts/tests/finance-v1-database.test.mjs
```
