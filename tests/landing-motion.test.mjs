// Run the actual landing controller against media / browser event fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/landing/silo-hero-motion.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ reduce = false, saveData = false, mode = 'landing', mobile = false, unsupported = false,
  pending = false, blocked = false, legacyMedia = false, missingOptional = false } = {}) {
  class Target {
    constructor() { this.events = {}; }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    fire(type) { for (const callback of this.events[type] || []) callback({ type }); }
  }
  const attributes = new Map([['data-mode', mode]]);
  const root = { getAttribute: name => attributes.get(name) };
  const attempts = [];
  const timers = new Map();
  let nextTimer = 0;
  const video = Object.assign(new Target(), {
    dataset: { src: '/assets/landing/silo-hero-motion.mp4', mobileSrc: '/assets/landing/silo-hero-motion-mobile.mp4' },
    paused: true, readyState: 0, src: '', muted: true, plays: 0, pauses: 0, loads: 0, error: null,
    canPlayType: () => unsupported ? '' : 'probably',
    pause() { this.paused = true; this.pauses++; },
    load() { this.loads++; this.paused = true; this.readyState = 0; this.error = null; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    play() {
      this.plays++;
      return new Promise((resolve, reject) => {
        const attempt = {
          finish: () => { this.paused = false; this.readyState = 3; this.fire('playing'); resolve(); },
          reject: () => reject(new Error('Autoplay blocked')),
        };
        attempts.push(attempt);
        this.finishPlay = attempt.finish;
        this.rejectPlay = attempt.reject;
        if (!pending) setImmediate(() => blocked ? attempt.reject() : attempt.finish());
      });
    },
  });
  const button = Object.assign(new Target(), { hidden: true, textContent: 'Play animation', disabled: false });
  const status = { hidden: false, textContent: '' };
  const fallback = { hidden: false, href: '/assets/landing/silo-hero-motion.mp4', textContent: 'Watch animation' };
  const visual = { dataset: { motion: 'still' } };
  const document = Object.assign(new Target(), { hidden: false, documentElement: root,
    getElementById: id => ({ lpHeroVideo: video, lpMotionToggle: button, lpVisual: visual,
      lpMotionStatus: missingOptional ? null : status, lpMotionFallback: missingOptional ? null : fallback })[id] });
  const media = Object.assign(new Target(), { matches: reduce });
  if (legacyMedia) {
    media.addEventListener = undefined;
    media.addListener = callback => Target.prototype.addEventListener.call(media, 'change', callback);
  }
  const connection = Object.assign(new Target(), { saveData });
  const window = Object.assign(new Target(), { matchMedia: query => query.includes('reduced-motion') ? media : { matches: mobile } });
  let intersect, mutate;
  const context = vm.createContext({ document, window, navigator: { connection }, Promise,
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    IntersectionObserver: class { constructor(callback) { intersect = callback; } observe() {} },
    MutationObserver: class { constructor(callback) { mutate = callback; } observe() {} },
  });
  vm.runInContext(source, context);
  return { video, button, visual, document, window, connection, media, status, fallback, attempts,
    visible(value = true) { intersect?.([{ isIntersecting: value }]); },
    intersections(entries) { intersect?.(entries); },
    mode(value) { attributes.set('data-mode', value); mutate?.(); },
    reduced(value) { media.matches = value; media.fire('change'); },
    hidden(value) { document.hidden = value; document.fire('visibilitychange'); },
    timeout(ms) { for (const [id, timer] of [...timers]) if (timer.delay <= ms) { timers.delete(id); timer.callback(); } },
  };
}

test('no video URL or playback until landing artwork is visible', async () => {
  const f = fixture();
  assert.equal(f.video.src, '');
  assert.equal(f.video.plays, 0);
  assert.equal(f.button.hidden, true);
  f.visible(); await tick();
  assert.equal(f.video.src, '/assets/landing/silo-hero-motion.mp4');
  assert.equal(f.video.muted, true);
  assert.equal(f.video.plays, 1);
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.button.hidden, false);
  f.visible(); await tick();
  assert.equal(f.video.plays, 1, 'repeated intersection must not restart playback');
});

test('router and unsupported video never fetch motion', async () => {
  for (const options of [{ mode: 'router' }, { unsupported: true }]) {
    const f = fixture(options); f.visible(); await tick();
    assert.equal(f.video.src, '', JSON.stringify(options));
    assert.equal(f.video.plays, 0);
    assert.equal(f.button.hidden, true);
  }
});

