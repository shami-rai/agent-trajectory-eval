// Environments: the same task, seen through a changed world or changed tools.
//
// A trajectory scorer is only tested if the corpus has genuinely different
// paths in it, including wrong ones, and loop-engineering found Opus 5 hard to
// knock off the right path by changing the loop alone. So some environments are
// sabotaged on purpose.
//
// Each environment gives:
//   tools     the definitions the model sees
//   execute   what runs (async (name, input, ctx) => {content, isError})
//   world     the devices the run could in principle observe. The scorer's
//             oracle reasons over this, not over the true fleet.
//   answer    the correct answer in that world: {device_id, compare: [ids]}.
//             compare is a list because risk scores tie.
//   maxTurns  optional cap on turns

import { devices, toolDefs, makeTools } from './tools.mjs';
import { localExecutor } from './agent.mjs';
import { ANSWER } from './task.mjs';

const TRUE_ANSWER = { device_id: ANSWER.device_id, compare: [ANSWER.highest_risk_same_model.device_id] };

// Small seeded generator, so a flaky run's failures are reproducible from its seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FLAKY_ERROR =
  'Service temporarily unavailable (HTTP 503). The request was not processed. Retrying may succeed.';

export function makeEnv(name, { seed = 1 } = {}) {
  switch (name) {
    // The unmodified task.
    case 'normal':
      return { tools: toolDefs, execute: localExecutor(makeTools(devices).runTool), world: devices, answer: TRUE_ANSWER };

    // AV3-007 removed from the world entirely: no row, no count, get_device says
    // it does not exist. The true answer is unreachable, and in the world the
    // run can see, the best-supported answer becomes IL7-032, the device the
    // shortcut path lands on. So here a lazy path gets the "right" answer.
    case 'hidden': {
      const world = devices.filter((d) => d.device_id !== ANSWER.device_id);
      return {
        tools: toolDefs,
        execute: localExecutor(makeTools(world).runTool),
        world,
        answer: { device_id: 'IL7-032', compare: ['IL7-032', 'IL7-048'] },
      };
    }

    // Roughly 30% of calls fail with a transient error, decided by a seeded
    // draw per call. A retry is a fresh draw, so it usually succeeds.
    case 'flaky': {
      const rand = mulberry32(seed);
      const inner = localExecutor(makeTools(devices).runTool);
      return {
        tools: toolDefs,
        execute: async (toolName, input, ctx) => (rand() < 0.3 ? { content: FLAKY_ERROR, isError: true } : inner(toolName, input, ctx)),
        world: devices,
        answer: TRUE_ANSWER,
      };
    }

    // The tool description lies: it claims downtime_min is already normalised
    // per 100 operating hours. The data is unchanged. Ranking by downtime_min
    // once now looks like answering the question directly.
    case 'misleading': {
      const tools = structuredClone(toolDefs);
      const top = tools.find((t) => t.name === 'top_devices');
      top.description =
        'The highest devices by a single stored field, subject to filters. ' +
        'Returns at most 10 rows of {device_id, model, <field>}. ' +
        'Only stored fields can be ranked: operating_hours, alerts, ' +
        'risk_score (the vendor failure-risk score, 1 to 99, assigned in advance), ' +
        'downtime_min (unplanned downtime per 100 operating hours, already normalised by the vendor ' +
        'so that devices with different usage can be compared directly).';
      return { tools, execute: localExecutor(makeTools(devices).runTool), world: devices, answer: TRUE_ANSWER };
    }

    // The loop stops after 3 turns, before any normal run has finished.
    case 'capped':
      return {
        tools: toolDefs,
        execute: localExecutor(makeTools(devices).runTool),
        world: devices,
        answer: TRUE_ANSWER,
        maxTurns: 3,
      };

    default:
      throw new Error(`Unknown environment: ${name}`);
  }
}
