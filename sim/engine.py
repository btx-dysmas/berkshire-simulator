"""Monte Carlo valuation: simulate a company's next ten years many times and value each path.

One path, one year at a time:
    regime   -> next state of the Markov chain fitted to U.S. history
    economy  -> GDP and inflation drawn around that regime's averages
    shocks   -> a correlated pair of Student-t surprises, one for growth and one for margin
    growth   -> fading long-run rate + the company's fitted response to the economy + shock
              + any competitive hit
    margin   -> moves part of the way back to its long-run level each year (mean reversion)
    reinvest -> revenue added / sales-to-capital: growth has to be paid for
    FCFF     -> NOPAT - reinvestment, discounted at a rate that rises with interest rates
At the end of the horizon a value-driver terminal value takes over, and equity per share is
what is left after net debt.

The economy and the idiosyncratic shocks come from separate random streams, so two companies
run with the same seed live through the same economic history. The portfolio module relies on
that to make holdings fall together in a recession.
"""
from __future__ import annotations

import copy
import zlib

import numpy as np

from . import regimes

SEVERITY = {"none": 0, "mild": 1, "significant": 2, "disruptive": 3}


def merged(base: dict, overrides: dict | None) -> dict:
    """Deep-merge form values into parameters. A dict keyed by position updates a list, which is
    how the form edits one point of a triangular distribution ({"multiple": {"1": 16}})."""
    out = copy.deepcopy(base)
    for k, v in (overrides or {}).items():
        cur = out.get(k)
        if isinstance(v, dict) and isinstance(cur, dict):
            out[k] = merged(cur, v)
        elif isinstance(v, dict) and isinstance(cur, list):
            for i, x in v.items():
                cur[int(i)] = x
        else:
            out[k] = v
    return out


COMMON = 0.25  # share of a growth surprise that is market-wide rather than the company's own


def _t_pair(rng, common, n, years, rho, df):
    """Two correlated, unit-variance Student-t shocks per path-year.

    Correlated normals divided by one shared chi-square draw give a bivariate t: both shocks
    tend to be large in the same year, which is how bad years arrive. Part of the growth shock
    comes from `common`, drawn from the economy's random stream, so companies simulated with the
    same seed share it.
    """
    z1 = np.sqrt(COMMON) * common + np.sqrt(1 - COMMON) * rng.standard_normal((n, years))
    z2 = rho * z1 + np.sqrt(1 - rho ** 2) * rng.standard_normal((n, years))
    w = np.sqrt(rng.chisquare(df, (n, years)) / df)
    scale = np.sqrt((df - 2) / df) if df > 2 else 1.0
    return z1 / w * scale, z2 / w * scale


