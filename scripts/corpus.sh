#!/usr/bin/env bash
# The labelled corpus: 24 runs with deliberately different paths, run one at a
# time (never concurrently; the API key is shared). Re-running skips any id
# already in runs/corpus.jsonl, so an interrupted batch can be resumed.
#   bash scripts/corpus.sh
set -u
cd "$(dirname "$0")/.."
OUT=runs/corpus.jsonl
touch "$OUT"

run() {
  local id=$1; shift
  if grep -q "\"id\":\"$id\"" "$OUT"; then echo "skip $id"; return; fi
  node --env-file-if-exists=.env scripts/run.mjs --id "$id" --out "$OUT" "$@" 2>&1 | tail -4 || true
  echo
}

# Opus 5, unmodified task: effort and parallelism varied.
run c01 --env normal --effort low
run c02 --env normal --effort low
run c03 --env normal --effort low
run c04 --env normal --effort medium
run c05 --env normal --effort medium
run c06 --env normal --effort high
run c07 --env normal --effort high
run c08 --env normal --effort low --serial
run c09 --env normal --effort low --serial
run c10 --env normal --effort high --serial

# Secondary arm, Haiku 4.5: here because Opus rarely takes a wrong path on its
# own, and the scorer needs natural wrong paths, not only sabotaged ones.
run c11 --env normal --model claude-haiku-4-5
run c12 --env normal --model claude-haiku-4-5
run c13 --env normal --model claude-haiku-4-5 --serial

# Sabotaged environments (see src/rig/envs.mjs).
run c14 --env hidden --effort low
run c15 --env hidden --effort high
run c16 --env flaky --effort low --seed 3
run c17 --env flaky --effort medium --seed 2
run c18 --env flaky --effort high --seed 1
run c19 --env misleading --effort low
run c20 --env misleading --effort high
run c21 --env capped --effort low
run c22 --env misleading --model claude-haiku-4-5
run c23 --env flaky --model claude-haiku-4-5 --seed 3
run c24 --env hidden --effort medium --serial

node scripts/spend.mjs
