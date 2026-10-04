# Early-access intake: backend preflight (2026-10-03)

## Scope and call path, established before implementation

- New landing form -> public `onboarding-interest` Edge Function -> one service-role `submit_onboarding_interest` transaction -> new `onboarding_interest_queue` only
- Platform-admin queue -> table SELECT / UPDATE(status), authorized by the existing `is_platform_admin()` predicate
- New endpoint has no existing call sites. No existing RPC or tenant table/policy changes. No invitation, authentication, billing, or email workflow is invoked
- Existing deploy workflow accepts one function or `all`; both must keep this new function public (`--no-verify-jwt`). The code validates its own input; this endpoint intentionally has no user session
- Live preflight verified: project `mkquclffrvlzyecnabyf` is Silo; queue/rate tables absent; `is_platform_admin()` uses platform_admins + auth.uid(), callable by authenticated, not anon. Public default ACLs grant ALL table privileges and function EXECUTE to anon/authenticated/service_role. Explicit revocation is mandatory

## Decisions and failure model

- Body is at most 4 KiB, read incrementally, JSON only, exactly name/company_name/email/optional website; name 120, company 200, email 254 characters maximum. Honeypot is rejected with generic 400, never a false saved response
- Names/company are trimmed, bounded, nonempty, no control characters. Email is trimmed and lowercased, with practical ASCII mailbox/domain validation. Database constraints repeat bounded/normalized validation
- No verified trustworthy client-IP header contract is available: ignore all IP headers. Durable global bounds: 30 requests/minute, 300/day; email bound: 3/hour. This is an intentional availability tradeoff: a determined sender can exhaust global intake temporarily. CORS is not authentication and does not prevent non-browser abuse
- Email bucket identity is HMAC-SHA256 with the existing service-role environment key, domain separated. No new credential, raw IP, user agent, or email is stored in rate buckets. Queue holds only the requested contact data
- One SECURITY INVOKER RPC, callable only by service_role; transaction-scoped global lock serializes limit checks and the insert. Counters only advance for admitted attempts. Duplicate attempts consume identical quota to new attempts. Per-email cooldown is evaluated before checking whether a lead exists, preventing duplicate enumeration
- Success is identical for first and duplicate submissions. ON CONFLICT(email) DO NOTHING preserves original name/company/status/timestamp. The email uniqueness constraint arbitrates concurrent retry submissions
- Persistence and quota updates commit or roll back together. A write error, timeout, unexpected RPC result, or missing configuration returns 503; no PII or database exception goes into the response or log
- Cleanup deletes only expired rate rows, at most 100 per request, using an expiry index. It never deletes leads. Global rows are reusable and per-email keys can only be added after the global checks admit a request
- No background task or mutable in-memory counters. Lost-success retry finds the preserved row, subject to the same quota as any request
- All queue table grants are explicitly revoked first; authenticated receives SELECT + column UPDATE(status) only. Policies require is_platform_admin() on both USING and WITH CHECK. No anon access and no ordinary company-admin access. Rate buckets have RLS, no client policies/grants

## Tests specified before implementation

1. Execute the migration twice in isolated PostgreSQL (PGlite) with poisoned Supabase-like default table/function grants
2. Impersonate anon, ordinary company admin, platform admin, and service_role. Check queue denial, status-only column permissions, all unsupported writes refused, rate data/RPC private, and no broad authority change
3. New lead + normalized retry: same outcome, one row, original fields/status/created_at preserved; overlapping queued calls collapse (PGlite uses one connection; true multiconnection interleaving remains untested)
4. CHECK violations: empty/oversized fields, malformed/non-normalized email, invalid source/status; RPC checks reject nulls, invalid digest, oversized fields
5. DB quotas survive separate invocations; request 31/minute, request 301/day, request 4/email/hour denied; blocked attempts add no new email bucket; expired buckets reset; cleanup bounded to 100
6. Execute actual deployed handler wiring with fake fetch only: normal/duplicate, honeypot, origin/preflight/method, JSON/schema/type checks, oversized declared and streamed bodies, missing env, fetch rejection/non-2xx/malformed result, honest 429, and no leaked secrets/PII
7. Mutation checks must catch widened admin gate/grants, duplicate overwrite, non-atomic quota bypass, and false-success persistence errors
8. Independent final integrated-path security review before any live migration. No live apply or function deploy during isolated testing

## Sources checked

- Supabase changelog (2026-10-03), current Edge Function authorization headers and per-function configuration docs
- Supabase security/RLS docs and Postgres RLS performance guidance (predicate evaluated through scalar SELECT)
