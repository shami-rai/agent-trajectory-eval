// Converts loop-engineering's two original text traces into run records, so
// the scorer can read the runs that were first graded by eye.
//   npm run import-legacy
//
// The text traces truncate long tool results ("...[+501 chars]"). The fleet
// and tools are byte-identical to loop-engineering's, and the tools are
// deterministic, so each call is re-executed to recover its full result, and the
// printed prefix is checked against it. Token usage is not in the text, so
// these records carry no cost. They carry no thinking summaries either: the
// loop-engineering rig never asked for them.

import { readFileSync, writeFileSync } from 'node:fs';
import { runTool } from '../src/rig/tools.mjs';

const SOURCES = [
  { id: 'legacy-01-parallel', file: '../loop-engineering/runs/run-01-parallel.txt', parallel: true },
  { id: 'legacy-02-serial', file: '../loop-engineering/runs/run-02-serial.txt', parallel: false },
];

function parse({ id, file, parallel }) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const trace = [];
  let cur = null;
  let lastCall = null;
  let answer = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = line.match(/^(?:hop|turn) (\d+)\s+context ([\d,]+)\s+out (\d+)\s+stop=(\w+)/);
    if (head) {
      cur = { turn: Number(head[1]), context: Number(head[2].replace(/,/g, '')), output: Number(head[3]), stop_reason: head[4], text: '', calls: [] };
      trace.push(cur);
      continue;
    }
    if (line.startsWith('--- ')) {
      answer = lines.slice(i + 1).join('\n').trim();
      break;
    }
    if (!cur) continue;
    const say = line.match(/^ {2}say {2}(.*)$/);
    const call = line.match(/^ {2}call (\w+) (\{.*\})$/);
    const res = line.match(/^ {2}-> {3}(.*)$/);
    if (say) cur.text = say[1];
    else if (call) {
      const input = JSON.parse(call[2]);
      const result = JSON.stringify(runTool(call[1], input));
      lastCall = { id: `legacy_${trace.length}_${cur.calls.length}`, name: call[1], input, result, isError: false, ms: null };
      cur.calls.push(lastCall);
    } else if (res && lastCall) {
      const printed = res[1].replace(/ \.\.\.\[\+\d+ chars\]$/, '');
      if (!lastCall.result.startsWith(printed)) throw new Error(`${id}: re-executed result does not match the trace for ${lastCall.name}`);
    }
  }
  // The final turn's visible text is the full answer printed after the trace.
  trace.at(-1).text = answer;
  return {
    id,
    env: 'normal',
    source: `loop-engineering/${file.split('/').slice(-2).join('/')}`,
    label: id,
    model: 'claude-opus-5',
    effort: 'high',
    parallel,
    stop: 'end_turn',
    answer,
    turns: trace.length,
    toolCalls: trace.reduce((s, t) => s + t.calls.length, 0),
    toolErrors: 0,
    peakContext: Math.max(...trace.map((t) => t.context)),
    usage: null,
    costUSD: null,
    wallMs: null,
    trace,
  };
}

const out = SOURCES.map(parse);
writeFileSync('runs/legacy.jsonl', out.map((r) => JSON.stringify(r)).join('\n') + '\n');
for (const r of out) console.log(`${r.id}: ${r.turns} turns, ${r.toolCalls} calls, answer starts "${r.answer.slice(0, 60).replace(/\n/g, ' ')}"`);
