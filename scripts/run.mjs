// One run of the task in a named environment, appended to a JSONL file.
//   npm run agent -- --id c01 --env normal --effort low [--model claude-opus-5]
//                    [--serial] [--seed 1] [--out runs/corpus.jsonl]
//
// Runs are sequential by design: one process, one run. Four other projects
// share this API key.

import { appendFile } from 'node:fs/promises';
import { runAgent } from '../src/rig/agent.mjs';
import { makeEnv } from '../src/rig/envs.mjs';
import { SYSTEM, QUESTION } from '../src/rig/task.mjs';
import { assertBudget, totalSpend } from './spend.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};

const id = arg('id');
if (!id) throw new Error('--id is required');
const envName = arg('env', 'normal');
const model = arg('model', 'claude-opus-5');
const effort = arg('effort', 'low');
const seed = Number(arg('seed', 1));
const parallel = !process.argv.includes('--serial');
const out = arg('out', 'runs/corpus.jsonl');

const before = assertBudget();
const env = makeEnv(envName, { seed });
const haiku = model.startsWith('claude-haiku');

const run = await runAgent({
  model,
  effort,
  parallel,
  system: SYSTEM,
  question: QUESTION,
  tools: env.tools,
  execute: env.execute,
  maxTurns: env.maxTurns ?? 40,
  // Opus 5 thinks adaptively by default but returns empty thinking text
  // unless asked. Haiku 4.5 does not take adaptive thinking, so it runs
  // without, as the rig's default for it.
  extra: haiku ? {} : { thinking: { type: 'adaptive', display: 'summarized' } },
  label: id,
});

const record = { id, env: envName, seed: envName === 'flaky' ? seed : undefined, ...run };
await appendFile(out, JSON.stringify(record) + '\n');

for (const t of run.trace) {
  if (t.error) {
    console.log(`turn ${t.turn} API ERROR ${t.error}`);
    continue;
  }
  console.log(`turn ${t.turn} ctx ${t.context} out ${t.output} ${t.stop_reason}`);
  for (const c of t.calls ?? []) console.log(`  ${c.name} ${JSON.stringify(c.input)}${c.isError ? '  ERROR' : ''}`);
}
const final = (run.answer.match(/FINAL:.*$/im) ?? ['(no FINAL line)'])[0];
console.log(`\n${id} ${envName} ${model} ${run.effort ?? ''} ${parallel ? 'parallel' : 'serial'}`);
console.log(`stop ${run.stop} | turns ${run.turns} | calls ${run.toolCalls} | errors ${run.toolErrors} | peak ctx ${run.peakContext}`);
console.log(final);
console.log(`cost $${run.costUSD.toFixed(4)} | spend before $${before.toFixed(4)} | after $${totalSpend().toFixed(4)}`);
