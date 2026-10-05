/* Public early-access intake. Never creates an account, company, or invite. */
(function () {
  'use strict';
  if (document.documentElement.getAttribute('data-mode') !== 'landing') return;

  const config = window.__SILO_CONFIG__ || {};
  const form = document.getElementById('lpInterestForm');
  const button = document.getElementById('lpJoinButton');
  // Each page names its own call to action; a reset restores that label.
  const buttonLabel = button ? button.textContent : '';
  const status = document.getElementById('lpFormStatus');
  const fields = ['lpName', 'lpCompanyName', 'lpEmail'].map(id => document.getElementById(id));
  const website = document.getElementById('lpWebsite');
  const video = document.getElementById('lpDemoVideo');
  const placeholder = document.getElementById('lpDemoPlaceholder');
  const caption = document.getElementById('lpDemoCaption');
  const year = document.getElementById('lpYear');
  if (year) year.textContent = String(new Date().getFullYear());

  if (typeof document.querySelectorAll === 'function') {
    document.querySelectorAll('.lp-shot[data-asset]').forEach(slot => {
      const file = slot.getAttribute('data-asset');
      if (!file || /[^a-z0-9._-]/i.test(file)) return;
      const img = new Image();
      img.className = 'lp-shot-img';
      img.decoding = 'async';
      img.alt = slot.getAttribute('data-alt') || '';
      img.addEventListener('load', () => {
        slot.classList.add('lp-shot--filled');
        slot.insertBefore(img, slot.firstChild);
        if (slot.id === 'lpDemoPlaceholder' && video) video.poster = img.currentSrc || img.src;
      }, { once: true });
      img.src = '/assets/landing/' + file;
    });
  }

  // A config entry must be a direct media file, never HTML, an embed, a
  // credential-bearing URL, or an executable scheme. HTTPS CDNs and local
  // same-origin media are supported; no visitor-supplied value is read.
  function mediaUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    const raw = value.trim();
    if (/[\s\\\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('//')) return '';
    try {
      const url = new URL(raw, window.location.href);
      const local = url.origin === window.location.origin;
      if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) return '';
      if (!/\.(mp4|webm|ogv)$/i.test(url.pathname)) return '';
      return url.href;
    } catch (_) { return ''; }
  }

  const demoUrl = mediaUrl(config.LANDING_DEMO_VIDEO_URL);
  if (video && placeholder && caption && demoUrl) {
    video.addEventListener('error', () => {
      video.hidden = true;
      placeholder.hidden = false;
      caption.textContent = 'The walkthrough couldn’t load. Please try again later.';
    }, { once: true });
    video.src = demoUrl;
    video.hidden = false;
    placeholder.hidden = true;
    caption.textContent = 'Watch the SILO product walkthrough.';
  }

  if (!form || !button || !status || fields.some(field => !field) || !website) return;
  let pending = false;
  let submitted = false;

  function showStatus(message, kind) {
    status.className = 'bcn-status bcn-status--' + kind;
    status.textContent = message;
    status.hidden = false;
  }

  function intakeUrl() {
    if (typeof config.SUPABASE_URL !== 'string' || !config.SUPABASE_URL.trim()) return '';
    try {
      const url = new URL(config.SUPABASE_URL.trim());
      if (url.username || url.password || url.protocol !== 'https:' || url.search || url.hash) return '';
      return url.href.replace(/\/$/, '') + '/functions/v1/onboarding-interest';
    } catch (_) { return ''; }
  }

  const endpoint = intakeUrl();
  if (!endpoint) {
    showStatus('The request form is temporarily unavailable. Please try again later.', 'neg');
    return;
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || submitted) return;
    fields.forEach(field => { field.value = field.value.trim(); });
    if (!form.reportValidity()) return;

    const payload = {
      name: fields[0].value,
      company_name: fields[1].value,
      email: fields[2].value,
      website: website.value,
    };
    pending = true;
    button.disabled = true;
    button.textContent = 'Sending…';
    form.setAttribute('aria-busy', 'true');
    fields.forEach(field => { field.readOnly = true; });
    showStatus('Sending your request…', 'info');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (config.SUPABASE_ANON_KEY) headers.apikey = config.SUPABASE_ANON_KEY;
      const response = await window.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) {
        showStatus(response.status === 429
          ? 'We couldn’t submit your request right now. Please wait a few minutes and try again.'
          : 'We couldn’t submit your request. Please try again.', 'neg');
        return;
      }
      submitted = true;
      showStatus('Thanks! Your early-access request has been received. We’ll contact you about SILO onboarding.', 'pos');
      status.focus();
    } catch (_) {
      // Never render server/body error details or imply a failed transport
      // did not persist. Retrying is safe: the server owns deduplication.
      showStatus('We couldn’t confirm your request. Please try again.', 'neg');
    } finally {
      window.clearTimeout(timeout);
      pending = false;
      form.removeAttribute('aria-busy');
      button.disabled = submitted;
      button.textContent = buttonLabel;
      fields.forEach(field => { field.readOnly = submitted; });
    }
  });
  // Keep native submission disabled until interception is installed.
  button.disabled = false;
})();
