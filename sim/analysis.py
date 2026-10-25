"""Turn simulated paths into what an investor reads: the distribution, what drives it, the
scenarios behind it, and whether the price is worth paying."""
from __future__ import annotations

import numpy as np

from . import regimes
from .engine import SEVERITY, simulate

PCTS = [1, 5, 10, 25, 50, 75, 90, 95, 99]


def distribution(v: np.ndarray, price: float | None) -> dict:
    n = len(v)
    q = np.percentile(v, PCTS)
    se = v.std(ddof=1) / np.sqrt(n)
    out = {
        "n": n,
        "mean": float(v.mean()),
        "median": float(q[4]),
        "sd": float(v.std(ddof=1)),
        "percentiles": dict(zip(map(str, PCTS), q.tolist())),
        # Two different intervals: where outcomes fall, and how precisely 10,000 paths pin down
        # the mean. People mix these up; the second is tiny.
        "ranges": {
            "90": [float(np.percentile(v, 5)), float(np.percentile(v, 95))],
            "95": [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))],
            "99": [float(np.percentile(v, 0.5)), float(np.percentile(v, 99.5))],
        },
        "mean_ci95": [float(v.mean() - 1.96 * se), float(v.mean() + 1.96 * se)],
    }

    hi = float(np.percentile(v, 99.5))
    edges = np.linspace(0, hi if hi > 0 else 1, 61)
    counts, _ = np.histogram(np.clip(v, 0, hi), edges)
    out["histogram"] = {"edges": edges.tolist(), "counts": (counts / n).tolist()}
    xs = np.linspace(0, hi, 120)
    s = np.sort(v)
    out["exceed"] = {"x": xs.tolist(), "p": (1 - np.searchsorted(s, xs, side="right") / n).tolist()}

    if price:
        cuts = [0, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, np.inf]
        rows = []
        for a, b in zip(cuts, cuts[1:]):
            rows.append({"lo": a * price, "hi": None if np.isinf(b) else b * price, "lo_x": a, "hi_x": None if np.isinf(b) else b,
                         "p": float(((v >= a * price) & (v < b * price)).mean())})
        out["buckets"] = rows
    return out


def fan(arr: np.ndarray) -> dict:
    q = np.percentile(arr, [5, 25, 50, 75, 95], axis=0)
    return {k: q[i].tolist() for i, k in enumerate(["p5", "p25", "p50", "p75", "p95"])}


def rank_sensitivity(value: np.ndarray, drivers: dict) -> list[dict]:
    """Share of the spread in value explained by each driver.

    Standardized rank regression: rank-transform value and drivers, regress, and square the
    coefficients. Ranks handle the curvature in a DCF (value is convex in growth and explodes as
    WACC nears terminal growth) better than a linear fit would.
    """
    def ranks(x):
        r = np.empty(len(x))
        r[np.argsort(x, kind="stable")] = np.arange(len(x))
        return (r - r.mean()) / (r.std() or 1)

    names = list(drivers)
    X = np.column_stack([ranks(drivers[k]) for k in names])
    y = ranks(value)
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    r2 = 1 - np.sum((y - X @ coef) ** 2) / np.sum(y ** 2)
    sq = coef ** 2
    total = sq.sum() or 1
    return [{"driver": k, "coef": float(c), "share": float(s / total), "r2": float(r2)} for k, c, s in zip(names, coef, sq)]


