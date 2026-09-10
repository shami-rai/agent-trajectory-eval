// Renders run records as plain-text traces, one file per run, for reading by
// eye. This is what the hand labels were written from, and what the LLM judge
// is shown. It contains the trace and nothing else: no grade, no scorer output.
//   npm run render -- runs/corpus.jsonl [--dir runs/rendered]
//
// Calls are numbered #k across the whole run (failed calls included), the same
// numbering the scorer and the labels use.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function render(run) {
  const lines = [];
  lines.push(`run ${run.id}`);
  lines.push(`environment: ${run.env ?? 'normal'} | model: ${run.model} | effort: ${run.effort ?? 'n/a'} | ${run.parallel ? 'parallel' : 'serial'} tool calls`);
  lines.push(`stop: ${run.stop} | turns: ${run.turns} | tool calls: ${run.toolCalls}`);
  lines.push('');
  let k = 0;
  for (const t of run.trace) {
    if (t.error) {
      lines.push(`turn ${t.turn}  API ERROR: ${t.error}`);
      continue;
    }
    lines.push(`turn ${t.turn}`);
    if (t.thinking) lines.push(...t.thinking.split('\n').map((l, i) => (i ? '         ' : '  think  ') + l));
    const last = t.stop_reason !== 'tool_use';
    if (t.text && !last) lines.push(...t.text.split('\n').map((l, i) => (i ? '         ' : '  say    ') + l));
    for (const c of t.calls ?? []) {
      k++;
      lines.push(`  #${k} ${c.name} ${JSON.stringify(c.input)}`);
      lines.push(`      ${c.isError ? 'ERROR ' : '-> '}${c.result}`);
    }
    if (last) {
      lines.push('');
      lines.push(`final answer (stop: ${t.stop_reason}):`);
      lines.push(t.text || '(empty)');
    }
  }
  if (run.stop !== 'end_turn' && run.trace.at(-1)?.stop_reason === 'tool_use') {
    lines.push('');
    lines.push(`(run ended with stop=${run.stop} before any final answer)`);
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1]?.endsWith('render.mjs')) {
  const args = process.argv.slice(2);
  const di = args.indexOf('--dir');
  const dir = di > -1 ? args[di + 1] : 'runs/rendered';
  mkdirSync(dir, { recursive: true });
  for (const f of args.filter((a, i) => a.endsWith('.jsonl') && i !== di + 1)) {
    for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      const run = JSON.parse(line);
      writeFileSync(join(dir, `${run.id}.txt`), render(run));
      console.log(`${run.id} -> ${join(dir, `${run.id}.txt`)}`);
    }
  }
}
