"""Eval entrypoints (SPEC §7).

    nodrel-eval baseline --suite internal     freeze eval/reports/m0-baseline.json
    nodrel-eval run      --suite smoke        run a suite, print a summary
    nodrel-eval compare  --against m0         compare a fresh run to a report
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from .runner import AgentUnavailable, result_dicts, run_suite, summarize
from .task import load_tasks

EVAL_ROOT = Path(__file__).resolve().parents[1]
TASKS_DIR = EVAL_ROOT / "tasks"
REPORTS_DIR = EVAL_ROOT / "reports"

DEFAULT_MODEL = "z-ai/glm-5.3-flash"


def _progress(task, seed: int) -> None:
    print(f"  [seed {seed}] {task.id} ...", file=sys.stderr, flush=True)


def _run(suite: str | None, model: str, seeds: int, history: bool = False) -> dict:
    tasks = load_tasks(TASKS_DIR, suite)
    if not tasks:
        raise SystemExit(f"no tasks found for suite {suite!r} under {TASKS_DIR}")

    print(f"running {len(tasks)} task(s) x {seeds} seed(s) on {model}", file=sys.stderr)
    results = run_suite(tasks, model, seeds, progress=_progress, history=history)

    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "model": model,
        "suite": suite or "all",
        "history": history,
        "summary": summarize(results),
        "results": result_dicts(results),
    }


def _print_summary(report: dict) -> None:
    s = report["summary"]
    print(f"\n{report['suite']} on {report['model']}")
    print(f"  solve rate      {s['solve_rate']:.1%} +/- {s['solve_rate_sd']:.1%}")
    print(f"  tokens/task     {s['tokens_per_task']:,.0f}")
    print(f"  cost/task       ${s['cost_per_task']:.5f}")
    print(f"  cache hit       {s['cache_hit_rate']:.1%}")
    print(f"  mean turns      {s['mean_turns']:.1f}")
    if s.get("masked_outputs"):
        print(f"  masked          {s['masked_outputs']} outputs, "
              f"{s['masked_tokens_saved']:,} tokens elided")
    if s.get("failures"):
        print(f"  unsolved        {len(s['failures'])}")


def _compare(current: dict, baseline: dict) -> int:
    """Prints a comparison. Returns a process exit code."""
    c, b = current["summary"], baseline["summary"]

    def ratio(new: float, old: float) -> float:
        return (new / old) if old else 0.0

    print(f"\ncompared to baseline ({baseline.get('generated_at', 'unknown')})")
    print(f"  solve rate   {b['solve_rate']:.1%} -> {c['solve_rate']:.1%}"
          f"  ({ratio(c['solve_rate'], b['solve_rate']):.0%} of baseline)")
    print(f"  tokens/task  {b['tokens_per_task']:,.0f} -> {c['tokens_per_task']:,.0f}"
          f"  ({ratio(c['tokens_per_task'], b['tokens_per_task']):.0%} of baseline)")
    print(f"  cost/task    ${b['cost_per_task']:.5f} -> ${c['cost_per_task']:.5f}")
    print(f"  cache hit    {b['cache_hit_rate']:.1%} -> {c['cache_hit_rate']:.1%}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nodrel-eval")
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ("run", "baseline"):
        p = sub.add_parser(name)
        p.add_argument("--suite", default=None)
        p.add_argument("--model", default=DEFAULT_MODEL)
        p.add_argument("--seeds", type=int, default=3 if name == "baseline" else 1)
        p.add_argument("--history", action="store_true", help="enable the history manager")

    p = sub.add_parser("compare")
    p.add_argument("--against", default="m0")
    p.add_argument("--suite", default=None)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--seeds", type=int, default=3)
    p.add_argument("--history", action="store_true", help="enable the history manager")

    args = parser.parse_args(argv)

    try:
        report = _run(args.suite, args.model, args.seeds, args.history)
    except AgentUnavailable as error:
        print(f"cannot run eval: {error}", file=sys.stderr)
        return 2

    _print_summary(report)

    if args.command == "baseline":
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        out = REPORTS_DIR / "m0-baseline.json"
        out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nfrozen baseline -> {out.relative_to(EVAL_ROOT.parent)}")
        return 0

    if args.command == "compare":
        baseline_path = REPORTS_DIR / f"{args.against}-baseline.json"
        if not baseline_path.exists():
            print(f"no baseline at {baseline_path}", file=sys.stderr)
            return 2
        return _compare(report, json.loads(baseline_path.read_text(encoding="utf-8")))

    return 0
