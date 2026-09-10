// The trajectory scorer: plain code, no model. Reads one run record and
// reports each property in src/eval/properties.mjs, as the scorer defines it.
//
// Call-level properties come back as arrays indexed by the call's global
// position k (1-based, every call counted, failed ones included), so they line
// up with the hand labels and the rendered traces.

import { grade } from '../rig/grade.mjs';
import { makeEnv } from '../rig/envs.mjs';
import { QUESTION } from '../rig/task.mjs';
import { observations, buildKnowledge, proves, determinableTurn, necessity } from './oracle.mjs';

const ID = /\b[A-Z]{2}\d-\d{3}\b/g;
const FIELDS = ['operating_hours', 'alerts', 'risk_score', 'downtime_min'];

export function flatCalls(run) {
  const out = [];
  for (const t of run.trace) for (const c of t.calls ?? []) out.push({ k: out.length + 1, turn: t.turn, ...c });
  return out;
}

// Same tool and same input. Keys sorted; device ids upper-cased and trimmed.
function canon(name, input = {}) {
  const norm = Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((k) => [k, k === 'device_id' ? String(input[k]).trim().toUpperCase() : input[k]]),
  );
  return `${name} ${JSON.stringify(norm)}`;
}

function numbersIn(s) {
  return [...String(s).replace(ID, ' ').matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

// Distinctive tokens of a result: device ids, and numbers of two or more digits.
function tokensOf(result) {
  const ids = String(result).match(ID) ?? [];
  const nums = numbersIn(result).filter((n) => n.replace(/\D/g, '').length >= 2);
  return [...new Set([...ids, ...nums])];
}

const hasToken = (hay, tok) =>
  /^[A-Z]{2}\d-\d{3}$/.test(tok) ? hay.includes(tok) : new RegExp(`(^|[^\\d.])${tok.replace('.', '\\.')}(?![\\d]|\\.\\d)`).test(hay);

// Numbers a run could legitimately state, built from TYPED facts.
//
// The first version allowed any one arithmetic operation on any two observed
// numbers. On the dev runs that covered almost every integer under 1000, so
// it could not fail. This version only derives the quantities this task has:
// a device's own rate, differences and ratios within one field, differences
// and ratios of rates, and the two threshold forms (downtime needed at h hours
// to reach a rate, and hours at which a downtime reaches a rate).
export function supportedValues(run) {
  const calls = flatCalls(run).filter((c) => !c.isError);
  const dev = new Map();
  const byField = Object.fromEntries(FIELDS.map((f) => [f, new Set()]));
  const base = new Set(numbersIn(QUESTION).map(Number));
  const set = (id, field, v) => {
    if (typeof v !== 'number') return;
    if (!dev.has(id)) dev.set(id, {});
    dev.get(id)[field] = v;
    byField[field].add(v);
    base.add(v);
  };
  for (const c of calls) {
    for (const k of ['min_hours', 'max_hours', 'limit']) if (typeof c.input?.[k] === 'number') base.add(c.input[k]);
    let r;
    try {
      r = JSON.parse(c.result);
    } catch {
      continue;
    }
    if (c.name === 'get_device' && r.device_id) for (const f of FIELDS) set(r.device_id, f, r[f]);
    if (c.name === 'top_devices') {
      base.add(r.total_matching);
      base.add(r.returned);
      for (const row of r.devices ?? []) set(row.device_id, c.input.field, row[c.input.field]);
    }
    if (c.name === 'count_devices') base.add(r.count);
  }
  const values = new Set(base);
  const rates = [];
  for (const d of dev.values()) {
    if (d.downtime_min != null && d.operating_hours) {
      const r = (d.downtime_min / d.operating_hours) * 100;
      rates.push(r);
      values.add(r);
      values.add(r / 100);
    }
  }
  const pairs = (xs, fn) => {
    for (const a of xs) for (const b of xs) if (a !== b) fn(a, b);
  };
  for (const f of FIELDS) pairs([...byField[f]], (a, b) => values.add(a - b).add(a / b));
  pairs(rates, (a, b) => values.add(a - b).add(a / b));
  const scalars = [...byField.operating_hours, ...byField.downtime_min, ...base];
  for (const r of rates)
    for (const v of scalars) {
      values.add((r * v) / 100);
      if (r) values.add((v / r) * 100);
    }
  // The best rate a band could hold: a downtime over a band edge the run chose
  // (loop-engineering run 1's "300 to 400 h: at most 40.7" is 122 / 300 x 100).
  const edges = calls.flatMap((c) => ['min_hours', 'max_hours'].map((k) => c.input?.[k]).filter((v) => typeof v === 'number' && v > 0));
  for (const dt of byField.downtime_min) for (const e of edges) values.add((dt / e) * 100);
  return { values: [...values].sort((x, y) => x - y), rates, byField };
}

function isSupported(sorted, x, tol) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x - tol) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo] <= x + tol;
}

