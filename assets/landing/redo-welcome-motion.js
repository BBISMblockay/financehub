/* Progressive enhancement for /redo-welcome.html — product slideshow + Ask Silo demo. */
(function () {
  'use strict';
  if (document.documentElement.getAttribute('data-mode') !== 'landing') return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function initProductSlideshow() {
    const root = document.getElementById('lpProductSlideshow');
    const track = root && root.querySelector('.lp-slideshow-track');
    const slides = track ? track.querySelectorAll('.lp-slideshow-slide') : [];
    const prev = root && root.querySelector('.lp-slideshow-btn--prev');
    const next = root && root.querySelector('.lp-slideshow-btn--next');
    const dots = root ? root.querySelectorAll('.lp-slideshow-dot') : [];
    const caption = document.getElementById('lpSlideshowCaption');
    if (!root || !track || slides.length < 2 || !prev || !next) return;

    const labels = ['Attributed revenue, spend, and daily trend', 'Channel overview and top campaigns'];
    let index = 0;
    let timer;
    let paused = false;

    function setSlide(nextIndex) {
      index = (nextIndex + slides.length) % slides.length;
      track.style.transform = 'translateX(-' + (index * 100) + '%)';
      dots.forEach((dot, i) => {
        const on = i === index;
        dot.classList.toggle('lp-slideshow-dot--active', on);
        dot.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (caption && labels[index]) caption.textContent = labels[index];
    }

    function stopAuto() {
      paused = true;
      clearInterval(timer);
    }

    function startAuto() {
      if (reduced || paused) return;
      clearInterval(timer);
      timer = window.setInterval(() => { setSlide(index + 1); }, 9000);
    }

    prev.addEventListener('click', () => { stopAuto(); setSlide(index - 1); });
    next.addEventListener('click', () => { stopAuto(); setSlide(index + 1); });
    dots.forEach((dot) => {
      dot.addEventListener('click', () => {
        stopAuto();
        const n = Number(dot.getAttribute('data-lp-slide'));
        if (Number.isFinite(n)) setSlide(n);
      });
    });

    root.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); stopAuto(); setSlide(index - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); stopAuto(); setSlide(index + 1); }
    });

    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) startAuto();
          else clearInterval(timer);
        });
      }, { threshold: 0.2 });
      io.observe(root);
    } else {
      startAuto();
    }

    setSlide(0);
  }

  function initAskMotion() {
    const preview = document.querySelector('.lp-ask-preview');
    if (!preview) return;
    preview.classList.add('lp-ask-preview--motion');
    if (typeof IntersectionObserver === 'undefined') return;

    const userEl = preview.querySelector('.lp-ask-user [data-lp-ask-type="user"]');
    const recEl = preview.querySelector('[data-lp-ask-type="recommend"]');
    const whyEl = preview.querySelector('[data-lp-ask-type="why"]');
    const whenEl = preview.querySelector('[data-lp-ask-type="when"]');
    const draftSmsEl = preview.querySelector('[data-lp-ask-type="draft-sms"]');
    const draftSubjectEl = preview.querySelector('[data-lp-ask-type="draft-subject"]');
    const draftPreEl = preview.querySelector('[data-lp-ask-type="draft-pre"]');
    const draftLeadEl = preview.querySelector('[data-lp-ask-type="draft-lead"]');
    const agent = preview.querySelector('.lp-ask-agent');
    const thinking = preview.querySelector('.lp-ask-thinking');
    const evidence = preview.querySelector('.lp-ask-evidence-line:not(.lp-ask-timing)');
    const timing = preview.querySelector('.lp-ask-timing');
    const drafts = preview.querySelector('.lp-ask-drafts');
    const meta = preview.querySelector('.lp-ask-ai-meta');
    const caret = preview.querySelector('.lp-ask-caret');
    if (!userEl || !recEl || !whyEl || !agent) return;

    function text(el) {
      return el ? el.textContent.trim() : '';
    }

    const copy = {
      user: text(userEl),
      rec: text(recEl),
      why: text(whyEl),
      when: text(whenEl),
      draftSms: text(draftSmsEl),
      draftSubject: text(draftSubjectEl),
      draftPre: text(draftPreEl),
      draftLead: text(draftLeadEl),
    };
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
  }

  initProductSlideshow();
  initAskMotion();
})();
