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

from .compare import format_comparison, per_seed, welch
from .runner import AgentUnavailable, result_dicts, run_suite, summarize
from .task import load_tasks

EVAL_ROOT = Path(__file__).resolve().parents[1]
TASKS_DIR = EVAL_ROOT / "tasks"
REPORTS_DIR = EVAL_ROOT / "reports"

DEFAULT_MODEL = "z-ai/glm-5.3-flash"


def _progress(task, seed: int) -> None:
    print(f"  [seed {seed}] {task.id} ...", file=sys.stderr, flush=True)


def _run(
    suite: str | None, model: str, seeds: int, history: bool = False, graph: bool = False
) -> dict:
    tasks = load_tasks(TASKS_DIR, suite)
    if not tasks:
        raise SystemExit(f"no tasks found for suite {suite!r} under {TASKS_DIR}")

    print(f"running {len(tasks)} task(s) x {seeds} seed(s) on {model}", file=sys.stderr)
    results = run_suite(
        tasks, model, seeds, progress=_progress, history=history, graph=graph
    )

    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "model": model,
        "suite": suite or "all",
        "history": history,
        "graph": graph,
        "summary": summarize(results),
        "results": result_dicts(results),
    }


def _print_summary(report: dict) -> None:
    s = report["summary"]
    print(f"\n{report['suite']} on {report['model']}")
    print(f"  solve rate      {s['solve_rate']:.1%} +/- {s['solve_rate_sd']:.1%}")
    print(f"  tokens/task     {s['tokens_per_task']:,.0f} +/- {s.get('tokens_per_task_sd', 0):,.0f}")
    print(f"  cost/task       ${s['cost_per_task']:.5f} +/- ${s.get('cost_per_task_sd', 0):.5f}")
    print(f"  cache hit       {s['cache_hit_rate']:.1%} +/- {s.get('cache_hit_rate_sd', 0):.1%}")
    print(f"  mean turns      {s['mean_turns']:.1f}")
    if s.get("graph_queries"):
        print(f"  graph queries   {s['graph_queries']}")
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
          f"  ({ratio(c['tokens_per_task'], b['tokens_per_task']):.0%} of baseline)"
          + verdict(c["tokens_per_task"], b["tokens_per_task"],
                    c.get("tokens_per_task_sd", 0.0), b.get("tokens_per_task_sd", 0.0)))
    print(f"  cost/task    ${b['cost_per_task']:.5f} -> ${c['cost_per_task']:.5f}"
          + verdict(c["cost_per_task"], b["cost_per_task"],
                    c.get("cost_per_task_sd", 0.0), b.get("cost_per_task_sd", 0.0)))
    print(f"  cache hit    {b['cache_hit_rate']:.1%} -> {c['cache_hit_rate']:.1%}")
    return 0


def _ab(args) -> int:
    """Runs both configurations back to back and tests the difference.

    Back to back rather than against a stored baseline: provider cache state
    moves on a timescale of minutes, so comparing against a report from an
    hour ago measures the clock as much as the change.
    """
    tasks = load_tasks(TASKS_DIR, args.suite)
    if not tasks:
        raise SystemExit("no tasks for suite %r" % args.suite)

    graph = args.treatment in ("graph", "both")
    history = args.treatment in ("history", "both")

    log = lambda text: print(text, file=sys.stderr)
    control_model = args.control_model or args.model
    treatment_model = args.treatment_model or args.model
    log("A/B on %d task(s) x %d seed(s)" % (len(tasks), args.seeds))
    log("  control:   baseline harness on %s" % control_model)
    log("  treatment: %s on %s" % (args.treatment, treatment_model))

    fallback = [m for m in (args.fallback or "").split(",") if m]
    log("running control...")
    control = run_suite(tasks, control_model, args.seeds, progress=_progress, fallback=fallback)
    log("running treatment...")
    treatment = run_suite(
        tasks, treatment_model, args.seeds, progress=_progress,
        history=history, graph=graph, fallback=fallback,
    )

    metrics = [
        ("tokens/task", "total_tokens", "", True),
        ("cost/task", "cost_usd", "$", True),
        ("turns", "turns", "", True),
        ("wall ms", "wall_ms", "", True),
    ]

    rule = "=" * 104
    print("")
    print(rule)
    print(
        "A/B: %s (baseline) vs %s (%s)  --  %d tasks x %d seeds"
        % (control_model, treatment_model, args.treatment, len(tasks), args.seeds)
    )
    print(rule)

    comparisons = []
    for label, attribute, unit, lower_better in metrics:
        comparison = welch(label, per_seed(control, attribute), per_seed(treatment, attribute))
        comparisons.append(comparison)
        print(format_comparison(comparison, unit, lower_better))

    # Solve rate is the guard: a cheaper run that solves less is not an
    # improvement, so it is reported whether or not it moved.
    control_solved = sum(1 for r in control if r.solved) / max(1, len(control))
    treatment_solved = sum(1 for r in treatment if r.solved) / max(1, len(treatment))
    changed = "unchanged" if control_solved == treatment_solved else "CHANGED"
    print("")
    print(
        "  solve rate       %21.1f%%  ->  %21.1f%%   (%s)"
        % (control_solved * 100, treatment_solved * 100, changed)
    )

    fallbacks = sum(r.fallbacks_from for r in control) + sum(r.fallbacks_from for r in treatment)
    if fallbacks:
        used = sorted({r.model for r in control + treatment if r.model})
        print("  fallbacks        %d provider failures rerouted; models used: %s" % (fallbacks, ", ".join(used)))
    graph_queries = sum(r.graph_queries for r in treatment)
    if graph_queries:
        print("  graph queries    %d across the treatment run" % graph_queries)
    compacted = sum(r.masked_count for r in treatment)
    if compacted:
        print("  compacted        %d outputs" % compacted)

    significant = [c for c in comparisons if c.significant]
    print("")
    print(
        "  %d of %d metrics moved outside the noise floor."
        % (len(significant), len(comparisons))
    )

    if treatment_solved < control_solved:
        print("  WARNING: solve rate fell; a cheaper run that solves less is not an improvement.")
        return 1
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
        p.add_argument("--graph", action="store_true", help="enable graph_query")

    p = sub.add_parser("ab", help="run two configurations and test the difference")
    p.add_argument("--suite", default=None)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--seeds", type=int, default=3)
    p.add_argument(
        "--treatment",
        default="graph",
        choices=["graph", "history", "both"],
        help="what to enable on the treatment side",
    )
    p.add_argument("--control-model", default=None, help="model for the control side")
    p.add_argument("--fallback", default=None, help="comma-separated fallback models, both sides")
    p.add_argument("--treatment-model", default=None, help="model for the treatment side")

    p = sub.add_parser("compare")
    p.add_argument("--against", default="m0")
    p.add_argument("--suite", default=None)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--seeds", type=int, default=3)
    p.add_argument("--history", action="store_true", help="enable the history manager")
    p.add_argument("--graph", action="store_true", help="enable graph_query")

    args = parser.parse_args(argv)

    if args.command == "ab":
        return _ab(args)

    try:
        report = _run(args.suite, args.model, args.seeds, args.history, args.graph)
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
