// What a run's observations actually prove.
//
// The scorer needs to know, at any point in a trace, whether the answer was
// already pinned down by what the agent had been shown. That cannot be read off
// the trace text. It needs a model of what the tools mean:
//
//   top_devices returns the k highest rows, so any device matching the filters
//   that was NOT returned has a value at or below the last row's.
//   total_matching (and count_devices) says how many devices match, so once
//   that many are identified inside a range, nothing unseen can be there.
//   get_device gives exact values.
//
// From those rules this file bounds the downtime rate of every device the run
// has seen, and of a hypothetical unseen device of each model, at every
// possible operating-hours value. The named answer is proven when nothing can
// beat it.
//
// Assumptions, stated because each one is a place the oracle can disagree with
// a careful human reader:
//   - operating hours are integers of at least 1 (a device with 0 hours has no
//     rate). The fleet's minimum is 28, but the agent is never told that.
//   - a query filtered by site or firmware says nothing about a device whose
//     site or firmware the run has not seen, and nothing about unseen devices.
//   - a query filtered by model covers unseen devices of that model only.
//   - it is sound but not complete: it never proves a wrong answer, but it can
//     fail to prove a right one that a cleverer argument would establish.

const HMAX = 499; // the pool is operating_hours < 500

const MODELS = ['InfusaLine 400', 'InfusaLine 700', 'CardioTrack M5', 'Aeris V3', 'RenalPure D2'];

// Successful tool calls in order, with parsed results. Each keeps its global
// index k (1-based, counting every call including failed ones) and its turn.
export function observations(run) {
  const out = [];
  let k = 0;
  for (const t of run.trace) {
    for (const c of t.calls ?? []) {
      k++;
      if (c.isError) continue;
      let data;
      try {
        data = JSON.parse(c.result);
      } catch {
        continue;
      }
      out.push({ k, turn: t.turn, name: c.name, input: c.input ?? {}, data });
    }
  }
  return out;
}

function valueOf(d, field) {
  return { operating_hours: d.hours, downtime_min: d.dt, risk_score: d.risk, alerts: d.alerts }[field] ?? null;
}

function attrsMatch(q, d) {
  if (q.model !== undefined && d.model !== q.model) return false;
  if (q.site !== undefined && d.site !== q.site) return false;
  if (q.firmware !== undefined && d.firmware !== q.firmware) return false;
  return true;
}

export function buildKnowledge(obs) {
  const dev = new Map();
  const queries = [];
  const touch = (id) => {
    if (!dev.has(id)) dev.set(id, { id, model: null, site: null, firmware: null, hours: null, dt: null, risk: null, alerts: null, inQ: new Set() });
    return dev.get(id);
  };

  for (const o of obs) {
    if (o.name === 'get_device') {
      const r = o.data;
      if (!r?.device_id) continue;
      Object.assign(touch(r.device_id), {
        model: r.model,
        site: r.site,
        firmware: r.firmware,
        hours: r.operating_hours,
        dt: r.downtime_min,
        risk: r.risk_score,
        alerts: r.alerts,
      });
    } else if (o.name === 'count_devices' || o.name === 'top_devices') {
      const f = o.input;
      const rows = o.name === 'top_devices' ? (o.data.devices ?? []) : [];
      const q = {
        k: o.k,
        kind: o.name,
        field: f.field ?? null,
        lo: f.min_hours ?? 0,
        hi: f.max_hours ?? Infinity,
        model: f.model,
        site: f.site,
        firmware: f.firmware,
        total: o.name === 'count_devices' ? o.data.count : o.data.total_matching,
        rows,
        last: rows.length ? rows.at(-1)[f.field] : null,
      };
      for (const r of rows) {
        const d = touch(r.device_id);
        if (r.model) d.model = r.model;
        if (q.field === 'operating_hours') d.hours = r.operating_hours;
        if (q.field === 'downtime_min') d.dt = r.downtime_min;
        if (q.field === 'risk_score') d.risk = r.risk_score;
        if (q.field === 'alerts') d.alerts = r.alerts;
        d.inQ.add(q);
      }
      queries.push(q);
    }
  }

  // Pass 1: each seen device's hours interval from direct evidence only, then
  // which queries are exhausted (every matching device already identified).
  for (const d of dev.values()) {
    let lo = 0;
    let hi = Infinity;
    for (const q of d.inQ) {
      lo = Math.max(lo, q.lo);
      hi = Math.min(hi, q.hi);
    }
    if (d.hours != null) [lo, hi] = [d.hours, d.hours + 1];
    d.lo = lo;
    d.hi = hi;
  }
  for (const q of queries) {
    q.members = new Set();
    for (const d of dev.values()) if (attrsMatch(q, d) && d.lo >= q.lo && d.hi <= q.hi) q.members.add(d.id);
    q.exhausted = q.members.size >= q.total;
  }
  return { dev, queries };
}