test('reduced motion and data saver explain the static default and permit explicit play only', async () => {
  for (const options of [{ reduce: true }, { saveData: true }, { reduce: true, saveData: true }]) {
    const f = fixture(options); f.visible(); await tick();
    assert.equal(f.video.src, '');
    assert.equal(f.video.plays, 0);
    assert.equal(f.visual.dataset.motion, 'still');
    assert.equal(f.button.hidden, false);
    assert.equal(f.button.textContent, 'Play animation');
    assert.match(f.status.textContent, /motion|data saving/i);
    f.button.fire('click'); await tick();
    assert.equal(f.visual.dataset.userMotion, 'true', 'manual opt-in is explicit for the CSS override');
    assert.equal(f.video.plays, 1);
    assert.equal(f.visual.dataset.motion, 'playing');
    f.hidden(true); f.hidden(false); await tick();
    assert.equal(f.visual.dataset.motion, 'playing', 'same-page opt-in survives visibility changes');
    f.button.fire('click');
    f.hidden(true); f.hidden(false); await tick();
    assert.equal(f.video.paused, true, 'user pause still wins over manual opt-in');
    f.button.fire('click'); await tick();
    assert.equal(f.visual.dataset.motion, 'playing');
  }
});

test('preference changes revoke manual opt-in without replaying a restricted animation', async () => {
  for (const change of [f => f.reduced(true), f => { f.connection.saveData = true; f.connection.fire('change'); }]) {
    const f = fixture({ reduce: true }); f.visible();
    f.button.fire('click'); await tick();
    assert.equal(f.visual.dataset.motion, 'playing');
    const plays = f.video.plays;
    change(f); await tick();
    assert.notEqual(f.visual.dataset.userMotion, 'true');
    assert.equal(f.video.paused, true);
    assert.equal(f.visual.dataset.motion, 'still');
    assert.equal(f.button.textContent, 'Play animation');
    f.visible(); f.hidden(true); f.hidden(false); await tick();
    assert.equal(f.video.plays, plays, 'restriction cannot be overridden by restoring visibility');
    f.button.fire('click'); await tick();
    assert.equal(f.visual.dataset.motion, 'playing');
  }
});

test('narrow screens receive the smaller video', async () => {
  const f = fixture({ mobile: true }); f.visible(); await tick();
  assert.equal(f.video.src, '/assets/landing/silo-hero-motion-mobile.mp4');
});

test('pause and resume are explicit and user pause survives visibility changes', async () => {
  const f = fixture(); f.visible(); await tick();
  f.button.fire('click');
  assert.equal(f.video.paused, true);
  assert.equal(f.visual.dataset.motion, 'paused');
  assert.equal(f.button.textContent, 'Play animation');
  f.hidden(true); f.hidden(false); await tick();
  assert.equal(f.video.plays, 1);
  f.button.fire('click'); await tick();
  assert.equal(f.video.paused, false);
  assert.equal(f.button.textContent, 'Pause animation');
});

test('hidden tabs, offscreen art, pagehide, and route changes stop video', async () => {
  for (const stop of [f => f.hidden(true), f => f.visible(false), f => f.window.fire('pagehide'), f => f.mode('router')]) {
    const f = fixture(); f.visible(); await tick(); stop(f);
    assert.equal(f.video.paused, true);
    assert.equal(f.visual.dataset.motion, 'still');
    assert.equal(f.button.hidden, true);
  }
});

test('visibility and bfcache restoration resume eligible motion, not reduced motion', async () => {
  const f = fixture(); f.visible(); await tick();
  f.hidden(true); f.hidden(false); await tick();
  assert.equal(f.video.paused, false);
  f.window.fire('pagehide'); f.window.fire('pageshow'); await tick();
  assert.equal(f.video.paused, false);
  f.reduced(true); f.window.fire('pageshow'); await tick();
  assert.equal(f.video.paused, true);
  f.reduced(false); await tick();
  assert.equal(f.video.paused, false);
});

test('failed autoplay keeps original still and offers a manual play retry', async () => {
  const f = fixture({ blocked: true }); f.visible(); await tick();
  assert.equal(f.visual.dataset.motion, 'still');
  assert.equal(f.button.hidden, false);
  assert.equal(f.button.textContent, 'Play animation');
  f.visible(); await tick(); assert.equal(f.video.plays, 1, 'do not retry autoplay endlessly');
  f.video.play = function () { this.plays++; this.paused = false; this.readyState = 3; this.fire('playing'); return Promise.resolve(); };
  f.button.fire('click'); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.video.plays, 2);
});

