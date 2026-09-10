// Agreement between the hand labels and the scorer (and the LLM judge, when
// its labels exist), property by property, with counts.
//   npm run agreement
//
// Reads  labels/labels.json          hand labels, written before scoring
//        results/scores-corpus.json  scorer output
//        results/judge-corpus.json   judge labels (optional)
// Writes results/agreement.json and prints the table used in the README.
//
// Positive means "the property holds" (true, or the call is flagged). For
// call-level properties each tool call is one item; for error_recovered each
// failed call is one item.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PROPERTIES } from '../src/eval/properties.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const hand = JSON.parse(readFileSync(arg('labels', 'labels/labels.json'), 'utf8')).runs;
const scores = Object.fromEntries(JSON.parse(readFileSync(arg('scores', 'results/scores-corpus.json'), 'utf8')).map((s) => [s.id, s]));
const judgePath = arg('judge', 'results/judge-corpus.json');
const judge = existsSync(judgePath) ? JSON.parse(readFileSync(judgePath, 'utf8')).runs : null;
const outPath = arg('out', 'results/agreement.json');

// Normalise any labeller's output for one run and one property into a list of
// {key, value} items, so every property compares the same way.
function items(src, run, prop, id) {
  const v = src[prop];
  const calls = scores[id].toolCalls;
  const errorKs = scores[id].detail.errors.map((e) => e.k);
  switch (prop) {
    case 'redundant':
    case 'unused': {
      // Hand and judge labels list the flagged call numbers; the scorer gives
      // an array with null for calls that are out of scope (failed calls).
      const flagged = Array.isArray(v) && v.every((x) => typeof x === 'number' && !Number.isNaN(x)) && run !== 'scorer' ? new Set(v) : null;
      const out = [];
      for (let k = 1; k <= calls; k++) {
        if (prop === 'unused' && errorKs.includes(k)) continue; // failed calls have no result to use
        out.push({ key: k, value: flagged ? flagged.has(k) : Boolean(v[k - 1]) });
      }
      return out;
    }
    case 'error_recovered': {
      if (run === 'scorer') return scores[id].detail.errors.map((e) => ({ key: e.k, value: e.recovered }));
      return errorKs.map((k) => ({ key: k, value: v?.[k] ?? v?.[String(k)] ?? null }));
    }
    default:
      return [{ key: 'run', value: v ?? null }];
  }
}

function compare(prop, other) {
  const res = { n: 0, agree: 0, tp: 0, fp: 0, fn: 0, tn: 0, within1: 0, skipped: 0, disagreements: [] };
  for (const id of Object.keys(hand)) {
    if (!scores[id]) continue;
    const src = other === 'scorer' ? scores[id].properties : judge?.[id];
    if (!src) continue;
    const h = new Map(items(hand[id], 'hand', prop, id).map((x) => [x.key, x.value]));
    for (const { key, value } of items(src, other, prop, id)) {
      const hv = h.get(key);
      if (hv === undefined) continue;
      // A run with no final answer has no grounded / numbers label; skip where the hand label is null.
      if (hv === null && prop !== 'determinable_turn') {
        res.skipped++;
        continue;
      }
      res.n++;
      if (prop === 'determinable_turn') {
        const same = hv === value;
        if (same) res.agree++;
        if (same || (hv != null && value != null && Math.abs(hv - value) <= 1)) res.within1++;
        if (!same) res.disagreements.push({ id, hand: hv, [other]: value });
        continue;
      }
      const ov = Boolean(value);
      if (ov === hv) res.agree++;
      else res.disagreements.push({ id, ...(key === 'run' ? {} : { call: key }), hand: hv, [other]: ov });
      if (hv && ov) res.tp++;
      else if (!hv && ov) res.fp++;
      else if (hv && !ov) res.fn++;
      else res.tn++;
    }
  }
  return res;
}

const table = PROPERTIES.map((p) => ({
  property: p.id,
  level: p.level,
  scorer: compare(p.id, 'scorer'),
  ...(judge ? { judge: compare(p.id, 'judge') } : {}),
}));
writeFileSync(outPath, JSON.stringify(table, null, 2) + '\n');

const pct = (r) => (r.n ? `${r.agree}/${r.n} (${Math.round((100 * r.agree) / r.n)}%)` : 'n/a');
const conf = (r, prop) => (prop === 'determinable_turn' ? `within one turn ${r.within1}/${r.n}` : `hand+ ${r.tp + r.fn}, flagged ${r.tp + r.fp}, missed ${r.fn}, false ${r.fp}`);
console.log(`| property | unit | scorer agreement | scorer detail |${judge ? ' judge agreement |' : ''}`);
console.log(`|---|---|---|---|${judge ? '---|' : ''}`);
for (const row of table) {
  console.log(`| ${row.property} | ${row.level} | ${pct(row.scorer)} | ${conf(row.scorer, row.property)} |${judge ? ` ${pct(row.judge)} |` : ''}`);
}
console.log('\nDisagreements (scorer):');
for (const row of table) for (const d of row.scorer.disagreements) console.log(`  ${row.property.padEnd(18)} ${JSON.stringify(d)}`);
if (judge) {
  console.log('\nDisagreements (judge):');
  for (const row of table) for (const d of row.judge.disagreements) console.log(`  ${row.property.padEnd(18)} ${JSON.stringify(d)}`);
}
