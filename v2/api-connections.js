/* ==========================================================================
   SILO — connected applications, shared logic
   --------------------------------------------------------------------------
   Used by v2/api-consent.html (approving a connection) and
   v2/settings-connected-apps.html (seeing and disconnecting one). Pure
   functions only: no network, no DOM. The two pages do the talking.

   The one rule that matters here: every judgement this file makes about a
   grant must agree with silo_api_grant() in
   supabase/migrations/20261020030000_developer_api_integration_access.sql, as
   amended by 20261028070000. A screen that says "Active" about a connection
   the database refuses is worse than no screen, because the person stops
   looking for the real reason their app broke.
   ========================================================================== */
(function (global) {
  'use strict';

  /* The idle window, mirroring silo_api_idle_window(). Duplicated into the
     browser because a page cannot call an immutable SQL function for every
     row, and shown to people as a sentence rather than a number. If the
     database's window ever changes, this changes with it -- the verify check
     asserts the database side, and api-connections.test.mjs asserts this one
     matches the migration's literal. */
  const IDLE_DAYS = 30;
  const DAY_MS = 24 * 60 * 60 * 1000;

  /* The order is silo_api_grant()'s own order of refusal, and it is not
     cosmetic. A grant can be several of these at once -- revoked AND expired,
     expired AND idle -- and the first match is the one that explains it. Test
     idle last, because an expired grant is also idle by arithmetic and
     "Expired" is the truer answer. */
  function grantStatus(grant, now) {
    const t = (now instanceof Date ? now : new Date(now || Date.now())).getTime();
    if (!grant) return 'unknown';
    if (grant.revoked_at) return 'disconnected';
    if (grant.expires_at && new Date(grant.expires_at).getTime() <= t) return 'expired';
    const since = grant.last_used_at || grant.consented_at;
    if (!since || new Date(since).getTime() <= t - IDLE_DAYS * DAY_MS) return 'idle';
    return 'active';
  }

  /* What each status means to the person, in their terms. "Idle" is the one
     worth labouring: nothing was revoked and nothing was deleted, the
     connection simply stopped being used, and reconnecting from the
     application brings it back. Someone reading "Idle" beside an app that
     stopped working will otherwise assume SILO broke it. */
  const STATUS_COPY = {
    active: { label: 'Active', tone: 'pos',
      detail: 'Working normally.' },
    idle: { label: 'Idle', tone: 'warn',
      detail: 'Unused for ' + IDLE_DAYS + ' days, so it stopped working. Nothing was deleted —'
        + ' connect again from the application to bring it back.' },
    expired: { label: 'Expired', tone: 'neg',
      detail: 'Past its 90-day limit. Connect again from the application to approve a new one.' },
    disconnected: { label: 'Disconnected', tone: 'neg',
      detail: 'Someone disconnected this. Connect again from the application to approve a new one.' },
    unknown: { label: 'Unknown', tone: 'warn', detail: '' },
  };

  /* Scope keys to a sentence a person can actually weigh. An unknown scope is
     shown verbatim rather than hidden: a connection asking for something this
     page does not recognise is exactly the one not to approve silently. */
  const SCOPE_COPY = {
    'reports:read': 'Read your reports',
  };
  function describeScopes(scopes) {
    const list = Array.isArray(scopes) ? scopes : [];
    if (!list.length) return [];
    return list.map((s) => SCOPE_COPY[s] || s);
  }

  /* Supabase AUTO-APPROVES a repeat authorization: when the person has
     consented to this client before, getAuthorizationDetails() comes back with
     NO authorization_id, only a redirect_url to follow, and Supabase's own
     example code follows it immediately.

     Following it immediately is the bug. SILO keeps its own grant row, and
     that row is what every boundary reads -- so a connection that went idle,
     expired, or that an owner disconnected would be impossible to restore:
     the person reconnects from the app, Supabase says "already consented",
     the page redirects, no grant row is written, and the connection stays
     dead with nothing on screen admitting it.

     So this returns what the page must DO, and the already-consented branch
     still writes the grant. Nothing else on either page is as easy to get
     wrong or as quiet when it is wrong. */
  function planFromAuthorizationDetails(details) {
    if (!details || typeof details !== 'object') {
      return { kind: 'error', reason: 'no_details' };
    }
    const hasId = typeof details.authorization_id === 'string' && details.authorization_id !== '';
    if (!hasId) {
      if (!details.redirect_url) return { kind: 'error', reason: 'no_redirect' };
      return {
        kind: 'already_consented',
        redirectUrl: details.redirect_url,
        clientId: clientIdOf(details),
        clientName: clientNameOf(details),
        scope: scopeList(details),
      };
    }
    return {
      kind: 'ask',
      authorizationId: details.authorization_id,
      redirectUri: details.redirect_uri || '',
      clientId: clientIdOf(details),
      clientName: clientNameOf(details),
      scope: scopeList(details),
    };
  }

  /* The client arrives nested under `client` in the documented shape, but the
     endpoint is beta and a flat client_id/client_name is the obvious other
     shape. Read both rather than render "undefined" at the one moment a
     person is deciding whether to trust an application. */
  function clientIdOf(d) {
    return (d.client && (d.client.id || d.client.client_id)) || d.client_id || '';
  }
  function clientNameOf(d) {
    return (d.client && (d.client.name || d.client.client_name)) || d.client_name || '';
  }

  /* Supabase's authorization details carry `scope`, SINGULAR, as a
     space-separated string. getUserGrants() carries `scopes`, an array. Both
     appear in this codebase, so normalise once here. */
  function scopeList(d) {
    if (Array.isArray(d.scopes)) return d.scopes.filter(Boolean);
    if (typeof d.scope === 'string') return d.scope.split(/\s+/).filter(Boolean);
    return [];
  }

  /* What SILO grants, as opposed to what the OAuth request asked for. The
     OIDC scopes (openid, email, profile, phone) govern identity claims and
     NOT database access -- Supabase's own documentation says so -- and
     silo_api_consent() ignores anything outside its allowlist. So the page
     asks for exactly what SILO offers and says so plainly, rather than
     echoing an OAuth scope string as though it were the permission. */
  const SILO_SCOPES = ['reports:read'];

  /* A name to show when the client has none. Not "Unknown application" as a
     label on its own -- the client_id is the only identifying thing left, so
     show it rather than nothing. */
  function displayName(clientName, clientId) {
    const n = String(clientName || '').trim();
    if (n) return n;
    const id = String(clientId || '').trim();
    return id ? 'Application ' + id.slice(0, 8) : 'An application';
  }

  const api = {
    IDLE_DAYS, SILO_SCOPES, STATUS_COPY, SCOPE_COPY,
    grantStatus, describeScopes, planFromAuthorizationDetails,
    scopeList, clientIdOf, clientNameOf, displayName,
  };
  global.SiloApiConnections = api;
})(typeof window !== 'undefined' ? window : globalThis);