test('network or decode error offers explicit retry and a plain fallback without automatic retries', async () => {
  const f = fixture(); f.visible(); await tick(); f.video.fire('error');
  assert.equal(f.visual.dataset.motion, 'still');
  assert.equal(f.video.paused, true);
  assert.equal(f.button.hidden, false);
  assert.equal(f.button.textContent, 'Retry animation');
  assert.equal(f.fallback.hidden, false);
  assert.match(f.status.textContent, /could|unavailable|fail|retry|load/i);
  f.visible(); await tick(); assert.equal(f.video.plays, 1);
  f.hidden(true); f.hidden(false); await tick(); assert.equal(f.video.plays, 1);
  f.button.fire('click'); await tick();
  assert.equal(f.video.plays, 2);
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.fallback.hidden, true);
});

test('late play success cannot override a newer policy, hidden page, or route', async () => {
  for (const stop of [f => f.reduced(true), f => f.hidden(true), f => f.mode('router'), f => f.window.fire('pagehide')]) {
    const f = fixture({ pending: true }); f.visible(); stop(f); f.video.finishPlay();
    assert.equal(f.visual.dataset.motion, 'still', 'a stale playing event must not reveal even one frame');
    assert.equal(f.video.paused, true, 'playing event must honor policy immediately');
    await tick();
    assert.equal(f.video.paused, true);
    assert.equal(f.visual.dataset.motion, 'still');
    assert.equal(f.button.hidden, !f.media.matches, 'policy-blocked visible artwork keeps manual play reachable');
  }
});

test('a stale rejected play does not block a newly eligible page', async () => {
  const f = fixture({ pending: true }); f.visible();
  const first = f.attempts[0];
  f.hidden(true); f.hidden(false);
  first.reject(); await tick();
  assert.equal(f.video.plays, 2);
  f.video.finishPlay(); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
});

test('late successful play after hide and restore converges on eligible playback', async () => {
  const f = fixture({ pending: true }); f.visible();
  const first = f.attempts[0];
  f.hidden(true); f.hidden(false);
  first.finish(); await tick();
  assert.equal(f.video.plays, 2, 'superseded play is reconciled once');
  f.video.finishPlay(); await tick();
  assert.equal(f.video.paused, false);
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.button.textContent, 'Pause animation');
});

test('repeated manual play before first frame cannot strand the only control', async () => {
  const f = fixture({ pending: true }); f.visible();
  f.button.fire('click'); // Manual retry supersedes pending autoplay.
  f.button.fire('click'); // Repeated activation supersedes that retry.
  assert.equal(f.button.hidden, false, 'Play control must remain reachable before first frame');
  assert.equal(f.button.textContent, 'Play animation');
  assert.equal(f.video.plays, 3);
  f.attempts[0].reject(); f.attempts[1].reject(); await tick();
  assert.equal(f.button.hidden, false);
  assert.equal(f.video.plays, 3, 'stale rejections must neither retry nor cancel the latest attempt');
  f.attempts[2].finish(); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.button.textContent, 'Pause animation');
  f.button.fire('click'); f.hidden(true); f.hidden(false);
  assert.equal(f.button.hidden, false);
  f.button.fire('click'); f.video.finishPlay(); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.button.textContent, 'Pause animation');
});


test('the newest intersection wins when a delivery contains multiple observations', async () => {
  const f = fixture();
  f.intersections([{ isIntersecting: true, time: 1 }, { isIntersecting: false, time: 2 }]);
  await tick();
  assert.equal(f.video.src, '', 'an older visible observation must not download offscreen video');
  f.intersections([{ isIntersecting: false, time: 3 }, { isIntersecting: true, time: 4 }]);
  await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
  f.intersections([{ isIntersecting: true, time: 5 }, { isIntersecting: false, time: 6 }]);
  assert.equal(f.video.paused, true);
  assert.equal(f.visual.dataset.motion, 'still');
});

test('a synchronous play exception preserves the still and manual retry', async () => {
  const f = fixture();
  f.video.play = () => { throw new Error('Media cannot start'); };
  f.visible(); await tick();
  assert.equal(f.visual.dataset.motion, 'still');
  assert.equal(f.button.hidden, false);
  assert.equal(f.button.textContent, 'Play animation');
});

