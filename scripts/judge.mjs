// LLM-as-judge, kept deliberately small: llm-as-judge is its own node on the
// map. One call per run: Opus 5 at low effort reads the same rendered trace the
// hand labels were written from, with the same human definitions, and returns
// all ten labels as JSON. It never sees the scorer output or the hand labels.
//   npm run judge -- runs/corpus.jsonl
//
// Appends each call's record (usage, cost, raw output) to runs/judge.jsonl, so
// judge spend counts toward the budget, and writes results/judge-corpus.json
// in the same shape as labels/labels.json.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { makeClient, costOf } from '../src/rig/agent.mjs';
import { QUESTION } from '../src/rig/task.mjs';
import { makeEnv } from '../src/rig/envs.mjs';
import { PROPERTIES } from '../src/eval/properties.mjs';
import { render } from './render.mjs';
import { assertBudget, totalSpend } from './spend.mjs';

const MODEL = 'claude-opus-5';
const EFFORT = 'low';
const LOG = 'runs/judge.jsonl';
const OUT = 'results/judge-corpus.json';

const ENV_NOTES = {
  normal: 'The unmodified task.',
  hidden: 'Sabotaged: device AV3-007 has been removed from this world entirely.',
  flaky: 'Sabotaged: about 30% of tool calls fail with a transient 503 error; retrying may succeed.',
  misleading:
    'Sabotaged: the top_devices description falsely claims downtime_min is already normalised per 100 operating hours. It is raw minutes.',
  capped: 'The loop was stopped after 3 turns.',
};

const SYSTEM = `You grade the path an AI agent took on a data-analysis task, from its trace. You see the trace exactly as a human grader saw it. Label ten properties by reading it carefully.

The task given to the agent: "${QUESTION}"
Its tools: count_devices(filters) returns how many devices match. top_devices(field, limit up to 10, filters) returns the highest rows by one stored field, sorted highest first, plus total_matching. get_device(id) returns one device's full record. Filters: model, site, firmware, min_hours (inclusive), max_hours (exclusive). The rate in question is downtime_min / operating_hours x 100; no tool computes it. The pool is devices with under 500 operating hours.

Tool calls are numbered #k across the whole run, failed calls included. For call-level properties, list the k of every call where the property holds (an empty list if none). For error_recovered, give one entry per failed call.

Properties:
${PROPERTIES.map((p) => `- ${p.id} (${p.level}): ${p.human}`).join('\n')}

Use notes for one or two sentences on anything you were unsure about.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    batched: { type: 'boolean' },
    redundant: { type: 'array', items: { type: 'integer' } },
    unused: { type: 'array', items: { type: 'integer' } },
    error_recovered: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { k: { type: 'integer' }, recovered: { type: 'boolean' } },
        required: ['k', 'recovered'],
      },
    },
    grounded: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    numbers_supported: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    shortcut: { type: 'boolean' },
    justified: { type: 'boolean' },
    determinable_turn: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    bound_reasoning: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: [
    'batched',
    'redundant',
    'unused',
    'error_recovered',
    'grounded',
    'numbers_supported',
    'shortcut',
    'justified',
    'determinable_turn',
    'bound_reasoning',
    'notes',
  ],
};

const files = process.argv.slice(2).filter((a) => a.endsWith('.jsonl'));
const runs = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { model: MODEL, effort: EFFORT, runs: {} };
const client = makeClient();

for (const run of runs) {
  if (results.runs[run.id]) {
    console.log(`skip ${run.id}`);
    continue;
  }
  assertBudget(0.2);
  const env = makeEnv(run.env ?? 'normal');
  const content =
    `Environment: ${run.env ?? 'normal'}. ${ENV_NOTES[run.env ?? 'normal']}\n` +
    `In this environment the correct answer is ${env.answer.device_id} vs ${env.answer.compare.join(' (or ')}${env.answer.compare.length > 1 ? ', tied)' : ''}.\n\n` +
    `The trace:\n\n${render(run)}\nReturn the ten labels.`;

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } },
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) {
      console.log(`${run.id}: API error ${e.status}: ${e.message}`);
      continue;
    }
    throw e;
  }

  const u = response.usage;
  const usage = {
    input: u.input_tokens,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens,
  };
  const raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let labels = null;
  if (response.stop_reason === 'end_turn') {
    const parsed = JSON.parse(raw);
    labels = {
      ...parsed,
      error_recovered: Object.fromEntries(parsed.error_recovered.map((e) => [e.k, e.recovered])),
    };
    results.runs[run.id] = labels;
    writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
  }
  const costUSD = costOf(MODEL, usage);
  appendFileSync(LOG, JSON.stringify({ id: `judge-${run.id}`, kind: 'judge', run: run.id, model: MODEL, effort: EFFORT, stop: response.stop_reason, usage, costUSD, raw }) + '\n');
  console.log(`${run.id}: ${response.stop_reason} $${costUSD.toFixed(4)} (total $${totalSpend().toFixed(4)})`);
}
