// Running total of API spend: the sum of costUSD over every record in
// runs/*.jsonl (agent runs and judge calls alike). Imported by the scripts
// that spend money, so they can refuse to start once the budget is nearly used.
//   npm run spend

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = join(dirname(fileURLToPath(import.meta.url)), '..', 'runs');

// The hard budget for this project, and the margin kept back so one more
// expensive run cannot carry the total over it.
export const BUDGET = 8;
export const MARGIN = 0.5;

export function spendByFile() {
  const out = {};
  for (const f of readdirSync(RUNS).filter((f) => f.endsWith('.jsonl'))) {
    let sum = 0;
    let n = 0;
    for (const line of readFileSync(join(RUNS, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (typeof r.costUSD === 'number') {
        sum += r.costUSD;
        n++;
      }
    }
    out[f] = { records: n, usd: sum };
  }
  return out;
}

export const totalSpend = () => Object.values(spendByFile()).reduce((s, x) => s + x.usd, 0);

export function assertBudget(next = 0) {
  const spent = totalSpend();
  if (spent + next > BUDGET - MARGIN) {
    throw new Error(`Budget guard: $${spent.toFixed(3)} spent, refusing to start (limit $${BUDGET}, margin $${MARGIN}).`);
  }
  return spent;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [f, { records, usd }] of Object.entries(spendByFile())) console.log(`${f.padEnd(24)} ${String(records).padStart(3)} records  $${usd.toFixed(4)}`);
  console.log(`total $${totalSpend().toFixed(4)} of $${BUDGET}`);
}