def tornado(p: dict, n: int, seed: int, key: str) -> list[dict]:
    """Median value with one driver held at a low and a high setting, everything else random.
    Same seed throughout, so differences come from the driver alone."""
    g, m, w = p["growth"], p["margin"], p["wacc"]
    s2c = p["reinvest"]["sales_to_capital"]
    sd = p["reinvest"]["sd_log"]
    tests = [
        ("Long-run growth", {"growth": g["mean"] - 1.2816 * g["se"]}, {"growth": g["mean"] + 1.2816 * g["se"]}, "10th / 90th percentile"),
        ("Long-run margin", {"margin": m["long_run"] - 1.2816 * m["long_run_sd"]}, {"margin": m["long_run"] + 1.2816 * m["long_run_sd"]}, "10th / 90th percentile"),
        ("Sales to capital", {"s2c": s2c * np.exp(-1.2816 * sd)}, {"s2c": s2c * np.exp(1.2816 * sd)}, "10th / 90th percentile"),
        ("Discount rate", {"wacc": w["mean"] + 0.01}, {"wacc": w["mean"] - 0.01}, "+1 / -1 point"),
        ("Terminal growth", {"terminal_growth": p["terminal"]["growth"] - 0.005}, {"terminal_growth": p["terminal"]["growth"] + 0.005}, "-0.5 / +0.5 point"),
        ("Competition", {"competition": 2.0}, {"competition": "off"}, "double odds / none"),
        ("Economy", {"economy": "stressed"}, {"economy": "calm"}, "1.5x recession odds / none"),
    ]
    base = float(np.median(simulate(p, n, seed, key=key)["value"]))
    out = []
    for name, lo, hi, note in tests:
        a = float(np.median(simulate(p, n, seed, fix=lo, key=key)["value"]))
        b = float(np.median(simulate(p, n, seed, fix=hi, key=key)["value"]))
        out.append({"driver": name, "low": a, "high": b, "base": base, "setting": note})
    out.sort(key=lambda r: -abs(r["high"] - r["low"]))
    return out


def scenario_tree(value: np.ndarray, states: np.ndarray, worst: np.ndarray, price: float | None) -> dict:
    """Paths grouped by the worst economy in the first five years, then the worst competitive
    event over the horizon."""
    names = regimes.macro()["regimes"]
    order = ["expansion", "neutral", "inflation", "recession", "crisis"]
    rank = np.array([order.index(n) for n in names])
    first = states[:, :5]
    # "Worst" economy: crisis beats recession beats inflation; calm paths are grouped.
    sev = rank[first].max(axis=1)
    macro_group = np.select([sev >= 4, sev == 3, sev == 2], ["crisis", "recession", "inflation"], "calm")
    macro_labels = {"calm": "No downturn", "inflation": "High inflation", "recession": "Recession", "crisis": "Severe crisis"}
    comp_labels = {0: "No competitive shock", 1: "Mild competition", 2: "Significant competition", 3: "Disruptive competitor"}

    def node(mask):
        sub = value[mask]
        if not len(sub):
            return {"p": 0.0}
        d = {"p": float(mask.mean()), "median": float(np.median(sub)), "mean": float(sub.mean())}
        if price:
            d["p_above"] = float((sub > price).mean())
        return d

    tree = []
    for mg in ["calm", "inflation", "recession", "crisis"]:
        mmask = macro_group == mg
        kids = []
        for c in range(4):
            kids.append({"label": comp_labels[c], **node(mmask & (worst == c))})
        tree.append({"label": macro_labels[mg], **node(mmask), "children": kids})
    return {"root": node(np.ones(len(value), bool)), "branches": tree}


def kelly(multiple: np.ndarray, riskless: float) -> float:
    """Fraction of capital that maximizes expected log wealth over the horizon, between 0 and 1."""
    excess = multiple - riskless
    best, best_f = -np.inf, 0.0
    for f in np.linspace(0, 1, 101):
        growth = np.mean(np.log(np.maximum(riskless + f * excess, 1e-9)))
        if growth > best:
            best, best_f = growth, float(f)
    return best_f


