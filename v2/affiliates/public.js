// Shared by the three affiliate-facing pages (join, portal, apply). These
// pages have no SILO login: the link's token is the authorization, checked by
// the affiliate-portal edge function, which only ever sees its hash. The
// project's public anon key is sent because the function gateway requires a
// JWT; it is never treated as an identity.
export const cfg = window.__SILO_CONFIG__ || {};
export const $ = (id) => document.getElementById(id);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function setStatus(msg, type = 'info') {
  const el = $('status');
  el.className = `bcn-status bcn-status--${type}`;
  el.textContent = msg;
  el.hidden = !msg;
}

export async function call(action, payload = {}) {
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) throw Object.assign(new Error('Missing Supabase config'), { status: 0 });
  const res = await fetch(`${cfg.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/affiliate-portal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong. Try again in a minute.'), { status: res.status, code: body.code });
  return body;
}

// The token leaves the address bar as soon as it is read, so it is not in a
// screenshot, a bookmark or browser history; this tab keeps it for reloads.
export function takeToken(storageKey) {
  const url = new URL(location.href);
  let t = url.searchParams.get('t');
  try {
    if (t) sessionStorage.setItem(storageKey, t); else t = sessionStorage.getItem(storageKey);
  } catch { /* private mode: the token just is not kept across reloads */ }
  if (url.searchParams.has('t')) { url.searchParams.delete('t'); history.replaceState(null, '', url.pathname + url.search); }
  return t || '';
}

// Program terms are the brand's own text. They are shown as plain paragraphs,
// never as HTML, so nothing in them can run or restyle the page.
export function termsHtml(text) {
  const paras = String(text || '').trim().split(/\n\s*\n/).filter(Boolean);
  return paras.length ? paras.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') : '<p>The brand has not written terms for this program yet.</p>';
}

// The brand's mark: its logo when the company uploaded one (Settings ->
// Company), otherwise its initial in a badge. A logo that fails to load
// falls back to the initial too, so a page never shows a broken image.
const LOGO_RE = /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/company-logos\/[0-9a-f-]{36}\/logo-[0-9]{10,16}\.(png|jpg|jpeg|webp)$/;
export function brandMark(brand, logo) {
  const name = String(brand || 'Affiliate program');
  const initial = esc(name.trim().charAt(0).toUpperCase());
  if (typeof logo === 'string' && LOGO_RE.test(logo)) {
    return `<img class="af-logo" src="${esc(logo)}" alt="${esc(name)}" data-initial="${initial}">`;
  }
  return `<span class="af-badge" aria-hidden="true">${initial}</span>`;
}
export function wireBrandMark(root = document) {
  for (const img of root.querySelectorAll('img.af-logo')) {
    img.addEventListener('error', () => {
      const s = document.createElement('span');
      s.className = 'af-badge'; s.setAttribute('aria-hidden', 'true'); s.textContent = img.dataset.initial || '';
      img.replaceWith(s);
    }, { once: true });
  }
}
