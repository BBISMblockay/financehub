# Member Onboarding — SILO ERP

How to add a new team member to SILO. Covers both what the new member does and what you (the admin) do.

---

## How access works

SILO uses Supabase Auth for login and a `profiles` table to control what a signed-in user can actually see. **Both must exist** for a user to get in:

1. A Supabase **auth user** (created when they sign up)
2. A **profiles row** with `is_active = true` (created when you approve them)

A user who has signed up but has no profile row will hit an error on login: _"No profile found for this user."_ — that's intentional and expected until you approve them.

---

## Roles and departments

### Roles (`profiles.role`)

| Role | What it gets |
|------|-------------|
| `admin` | Full read + write on POs, costing, launches, payments. Currently all 7 team members. |
| `owner` | Same as admin + owner cockpit access. Use for blake only. |
| `user` | Read-only on PO/costing tables. Suitable for contractors or viewers. |

> Default for new internal team members: **`admin`**.

### Departments

`ops` · `finance` · `logistics` · `marketing` · `retail` · `exec`

Department controls the post-login redirect destination. Most land on `/v2/finance.html`. Set it to whatever fits their role.

---

## Step 1 — Send the member this note

> **Subject: SILO ERP access — getting you set up**
>
> Hey [Name],
>
> Here's how to get into SILO:
>
> 1. Go to **[SILO login URL]** (ask Blake if you don't have it)
> 2. Click **"Create account"**
> 3. Enter your name, your **@baseballism.com email**, and a password (6+ characters)
> 4. Click Create account — you'll see a message saying your access is pending
> 5. That's it on your end. I'll approve you and let you know when you're in.
>
> Once I approve you, come back to the same URL and sign in normally.

---

## Step 2 — Admin: approve the member in Backend Hub

1. Open **SILO → Backend Hub** (`/v2/backend.html`)
2. Under **Pending access requests**, find their row
3. Click **Review**
4. Confirm or set:
   - **Department** — pick the right one (e.g. `ops`, `finance`, `exec`)
   - **Role** — `admin` for internal team, `user` for read-only/contractors
5. Click **Approve**

The system will upsert a `profiles` row tied to their auth user (matched on email). They can sign in immediately after.

> If their request doesn't appear in the list, see the **Troubleshooting** section below.

---

## Step 3 — Verify

After approving:

- Refresh the **Profiles** table in Backend Hub — their row should appear as **active**
- Optionally, ask them to sign in and confirm they land on the right page
- Their role and department can be edited at any time by clicking their row in the Profiles table

---

## Editing an existing member

1. Open **Backend Hub → Profiles** section
2. Find the user (search by email or name)
3. Click their row (or the **Edit** button)
4. Adjust name, department, role, or status
5. Click **Save** — changes take effect immediately on their next page load

To deactivate a user: click **Disable** in the edit dialog. This sets `is_active = false` and blocks login without deleting their auth account.

---

## Removing access

SILO does not hard-delete users. To revoke access:

1. Open their profile in Backend Hub
2. Click **Disable**

If you need to permanently remove the Supabase auth user (rare), do it in the **Supabase Dashboard → Authentication → Users** section. That is out-of-band and not needed for normal offboarding.

---

## Troubleshooting

### "No profile found for this user" on login
The user signed up successfully but has not been approved yet. Go to Backend Hub and approve them.

### Their request doesn't appear in "Pending access requests"
The `access_requests` row may not have been created automatically on signup. You can manually create a `profiles` row instead:

1. Get their auth user UID from **Supabase Dashboard → Authentication → Users**
2. In **Supabase SQL Editor**, run:

```sql
insert into public.profiles (id, email, name, role, department, is_active)
values (
  '<their-auth-uid>',
  '<their-email>',
  '<their-name>',
  'admin',
  'ops',
  true
)
on conflict (id) do update
  set is_active = true,
      role = excluded.role,
      department = excluded.department,
      updated_at = now();
```

Then verify the row appears in Backend Hub → Profiles.

### "Access denied: owner/admin/superadmin required" on Backend Hub
The person trying to open Backend Hub has role `user`. Only `owner`, `admin`, or `superadmin` can access it. Update their role in Profiles first.

### Profile was updated but user still sees old behavior
Profiles are read on each page load. Ask them to hard-refresh (Ctrl+Shift+R / Cmd+Shift+R) or sign out and back in.

---

## Current team (as of Jun 2026)

All 7 active members have `role = admin`. Owner account is blake@baseballism.com (`role = owner`).

To see the live list: **Backend Hub → Profiles** or run:

```sql
select email, name, role, department, is_active, updated_at
from public.profiles
order by created_at;
```