function feasible(K, d, h) {
  if (d.hours != null && h !== d.hours) return false;
  for (const q of d.inQ) if (h < q.lo || h >= q.hi) return false;
  for (const q of K.queries) {
    if (d.inQ.has(q) || h < q.lo || h >= q.hi || !attrsMatch(q, d)) continue;
    // Every device matching q is already identified, and d is not one of them.
    if (q.exhausted && !q.members.has(d.id)) return false;
    // d would have been returned: its value beats the last row shown.
    if (q.kind === 'top_devices' && q.last != null) {
      const v = valueOf(d, q.field);
      if (v != null && v > q.last) return false;
    }
  }
  return true;
}

function dtHi(K, d, h) {
  if (d.dt != null) return d.dt;
  let cap = Infinity;
  for (const q of K.queries) {
    if (q.kind !== 'top_devices' || q.field !== 'downtime_min' || q.last == null) continue;
    if (d.inQ.has(q) || h < q.lo || h >= q.hi || !attrsMatch(q, d)) continue;
    cap = Math.min(cap, q.last);
  }
  return cap;
}

// Highest downtime per 100 hours d could have while staying in the pool.
function rateHi(K, d) {
  let best = -Infinity;
  let at = null;
  for (let h = 1; h <= HMAX; h++) {
    if (!feasible(K, d, h)) continue;
    const r = (dtHi(K, d, h) / h) * 100;
    if (r > best) [best, at] = [r, h];
  }
  return { rate: best, h: at };
}

const phantom = (model) => ({ id: null, model, site: null, firmware: null, hours: null, dt: null, risk: null, alerts: null, inQ: new Set() });

// Is compareId shown to hold the highest risk score of `model`? With
// compareId null, is ANY device shown to hold it?
function provesTopRisk(K, model, compareId) {
  for (const q of K.queries) {
    if (q.kind !== 'top_devices' || q.field !== 'risk_score') continue;
    if (q.lo > 0 || q.hi !== Infinity || q.site !== undefined || q.firmware !== undefined) continue;
    if (q.model !== undefined && q.model !== model) continue;
    const first = q.rows.find((r) => r.model === model);
    if (!first) continue;
    if (compareId == null) return true;
    const y = K.dev.get(compareId);
    if (y && y.model === model && y.risk === first.risk_score) return true;
  }
  return false;
}

// Does the evidence prove "answerId is the rate leader of the pool, and
// compareId has the top risk score of its model, with both risk scores known"?
export function proves(K, answerId, compareId) {
  const x = K.dev.get(answerId);
  if (!x) return { ok: false, why: `${answerId} never observed` };
  if (x.dt == null) return { ok: false, why: `${answerId} downtime never observed` };
  let hMax = 0;
  for (let h = 1; h <= HMAX + 1; h++) if (h <= HMAX ? feasible(K, x, h) : x.hi > 500) hMax = h;
  if (hMax === 0 || hMax > HMAX) return { ok: false, why: `${answerId} not shown to be under 500 hours` };
  const rLo = (x.dt / hMax) * 100;

  for (const d of K.dev.values()) {
    if (d.id === answerId) continue;
    const { rate, h } = rateHi(K, d);
    if (rate > rLo + 1e-9) return { ok: false, why: `${d.id} could reach ${rate.toFixed(1)} at ${h}h` };
  }
  for (const m of MODELS) {
    const { rate, h } = rateHi(K, phantom(m));
    if (rate > rLo + 1e-9) return { ok: false, why: `an unseen ${m} could reach ${rate === Infinity ? 'any rate' : rate.toFixed(1)} at ${h}h` };
  }
  if (x.risk == null) return { ok: false, why: `${answerId} risk score never observed` };
  if (!provesTopRisk(K, x.model, compareId)) return { ok: false, why: `top risk score of ${x.model} not established${compareId ? ` as ${compareId}` : ''}` };
  return { ok: true, why: null };
}

// First turn after whose results the correct answer was proven, or null.
export function determinableTurn(run, answer) {
  const obs = observations(run);
  const turns = [...new Set(obs.map((o) => o.turn))];
  for (const t of turns) {
    const K = buildKnowledge(obs.filter((o) => o.turn <= t));
    if (answer.compare.some((c) => proves(K, answer.device_id, c).ok)) return t;
  }
  return null;
}

// For a proven answer: which calls could each be removed on its own without
// losing the proof, and how small a set of calls still proves it (greedy,
// dropping from the latest call backwards, so an upper bound on the minimum).
export function necessity(run, answerId, compareId) {
  const obs = observations(run);
  if (!proves(buildKnowledge(obs), answerId, compareId).ok) return null;
  const individuallyUnnecessary = obs.filter((o) => proves(buildKnowledge(obs.filter((p) => p !== o)), answerId, compareId).ok).map((o) => o.k);
  let keep = [...obs];
  for (const o of [...obs].reverse()) {
    const trial = keep.filter((p) => p !== o);
    if (proves(buildKnowledge(trial), answerId, compareId).ok) keep = trial;
  }
  return { successfulCalls: obs.length, individuallyUnnecessary, minimalSet: keep.map((o) => o.k) };
}
