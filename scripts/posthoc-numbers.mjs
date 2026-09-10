// POST-HOC, not part of the frozen scorer. After scoring the corpus, every
// "unsupported number" flag turned out to come from a model name ("InfusaLine
// 700") or a firmware string ("4.0.1"). This re-runs the same typed check with
// those stripped from the answer, to see what the check catches once that bug
// is gone.
//   node scripts/posthoc-numbers.mjs
//
// Result on the corpus: agreement with the hand labels rises from 16/23 to
// 20/23, and the check then flags only c20, for "~9%", which is itself valid
// arithmetic. The four runs hand-labelled unsupported (a count written as a
// word, and three misread units) are caught for the right reason 0 times.

import { readFileSync } from 'node:fs';
import { supportedValues } from '../src/eval/score.mjs';

const ID = /\b[A-Z]{2}\d-\d{3}\b/g;
const numbersIn = (t) => [...String(t).replace(ID, ' ').matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => m[0]);

const runs = readFileSync('runs/corpus.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const hand = JSON.parse(readFileSync('labels/labels.json', 'utf8')).runs;

let agree = 0;
let n = 0;
for (const run of runs) {
  const h = hand[run.id].numbers_supported;
  if (h === null) continue;
  const { values } = supportedValues(run);
  const text = run.answer
    .replace(/InfusaLine [47]00|CardioTrack M5|Aeris V3|RenalPure D2/g, ' ')
    .replace(/\b\d+\.\d+\.\d+\b/g, ' ');
  const unsupported = [];
  for (const raw of numbersIn(text)) {
    const x = Number(raw.replace(/,/g, ''));
    const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
    if (!values.some((v) => Math.abs(v - x) <= 10 ** -decimals - 1e-9)) unsupported.push(raw);
  }
  const supported = unsupported.length === 0;
  n++;
  if (supported === h) agree++;
  if (supported !== h || !h) console.log(`${run.id} hand ${h} post-hoc ${supported}${unsupported.length ? ` (flags ${[...new Set(unsupported)].join(' ')})` : ''}`);
}
console.log(`post-hoc agreement: ${agree}/${n}`);
