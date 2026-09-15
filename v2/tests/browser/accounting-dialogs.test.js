/* Readability across the whole Accounting Suite, not just the register.
 *
 * The see-through-dialog bug had one cause (an undefined --bcn-panel token)
 * and two shapes. The second shape is here: schedules.html and
 * fixed-assets.html style `dialog` for border, radius and padding and never
 * set a background at all, so the dialog took the UA's `Canvas` -- which is
 * WHITE, in both themes, because beacon.css declares no `color-scheme`. A
 * white card with light-grey text on it is unreadable in dark mode and nobody
 * notices until they are in it.
 *
 * So this suite opens every <dialog> on every suite page, in both themes, and
 * asks three questions: is the background opaque, does the text contrast with
 * it, and does the dialog stay inside a phone screen. It also checks the
 * shared nav renders its icons everywhere, since that is the other thing all
 * seven pages now share.
 *
 * Nothing is saved or submitted: dialogs are opened and closed.
 */
'use strict';

const { createReporter } = require('../lib/assert');
const { startSuite } = require('../lib/harness');

const r = createReporter('accounting-dialogs');

const PAGES = [
  '/v2/transactions.html',
  '/v2/accounting-export.html',
  '/v2/qbo-reports.html',
  '/v2/schedules.html',
  '/v2/fixed-assets.html',
  '/v2/cash-forecast.html',
  '/v2/accounting-books.html',
];

/* Read every dialog's own painted colours, in the page, one theme at a time.
   Returned rather than asserted in the page so a failure can name the value. */
const INSPECT = (theme) => {
  document.documentElement.setAttribute('data-theme', theme);
  const out = [];
  for (const d of document.querySelectorAll('dialog')) {
    let opened = false;
    try { if (!d.open) { d.showModal(); opened = true; } } catch (e) { /* already open */ }
    const s = getComputedStyle(d);
    const box = d.getBoundingClientRect();
    out.push({
      id: d.id || '(unnamed)',
      background: s.backgroundColor,
      color: s.color,
      overflow: s.overflowY,
      width: box.width,
      right: box.right,
      viewport: window.innerWidth,
      maxHeight: s.maxHeight,
      height: box.height,
      windowHeight: window.innerHeight,
    });
    if (opened) d.close();
  }
  return out;
};

/** 0 (black) to 1 (white), from rgb(), rgba() or oklch(). */
function lightness(value) {
  if (!value) return null;
  if (value.indexOf('oklch(') === 0) return Number(value.slice(6).trim().split(/[\s)]/)[0]);
  const parts = (value.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
  if (parts.length < 3) return null;
  return (parts[0] + parts[1] + parts[2]) / (3 * 255);
}

function opaque(value) {
  if (!value || value === 'transparent') return false;
  if (value.indexOf('rgba(') === 0) return Number(value.split(',')[3]) > 0.9;
  if (value.indexOf('oklch(') === 0) return value.indexOf('/') === -1;
  return value.indexOf('rgb(') === 0;
}

(async () => {
  const suite = await startSuite();
  let dialogsSeen = 0;

  async function check(name, fn) {
    try { await fn(); r.ok(name, true); }
    catch (err) { r.ok(name, false, err && err.message ? err.message : String(err)); }
  }

  try {
    for (const url of PAGES) {
      console.log(`\n── ${url} ──`);
      let page;
      const errors = [];
      try {
        page = await suite.open(url, {}, {
          ready: () => !!document.querySelector('[data-accounting-suite]'),
        });
      } catch (err) {
        r.ok(`${url} boots`, false, err.message.split('\n')[0]);
        continue;
      }
      page.on('pageerror', (e) => errors.push(e.message));

      await check(`${url} · the shared nav renders with an icon per destination`, async () => {
        const nav = await page.$$eval('[data-accounting-suite] a', (links) => links.map((a) => ({
          name: a.textContent.trim(), icon: !!a.querySelector('svg'),
          label: a.dataset.label, current: a.getAttribute('aria-current'),
        })));
        r.truthy(nav.length >= 7, `only ${nav.length} destinations`);
        r.truthy(nav.every((n) => n.icon), 'a destination is drawn without an icon');
        r.truthy(nav.every((n) => n.name && n.name === n.label), 'a name and its tooltip disagree');
        r.eq(nav.filter((n) => n.current === 'page').length, 1, 'exactly one destination is current');
      });

      await check(`${url} · the nav bar itself is opaque`, async () => {
        const bg = await page.$eval('[data-accounting-suite]', (n) => getComputedStyle(n).backgroundColor);
        r.truthy(opaque(bg), `background-color was ${bg}`);
      });

      for (const theme of ['light', 'dark']) {
        const dialogs = await page.evaluate(INSPECT, theme);
        if (!dialogs.length) {
          r.ok(`${url} · no dialogs to check in ${theme}`, true);
          continue;
        }
        if (theme === 'light') dialogsSeen += dialogs.length;

        for (const d of dialogs) {
          await check(`${url} · ${theme} · dialog #${d.id} is opaque and readable`, async () => {
            r.truthy(opaque(d.background), `background-color was ${d.background}`);
            const bg = lightness(d.background);
            const fg = lightness(d.color);
            r.truthy(bg != null && fg != null, `could not read colours: ${d.background} / ${d.color}`);
            r.truthy(Math.abs(bg - fg) > 0.35,
              `text and background are too close: ${d.color} on ${d.background}`);
            if (theme === 'dark') {
              r.truthy(bg < 0.55, `a dark-theme dialog painted light: ${d.background}`);
            }
          });

          await check(`${url} · ${theme} · dialog #${d.id} can be scrolled rather than clipped`, async () => {
            r.truthy(d.maxHeight !== 'none', 'no max-height, so a tall dialog runs off the screen');
            r.truthy(d.height <= d.windowHeight + 1,
              `dialog is ${d.height}px tall in a ${d.windowHeight}px window`);
            r.truthy(['auto', 'scroll'].includes(d.overflow),
              `overflow-y is ${d.overflow}, so content past the fold is unreachable`);
          });
        }
      }

      await page.setViewportSize({ width: 390, height: 780 });
      await page.waitForTimeout(150);
      const phone = await page.evaluate(INSPECT, 'light');
      for (const d of phone) {
        await check(`${url} · dialog #${d.id} fits a 390px screen`, async () => {
          r.truthy(d.width <= d.viewport, `dialog is ${d.width}px wide in ${d.viewport}px`);
          r.truthy(d.right <= d.viewport + 1, `dialog runs to ${d.right}px`);
        });
      }

      await check(`${url} · loaded without a script error`, async () => {
        r.eq(errors, []);
      });

      await page.close();
    }

    r.test('dialogs were actually found and inspected', () => {
      r.truthy(dialogsSeen >= 5, `only ${dialogsSeen} dialogs inspected across the suite`);
    });
  } finally {
    await suite.close();
  }

  process.exit(r.summary().fail ? 1 : 0);
})();
