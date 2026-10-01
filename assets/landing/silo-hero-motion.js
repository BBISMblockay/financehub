// Progressive enhancement: the still and direct video link also work without JS.
(function () {
  const root = document.documentElement;
  const visual = document.getElementById('lpVisual');
  const video = document.getElementById('lpHeroVideo');
  const toggle = document.getElementById('lpMotionToggle');
  const status = document.getElementById('lpMotionStatus');
  const fallback = document.getElementById('lpMotionFallback');
  if (root.getAttribute('data-mode') !== 'landing' || !visual || !video || !toggle ||
      !window.matchMedia || typeof IntersectionObserver === 'undefined' ||
      !video.canPlayType('video/mp4')) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = navigator.connection;
  let inView = false;
  let pageActive = true;
  let userPaused = false;
  let userEnabled = false;
  let failed = false;
  let blocked = false;
  let hasFrame = false;
  let pending = false;
  let generation = 0;
  let timer;

  function visible() {
    return root.getAttribute('data-mode') === 'landing' && pageActive && inView && !document.hidden;
  }
  function allowed() {
    return userEnabled || (!reducedMotion.matches && !connection?.saveData);
  }
  function eligible() { return visible() && allowed() && !failed; }
  function still() { visual.dataset.motion = 'still'; }
  function controls(label, message = '', showLink = false) {
    toggle.hidden = !visible();
    toggle.textContent = label;
    // A cached previous HTML version may not have these progressive controls.
    if (status) { status.textContent = message; status.hidden = !message; }
    if (fallback) fallback.hidden = !showLink;
  }
  function cancelPending() {
    generation++;
    pending = false;
    clearTimeout(timer);
  }

  function reconcile() {
    if (!visible() || !allowed()) {
      cancelPending();
      video.pause();
      still();
      controls('Play animation', !allowed()
        ? (connection?.saveData ? 'Data saving is on. Play downloads the animation.'
          : 'Motion is off in your device settings. Play to watch.') : '');
      return;
    }
    if (failed) {
      cancelPending();
      video.pause();
      still();
      controls('Retry animation', 'Animation could not load. Retry or watch the video.', true);
      return;
    }
    if (userPaused || blocked) {
      cancelPending();
      video.pause();
      visual.dataset.motion = hasFrame ? 'paused' : 'still';
      controls('Play animation', blocked ? 'Animation did not start. Select Play to try again.' : '');
      return;
    }
    if (!video.src) {
      // Source is selected once. Device policies never download without a click.
      video.muted = true;
      video.src = window.matchMedia('(max-width: 600px)').matches
        ? video.dataset.mobileSrc : video.dataset.src;
    }
    if (pending || !video.paused) return;
    pending = true;
    controls('Play animation', 'Loading animation…');
    const attempt = ++generation;
    timer = setTimeout(() => {
      if (attempt !== generation || !pending) return;
      blocked = true;
      reconcile();
    }, 5000);
    let play;
    try { play = video.play(); } catch (error) { play = Promise.reject(error); }
    Promise.resolve(play).then(() => {
      if (attempt !== generation) return;
      pending = false;
      clearTimeout(timer);
      if (!eligible() || userPaused || blocked) {
        video.pause();
        reconcile();
      }
    }, () => {
      if (attempt !== generation) return;
      pending = false;
      clearTimeout(timer);
      if (eligible() && !userPaused) blocked = true;
      reconcile();
    });
  }

  video.addEventListener('playing', () => {
    if (!eligible() || userPaused || blocked) {
      video.pause();
      reconcile();
      return;
    }
    hasFrame = true;
    pending = false;
    clearTimeout(timer);
    visual.dataset.motion = 'playing';
    controls('Pause animation');
  });
  video.addEventListener('pause', () => {
    // Native/browser pauses must not leave a misleading Pause control.
    if (video.paused && eligible() && !pending && !userPaused && !blocked && hasFrame) {
      blocked = true;
      reconcile();
    }
  });
  video.addEventListener('error', () => { failed = true; reconcile(); });
  toggle.addEventListener('click', () => {
    if (hasFrame && !video.paused && !pending) {
      userPaused = true;
    } else {
      cancelPending();
      video.pause();
      userEnabled = true;
      visual.dataset.userMotion = 'true';
      userPaused = false;
      blocked = false;
      const retry = failed;
      failed = false;
      if (retry) {
        hasFrame = false;
        video.load();
      }
    }
    reconcile();
  });
  function policyChanged() {
    userEnabled = false;
    delete visual.dataset.userMotion;
    reconcile();
  }
  document.addEventListener('visibilitychange', reconcile);
  window.addEventListener('pagehide', () => { pageActive = false; reconcile(); });
  window.addEventListener('pageshow', () => { pageActive = true; reconcile(); });
  if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', policyChanged);
  else reducedMotion.addListener?.(policyChanged);
  connection?.addEventListener?.('change', policyChanged);
  new IntersectionObserver(entries => {
    if (!entries.length) return;
    inView = entries[entries.length - 1].isIntersecting;
    reconcile();
  }, { threshold: 0 }).observe(visual);
  new MutationObserver(reconcile).observe(root, { attributes: true, attributeFilter: ['data-mode'] });
  reconcile();
}());
