"""Several companies simulated through the same economic futures.

Each holding uses its own fitted parameters, but every company sees the same sequence of
regimes on a given path, so a recession hits the whole portfolio at once. That shared economy
is the only source of correlation between holdings; the rest of each company's uncertainty is
its own.
"""
from __future__ import annotations

import numpy as np

from .engine import merged, simulate
from .fit import fit


def run(holdings: list[dict], n: int = 6000, seed: int = 7, horizon: int = 10, samples: int = 3000) -> dict:
    fits, mults, rows = [], [], []
    for h in holdings:
        f = fit(h["ticker"])
        p = merged(f["params"], {"horizon": horizon, **(h.get("overrides") or {})})
        if not p.get("price"):
            raise ValueError(f"No price for {h['ticker']}")
        r = simulate(p, n, seed, key=f["company"]["ticker"])
        m = r["wealth"] / p["price"]
        mults.append(m)
        fits.append(f)
        rows.append({
            "ticker": f["company"]["ticker"], "name": f["company"]["name"], "price": p["price"],
            "median_value": float(np.median(r["value"])), "p_above": float((r["value"] > p["price"]).mean()),
            "median_return": float(np.median(m ** (1 / horizon) - 1)), "p_loss": float((m < 1).mean()),
            "warnings": f["warnings"],
        })
    M = np.column_stack(mults)
    rf = fits[0]["params"]["wacc"]["rf"]
    riskless = (1 + rf) ** horizon

    w = np.array([max(float(h.get("weight", 1)), 0) for h in holdings])
    w = w / w.sum() if w.sum() > 0 else np.full(len(holdings), 1 / len(holdings))

    def stats(weights):
        port = M @ weights
        ann = np.maximum(port, 1e-9) ** (1 / horizon) - 1
        ce = np.mean(np.maximum(port, 1e-6) ** -2) ** -0.5  # risk aversion of 3
        return {
            "median": float(np.median(ann)), "mean": float(ann.mean()), "p5": float(np.percentile(ann, 5)),
            "p_loss": float((port < 1).mean()), "p_beat_treasuries": float((port > riskless).mean()),
            "ce": float(ce ** (1 / horizon) - 1),
        }

    # Search long-only weights at random for the portfolio that does best on each objective.
    rng = np.random.default_rng(seed + 1)
    W = rng.dirichlet(np.ones(len(holdings)), samples)
    P = M @ W.T
    ann = np.maximum(P, 1e-9) ** (1 / horizon) - 1
    exp_ret = ann.mean(axis=0)
    p_loss = (P < 1).mean(axis=0)
    ce = np.mean(np.maximum(P, 1e-6) ** -2, axis=0) ** -0.5
    best = {
        "max_expected": W[np.argmax(exp_ret)],
        "min_loss": W[np.argmin(p_loss + 1e-6 * -exp_ret)],
        "max_ce": W[np.argmax(ce)],
    }

    corr = np.corrcoef(np.log(np.maximum(M, 1e-6)).T) if len(holdings) > 1 else np.ones((1, 1))
    return {
        "horizon": horizon, "risk_free": rf,
        "holdings": rows,
        "weights": w.tolist(),
        "portfolio": stats(w),
        "equal": stats(np.full(len(holdings), 1 / len(holdings))),
        "best": {k: {"weights": v.tolist(), **stats(v)} for k, v in best.items()},
        "correlation": corr.tolist(),
        "histogram": np.histogram(np.clip(np.maximum(M @ w, 1e-9) ** (1 / horizon) - 1, -0.3, 0.4), np.linspace(-0.3, 0.4, 57))[0].tolist(),
    }