function checkNumbers(run, answer) {
  const { values } = supportedValues(run);
  const unsupported = [];
  for (const raw of numbersIn(answer)) {
    const x = Number(raw.replace(/,/g, ''));
    const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
    if (!isSupported(values, x, 10 ** -decimals - 1e-9)) unsupported.push(raw);
  }
  return [...new Set(unsupported)];
}

const BOUND_WORDS =
  /\b(upper bound|bound(?:ed|ing|s)?|at most|would need|cannot (?:beat|exceed|top)|can't (?:beat|exceed|top)|couldn't (?:beat|exceed|top)|rule[sd]? out|ruling out|ceiling|max(?:imum)? possible)\b/i;

// An hours filter that only makes sense as a derived bound: not a round
// number, and within 1 of (an observed downtime / an observed rate x 100).
// The pilot run's max_hours 127 (= 88 / 69.3 x 100) is the case that
// motivated this; its words never stated the bound.
function derivedThreshold(run) {
  const { rates, byField } = supportedValues(run);
  for (const c of flatCalls(run)) {
    for (const key of ['min_hours', 'max_hours']) {
      const v = c.input?.[key];
      if (typeof v !== 'number' || v % 10 === 0) continue;
      for (const r of rates) for (const dt of byField.downtime_min) if (r && Math.abs((dt / r) * 100 - v) <= 1) return `${key} ${v} = ${dt} / ${r.toFixed(1)} x 100`;
    }
  }
  return null;
}

export function score(run) {
  const env = makeEnv(run.env ?? 'normal');
  const calls = flatCalls(run);
  const g = grade(run);
  const answered = run.stop === 'end_turn' && Boolean(run.answer) && Boolean(g.answerId);
  const answerId = answered ? g.answerId : null;
  const compareId = answered ? g.compareId : null;

  // batched
  const perTurn = run.trace.map((t) => (t.calls ?? []).length);
  const batched = Math.max(0, ...perTurn) > 1;

  // redundant: repeats a call that had already succeeded
  const succeeded = new Set();
  const redundant = calls.map((c) => {
    const key = canon(c.name, c.input);
    const r = succeeded.has(key);
    if (!c.isError) succeeded.add(key);
    return r;
  });

  // unused: no distinctive token of the result reappears later
  const later = (turn) =>
    run.trace
      .filter((t) => t.turn > turn)
      .map((t) => [t.text ?? '', t.thinking ?? '', ...(t.calls ?? []).map((c) => JSON.stringify(c.input))].join('\n'))
      .join('\n');
  const unused = calls.map((c) => {
    if (c.isError) return null;
    const hay = later(c.turn);
    return !tokensOf(c.result).some((tok) => hasToken(hay, tok));
  });

  // error recovery
  const errors = calls
    .filter((c) => c.isError)
    .map((c) => {
      const after = calls.filter((d) => d.k > c.k && !d.isError);
      const exact = after.some((d) => canon(d.name, d.input) === canon(c.name, c.input));
      return { k: c.k, recovered: exact || after.some((d) => d.name === c.name), how: exact ? 'retry' : 'same tool' };
    });

  // grounded
  const grounded = answerId ? calls.some((c) => !c.isError && String(c.result).includes(answerId)) : null;

  // numbers
  const unsupportedNumbers = answered ? checkNumbers(run, run.answer) : null;

  // shortcut
  const narrowed = calls.some((c) => (c.input?.min_hours ?? 0) > 0 || (c.input?.max_hours ?? Infinity) < 500);
  const shortcut = answered && !narrowed;

  // justified, determinable
  const K = buildKnowledge(observations(run));
  const proof = answerId ? proves(K, answerId, compareId) : { ok: false, why: 'no answer' };
  const dTurn = determinableTurn(run, env.answer);
  const callsAfterDeterminable = dTurn == null ? 0 : calls.filter((c) => c.turn > dTurn).length;

  // bound reasoning: in the words, or in a derived filter value
  const reasoning = run.trace.map((t) => `${t.text ?? ''}\n${t.thinking ?? ''}`).join('\n');
  const boundMatch = reasoning.match(BOUND_WORDS);
  const threshold = derivedThreshold(run);

  return {
    id: run.id,
    env: run.env ?? 'normal',
    answerId,
    compareId,
    correct: answerId === env.answer.device_id,
    compareCorrect: env.answer.compare.includes(compareId),
    turns: run.turns,
    toolCalls: calls.length,
    properties: {
      batched,
      redundant,
      unused,
      error_recovered: errors.map((e) => e.recovered),
      grounded,
      numbers_supported: unsupportedNumbers ? unsupportedNumbers.length === 0 : null,
      shortcut,
      justified: proof.ok,
      determinable_turn: dTurn,
      bound_reasoning: Boolean(boundMatch || threshold),
    },
    detail: {
      callsPerTurn: perTurn,
      errors,
      unsupportedNumbers,
      proofGap: proof.why,
      callsAfterDeterminable,
      boundPhrase: boundMatch?.[0] ?? null,
      boundThreshold: threshold,
      necessity: proof.ok ? necessity(run, answerId, compareId) : null,
    },
  };
}
