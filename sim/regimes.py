"""Economic regimes: five states fitted to U.S. data since 1961, and a Markov chain to move between them."""
from __future__ import annotations

import json
import os
from functools import lru_cache

import numpy as np

PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "macro.json")
LABELS = {
    "expansion": "Expansion",
    "neutral": "Neutral",
    "inflation": "High inflation",
    "recession": "Recession",
    "crisis": "Severe crisis",
}


@lru_cache(maxsize=1)
def macro() -> dict:
    with open(PATH) as f:
        m = json.load(f)
    names = m["regimes"]
    rows = m["years"]
    gdp = np.array([r["gdp"] for r in rows])
    cpi = np.array([r["cpi"] for r in rows])
    m["cpi_mean"] = float(cpi.mean())
    for name in names:
        sub = [r for r in rows if r["regime"] == name]
        g = np.array([r["gdp"] for r in sub])
        c = np.array([r["cpi"] for r in sub])
        # Spread within a regime: pooled with the overall spread when a regime has few years.
        w = len(sub) / (len(sub) + 5)
        m["stats"][name]["gdp_sd"] = float(w * (g.std(ddof=1) if len(g) > 1 else 0) + (1 - w) * gdp.std() * 0.5)
        m["stats"][name]["cpi_sd"] = float(w * (c.std(ddof=1) if len(c) > 1 else 0) + (1 - w) * cpi.std() * 0.5)
    m["stationary"] = stationary(np.array(m["transition"])).tolist()
    return m


def stationary(P: np.ndarray) -> np.ndarray:
    """Long-run share of years in each regime: the left eigenvector of P for eigenvalue 1."""
    vals, vecs = np.linalg.eig(P.T)
    v = np.real(vecs[:, np.argmin(np.abs(vals - 1))])
    return v / v.sum()


def by_year() -> dict[int, dict]:
    return {r["year"]: r for r in macro()["years"]}


def simulate(n: int, years: int, start: int, rng: np.random.Generator, P: np.ndarray | None = None) -> np.ndarray:
    """Regime index per path and year. Year 1 is drawn from the start regime's row."""
    if P is None:
        P = np.array(macro()["transition"])
    cum = np.cumsum(P, axis=1)
    cum[:, -1] = 1.0
    states = np.empty((n, years), dtype=np.int8)
    s = np.full(n, start)
    for t in range(years):
        u = rng.random(n)
        s = (u[:, None] > cum[s]).sum(axis=1)
        states[:, t] = s
    return states


def conditions(states: np.ndarray, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """GDP growth and inflation, as deviations from their 1961-2024 means, for each path-year."""
    m = macro()
    st = [m["stats"][name] for name in m["regimes"]]
    g_mu = np.array([s["gdp"] for s in st]) - m["gdp_mean"]
    g_sd = np.array([s["gdp_sd"] for s in st])
    c_mu = np.array([s["cpi"] for s in st]) - m["cpi_mean"]
    c_sd = np.array([s["cpi_sd"] for s in st])
    gdp = g_mu[states] + g_sd[states] * rng.standard_normal(states.shape)
    cpi = c_mu[states] + c_sd[states] * rng.standard_normal(states.shape)
    return gdp, cpi


def current() -> dict:
    """The most recent year with data, which sets the chain's starting regime."""
    last = macro()["years"][-1]
    return {"year": last["year"], "regime": last["regime"], "gdp": last["gdp"], "cpi": last["cpi"]}
