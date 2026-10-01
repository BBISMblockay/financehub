// Progressive enhancement only: the original responsive still and every auth
// route work without this file. Motion never makes a request until eligible.
(function () {
  const root = document.documentElement;
  const visual = document.getElementById('lpVisual');
  const video = document.getElementById('lpHeroVideo');
  const toggle = document.getElementById('lpMotionToggle');
  if (root.getAttribute('data-mode') !== 'landing' || !visual || !video || !toggle ||
      !window.matchMedia || typeof IntersectionObserver === 'undefined' ||
      !video.canPlayType('video/mp4')) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = navigator.connection;
  let inView = false;
  let pageActive = true;
  let userPaused = false;
  let failed = false;
  let blocked = false;
  let hasFrame = false;
  let pending = false;
  let generation = 0;

  function eligible() {
    return root.getAttribute('data-mode') === 'landing' && pageActive && inView &&
      !document.hidden && !reducedMotion.matches && !connection?.saveData && !failed;
  }

  function still() {
    visual.dataset.motion = 'still';
  }

  function reconcile() {
    if (!eligible()) {
      generation++;
      video.pause();
      still();
      toggle.hidden = true;
      return;
    }
    if (userPaused) {
      generation++;
      video.pause();
      visual.dataset.motion = hasFrame ? 'paused' : 'still';
      // A repeated manual retry can pause before its first frame arrives.
      // Keep Play reachable even in that still-only state.
      toggle.hidden = false;
      toggle.textContent = 'Play motion';
      return;
    }
    if (blocked) {
      still();
      toggle.hidden = false;
      toggle.textContent = 'Play motion';
      return;
    }
    if (!video.src) {
      // Source is selected once, avoiding a new download on every resize.
      video.muted = true;
      video.src = window.matchMedia('(max-width: 600px)').matches
        ? video.dataset.mobileSrc : video.dataset.src;
    }
    if (pending || !video.paused) return;
    pending = true;
    const attempt = ++generation;
    // Some browsers throw synchronously; others reject their play promise.
    let play;
    try { play = video.play(); } catch (error) { play = Promise.reject(error); }
    Promise.resolve(play).then(() => {
      pending = false;
      if (attempt !== generation || !eligible() || userPaused) {
        video.pause();
        reconcile();
      }
    }, () => {
      pending = false;
      if (attempt === generation && eligible() && !userPaused) blocked = true;
      reconcile();
    });
  }

  video.addEventListener('playing', () => {
    if (!eligible() || userPaused) {
      video.pause();
      reconcile();
      return;
    }
    hasFrame = true;
    visual.dataset.motion = 'playing';
    toggle.hidden = false;
    toggle.textContent = 'Pause motion';
  });
  video.addEventListener('error', () => { failed = true; reconcile(); });
  toggle.addEventListener('click', () => {
    if (blocked) { blocked = false; userPaused = false; }
    else userPaused = !userPaused;
    reconcile();
  });
  document.addEventListener('visibilitychange', reconcile);
  window.addEventListener('pagehide', () => { pageActive = false; reconcile(); });
  window.addEventListener('pageshow', () => { pageActive = true; reconcile(); });
  reducedMotion.addEventListener('change', reconcile);
  connection?.addEventListener?.('change', reconcile);
  new IntersectionObserver(entries => {
    if (!entries.length) return;
    // One observed target; batched entries are queued oldest to newest.
    inView = entries[entries.length - 1].isIntersecting;
    reconcile();
  }, { threshold: 0 }).observe(visual);
  new MutationObserver(reconcile).observe(root, { attributes: true, attributeFilter: ['data-mode'] });
}());
