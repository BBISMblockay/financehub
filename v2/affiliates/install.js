// "Add to home screen" for the rep portal (Blake 2026-11-17: "a cta that
// allows them to add to their iphone or android device as webapp ... to give
// more of an app feel").
//
// The portal has no password: its link IS the sign-in. So the home-screen
// icon must open the portal WITH the rep's link, or it would land on a
// sign-in form every time. Two platforms, two routes, one rule:
//   * Android / Chrome: a manifest is built on the page (a data: URL) whose
//     start_url carries the link, and Chrome's own install prompt is used.
//   * iPhone / iPad: Safari saves the CURRENT address, so pressing the button
//     puts the link back in the address bar and shows the two taps to make.
// The link is the rep's own and was in that same address bar when they
// arrived; nothing new is exposed, and it stays on their device.
// The icon is the brand's logo (or its initial), drawn square on a canvas.
import { esc } from './public.js';

const DISMISS_KEY = 'silo_affiliate_install_dismissed';
export const isStandalone = () => (window.matchMedia?.('(display-mode: standalone)').matches) || window.navigator.standalone === true;
export const platformOf = (ua = navigator.userAgent, touch = navigator.maxTouchPoints || 0) =>
  /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1) ? 'ios' : /Android/.test(ua) ? 'android' : 'other';

function drawIcon(brand, logo) {
  return new Promise((resolve) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    const initial = () => {
      g.fillStyle = '#14181d'; g.fillRect(0, 0, 512, 512);
      g.fillStyle = '#ffffff'; g.font = '700 260px "Plus Jakarta Sans", system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(brand || '?').trim().charAt(0).toUpperCase() || '?', 256, 276);
      resolve(c.toDataURL('image/png'));
    };
    if (!logo) return initial();
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 512);
        const s = Math.min(400 / img.width, 400 / img.height);
        const w = img.width * s, h = img.height * s;
        g.drawImage(img, (512 - w) / 2, (512 - h) / 2, w, h);
        resolve(c.toDataURL('image/png'));
      } catch { g.clearRect(0, 0, 512, 512); initial(); }
    };
    img.onerror = initial;
    img.src = logo;
  });
}

function headLink(rel, href, extra = {}) {
  let el = document.head.querySelector(`link[rel="${rel}"]`);
  if (!el) { el = document.createElement('link'); el.rel = rel; document.head.appendChild(el); }
  el.href = href; for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
}
function headMeta(name, content) {
  let el = document.head.querySelector(`meta[name="${name}"]`);
  if (!el) { el = document.createElement('meta'); el.name = name; document.head.appendChild(el); }
  el.content = content;
}

export function appUrl(token, loc = location) {
  return `${loc.origin}${loc.pathname}?t=${encodeURIComponent(token)}`;
}
export function manifestFor({ brand, token, icon, loc = location }) {
  return {
    name: `${brand} affiliate`, short_name: String(brand).slice(0, 12), start_url: appUrl(token, loc),
    scope: `${loc.origin}/v2/affiliates/`, display: 'standalone', background_color: '#ffffff', theme_color: '#14181d',
    icons: [{ src: icon, sizes: '512x512', type: 'image/png', purpose: 'any' }],
  };
}

let deferred = null;
window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); deferred = ev; });

export async function setupInstall({ token, brand, logo, mount, onStatus = () => {} }) {
  if (!token || !mount || isStandalone()) return;
  const icon = await drawIcon(brand, logo);
  headLink('manifest', `data:application/manifest+json,${encodeURIComponent(JSON.stringify(manifestFor({ brand, token, icon })))}`);
  headLink('apple-touch-icon', icon);
  headMeta('apple-mobile-web-app-capable', 'yes');
  headMeta('mobile-web-app-capable', 'yes');
  headMeta('apple-mobile-web-app-title', String(brand).slice(0, 12));
  const platform = platformOf();
  // On a computer there is no home screen to add to.
  if (platform === 'other' && !deferred) return;
  try { if (localStorage.getItem(DISMISS_KEY) === '1') return; } catch {}
  mount.innerHTML = `<div class="af-install" id="afInstall">
    <img class="af-install-icon" src="${icon}" alt="" width="44" height="44" />
    <div class="af-install-txt"><strong>Get the ${esc(brand)} app</strong><span>Add your portal to your home screen.</span></div>
    <button class="bcn-btn bcn-btn--primary" type="button" id="afInstallGo">Add to home screen</button>
    <button class="af-install-x" type="button" id="afInstallX" aria-label="Not now">×</button></div>`;
  mount.querySelector('#afInstallX').addEventListener('click', () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch {}
    mount.innerHTML = '';
  });
  mount.querySelector('#afInstallGo').addEventListener('click', async () => {
    if (deferred) {
      const ev = deferred; deferred = null;
      ev.prompt();
      const choice = await ev.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') { mount.innerHTML = ''; onStatus('Added. Open it from your home screen.', 'pos'); }
      return;
    }
    // Safari saves the address shown, so show the rep's link there first.
    history.replaceState(null, '', `${location.pathname}?t=${encodeURIComponent(token)}`);
    showSteps(platform, brand, icon);
  });
}

function showSteps(platform, brand, icon) {
  const steps = platform === 'ios'
    ? ['Tap <strong>Share</strong> <span class="af-install-glyph" aria-hidden="true">⎙</span> in the browser bar.', 'Tap <strong>Add to Home Screen</strong>.', 'Tap <strong>Add</strong>.']
    : ['Tap the browser menu <strong>⋮</strong>.', 'Tap <strong>Add to Home screen</strong> or <strong>Install app</strong>.', 'Tap <strong>Add</strong>.'];
  const wrap = document.createElement('div');
  wrap.className = 'af-sheet-back'; wrap.id = 'afInstallSheet';
  wrap.innerHTML = `<div class="af-sheet" role="dialog" aria-modal="true" aria-labelledby="afSheetTitle">
    <div class="af-sheet-head"><img src="${icon}" alt="" width="40" height="40" /><h2 id="afSheetTitle">Add ${esc(brand)} to your home screen</h2></div>
    <ol class="af-sheet-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
    <button class="bcn-btn bcn-btn--primary" type="button" id="afSheetOk">Got it</button></div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (ev) => { if (ev.target === wrap) close(); });
  wrap.querySelector('#afSheetOk').addEventListener('click', close);
}
