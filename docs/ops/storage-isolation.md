# Storage isolation — what it is and how to prove it

Fixed 2026-09-04 (`20260904120000_storage_company_scoping.sql`).

## What was wrong

The database tier is properly multi-tenant: every operational table carries
`company_entity_id` and every policy checks `active_company_id()`.

**Storage was not.** All 27 policies on `storage.objects` gated on the bucket
alone. In full, the payment-request read policy was:

```sql
using (bucket_id = 'payment-request-files')
```

That is *any authenticated user, of any company, may read or delete any
object in this bucket* — 375 payment-request attachments (invoices,
commission statements, AP confirmations) and 51 mailroom scans.

The buckets being "private" bought nothing. Private means the CDN will not
serve the file anonymously. **RLS is what decides who may**, and it said
everyone.

The `schedule-item-files` policies are the clearest evidence this was copied
rather than decided: they are *named* `"schedule files readable by company"`
and contain no company clause at all, because they were modelled on the
payment-request ones.

## The fix

Every private bucket already writes its parent row's id as the first path
segment (`<payment_request_id>/<file>`, `<mail_item_id>/<file>`), and the
parent tables are the ones with correct RLS. So the object inherits the row's
visibility through a plain `EXISTS` — no `SECURITY DEFINER`, no path
rewriting, no backfill, and **no second definition of who may see what**.

For payment requests that is *stricter* than company scoping, and right:
`payment_requests_active_select` is "your own request, or you manage AP, or
you are an admin", so an attachment is now exactly as visible as the request
it belongs to.

| Bucket | Read | Write / delete |
|---|---|---|
| `payment-request-files` (private) | parent request | parent request |
| `mail-item-files` (private) | parent mail item | parent mail item |
| `schedule-item-files` (private) | parent schedule item | parent schedule item |
| `sample-images` (public) | **public** — see below | parent sample |
| `launch-images` (public) | **public** | uploader only |
| `product-concept-images` (public) | **public** | uploader only |
| `avatars` (public) | **public** | own `auth.uid()` folder (unchanged) |

### Why public buckets keep public reads

A public bucket is served at `/object/public/...` with **no RLS evaluated at
all**. Tightening a SELECT policy there would be theatre: it cannot hide a
file from anyone who has the URL. What a policy *can* do is stop another
company's user deleting it, so that is what changed.

### What is deliberately still open

`launch-images` and `product-concept-images` accept an INSERT from any
authenticated user. Neither has a usable key: `launches/<launchId>-<ts>.png`
is not a folder, and the id is literally the string `new` for an image
attached before the launch row is saved (3 of the 10 objects). The honest fix
is to put the company id in the upload path — a page change, not a policy
change. A stray image in a public marketing bucket is not worth blocking an
upload over; deleting someone else's was, and that is closed.

## How to prove it

### 1. The one-line check

Run `supabase/verify_v2_schema.sql` in the SQL editor. The
`storage_isolation` row must read `ok`. It fails if any private-bucket policy
stops naming its parent table — the exact shape of the original bug.

### 2. In SQL, as another company's user

Impersonate rather than trust the policy text. Substitute a real user id from
the *other* company:

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<other-company-user-uuid>","role":"authenticated"}';
select bucket_id, count(*)
  from storage.objects
 where bucket_id in ('payment-request-files','mail-item-files')
 group by bucket_id;
rollback;
```

**Expected: no rows.** Before the fix this returned 375 and 51.

Then run the same block with a Baseballism id and confirm the counts come
back — that is the half that catches an over-tightening.

Note you cannot test DELETE this way: `storage.protect_delete()` blocks
direct SQL deletion from storage tables regardless of policy. The DELETE
policy carries the same `EXISTS` as SELECT, so a zero-row SELECT is the same
predicate returning zero.

### 3. In the app — the test that actually matters

Policies are only half of it; the pages have to still work.

1. **Purchase Request** (`/v2/purchase_request.html`) — submit a request with
   a file attached. The upload must succeed.
2. **Request Manager** (`/v2/request_manager.html`) — open that request, view
   the attachment (it mints a signed URL), upload an AP confirmation file,
   then delete a file. All four must work.
3. **Mailroom** (`/v2/mail-intake.html` → `/v2/mailroom.html`) — intake an
   item with a scan, then open it from the queue and view the file.
4. **Products → Samples** (`/v2/products.html`) — request a sample with a
   photo; the thumbnail must appear on the card.
5. **Launch Calendar** (`/v2/launch-calendar.html`) — attach an image to a
   launch, including a **brand-new unsaved** launch (that is the `new-<ts>`
   path that no parent-row check could satisfy).

If any upload starts failing with a 403 from storage, the cause is almost
certainly a path convention that does not put the parent id first.

## If you add a bucket

Put the parent row's id first in the path and write the policy as an `EXISTS`
against that parent. Do not copy an existing policy body — that is how
`schedule-item-files` ended up named "by company" with no company in it.
