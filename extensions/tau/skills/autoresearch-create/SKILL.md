---
name: autoresearch-create
description: Set up and run an autonomous optimization loop with tau Autoresearch. Use when asked to run autoresearch, optimize a metric in a loop, create autoresearch files, or start experiment-driven iteration.
---

# Autoresearch Create

Set up tau Autoresearch so the agent can run a long optimization loop with the current built-in tools and strict contract validation.

## When to Use

- User asks to run autoresearch
- User asks to optimize a benchmark or metric in a loop
- User asks to create `autoresearch.md`, `autoresearch.sh`, or related sidecar files
- User wants autonomous experiment iteration with `init_experiment`, `run_experiment`, and `log_experiment`

## Core Compatibility Rules

Follow these rules exactly. Tau's implementation validates them.

1. Create `autoresearch.md` before calling `init_experiment`.
2. Include a `## Benchmark` section in `autoresearch.md` with these bullet keys:
   - `Command:`
   - `Primary metric:`
   - `Direction:`
   - optional `Metric unit:`
   - optional `Secondary metrics:`
3. Make `Benchmark.command` invoke `autoresearch.sh` directly. Valid examples:
   - `bash autoresearch.sh`
   - `sh autoresearch.sh`
   - `./autoresearch.sh`
4. Do not put the real benchmark command directly into `Benchmark.command` if it skips `autoresearch.sh`.
5. Include a non-empty `## Files in Scope` section. Tau rejects empty scope.
6. Use `run_experiment` with the same command declared in `autoresearch.md`.
7. Always include `asi` in `log_experiment`.
8. For `discard`, `crash`, and `checks_failed`, include both:
   - `asi.rollback_reason`
   - `asi.next_action_hint`
9. If a specific `/mode` is desired, set it before `init_experiment`. Tau pins the execution profile at initialization time.

## Setup Workflow

1. Determine the optimization target:
   - goal
   - primary metric and whether lower or higher is better
   - benchmark command that should live inside `autoresearch.sh`
   - files that may be edited
   - off-limits files or directories
   - hard constraints such as tests, types, lint, or no new dependencies
2. Read the relevant source files before writing the session files.
3. Create `autoresearch.md` with the contract format below.
4. Create `autoresearch.sh` as the benchmark entrypoint.
5. Create `autoresearch.checks.sh` only when correctness backpressure is required.
6. Optionally create `autoresearch.config.json` in the session cwd when `workingDir` or `maxIterations` is needed.
7. If desired, commit the initial autoresearch files so the loop starts from a clean baseline.
8. Call `init_experiment` exactly once before the first `run_experiment`, unless intentionally starting a new segment.
9. Run the baseline with `run_experiment`.
10. Immediately call `log_experiment` for that run.
11. Continue the experiment loop without pausing for confirmation.

## `autoresearch.md`

Use this structure. The exact required headings are `## Benchmark`, `## Files in Scope`, `## Off Limits`, and `## Constraints`.

```markdown
# Autoresearch: <goal>

## Objective
<Precise description of what is being optimized and why it matters.>

## Benchmark
- Command: bash autoresearch.sh
- Primary metric: <metric_name>
- Metric unit: <us|ms|s|kb|mb|"">
- Direction: lower
- Secondary metrics:
  - <secondary_metric_name>
  - <secondary_metric_name>

## Files in Scope
- <path-one>
- <path-two>

## Off Limits
- <off-limits-path>

## Constraints
- <hard-rule-one>
- <hard-rule-two>

## What's Been Tried
- Baseline established.
```

Notes:

- Keep the `Benchmark` values aligned with the later `init_experiment` call.
- `Primary metric` must match the metric name used by `init_experiment`.
- `Direction` must be exactly `lower` or `higher`; replace the example value when the metric should increase instead.
- `Files in Scope` should list only paths that may be modified.
- Extra sections are fine; tau ignores them for contract parsing.

## `autoresearch.sh`

Write a fast benchmark entrypoint with `set -euo pipefail`.

Requirements:

- Put the real workload here.
- Print `METRIC name=value` lines to stdout for the primary metric and any secondary metrics.
- Keep pre-checks fast.
- For noisy sub-5-second benchmarks, run several repetitions and report a stable aggregate such as the median.
- Make the script executable when appropriate.

