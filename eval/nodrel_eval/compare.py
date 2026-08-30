"""A/B comparison with a significance verdict (SPEC §9).

The project has already published one figure that turned out to be inside its
own noise floor (DEVIATION-002). This module exists so that cannot happen
silently again: every comparison reports the spread alongside the mean and
labels a difference it cannot distinguish from variance.

The test is Welch's t-test on per-seed means. Welch rather than Student because
the two configurations have no reason to share a variance -- the graph
configuration is measurably more consistent than the baseline, which is itself
part of the result.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass


@dataclass(frozen=True)
class Comparison:
    metric: str
    baseline_mean: float
    baseline_sd: float
    treatment_mean: float
    treatment_sd: float
    n: int
    #: Welch's t statistic; 0 when it cannot be computed.
    t: float
    #: Welch-Satterthwaite degrees of freedom.
    df: float
    significant: bool

    @property
    def delta(self) -> float:
        return self.treatment_mean - self.baseline_mean

    @property
    def relative(self) -> float:
        return (self.delta / self.baseline_mean) if self.baseline_mean else 0.0

    @property
    def ratio(self) -> float:
        return (self.treatment_mean / self.baseline_mean) if self.baseline_mean else 0.0


# Two-tailed critical values at alpha = 0.05, indexed by degrees of freedom.
# A table rather than a dependency: scipy is a large install for one lookup,
# and the harness must stay runnable anywhere the agent runs.
_T_CRITICAL_95 = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
    16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
    25: 2.060, 30: 2.042, 40: 2.021, 60: 2.000, 120: 1.980,
}


def _t_critical(df: float) -> float:
    """Critical value at alpha = 0.05, rounding df down to be conservative."""
    if df < 1:
        return float("inf")
    keys = sorted(_T_CRITICAL_95)
    chosen = keys[0]
    for key in keys:
        if key <= df:
            chosen = key
    return _T_CRITICAL_95[chosen] if df < 120 else 1.960


def welch(metric: str, baseline: list[float], treatment: list[float]) -> Comparison:
    """Compares two samples, refusing to claim an effect it cannot support."""
    n_a, n_b = len(baseline), len(treatment)
    mean_a = statistics.fmean(baseline) if baseline else 0.0
    mean_b = statistics.fmean(treatment) if treatment else 0.0
    sd_a = statistics.stdev(baseline) if n_a > 1 else 0.0
    sd_b = statistics.stdev(treatment) if n_b > 1 else 0.0

    # With fewer than two observations per side there is no variance estimate,
    # so no difference can be called significant however large it looks.
    if n_a < 2 or n_b < 2:
        return Comparison(metric, mean_a, sd_a, mean_b, sd_b, min(n_a, n_b), 0.0, 0.0, False)

    var_a = sd_a**2 / n_a
    var_b = sd_b**2 / n_b
    denominator = math.sqrt(var_a + var_b)

    if denominator == 0:
        # Both samples are constant. A difference between two exactly repeatable
        # measurements is real; an absence of one is not an effect.
        significant = mean_a != mean_b
        return Comparison(
            metric, mean_a, sd_a, mean_b, sd_b, min(n_a, n_b),
            float("inf") if significant else 0.0,
            float("inf"), significant,
        )

    t = (mean_b - mean_a) / denominator
    df_numerator = (var_a + var_b) ** 2
    df_denominator = (var_a**2 / (n_a - 1)) + (var_b**2 / (n_b - 1))
    df = df_numerator / df_denominator if df_denominator else 0.0

    return Comparison(
        metric, mean_a, sd_a, mean_b, sd_b, min(n_a, n_b),
        t, df, abs(t) > _t_critical(df),
    )


def per_seed(results: list, attribute: str) -> list[float]:
    """Collapses per-task results into one mean per seed.

    Seeds are the unit of repetition: tasks within a seed are not independent
    samples of the same quantity, so averaging them first is what makes the
    variance estimate meaningful.
    """
    by_seed: dict[int, list[float]] = {}
    for result in results:
        by_seed.setdefault(result.seed, []).append(float(getattr(result, attribute)))
    return [statistics.fmean(values) for _, values in sorted(by_seed.items()) if values]


def format_comparison(comparison: Comparison, unit: str = "", lower_is_better: bool = True) -> str:
    """One line: means with spread, relative change, and the verdict."""
    def render(value: float, sd: float) -> str:
        if unit == "$":
            return f"${value:.5f} ± ${sd:.5f}"
        if unit == "%":
            return f"{value * 100:.1f}% ± {sd * 100:.1f}%"
        return f"{value:,.0f} ± {sd:,.0f}"

    direction = ""
    if comparison.significant:
        improved = (comparison.delta < 0) if lower_is_better else (comparison.delta > 0)
        direction = "better" if improved else "WORSE"
        verdict = f"significant, {direction} (t={comparison.t:.2f}, df={comparison.df:.1f})"
    else:
        verdict = "not significant — within noise"

    return (
        f"  {comparison.metric:<16} "
        f"{render(comparison.baseline_mean, comparison.baseline_sd):>22}  ->  "
        f"{render(comparison.treatment_mean, comparison.treatment_sd):>22}  "
        f"{comparison.relative * 100:+6.1f}%   {verdict}"
    )
