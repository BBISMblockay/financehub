/* Load v3's browser modules into a node VM so the pure ones can be unit
 * tested without a browser.
 *
 * Every file in v3/js is an IIFE that hangs an object off `window`. That is
 * not a module format, and deliberately so -- these pages are served
 * statically with no build step. The consequence for testing is that they
 * cannot be `require`d; they have to be evaluated against a stand-in global.
 *
 * The stubs below are the minimum each file touches at LOAD time. If a new
 * module needs more, add it here rather than in a test, so every suite sees
 * the same environment. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const V3_JS = path.join(REPO_ROOT, 'v3', 'js');

/**
 * Evaluate the named v3/js files, in order, against one fresh global.
 * Returns that global, so a test reads `g.SiloReportBuilder` etc.
 *
 * Order matters: report-builder.js calls into SiloReportParams and
 * SiloFieldSemantics, so those must be loaded first -- exactly the order
 * the <script> tags use.
 */
function loadV3(files) {
  const g = {};
  g.window = g;
  g.globalThis = g;
  // chart-adapter reads the theme at draw time; field-semantics caches its
  // catalog in sessionStorage. Neither exists in node.
  g.document = {
    documentElement: { getAttribute: () => 'light' },
    getElementById: () => null,
  };
  g.matchMedia = () => ({ matches: false, addEventListener() {} });
  g.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.localStorage = g.sessionStorage;
  g.console = console;
  g.setTimeout = setTimeout;
  g.clearTimeout = clearTimeout;

  vm.createContext(g);
  for (const f of files) {
    const file = path.join(V3_JS, f);
    if (!fs.existsSync(file)) throw new Error(`loadV3: no such module ${f} (looked in ${V3_JS})`);
    vm.runInContext(fs.readFileSync(file, 'utf8'), g, { filename: file });
  }
  return g;
}

/** The four pure modules, in dependency order. Most unit suites want all. */
const PURE_MODULES = [
  'report-params.js',
  'field-semantics.js',
  'chart-adapter.js',
  'report-builder.js',
];

module.exports = { loadV3, PURE_MODULES, REPO_ROOT, V3_JS };