Example:

```bash
#!/usr/bin/env bash
set -euo pipefail

# fast sanity check
pnpm -s tsc --noEmit >/dev/null

value=$(node scripts/benchmark.js)
echo "METRIC total_us=${value}"
echo "METRIC memory_mb=128"
```

## `autoresearch.checks.sh` (optional)

Create this file only when the constraints require correctness validation after each passing benchmark.

Behavior in tau:

- Runs automatically after a benchmark passes.
- Its duration does not affect the primary metric.
- A failing checks script blocks `keep`.
- The result should be logged as `checks_failed`.
- Tau currently uses its built-in checks timeout; do not rely on a per-run checks timeout tool parameter.

Keep output compact. Prefer surfacing only the tail of failures rather than verbose success output.

Example:

```bash
#!/usr/bin/env bash
set -euo pipefail

pnpm test --run
pnpm typecheck
```

## `autoresearch.config.json` (optional)

This file lives in the session cwd. Supported fields:

- `workingDir`
- `maxIterations`

Example:

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

Rules:

- `workingDir` may be absolute or relative to the session cwd.
- Tau fails fast if `workingDir` does not exist.
- `maxIterations` stops the current segment after the limit is reached; start a new segment with `init_experiment` to continue.

## Tool Usage

### `init_experiment`

Call only after `autoresearch.md` exists and matches the intended experiment.

Example:

```json
{
  "name": "Optimize test runtime",
  "metric_name": "runtime_ms",
  "metric_unit": "ms",
  "direction": "lower"
}
```

Important:

- Tau reads the benchmark command, scope, off-limits paths, and constraints from `autoresearch.md`.
- Tau pins the current execution profile here.
- If `autoresearch.jsonl` already has a config for the current segment, do not call `init_experiment` again unless intentionally re-initializing a new segment.

### `run_experiment`

Use the exact command declared in `Benchmark.command`.

Example:

```json
{
  "command": "bash autoresearch.sh",
  "timeout": 600
}
```

### `log_experiment`

Call after every run.

Rules:

- `keep` commits automatically.
- `discard`, `crash`, and `checks_failed` revert automatically.
- Include parsed `metrics` when available.
- Always include `asi`.

Example keep:

```json
{
  "commit": "abc1234",
  "metric": 91.4,
  "status": "keep",
  "description": "vectorize hot path",
  "metrics": {
    "runtime_ms": 91.4,
    "memory_mb": 128
  },
  "asi": {
    "hypothesis": "vectorizing the hot loop reduces interpreter overhead"
  }
}
```

Example discard:

```json
{
  "commit": "abc1234",
  "metric": 96.8,
  "status": "discard",
  "description": "cache parsed config",
  "metrics": {
    "runtime_ms": 96.8
  },
  "asi": {
    "hypothesis": "config parsing is on the hot path",
    "rollback_reason": "regressed runtime versus best kept run",
    "next_action_hint": "inspect allocation-heavy code in the executor instead"
  }
}
```

## Loop Rules

- Continue autonomously once the loop starts.
- Prefer improvements in the primary metric.
- Keep changes that materially improve the metric and satisfy checks.
- Discard or mark crash/checks_failed when the experiment does not earn a keep.
- Update `autoresearch.md` when the loop uncovers durable insights or repeated dead ends.
- Append deferred promising ideas to `autoresearch.ideas.md`.
- Resume from existing `autoresearch.md` and `autoresearch.jsonl` when present.

## Compatibility Checklist

Before starting the loop, verify all of the following:

- `autoresearch.md` exists
- `autoresearch.md` contains `## Benchmark`
- `Benchmark.command` directly invokes `autoresearch.sh`
- `Primary metric` matches `init_experiment.metric_name`
- `Direction` is `lower` or `higher`
- `Files in Scope` is non-empty
- `autoresearch.sh` exists
- Optional `autoresearch.checks.sh` is present only when required
- Intended `/mode` is already set before `init_experiment`

## Resume Behavior

When the files already exist:

1. Read `autoresearch.md`.
2. Read recent `autoresearch.jsonl` history.
3. Read `autoresearch.ideas.md` if present.
4. Continue the loop using the existing contract instead of rewriting the session from scratch.