def decision(value: np.ndarray, wealth: np.ndarray, price: float, horizon: int, rf: float,
             margin_of_safety: float = 0.25, max_loss: float = 0.20, risk_aversion: float = 3.0,
             position: float = 0.10) -> dict:
    multiple = wealth / price
    annual = np.where(multiple > 0, multiple, 1e-9) ** (1 / horizon) - 1
    riskless = (1 + rf) ** horizon
    # Certainty equivalent under constant relative risk aversion, for a position of `position`
    # in a portfolio otherwise held in Treasuries: the sure return the investor would accept in
    # place of the whole distribution. Judged at the portfolio level, a single stock going to
    # zero is a loss rather than ruin.
    port = (1 - position) * riskless + position * multiple
    g = risk_aversion
    if g == 1:
        ce_mult = float(np.exp(np.mean(np.log(port))))
    else:
        ce_mult = float(np.mean(port ** (1 - g)) ** (1 / (1 - g)))
    ce = ce_mult ** (1 / horizon) - 1
    worst5 = value <= np.percentile(value, 5)
    median = float(np.median(value))
    mos = 1 - price / median if median > 0 else -np.inf
    p_loss = float((multiple < 1).mean())

    checks = [
        {"test": f"Median value at least {margin_of_safety:.0%} above price", "pass": bool(mos >= margin_of_safety), "value": float(mos)},
        {"test": f"Chance of losing money over {horizon} years at most {max_loss:.0%}", "pass": bool(p_loss <= max_loss), "value": p_loss},
        {"test": f"A {position:.0%} position raises the certainty-equivalent return above Treasuries", "pass": bool(ce > rf), "value": float(ce)},
    ]
    passed = sum(c["pass"] for c in checks)
    if passed == 3:
        verdict = "Attractive"
        note = "The price leaves a margin of safety in most futures, and the downside is limited."
    elif passed == 2:
        verdict = "Borderline"
        note = "Some of the case is there, but one test fails. Worth watching at a lower price."
    else:
        verdict = "Pass"
        note = "At this price the simulated futures do not pay for the risk."
    return {
        "price": price,
        "expected_value": float(value.mean()),
        "median_value": median,
        "upside_expected": float(value.mean() / price - 1),
        "p_value_above_price": float((value > price).mean()),
        "p_value_below_70": float((value < 0.7 * price).mean()),
        "p5_value": float(np.percentile(value, 5)),
        "downside_mean_worst5": float(value[worst5].mean()),
        "margin_of_safety": float(mos),
        "return": {
            "mean": float(annual.mean()), "median": float(np.median(annual)),
            "p5": float(np.percentile(annual, 5)), "p95": float(np.percentile(annual, 95)),
            "p_loss": p_loss, "certainty_equivalent": float(ce), "risk_free": rf,
        },
        "kelly": kelly(multiple, riskless),
        "checks": checks,
        "verdict": verdict,
        "note": note,
        "settings": {"margin_of_safety": margin_of_safety, "max_loss": max_loss, "risk_aversion": risk_aversion, "position": position},
    }


def implied_growth(p: dict, price: float, seed: int, key: str, n: int = 2000) -> float | None:
    """Reverse DCF: the long-run growth rate at which the median simulated value equals the price."""
    def gap(g):
        return float(np.median(simulate(p, n, seed, fix={"growth": g}, key=key)["value"])) - price

    lo, hi = -0.10, 0.60
    if gap(lo) > 0 or gap(hi) < 0:
        return None
    for _ in range(14):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if gap(mid) < 0 else (lo, mid)
    return (lo + hi) / 2


def regime_mix(states: np.ndarray) -> list[dict]:
    names = regimes.macro()["regimes"]
    return [{"regime": n, "label": regimes.LABELS[n], "share": float((states == i).mean()),
             "ever": float((states == i).any(axis=1).mean())} for i, n in enumerate(names)]


def run(p: dict, n: int = 10_000, seed: int = 7, key: str = "", decide: dict | None = None, with_tornado: bool = True) -> dict:
    r = simulate(p, n, seed, key=key)
    v = r["value"]
    price = p.get("price")
    out = {
        "distribution": distribution(v, price),
        "fan": {"revenue": fan(r["revenue"]), "margin": fan(r["margin"]), "fcff": fan(r["fcff"])},
        "sensitivity": rank_sensitivity(v, r["drivers"]),
        "tree": scenario_tree(v, r["states"], r["worst_competition"], price),
        "regimes": regime_mix(r["states"]),
        "competition": {k: float((r["worst_competition"] == s).mean()) for k, s in SEVERITY.items()},
        "tv_share": r["tv_share"],
    }
    if with_tornado:
        out["tornado"] = tornado(p, min(n, 4000), seed, key)
    if price:
        out["implied_growth"] = implied_growth(p, price, seed, key)
        out["decision"] = decision(v, r["wealth"], price, int(p["horizon"]), p["wacc"]["rf"], **(decide or {}))
    return out
