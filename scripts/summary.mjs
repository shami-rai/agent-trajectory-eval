// Per-run and per-arm summary of the corpus: what final-answer grading sees
// (correct) next to what the path shows (justified, calls after the answer
// was determinable). Reads run records and scorer output; no API calls.
//   npm run summary -- runs/corpus.jsonl --scores results/scores-corpus.json

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const si = args.indexOf('--scores');
const scoresPath = si > -1 ? args[si + 1] : 'results/scores-corpus.json';
const files = args.filter((a, i) => a.endsWith('.jsonl') && (si === -1 || i !== si + 1));

const runs = Object.fromEntries(
  files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).map((r) => [r.id, r]),
);
const scores = JSON.parse(readFileSync(scoresPath, 'utf8')).filter((s) => runs[s.id]);

const arm = (r) => `${r.env ?? 'normal'} ${r.model.replace('claude-', '')}${r.effort ? ` ${r.effort}` : ''} ${r.parallel ? 'par' : 'ser'}`;

console.log('| run | arm | turns | calls | errors | answer | correct | justified | calls after determinable | cost |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const s of scores) {
  const r = runs[s.id];
  const det = s.properties.determinable_turn;
  console.log(
    `| ${s.id} | ${arm(r)} | ${r.turns} | ${r.toolCalls} | ${r.toolErrors} | ${s.answerId ?? '(none)'} | ${s.correct ? 'yes' : 'no'} | ` +
      `${s.properties.justified ? 'yes' : 'no'} | ${det == null ? 'never determinable' : s.detail.callsAfterDeterminable} | ` +
      `${typeof r.costUSD === 'number' ? '$' + r.costUSD.toFixed(3) : 'n/a'} |`,
  );
}

const groups = {};
for (const s of scores) {
  const r = runs[s.id];
  const key = `${r.env ?? 'normal'} ${r.model.replace('claude-', '')}${r.effort ? ` ${r.effort}` : ''}`;
  (groups[key] ??= []).push(s);
}
console.log('\n| arm | runs | correct | justified | correct but unjustified |');
console.log('|---|---|---|---|---|');
for (const [key, ss] of Object.entries(groups)) {
  const c = ss.filter((s) => s.correct).length;
  const j = ss.filter((s) => s.properties.justified).length;
  const cu = ss.filter((s) => s.correct && !s.properties.justified).length;
  console.log(`| ${key} | ${ss.length} | ${c} | ${j} | ${cu} |`);
}