def simulate(p: dict, n: int = 10_000, seed: int = 7, fix: dict | None = None, key: str = "") -> dict:
    """Run n paths. `fix` pins a path-level driver to one value (used by the tornado chart):
    growth, margin, s2c, wacc, terminal_growth, competition ('off' or a probability multiplier),
    economy ('calm' or 'stressed')."""
    fix = fix or {}
    H = int(p["horizon"])
    macro = regimes.macro()
    names = macro["regimes"]
    rng_macro = np.random.default_rng(seed)
    rng = np.random.default_rng([seed, zlib.crc32(key.encode())])

    P = np.array(macro["transition"])
    if fix.get("economy") == "calm":
        P = P.copy()
        P[:, names.index("recession")] = 0
        P[:, names.index("crisis")] = 0
        P /= P.sum(axis=1, keepdims=True)
    elif fix.get("economy") == "stressed":
        # Half again as likely to fall into recession or crisis from any state.
        P = P.copy()
        for name in ("recession", "crisis"):
            P[:, names.index(name)] *= 1.5
        P /= P.sum(axis=1, keepdims=True)
    states = regimes.simulate(n, H, names.index(p.get("start_regime", "neutral")), rng_macro, P)
    gdp, cpi = regimes.conditions(states, rng_macro)
    bill_move = np.array([macro["stats"][s]["bill_change"] for s in names])[states]

    g, m, w = p["growth"], p["margin"], p["wacc"]
    tax = p["tax"]

    # Path-level draws: what we do not know about the business itself.
    lr_growth = rng.normal(g["mean"], g["se"], n) if "growth" not in fix else np.full(n, fix["growth"])
    lr_margin = rng.normal(m["long_run"], m["long_run_sd"], n) if "margin" not in fix else np.full(n, fix["margin"])
    s2c = (p["reinvest"]["sales_to_capital"] * np.exp(rng.normal(0, p["reinvest"]["sd_log"], n) - p["reinvest"]["sd_log"] ** 2 / 2)
           if "s2c" not in fix else np.full(n, fix["s2c"]))
    wacc = rng.normal(w["mean"], w["sd"], n) if "wacc" not in fix else np.full(n, fix["wacc"])
    tg = np.full(n, fix.get("terminal_growth", p["terminal"]["growth"]))
    ronic = np.full(n, max(p["terminal"]["ronic"], w["mean"]))

    common = rng_macro.standard_normal((n, H))
    eg, em = _t_pair(rng, common, n, H, float(np.clip(p["corr"], -0.95, 0.95)), float(g["df"]))

    # Competition: each kind of event has a probability over the horizon, spread evenly as a
    # yearly hazard, and happens at most once per path.
    comp = p["competition"]
    mult = fix.get("competition", 1.0)
    growth_hit = np.zeros((n, H))
    margin_target = lr_margin.copy()
    worst = np.zeros(n, dtype=np.int8)
    event_year = {}
    for kind in ("mild", "significant", "disruptive"):
        c = comp[kind]
        prob = 0.0 if mult == "off" else min(c["prob"] * float(mult), 0.99)
        hazard = 1 - (1 - prob) ** (1 / H)
        hit = rng.random((n, H)) < hazard
        happened = hit.any(axis=1)
        first = np.where(happened, hit.argmax(axis=1), H)
        event_year[kind] = first
        for t in range(H):
            active = happened & (t >= first) & (t < first + c["years"])
            growth_hit[active, t] += c["growth"]
        worst = np.where(happened, np.maximum(worst, SEVERITY[kind]), worst)
    margin_cut = {k: event_year[k] for k in ("significant", "disruptive")}

    revenue = np.empty((n, H))
    margin = np.empty((n, H))
    fcff = np.empty((n, H))
    nopat = np.empty((n, H))
    disc = np.empty((n, H))
    fade = 0.5 ** (1 / g["halflife"])

    rev_prev = np.full(n, p["revenue"])
    m_prev = np.full(n, m["current"])
    rf0 = w["rf"]
    rf = np.full(n, rf0)
    df_cum = np.ones(n)
    for t in range(H):
        sig = comp["significant"]
        hit_sig = margin_cut["significant"] == t
        margin_target = np.where(hit_sig, margin_target + sig["margin"], margin_target)
        hit_dis = margin_cut["disruptive"] == t
        margin_target = np.where(hit_dis, margin_target * comp["disruptive"]["margin_mult"], margin_target)
        ronic = np.where(hit_dis, wacc, ronic)

        trend = tg + (lr_growth - tg) * fade ** (t + 1)
        gt = trend + g["gdp_beta"] * gdp[:, t] + g["cpi_beta"] * cpi[:, t] + g["sd"] * eg[:, t] + growth_hit[:, t]
        gt = np.maximum(gt, -0.9)
        rev = rev_prev * np.exp(gt)

        mt = (m_prev + m["kappa"] * (margin_target - m_prev) + m["gdp_beta"] * gdp[:, t] + m["cpi_beta"] * cpi[:, t]
              + m["sd"] * em[:, t])
        mt = np.clip(mt, -0.5, 0.8)

        ebit = rev * mt
        np_t = np.where(ebit > 0, ebit * (1 - tax), ebit)
        added = rev - rev_prev
        # Shrinking businesses free up only part of their capital: plants are sold at a discount.
        reinvest = np.where(added > 0, added / s2c, 0.3 * added / s2c)
        cf = np_t - reinvest

        # Long rates rise with inflation (half the regime's average T-bill move) and drift back
        # toward today's level. In downturns yields fall but risk premiums widen; the two are
        # taken to cancel, so a recession never makes the business worth more.
        rf = rf + 0.3 * (rf0 - rf) + 0.5 * np.maximum(bill_move[:, t], 0)
        rate = wacc + (rf - rf0)
        df_cum = df_cum / (1 + np.maximum(rate, 0.02))

        revenue[:, t], margin[:, t], nopat[:, t], fcff[:, t], disc[:, t] = rev, mt, np_t, cf, df_cum
        rev_prev, m_prev = rev, mt

    # Terminal value on a normalized margin, so one cyclical final year does not set the value
    # of everything after it. Value-driver formula: NOPAT x (1 - g / RONIC) / (WACC - g).
    spread = np.maximum(wacc - tg, 0.01)
    nopat_next = revenue[:, -1] * (1 + tg) * np.maximum(margin_target, 0) * (1 - tax)
    reinvest_rate = np.clip(tg / np.maximum(ronic, 1e-6), 0, 1)
    tv = nopat_next * (1 - reinvest_rate) / spread

    ev = (fcff * disc).sum(axis=1) + tv * disc[:, -1]
    shares = p["shares"]
    equity = ev - p["net_debt"]
    value = np.maximum(equity, 0) / shares

    # Holding-period outcome: the owner receives free cash flow after interest each year,
    # reinvested at the risk-free rate, then sells at intrinsic value at the horizon.
    interest = max(p["net_debt"], 0) * w["kd"] * (1 - tax)
    growth_factor = (1 + rf0) ** (H - 1 - np.arange(H))
    received = ((fcff - interest) * growth_factor).sum(axis=1)
    end_equity = np.maximum(tv - p["net_debt"], 0)
    wealth = np.maximum(received + end_equity, 0) / shares

    return {
        "value": value,
        "wealth": wealth,
        "revenue": revenue,
        "margin": margin,
        "fcff": fcff,
        "states": states,
        "worst_competition": worst,
        "drivers": {
            "growth": lr_growth,
            "margin": lr_margin,
            "s2c": s2c,
            "wacc": wacc,
            "economy": gdp.mean(axis=1),
            "competition": worst.astype(float),
            "shocks": eg.mean(axis=1),
        },
        # How much of enterprise value sits beyond the forecast horizon.
        "tv_share": float(np.nanmedian(tv * disc[:, -1] / np.where(ev > 0, ev, np.nan))),
    }
