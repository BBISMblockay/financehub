// org-invite-redeem — PUBLIC (verify_jwt off): the invite token IS the auth,
// same model as review-portal. Powers the "set password & join" screen for
// invitees who don't have a SILO account yet — receiving the invite email
// already proved ownership of the address, so the account is created with
// email_confirm true and no confirmation round-trip.
//
// Actions:
//   peek   { token }                 → { email, org_title, account_exists }
//   redeem { token, password, name } → creates the confirmed auth user with
//            that password, applies the invite (profile role/department,
//            entity membership, active company), marks it accepted. The
//            client then signs in with the password normally.
//
// Existing accounts never redeem here — they sign in and the login page
// calls the accept_org_invite RPC as the authenticated user.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const db = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { action, token, password, name } = await req.json();
    if (!token) return reply({ error: 'token required' }, 400);

    const { data: invite } = await db
      .from('org_invites')
      .select('id, entity_id, email, role, department, status, expires_at')
      .eq('token_hash', await sha256hex(String(token)))
      .single();

    if (!invite || invite.status !== 'pending') {
      return reply({ error: 'Invite not found or no longer valid' }, 404);
    }
    if (new Date(invite.expires_at) < new Date()) {
      await db.from('org_invites').update({ status: 'expired' }).eq('id', invite.id);
      return reply({ error: 'Invite has expired — ask your admin for a new one' }, 410);
    }

    const { data: entity } = await db.from('entities').select('title').eq('id', invite.entity_id).single();
    const orgTitle = entity?.title || 'your team';

    // Every auth user has a profiles row (handle_new_user trigger), so
    // profile existence tells us whether this email already has an account.
    const { data: existing } = await db
      .from('profiles')
      .select('id')
      .ilike('email', invite.email)
      .maybeSingle();

    if (action === 'peek') {
      return reply({ ok: true, email: invite.email, org_title: orgTitle, account_exists: !!existing });
    }

    if (action !== 'redeem') return reply({ error: 'unknown action' }, 400);

    if (existing) {
      return reply({ error: 'account_exists', message: 'This email already has a SILO account — sign in instead.' }, 409);
    }
    if (!password || String(password).length < 6) {
      return reply({ error: 'Password must be at least 6 characters.' }, 400);
    }

    // email_confirm: the invite email delivered to this address is the proof
    // of ownership — no second confirmation email needed.
    const { data: created, error: cErr } = await db.auth.admin.createUser({
      email: invite.email,
      password: String(password),
      email_confirm: true,
      user_metadata: name ? { name: String(name) } : {},
    });
    if (cErr || !created?.user) {
      return reply({ error: `Could not create account: ${cErr?.message || 'unknown error'}` }, 500);
    }
    const uid = created.user.id;

    const profileRole = invite.role === 'owner' ? 'owner' : invite.role === 'admin' ? 'admin' : 'user';
    const membershipRole = invite.role === 'owner' ? 'owner_admin' : invite.role === 'admin' ? 'admin' : 'member';

    // handle_new_user already created the bare profile; apply the invite.
    const { error: pErr } = await db
      .from('profiles')
      .update({
        name: name ? String(name) : null,
        role: profileRole,
        department: invite.department,
        is_active: true,
        active_company_id: invite.entity_id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', uid);
    if (pErr) return reply({ error: `Profile setup failed: ${pErr.message}` }, 500);

    const { error: mErr } = await db
      .from('entity_memberships')
      .upsert({ entity_id: invite.entity_id, user_id: uid, role: membershipRole }, { onConflict: 'entity_id,user_id' });
    if (mErr) return reply({ error: `Membership setup failed: ${mErr.message}` }, 500);

    await db.from('org_invites')
      .update({ status: 'accepted', accepted_by: uid, accepted_at: new Date().toISOString() })
      .eq('id', invite.id);

    return reply({ ok: true, email: invite.email, org_title: orgTitle });
  } catch (err) {
    console.error('[org-invite-redeem]', err);
    return reply({ error: String(err?.message || err) }, 500);
  }
});
