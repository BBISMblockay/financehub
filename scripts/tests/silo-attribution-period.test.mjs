import test from 'node:test';
import assert from 'node:assert/strict';
const {periodRange,matchPeriod,PERIODS,shiftDay}=await import(new URL('../../v2/silo-attribution-period.js',import.meta.url));

test('presets are inclusive day counts anchored on the newest collected day',()=>{
 // Inclusive: "Last 7 days" ending 2026-10-17 starts on the 11th, which is 7 days of data, not 8.
 assert.deepEqual(periodRange('7','2026-10-17'),{start:'2026-10-11',end:'2026-10-17'});
 assert.deepEqual(periodRange('30','2026-10-17'),{start:'2026-09-18',end:'2026-10-17'});
 // No 90-day preset: loadRows() refuses anything over 31 days (review cycle 1, finding 1).
 assert.equal(periodRange('90','2026-10-17'),null);
});
test('month presets land on real month boundaries, including across a year',()=>{
 assert.deepEqual(periodRange('mtd','2026-10-17'),{start:'2026-10-01',end:'2026-10-17'});
 assert.deepEqual(periodRange('lastmonth','2026-10-17'),{start:'2026-09-01',end:'2026-09-30'});
 // 31-day month, a 28-day February, a leap February, and the year boundary.
 assert.deepEqual(periodRange('lastmonth','2026-09-05'),{start:'2026-08-01',end:'2026-08-31'});
 assert.deepEqual(periodRange('lastmonth','2026-03-02'),{start:'2026-02-01',end:'2026-02-28'});
 assert.deepEqual(periodRange('lastmonth','2028-03-02'),{start:'2028-02-01',end:'2028-02-29'});
 assert.deepEqual(periodRange('lastmonth','2027-01-09'),{start:'2026-12-01',end:'2026-12-31'});
 assert.deepEqual(periodRange('mtd','2027-01-01'),{start:'2027-01-01',end:'2027-01-01'});
});
test('a preset that cannot be computed leaves the dates alone',()=>{
 // null means "change nothing", which is what stops Custom, and a page whose anchor is not yet
 // known, from overwriting dates that arrived in the URL.
 assert.equal(periodRange('custom','2026-10-17'),null);
 for(const bad of [undefined,null,'','2026-10','17/10/2026','today',{}])assert.equal(periodRange('30',bad),null);
 assert.equal(periodRange('nonsense','2026-10-17'),null);
});
test('the control reflects the dates it is actually showing',()=>{
 assert.equal(matchPeriod('2026-10-11','2026-10-17','2026-10-17'),'7');
 assert.equal(matchPeriod('2026-09-18','2026-10-17','2026-10-17'),'30');
 assert.equal(matchPeriod('2026-09-01','2026-09-30','2026-10-17'),'lastmonth');
 // A range nobody offers reads as Custom rather than silently claiming a preset.
 assert.equal(matchPeriod('2026-09-03','2026-10-17','2026-10-17'),'custom');
 assert.equal(matchPeriod('','','2026-10-17'),'custom');
 assert.equal(matchPeriod('2026-10-11','2026-10-17','not-a-day'),'custom');
 // Every preset round-trips, so the control and the dates can never disagree.
 for(const preset of PERIODS){
   const range=periodRange(preset,'2026-10-17');
   if(range)assert.equal(matchPeriod(range.start,range.end,'2026-10-17'),preset);
 }
});
test('day arithmetic is UTC and does not drift across a DST change',()=>{
 // Pacific springs forward on 2026-03-08. Through a local Date this lands a day early.
 assert.equal(shiftDay('2026-03-09',-1),'2026-03-08');
 assert.equal(shiftDay('2026-03-09',-7),'2026-03-02');
 assert.deepEqual(periodRange('7','2026-03-09'),{start:'2026-03-03',end:'2026-03-09'});
 assert.equal(shiftDay('2026-11-02',-1),'2026-11-01');
});

// Review cycle 1 of PR #1173, finding 1: a "Last 90 days" option was offered that loadRows()
// deterministically refused. These two tests make the page's options, this module's list and the
// loader's own limit one fact instead of three that can drift.
import {readFileSync} from 'node:fs';
import {loadRows} from '../../v2/silo-attribution-report.js';
const pageHtml=readFileSync(new URL('../../v2/silo-attribution.html',import.meta.url),'utf8');

test('the page offers exactly the presets this module defines',()=>{
 const control=pageHtml.match(/<select[^>]*id="period"[^>]*>(.*?)<\/select>/s);
 assert.ok(control,'the period control must exist on the page');
 const offered=[...control[1].matchAll(/value="([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(offered,PERIODS);
});
test('every offered preset is a period the real loader will accept',async()=>{
 const uuid='00000000-0000-0000-0000-000000000001';
 for(const preset of PERIODS){
   for(const anchor of ['2026-10-17','2026-01-31','2026-03-01','2026-12-31']){
     const range=periodRange(preset,anchor);
     if(!range)continue; // 'custom' computes nothing; the typed dates are the user's own.
     const days=Math.round((Date.parse(range.end)-Date.parse(range.start))/86400000)+1;
     assert.ok(days>=1&&days<=31,`${preset} at ${anchor} spans ${days} days`);
     // Through loadRows itself, not a copy of its rule. Returning no control rows makes it stop at
     // the NEXT guard, so reaching that message proves the period length was accepted.
     const db={from:()=>{const q={select:()=>q,eq:()=>q,gte:()=>q,lte:()=>q,order:()=>Promise.resolve({data:[],error:null})};return q;}};
     await assert.rejects(()=>loadRows(db,uuid,uuid,range.start,range.end,30),
       (e)=>{assert.doesNotMatch(e.message,/inclusive period/,`${preset} at ${anchor} was refused as a period`);
             assert.match(e.message,/have not been backfilled/);return true;});
   }
 }
});