test('initial pending play keeps a control and a watchdog exposes manual recovery', async () => {
  const f = fixture({ pending: true }); f.visible();
  assert.equal(f.button.hidden, false, 'pending autoplay must never strand the artwork without a control');
  assert.match(f.status.textContent, /load|start|prepar/i);
  f.timeout(4999);
  assert.equal(f.video.plays, 1);
  f.timeout(5000); await tick();
  assert.equal(f.video.paused, true);
  assert.equal(f.visual.dataset.motion, 'still');
  assert.equal(f.button.hidden, false);
  assert.match(f.button.textContent, /^(Play|Retry) animation$/);
  assert.match(f.status.textContent, /did not start|retry|timed/i);
  f.visible(); f.hidden(true); f.hidden(false); f.timeout(5000); await tick();
  assert.equal(f.video.plays, 1, 'a watchdog must not create an autoplay retry loop');
  f.button.fire('click');
  assert.equal(f.video.plays, 2, 'manual retry must not be blocked by the abandoned pending promise');
  f.attempts[1].finish(); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
  f.attempts[0].reject(); await tick();
  assert.equal(f.visual.dataset.motion, 'playing', 'an old rejection cannot invalidate the manual retry');
  assert.equal(f.button.textContent, 'Pause animation');
});

test('policy change wins over a late successful manual opt-in', async () => {
  const f = fixture({ reduce: true, pending: true }); f.visible();
  f.button.fire('click');
  assert.equal(f.video.plays, 1);
  f.connection.saveData = true; f.connection.fire('change');
  f.attempts[0].finish(); await tick();
  assert.notEqual(f.visual.dataset.userMotion, 'true');
  assert.equal(f.video.paused, true);
  assert.equal(f.visual.dataset.motion, 'still');
  assert.equal(f.button.hidden, false);
  assert.equal(f.button.textContent, 'Play animation');
});

test('addListener-only MediaQueryList preserves manual opt-in and live policy changes', async () => {
  const f = fixture({ reduce: true, legacyMedia: true }); f.visible(); await tick();
  assert.equal(f.video.src, '');
  assert.equal(f.button.hidden, false);
  f.button.fire('click'); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
  f.reduced(false); await tick();
  assert.notEqual(f.visual.dataset.userMotion, 'true');
  f.reduced(true); await tick();
  assert.equal(f.video.paused, true);
  assert.equal(f.visual.dataset.motion, 'still');
  assert.equal(f.button.textContent, 'Play animation');
});

test('unsupported media preserves the plain Watch animation link', async () => {
  const f = fixture({ unsupported: true }); f.visible(); await tick();
  assert.equal(f.video.src, '');
  assert.equal(f.video.plays, 0);
  assert.equal(f.fallback.hidden, false);
  assert.equal(f.fallback.href, '/assets/landing/silo-hero-motion.mp4');
  assert.equal(f.fallback.textContent, 'Watch animation');
});

test('native playback interruption offers Play instead of a misleading Pause control', async () => {
  const f = fixture(); f.visible(); await tick();
  f.video.pause(); f.video.fire('pause');
  assert.equal(f.button.hidden, false);
  assert.equal(f.button.textContent, 'Play animation');
  assert.equal(f.video.paused, true);
  f.visible(); await tick();
  assert.equal(f.video.plays, 1, 'browser interruption is not an invitation to retry automatically');
  f.button.fire('click'); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
});

test('a queued native pause event cannot cancel already-resumed playback', async () => {
  const f = fixture(); f.visible(); await tick();
  f.hidden(true); f.hidden(false); await tick();
  assert.equal(f.video.paused, false);
  f.video.fire('pause'); // Earlier pause's queued event arrives after playing.
  assert.equal(f.video.paused, false);
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.button.textContent, 'Pause animation');
});

test('a failed or timed-out retry after decoding a frame restores the still, never an empty overlay', async () => {
  for (const failure of ['reject', 'timeout']) {
    const f = fixture({ pending: true }); f.visible();
    f.attempts[0].finish(); await tick();
    assert.equal(f.visual.dataset.motion, 'playing');
    f.video.fire('error');
    f.button.fire('click');
    assert.equal(f.video.readyState, 0, 'retry reload discarded the previously decoded frame');
    if (failure === 'reject') f.attempts[1].reject();
    else f.timeout(5000);
    await tick();
    assert.equal(f.video.paused, true);
    assert.equal(f.visual.dataset.motion, 'still', `${failure}: a discarded frame cannot cover the still`);
    assert.equal(f.button.hidden, false);
    assert.equal(f.button.textContent, 'Play animation');
  }
});

test('cached HTML without the optional status and fallback nodes still autoplays', async () => {
  const f = fixture({ missingOptional: true }); f.visible(); await tick();
  assert.equal(f.video.plays, 1);
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.button.textContent, 'Pause animation');
  f.button.fire('click'); await tick();
  assert.equal(f.video.paused, true);
  f.button.fire('click'); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
});
