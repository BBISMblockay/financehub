'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inventory = require('../fixtures/accounting-control-inventory.json');
let count = 0;
for (const [file, controls] of Object.entries(inventory)) {
  const html = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
  const tags = [...html.matchAll(/<(button|input|select|textarea)\b([^>]+)>/gi)];
  for (const { id, tag } of controls) {
    const matches = tags.filter(m => m[1].toLowerCase() === tag && m[2].match(/\sid=["']([^"']+)/)?.[1] === id);
    const expected = controls.filter(c => c.id === id && c.tag === tag).length;
    assert.equal(matches.length, expected, `${file}: preserve baseline occurrences of ${tag}#${id}`);
    count++;
  }
}
console.log(`${count} existing accounting controls retain their IDs and element types`);
