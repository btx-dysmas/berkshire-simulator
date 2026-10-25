"""Fit a company's simulation parameters to its own filings.

Ten to fifteen annual observations are too few for plain least squares: one odd year can make a
company look three times as cyclical as it is. Both regressions here are Bayesian linear
regressions with weak priors, so the estimates lean on the data when it is clear and fall back
toward ordinary values when it is not. The priors are listed in PRIORS and shown in the app.
"""
from __future__ import annotations

import math

import numpy as np

from . import market, regimes
from .history import history

PRIORS = {
    # (mean, sd)
    "growth_intercept": (0.05, 0.10),
    "growth_gdp": (1.0, 0.75),       # revenue moves about one-for-one with real GDP
    "growth_cpi": (0.7, 0.5),        # nominal revenue absorbs most of inflation
    "margin_kappa": (0.30, 0.20),    # a margin gap closes by about a third a year
    "margin_gdp": (0.30, 0.30),      # margins widen in good years
    "margin_cpi": (-0.15, 0.25),     # and narrow when costs rise faster than prices
}
CORR_PRIOR, CORR_WEIGHT = 0.30, 8      # growth and margin surprises tend to arrive together
DF_PRIOR, DF_WEIGHT = 5.0, 6           # fat tails unless the history clearly says otherwise


def bayes_regression(X: np.ndarray, y: np.ndarray, prior_mean, prior_sd):
    """Posterior mean and sd of the coefficients under independent normal priors.

    The noise variance comes from the least-squares residuals, then the posterior is the usual
    conjugate update: precision adds, and the mean is the precision-weighted average.
    """
    prior_mean = np.asarray(prior_mean, float)
    prior_prec = 1 / np.asarray(prior_sd, float) ** 2
    beta_ols, *_ = np.linalg.lstsq(X, y, rcond=None)
    dof = max(len(y) - X.shape[1], 1)
    sigma2 = max(float(np.sum((y - X @ beta_ols) ** 2) / dof), 1e-6)
    P = X.T @ X / sigma2 + np.diag(prior_prec)
    cov = np.linalg.inv(P)
    mean = cov @ (X.T @ y / sigma2 + prior_prec * prior_mean)
    resid = y - X @ mean
    return mean, np.sqrt(np.diag(cov)), float(np.sqrt(np.sum(resid ** 2) / dof)), resid, beta_ols


def tail_df(resid: np.ndarray) -> tuple[float, float]:
    """Student-t degrees of freedom matched to the residuals' excess kurtosis, shrunk toward 5."""
    n = len(resid)
    if n < 6:
        return DF_PRIOR, float("nan")
    z = (resid - resid.mean()) / resid.std()
    kurt = float(np.mean(z ** 4) - 3)
    raw = 4 + 6 / kurt if kurt > 0.05 else 30.0
    df = (n * min(raw, 30) + DF_WEIGHT * DF_PRIOR) / (n + DF_WEIGHT)
    return float(np.clip(df, 3, 30)), kurt


def _clip(v, lo, hi):
    return float(min(max(v, lo), hi))


