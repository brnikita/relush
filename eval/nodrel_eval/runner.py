"""Runs tasks against the nodrel agent (SPEC §4.9).

Each task runs in a fresh scratch repository and is judged by its own
verification command. The agent's token and cost figures come from the JSON the
`nodrel-run-task` entrypoint prints, so the numbers in a report are the numbers
the provider actually billed.
"""

from __future__ import annotations

import json
import os
import statistics
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from .task import Task, cleanup

REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_TASK_ENTRY = REPO_ROOT / "packages" / "cli" / "dist" / "bin" / "run-task.js"


@dataclass
class TaskResult:
    task_id: str
    suite: str
    seed: int
    solved: bool
    turns: int
    tool_calls: list[str]
    input_tokens: int
    cached_tokens: int
    output_tokens: int
    cost_usd: float
    wall_ms: int
    cache_hit_rate: float
    error: str | None = None
    verify_output: str = ""

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.cached_tokens + self.output_tokens


class AgentUnavailable(RuntimeError):
    """The agent entrypoint is missing or unusable."""


def _require_entrypoint() -> None:
    if not RUN_TASK_ENTRY.exists():
        raise AgentUnavailable(
            f"agent entrypoint not built: {RUN_TASK_ENTRY}\nRun `pnpm build` first."
        )


def run_task(task: Task, model: str, seed: int) -> TaskResult:
    """Runs one task end to end and judges it by its verification command."""
    _require_entrypoint()

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise AgentUnavailable("OPENROUTER_API_KEY is not set")

    cwd = task.materialize()
    try:
        completed = subprocess.run(
            [
                "node",
                str(RUN_TASK_ENTRY),
                "--prompt",
                task.prompt,
                "--cwd",
                str(cwd),
                "--model",
                model,
                "--timeout-ms",
                str(task.timeout_s * 1000),
            ],
            capture_output=True,
            text=True,
            timeout=task.timeout_s + 60,
        )

        stdout = completed.stdout.strip()
        if not stdout:
            # No JSON means the agent never got far enough to report. That is a
            # failed task, not a crashed suite.
            return TaskResult(
                task_id=task.id, suite=task.suite, seed=seed, solved=False,
                turns=0, tool_calls=[], input_tokens=0, cached_tokens=0,
                output_tokens=0, cost_usd=0.0, wall_ms=0, cache_hit_rate=0.0,
                error=(completed.stderr or "agent produced no output")[-500:],
            )

        payload = json.loads(stdout.splitlines()[-1])
        solved, verify_output = task.check(cwd)

        return TaskResult(
            task_id=task.id,
            suite=task.suite,
            seed=seed,
            solved=solved,
            turns=payload.get("turns", 0),
            tool_calls=payload.get("toolCalls", []),
            input_tokens=payload.get("tokens", {}).get("input", 0),
            cached_tokens=payload.get("tokens", {}).get("cached", 0),
            output_tokens=payload.get("tokens", {}).get("output", 0),
            cost_usd=payload.get("costUsd", 0.0),
            wall_ms=payload.get("wallMs", 0),
            cache_hit_rate=payload.get("cacheHitRate", 0.0),
            error=payload.get("error"),
            verify_output=verify_output,
        )
    except subprocess.TimeoutExpired:
        return TaskResult(
            task_id=task.id, suite=task.suite, seed=seed, solved=False,
            turns=0, tool_calls=[], input_tokens=0, cached_tokens=0,
            output_tokens=0, cost_usd=0.0, wall_ms=task.timeout_s * 1000,
            cache_hit_rate=0.0, error="task timed out",
        )
    finally:
        cleanup(cwd)


def run_suite(
    tasks: list[Task], model: str, seeds: int = 3, progress=None
) -> list[TaskResult]:
    """Runs every task once per seed.

    SPEC §4.9 requires three runs reported as mean +/- sd: a single run of a
    stochastic agent is not a measurement.
    """
    results: list[TaskResult] = []
    for seed in range(seeds):
        for task in tasks:
            if progress:
                progress(task, seed)
            results.append(run_task(task, model, seed))
    return results


def summarize(results: list[TaskResult]) -> dict:
    """Aggregates results into the figures SPEC §6 states targets against."""
    if not results:
        return {
            "tasks": 0, "runs": 0, "solve_rate": 0.0, "solve_rate_sd": 0.0,
            "tokens_per_task": 0.0, "cost_per_task": 0.0,
            "cache_hit_rate": 0.0, "mean_turns": 0.0,
        }

    by_seed: dict[int, list[TaskResult]] = {}
    for r in results:
        by_seed.setdefault(r.seed, []).append(r)

    per_seed_solve = [
        sum(1 for r in rs if r.solved) / len(rs) for rs in by_seed.values() if rs
    ]

    total_input = sum(r.input_tokens + r.cached_tokens for r in results)
    total_cached = sum(r.cached_tokens for r in results)

    return {
        "tasks": len({r.task_id for r in results}),
        "runs": len(results),
        "seeds": len(by_seed),
        "solve_rate": statistics.fmean(per_seed_solve) if per_seed_solve else 0.0,
        # Reported alongside the mean because a single seed hides variance, and
        # SPEC §9 forbids fixing a gate by re-rolling until it passes.
        "solve_rate_sd": (
            statistics.stdev(per_seed_solve) if len(per_seed_solve) > 1 else 0.0
        ),
        "tokens_per_task": statistics.fmean([r.total_tokens for r in results]),
        "cost_per_task": statistics.fmean([r.cost_usd for r in results]),
        "cache_hit_rate": (total_cached / total_input) if total_input else 0.0,
        "mean_turns": statistics.fmean([r.turns for r in results]),
        "failures": [
            {"task_id": r.task_id, "seed": r.seed, "error": r.error}
            for r in results
            if not r.solved
        ],
    }


def result_dicts(results: list[TaskResult]) -> list[dict]:
    return [asdict(r) for r in results]
