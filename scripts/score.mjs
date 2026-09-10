// Scores every run in the given JSONL files and writes the results.
//   npm run score -- runs/corpus.jsonl [more.jsonl ...] --out results/scores-corpus.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { score } from '../src/eval/score.mjs';

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const out = oi > -1 ? args[oi + 1] : 'results/scores.json';
const files = args.filter((a, i) => a.endsWith('.jsonl') && (oi === -1 || i !== oi + 1));

const runs = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const scores = runs.map(score);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(scores, null, 2) + '\n');

const ks = (arr) => arr.flatMap((v, i) => (v ? [i + 1] : [])).join(',') || '-';
for (const s of scores) {
  const p = s.properties;
  console.log(
    `${s.id.padEnd(22)} ${s.env.padEnd(10)} ${String(s.answerId).padEnd(8)} ${s.correct ? 'ok ' : 'BAD'} ` +
      `calls ${String(s.toolCalls).padStart(2)} batched ${p.batched ? 'y' : 'n'} redundant[${ks(p.redundant)}] ` +
      `unused[${ks(p.unused)}] err[${p.error_recovered.map((r) => (r ? 'r' : 'X')).join('')}] ` +
      `grounded ${p.grounded} nums ${p.numbers_supported} shortcut ${p.shortcut} justified ${p.justified} ` +
      `det ${p.determinable_turn} bound ${p.bound_reasoning}`,
  );
  const d = s.detail;
  console.log(
    `${''.padEnd(22)} gap: ${d.proofGap ?? '-'} | unsupported: ${d.unsupportedNumbers?.join(' ') || '-'} | ` +
      `after-det calls ${d.callsAfterDeterminable} | bound phrase: ${d.boundPhrase ?? '-'}` +
      (d.necessity ? ` | necessity: ${d.necessity.individuallyUnnecessary.length} of ${d.necessity.successfulCalls} individually unnecessary [${d.necessity.individuallyUnnecessary.join(',')}], minimal set [${d.necessity.minimalSet.join(',')}]` : ''),
  );
}
console.log(`\n${scores.length} runs scored -> ${out}`);