def fit(ticker: str) -> dict:
    h = history(ticker)
    # Twelve years: long enough to include a downturn, short enough that a company's hypergrowth
    # decade (Apple in 2011 and 2012) does not set its volatility today.
    rows = [r for r in h["rows"] if r["revenue"] and r["revenue"] > 0][-12:]
    if len(rows) < 5:
        raise ValueError(f"{h['ticker']} has fewer than five years of revenue in its XBRL filings")
    macro = regimes.macro()
    years = regimes.by_year()
    gdp_mean, cpi_mean = macro["gdp_mean"], macro["cpi_mean"]
    last_macro = max(years)

    # Pair each fiscal year with the macro year it mostly falls in. World Bank data lags a year, so
    # the latest fiscal year can be missing; it still counts for margins and reinvestment.
    def macro_for(r):
        y = r["fy"] if int(r["end"][5:7]) >= 7 else r["fy"] - 1
        m = years.get(min(y, last_macro))
        return m["gdp"] - gdp_mean, m["cpi"] - cpi_mean, m["regime"]

    rev = np.array([r["revenue"] for r in rows], float)
    op = np.array([r["operating_income"] if r["operating_income"] is not None else np.nan for r in rows], float)
    margin = op / rev
    g = np.diff(np.log(rev))
    gd, cd, labels = zip(*[macro_for(r) for r in rows[1:]])
    gd, cd = np.array(gd), np.array(cd)

    # Revenue growth: log growth on GDP and inflation deviations.
    X = np.column_stack([np.ones_like(gd), gd, cd])
    pm = [PRIORS["growth_intercept"][0], PRIORS["growth_gdp"][0], PRIORS["growth_cpi"][0]]
    ps = [PRIORS["growth_intercept"][1], PRIORS["growth_gdp"][1], PRIORS["growth_cpi"][1]]
    gb, gse, gsig, gres, gols = bayes_regression(X, g, pm, ps)
    # Recent growth says more about the next few years than growth a decade ago.
    recent = float(np.mean(g[-3:]))
    start_growth = 0.5 * gb[0] + 0.5 * recent

    # Operating margin: partial adjustment toward its long-run level, plus macro effects.
    okm = ~np.isnan(margin)
    if okm.sum() >= 5:
        m = margin[okm]
        long_run = 0.5 * float(np.mean(m)) + 0.5 * float(np.mean(m[-3:]))
        mprev = margin[:-1]
        dm = np.diff(margin)
        ok = ~(np.isnan(mprev) | np.isnan(dm))
        Xm = np.column_stack([-(mprev[ok] - long_run), gd[ok], cd[ok]])
        pmm = [PRIORS["margin_kappa"][0], PRIORS["margin_gdp"][0], PRIORS["margin_cpi"][0]]
        psm = [PRIORS["margin_kappa"][1], PRIORS["margin_gdp"][1], PRIORS["margin_cpi"][1]]
        mb, mse, msig, mres, mols = bayes_regression(Xm, dm[ok], pmm, psm)
        kappa = _clip(mb[0], 0.05, 0.95)
        current_margin = float(m[-1])
        hist_sd = float(np.std(m, ddof=1))
        # Residual correlation between the two equations, on the years both exist.
        gr = gres[ok]
        rho_raw = float(np.corrcoef(gr, mres)[0, 1]) if len(gr) > 3 and np.std(gr) > 0 and np.std(mres) > 0 else 0.0
    else:
        long_run = current_margin = 0.15
        kappa, mb, mse, msig, hist_sd, rho_raw, mols = 0.3, np.array([0.3, 0.3, -0.15]), np.array([0.2, 0.3, 0.25]), 0.02, 0.03, 0.0, None
    n = len(g)
    rho = (n * rho_raw + CORR_WEIGHT * CORR_PRIOR) / (n + CORR_WEIGHT)
    df, kurt = tail_df(gres)

    # Reinvestment: revenue added per dollar of net investment (capex less depreciation, plus
    # acquisitions). Working capital is left out: too few companies tag it consistently.
    net_inv, added = 0.0, 0.0
    for prev, r in zip(rows, rows[1:]):
        if r["capex"] is None or r["dna"] is None:
            continue
        net_inv += r["capex"] - r["dna"] + (r["acquisitions"] or 0)
        added += r["revenue"] - prev["revenue"]
    # Divestitures and refranchising (Coca-Cola's bottlers) shrink revenue without freeing the
    # capital in this measure, so the ratio is averaged on the log scale with a typical 2.0.
    raw_s2c = added / net_inv if net_inv > 0 and added > 0 else None
    s2c = math.exp((math.log(_clip(raw_s2c, 0.25, 12.0)) + math.log(2.0)) / 2) if raw_s2c else 2.0

    last = rows[-1]
    taxes = [r["tax"] / r["pretax"] for r in rows[-5:] if r["tax"] is not None and r["pretax"] and r["pretax"] > 0]
    tax = _clip(float(np.median(taxes)) if taxes else 0.21, 0.05, 0.30)
    cash = (last["cash"] or 0) + (last["securities"] or 0)
    debt = (last["debt"] or 0) + (last["debt_current"] or 0 if not last["debt"] else 0) + (last["short_debt"] or 0)
    shares = h["shares_outstanding"] or last["shares"]
    equity_book = last["equity"]
    invested = (equity_book or 0) + debt - cash
    nopat = (last["operating_income"] or 0) * (1 - tax)
    roic = nopat / invested if invested > 0 else None

    price = market.price(h["ticker"])
    rf = market.rate("%5ETNX", 0.043)
    b = market.beta(h["ticker"])
    beta = _clip(b["adjusted"], 0.5, 2.0) if b else 1.0
    erp = 0.0425  # near recent implied equity risk premium estimates for the S&P 500
    ke = rf + beta * erp
    kd = rf + 0.015
    mcap = (price or 0) * (shares or 0)
    wd = debt / (debt + mcap) if mcap > 0 else 0.2
    wacc = (1 - wd) * ke + wd * kd * (1 - tax)
    tg = min(0.03, rf)  # no business outgrows the economy forever
    ronic = max(wacc, wacc + 0.5 * ((roic or wacc) - wacc))

    sic = h.get("sic") or 0
    warnings = []
    if 6000 <= sic <= 6799:
        warnings.append("Financial company: revenue, margins and reinvestment do not describe a bank or insurer's economics, so these results are not meaningful. Berkshire has its own model.")
    if n < 8:
        warnings.append(f"Only {n} years of growth history; the priors carry more of the estimate.")
    if not price:
        warnings.append("No market price was available; enter one to see the decision metrics.")

    hist = []
    for i, r in enumerate(rows):
        hist.append({
            "fy": r["fy"], "end": r["end"], "revenue": r["revenue"], "operating_income": r["operating_income"],
            "margin": None if np.isnan(margin[i]) else float(margin[i]),
            "growth": float(g[i - 1]) if i else None,
            "regime": labels[i - 1] if i else None,
            "capex": r["capex"], "dna": r["dna"], "acquisitions": r["acquisitions"], "rnd": r["rnd"],
        })

    start = regimes.current()
    return {
        "company": {"ticker": h["ticker"], "name": h["name"], "cik": h["cik"], "sic": sic},
        "warnings": warnings,
        "history": hist,
        "latest_quarter": h["latest_quarter"],
        "params": {
            "revenue": float(rev[-1]),
            "shares": float(shares) if shares else None,
            "net_debt": float(debt - cash),
            "price": price,
            "tax": tax,
            "horizon": 10,
            "growth": {
                "mean": float(start_growth), "se": float(max(gse[0], 0.01)), "gdp_beta": float(gb[1]), "cpi_beta": float(gb[2]),
                "sd": float(max(gsig, 0.01)), "df": df, "halflife": 4.0,
            },
            "margin": {
                "current": float(current_margin), "long_run": float(long_run), "long_run_sd": float(max(0.01, 0.5 * hist_sd)),
                "kappa": kappa, "gdp_beta": float(mb[1]), "cpi_beta": float(mb[2]), "sd": float(max(msig, 0.003)),
            },
            "corr": float(rho),
            "reinvest": {"sales_to_capital": s2c, "sd_log": 0.3},
            "terminal": {"growth": tg, "ronic": float(ronic)},
            "wacc": {"rf": rf, "beta": beta, "erp": erp, "kd": kd, "weight_debt": wd, "mean": wacc, "sd": 0.0075},
            "competition": {
                "mild": {"prob": 0.30, "growth": -0.02, "years": 3},
                "significant": {"prob": 0.15, "growth": -0.04, "margin": -0.04, "years": 3},
                "disruptive": {"prob": 0.05, "growth": -0.10, "margin_mult": 0.6, "years": 4},
            },
            "start_regime": start["regime"],
        },
        "fit": {
            "n": n,
            "growth": {"coef": gb.tolist(), "se": gse.tolist(), "ols": gols.tolist(), "resid_sd": gsig, "recent": recent, "kurtosis": kurt},
            "margin": {"coef": [float(x) for x in mb], "se": [float(x) for x in mse], "ols": None if mols is None else mols.tolist(), "resid_sd": msig},
            "corr_raw": rho_raw,
            "roic": roic,
            "sales_to_capital_raw": raw_s2c,
            "beta": b,
            "priors": PRIORS,
            "macro_start": start,
        },
    }


def update_growth(mean: float, se: float, observed: float, noise: float) -> dict:
    """Normal-normal update of the long-run growth estimate from one new observation."""
    prior_prec, obs_prec = 1 / se ** 2, 1 / noise ** 2
    post_var = 1 / (prior_prec + obs_prec)
    post_mean = post_var * (prior_prec * mean + obs_prec * observed)
    return {
        "prior": {"mean": mean, "sd": se},
        "observation": {"value": observed, "sd": noise},
        "posterior": {"mean": post_mean, "sd": math.sqrt(post_var)},
        "weight_on_data": obs_prec / (prior_prec + obs_prec),
    }
