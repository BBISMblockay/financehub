/* Progressive enhancement for /redo-welcome.html — Ask Silo demo thread only. */
(function () {
  'use strict';
  if (document.documentElement.getAttribute('data-mode') !== 'landing') return;

  const preview = document.querySelector('.lp-ask-preview');
  if (!preview) return;
  preview.classList.add('lp-ask-preview--motion');
  if (typeof IntersectionObserver === 'undefined') return;

  const userEl = preview.querySelector('.lp-ask-user [data-lp-ask-type="user"]');
  const recEl = preview.querySelector('[data-lp-ask-type="recommend"]');
  const whyEl = preview.querySelector('[data-lp-ask-type="why"]');
  const agent = preview.querySelector('.lp-ask-agent');
  const thinking = preview.querySelector('.lp-ask-thinking');
  const evidence = preview.querySelector('.lp-ask-evidence-line');
  const meta = preview.querySelector('.lp-ask-ai-meta');
  const caret = preview.querySelector('.lp-ask-caret');
  if (!userEl || !recEl || !whyEl || !agent) return;

  const copy = {
    user: userEl.textContent.trim(),
    rec: recEl.textContent.trim(),
    why: whyEl.textContent.trim(),
  };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const metaDone = meta ? meta.textContent.trim() : '';

  function delay(ms) {
    return new Promise((resolve) => { window.setTimeout(resolve, ms); });
  }

  function setCaret(on) {
    if (caret) caret.hidden = !on;
  }

  function typeInto(el, text, msPerChar) {
    el.textContent = '';
    if (!text) return Promise.resolve();
    if (reduced) {
      el.textContent = text;
      return Promise.resolve();
    }
    setCaret(true);
    let i = 0;
    return new Promise((resolve) => {
      const tick = () => {
        if (i >= text.length) {
          setCaret(false);
          resolve();
          return;
        }
        el.textContent += text.charAt(i);
        i += 1;
        window.setTimeout(tick, msPerChar);
      };
      tick();
    });
  }

  function revealDone() {
    userEl.textContent = copy.user;
    recEl.textContent = copy.rec;
    whyEl.textContent = copy.why;
    agent.classList.remove('lp-ask-agent--pending');
    if (thinking) thinking.hidden = true;
    if (evidence) evidence.classList.add('lp-ask-reveal--in');
    if (meta) meta.textContent = metaDone;
    preview.classList.add('lp-ask-preview--done');
    setCaret(false);
  }

  async function play() {
    if (preview.classList.contains('lp-ask-preview--done')) return;
    preview.classList.add('lp-ask-preview--playing');
    if (reduced) {
      revealDone();
      return;
    }

    userEl.textContent = '';
    recEl.textContent = '';
    whyEl.textContent = '';
    agent.classList.add('lp-ask-agent--pending');
    if (evidence) evidence.classList.remove('lp-ask-reveal--in');
    if (thinking) thinking.hidden = true;

    await typeInto(userEl, copy.user, 22);
    await delay(350);
    if (thinking) thinking.hidden = false;
    if (meta) meta.textContent = 'Querying…';
    await delay(850);
    if (thinking) thinking.hidden = true;
    agent.classList.remove('lp-ask-agent--pending');
    await delay(120);
    await typeInto(recEl, copy.rec, 18);
    if (evidence) evidence.classList.add('lp-ask-reveal--in');
    await delay(200);
    await typeInto(whyEl, copy.why, 14);
    if (meta) meta.textContent = metaDone;
    preview.classList.add('lp-ask-preview--done');
    setCaret(false);
  }

  let started = false;
  function maybeStart(entry) {
    if (started || !entry.isIntersecting || entry.intersectionRatio < 0.15) return;
    started = true;
    observer.disconnect();
    play();
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(maybeStart);
  }, { threshold: [0, 0.15, 0.35] });

  observer.observe(preview);
  const rect = preview.getBoundingClientRect();
  if (rect.top < window.innerHeight && rect.bottom > 0) {
    window.requestAnimationFrame(() => {
      maybeStart({ isIntersecting: true, intersectionRatio: 1 });
    });
  }
})();
