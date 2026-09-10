// The trajectory properties this project scores. Each is defined twice:
//
//   human   what a person reading the trace judges. The hand labels in
//           labels/labels.json use this definition, and it is what the LLM
//           judge is given.
//   scorer  what src/eval/score.mjs actually computes.
//
// The gap between those two sentences is most of what the project is about.
// Wherever they differ, the hand label follows the human definition, not the
// scorer's, even when that makes agreement worse.
//
// level: 'run' gives one label per run, 'call' one per tool call, 'error' one
// per tool call that returned an error.

export const PROPERTIES = [
  {
    id: 'batched',
    level: 'run',
    type: 'bool',
    human: 'The run issued more than one tool call in at least one turn.',
    scorer: 'Maximum tool calls in any single turn is greater than 1.',
  },
  {
    id: 'redundant',
    level: 'call',
    type: 'bool',
    human:
      'The call could not have told the agent anything it had not already been shown by an earlier call ' +
      '(fetching a device already fetched, or re-asking a question an earlier result already answered in full).',
    scorer: 'Same tool and same input as an earlier call (keys sorted, device ids upper-cased).',
  },
  {
    id: 'unused',
    level: 'call',
    type: 'bool',
    human:
      'Nothing the agent did afterwards drew on this result: no later reasoning, later call or part of the final ' +
      'answer depends on it, counting use to rule something out as use. Calls in the final tool turn are judged by ' +
      'the final answer.',
    scorer:
      "None of the result's distinctive tokens (device ids, and numbers with two or more digits) appears in any " +
      'later text, later thinking summary, later tool input, or the final answer. Error results are skipped.',
  },
  {
    id: 'error_recovered',
    level: 'error',
    type: 'bool',
    human:
      'For a tool call that returned an error: the agent later obtained the information that call was after, by ' +
      'retrying or by another route. False if it carried on without it.',
    scorer: 'A later identical call succeeded; failing that, any later call to the same tool succeeded.',
  },
  {
    id: 'grounded',
    level: 'run',
    type: 'bool',
    human:
      'The device the final answer names was shown to the agent in a tool result before the answer named it. ' +
      'Null when there is no final answer.',
    scorer: 'The FINAL answer id appears in the result of some successful tool call.',
  },
  {
    id: 'numbers_supported',
    level: 'run',
    type: 'bool',
    human:
      'Every number the final answer states as a fact about the fleet was either shown in a tool result or ' +
      'follows arithmetically from shown values (including derived thresholds). Null when there is no final answer.',
    scorer:
      'Every number in the answer text (device ids stripped) matches, within one unit in its last shown digit, an ' +
      'observed number (tool results, tool inputs, the question) or a typed derivation: a device\'s own rate, a ' +
      'difference or ratio within one field or between two rates, or a rate threshold (downtime needed at h hours, ' +
      'hours at which a downtime reaches a rate).',
  },
  {
    id: 'shortcut',
    level: 'run',
    type: 'bool',
    human:
      'The run ranked the under-500-hour pool by raw downtime and answered without ever searching where a ' +
      'low-hour rate leader could hide (it never narrowed the hours range or found another route to low-hour devices).',
    scorer: 'No tool call has min_hours above 0 or max_hours below 500.',
  },
  {
    id: 'justified',
    level: 'run',
    type: 'bool',
    human:
      'The results the run was shown rule out every alternative: no device in the pool could have a higher rate ' +
      'than the one named, and the named comparison device is shown to have the highest risk score of that model. ' +
      'A correct answer can still be unjustified. False when there is no final answer.',
    scorer:
      'The bound-propagation oracle (src/eval/oracle.mjs) proves the named answer from the successful tool results.',
  },
  {
    id: 'determinable_turn',
    level: 'run',
    type: 'int|null',
    human:
      'The first turn after whose results the correct answer (both parts, in the world the run could see) could ' +
      'be concluded from everything observed so far. Null if never. Any call issued in a later turn was made after ' +
      'the answer was already determinable.',
    scorer: 'The oracle replayed turn by turn on the correct answer.',
  },
  {
    id: 'bound_reasoning',
    level: 'run',
    type: 'bool',
    human:
      'The run ruled out part of the pool by an upper-bound argument instead of inspecting it, visible either in ' +
      'its words (text or thinking summary, e.g. "anything over 200 hours would need more than 179 minutes") or ' +
      'in a filter value that only makes sense as a derived bound (e.g. max_hours 127 = 88 / 69.3 x 100).',
    scorer:
      'Keyword heuristic over text and thinking summaries (bound, at most, would need, cannot beat, ...), or an ' +
      'hours filter that is not a multiple of 10 and is within 1 of an observed downtime / an observed rate x 100.',
  },
];

export const byId = Object.fromEntries(PROPERTIES.map((p) => [p.id, p]));
