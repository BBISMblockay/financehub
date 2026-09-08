/* Load v2's browser modules into a node VM so the pure ones can be unit
 * tested without a browser.
 *
 * Same shape as v3/tests/lib/load.js and for the same reason: these files are
 * IIFEs that hang an object off `window`, because v2 pages are served
 * statically with no build step. They cannot be `require`d (the repo root is
 * type:module, so a bare .js is ESM and module.exports is not there), so they
 * are evaluated against a stand-in global instead.
 *
 * Only inventory-signals.js is loadable this way today. That is the point of
 * having extracted it: the rules that decide what the inventory page CLAIMS
 * about stock now live somewhere a test can reach. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const V2 = path.join(REPO_ROOT, 'v2');

/** Evaluate the named v2 files, in order, against one fresh global. */
function loadV2(files) {
  const g = {};
  g.window = g;
  g.globalThis = g;
  g.console = console;
  g.Object = Object;
  g.Math = Math;
  g.Number = Number;
  g.String = String;
  g.Array = Array;
  g.JSON = JSON;
  g.Date = Date;
  g.parseFloat = parseFloat;
  g.isNaN = isNaN;
  g.isFinite = isFinite;
  // daily-trend-kpis.js formats money and resolves the Pacific business day.
  g.Intl = Intl;
  g.setTimeout = setTimeout;
  g.clearTimeout = clearTimeout;

  vm.createContext(g);
  for (const f of files) {
    const file = path.join(V2, f);
    if (!fs.existsSync(file)) throw new Error(`loadV2: no such module ${f} (looked in ${V2})`);
    vm.runInContext(fs.readFileSync(file, 'utf8'), g, { filename: file });
  }
  return g;
}

/** Convenience: the inventory signal module, already unwrapped. */
function loadSignals() {
  return loadV2(['inventory-signals.js']).SiloInventorySignals;
}

module.exports = { loadV2, loadSignals, REPO_ROOT, V2 };
