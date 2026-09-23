/* Marketing Explorer: an ad's name links to Meta's preview whether or not the
 * creative has a thumbnail.
 *
 * Review cycle 1 of #762 found the anchor only inside the thumbnail branch, so
 * an ad with a preview and no thumbnail (older and deleted formats often have
 * none) rendered its name as plain text. The helper is evaluated from the
 * page's own text, and both layouts are checked to go through it. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createReporter } = require('../lib/assert');
const { REPO_ROOT } = require('../lib/load');

const r = createReporter('marketing-explorer-preview');
const html = fs.readFileSync(path.join(REPO_ROOT, 'v2', 'marketing-explorer.html'), 'utf8');

const grab = (name) => {
  const m = new RegExp(`^  const ${name} = [\\s\\S]*?;\\n(?=\\s*(?://|const |function |let |$))`, 'm').exec(html);
  if (!m) throw new Error(`${name} not found in marketing-explorer.html`);
  return m[0];
};
const ctx = {};
vm.runInNewContext(`${grab('esc')}\n${grab('safeHref')}\n${grab('rowNameHtml')}\n`
  + 'this.esc = esc; this.safeHref = safeHref; this.rowNameHtml = rowNameHtml;', ctx);

r.test('a preview with no thumbnail still links the name', () => {
  const out = ctx.rowNameHtml({ name: 'Old ad', thumb: '', preview: 'https://fb.me/abc' });
  if (!/<a class="mx-name" href="https:\/\/fb\.me\/abc"/.test(out)) throw new Error(out);
});

r.test('no preview renders plain, escaped text', () => {
  const out = ctx.rowNameHtml({ name: '<b>x</b>', preview: null });
  if (out !== '&lt;b&gt;x&lt;/b&gt;') throw new Error(out);
});

r.test('both layouts render the name through rowNameHtml', () => {
  const block = /const nameInner = r\.thumb([\s\S]*?);\n/.exec(html);
  if (!block) throw new Error('nameInner not found');
  const [withThumb, withoutThumb] = block[1].split('\n        : ');
  if (!withThumb.includes('${nameHtml}')) throw new Error('thumbnail branch bypasses the helper');
  if (!withoutThumb || !withoutThumb.includes('${nameHtml}')) throw new Error('no-thumbnail branch bypasses the helper');
});

const out = r.summary();
process.exit(out.fail ? 1 : 0);
