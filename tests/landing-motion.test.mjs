// Run the actual landing controller against media / browser event fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/landing/silo-hero-motion.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ reduce = false, saveData = false, mode = 'landing', mobile = false, unsupported = false, pending = false, blocked = false } = {}) {
  class Target {
    constructor() { this.events = {}; }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    fire(type) { for (const callback of this.events[type] || []) callback({ type }); }
  }
  const attributes = new Map([['data-mode', mode]]);
  const root = { getAttribute: name => attributes.get(name) };
  const video = Object.assign(new Target(), {
    dataset: { src: '/assets/landing/silo-hero-motion.mp4', mobileSrc: '/assets/landing/silo-hero-motion-mobile.mp4' },
    paused: true, readyState: 0, src: '', muted: true, plays: 0, pauses: 0,
    canPlayType: () => unsupported ? '' : 'probably',
    pause() { this.paused = true; this.pauses++; },
    play() {
      this.plays++;
      return new Promise((resolve, reject) => {
        this.finishPlay = () => { this.paused = false; this.readyState = 3; this.fire('playing'); resolve(); };
        this.rejectPlay = () => reject(new Error('Autoplay blocked'));
        if (!pending) setImmediate(() => blocked ? this.rejectPlay() : this.finishPlay());
      });
    },
  });
  const button = Object.assign(new Target(), { hidden: true, textContent: 'Pause motion' });
  const visual = { dataset: {} };
  const document = Object.assign(new Target(), { hidden: false, documentElement: root,
    getElementById: id => ({ lpHeroVideo: video, lpMotionToggle: button, lpVisual: visual })[id] });
  const media = Object.assign(new Target(), { matches: reduce });
  const connection = Object.assign(new Target(), { saveData });
  const window = Object.assign(new Target(), { matchMedia: query => query.includes('reduced-motion') ? media : { matches: mobile } });
  let intersect, mutate;
  const context = vm.createContext({ document, window, navigator: { connection }, Promise,
    IntersectionObserver: class { constructor(callback) { intersect = callback; } observe() {} },
    MutationObserver: class { constructor(callback) { mutate = callback; } observe() {} },
  });
  vm.runInContext(source, context);
  return { video, button, visual, document, window, connection, media,
    visible(value = true) { intersect?.([{ isIntersecting: value }]); },
    intersections(entries) { intersect?.(entries); },
    mode(value) { attributes.set('data-mode', value); mutate?.(); },
    reduced(value) { media.matches = value; media.fire('change'); },
    hidden(value) { document.hidden = value; document.fire('visibilitychange'); },
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

test('reduced motion, data saver, router, and unsupported video never fetch motion', async () => {
  for (const options of [{ reduce: true }, { saveData: true }, { mode: 'router' }, { unsupported: true }]) {
    const f = fixture(options); f.visible(); await tick();
    assert.equal(f.video.src, '', JSON.stringify(options));
    assert.equal(f.video.plays, 0);
    assert.equal(f.button.hidden, true);
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
  assert.equal(f.button.textContent, 'Play motion');
  f.hidden(true); f.hidden(false); await tick();
  assert.equal(f.video.plays, 1);
  f.button.fire('click'); await tick();
  assert.equal(f.video.paused, false);
  assert.equal(f.button.textContent, 'Pause motion');
});

test('hidden tabs, offscreen art, pagehide, reduced motion, and route changes stop video', async () => {
  for (const stop of [f => f.hidden(true), f => f.visible(false), f => f.window.fire('pagehide'), f => f.reduced(true), f => f.mode('router'), f => { f.connection.saveData = true; f.connection.fire('change'); }]) {
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
  assert.equal(f.button.textContent, 'Play motion');
  f.visible(); await tick(); assert.equal(f.video.plays, 1, 'do not retry autoplay endlessly');
  f.video.play = function () { this.plays++; this.paused = false; this.readyState = 3; this.fire('playing'); return Promise.resolve(); };
  f.button.fire('click'); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.video.plays, 2);
});

test('network or decode error permanently restores still, independent of controls', async () => {
  const f = fixture(); f.visible(); await tick(); f.video.fire('error');
  assert.equal(f.visual.dataset.motion, 'still');
  assert.equal(f.video.paused, true);
  assert.equal(f.button.hidden, true);
  f.visible(); await tick(); assert.equal(f.video.plays, 1);
});

test('late play success cannot override a newer policy, hidden page, or route', async () => {
  for (const stop of [f => f.reduced(true), f => f.hidden(true), f => f.mode('router'), f => f.window.fire('pagehide')]) {
    const f = fixture({ pending: true }); f.visible(); stop(f); f.video.finishPlay();
    assert.equal(f.visual.dataset.motion, 'still', 'a stale playing event must not reveal even one frame');
    assert.equal(f.video.paused, true, 'playing event must honor policy immediately');
    await tick();
    assert.equal(f.video.paused, true);
    assert.equal(f.visual.dataset.motion, 'still');
    assert.equal(f.button.hidden, true);
  }
});

test('a stale rejected play does not block a newly eligible page', async () => {
  const f = fixture({ pending: true }); f.visible(); f.hidden(true); f.hidden(false);
  f.video.rejectPlay(); await tick();
  assert.equal(f.video.plays, 2);
  f.video.finishPlay(); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
});

test('late successful play after hide and restore converges on eligible playback', async () => {
  const f = fixture({ pending: true }); f.visible(); f.hidden(true); f.hidden(false);
  f.video.finishPlay(); await tick();
  assert.equal(f.video.plays, 2, 'superseded play is reconciled once');
  f.video.finishPlay(); await tick();
  assert.equal(f.video.paused, false);
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.button.textContent, 'Pause motion');
});

test('repeated manual play before first frame cannot strand the only control', async () => {
  const f = fixture({ blocked: true }); f.visible(); await tick();
  f.video.play = function () {
    this.plays++;
    return new Promise(resolve => {
      this.finishPlay = () => { this.paused = false; this.readyState = 3; this.fire('playing'); resolve(); };
    });
  };
  f.button.fire('click'); // Manual retry is pending.
  f.button.fire('click'); // A second activation pauses before any frame exists.
  assert.equal(f.button.hidden, false, 'Play control must remain reachable before first frame');
  assert.equal(f.button.textContent, 'Play motion');
  f.video.finishPlay(); await tick();
  assert.equal(f.video.paused, true);
  assert.equal(f.button.hidden, false);
  f.hidden(true); f.hidden(false);
  assert.equal(f.button.hidden, false);
  f.button.fire('click'); f.video.finishPlay(); await tick();
  assert.equal(f.visual.dataset.motion, 'playing');
  assert.equal(f.button.textContent, 'Pause motion');
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
  assert.equal(f.button.textContent, 'Play motion');
});
