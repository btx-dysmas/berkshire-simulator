"""Berkshire Hathaway as a machine for compounding per-share value.

The model keeps the balance sheet and the cash moving through it, path by path, year by year:

  insurance  premiums grow with the economy; the combined ratio decides whether underwriting
             makes or costs money; float rises and falls with premiums. Float arrives as cash
             but sits on the balance sheet as a liability, and book value never counts it.
  investing  cash earns the T-bill rate; the stock portfolio moves with the market regime and
             pays dividends; investees keep most of their earnings, which GAAP never shows.
  operating  BNSF, BHE and the manufacturing, service and retailing group earn money, keep the
             share they need to grow, and send the rest to Omaha.
  allocation each year the cash above a reserve goes, in order, to an acquisition if one comes
             along, to buybacks if the stock is below intrinsic value, and otherwise stays in
             T-bills.

Three earnings figures fall out of the same path: GAAP net income (which includes unrealized
gains on stocks since 2018), operating earnings (which Berkshire reports), and look-through
earnings (operating earnings plus Berkshire's share of investees' retained earnings, after the
tax it would owe if they were paid out).
"""
from __future__ import annotations

import copy
import json
import os
from functools import lru_cache

import numpy as np

from . import market, regimes
from .engine import merged

TAX = 0.21
DIVIDEND_TAX = 0.13  # dividends received by a corporation are mostly exempt
SEED_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "berkshire.json")


@lru_cache(maxsize=1)
def seed_data() -> dict:
    with open(SEED_PATH) as f:
        return json.load(f)


def defaults() -> dict:
    s = seed_data()
    e = s["earnings_2025"]
    other = e["other"] - 3.6 + 0.642
    price = market.price("BRK-A")
    bill = market.rate("%5EIRX", 0.04)
    return {
        "horizon": 10,
        "price_per_share": price,  # Class A, dollars
        "start_regime": regimes.current()["regime"],
        "balance": {
            "shares": s["shares_a_equivalent"] / 1e6,  # millions of A-equivalent shares
            "book_value": s["shareholders_equity"],
            "cash": s["cash_and_tbills"],
            "equities": s["equities_fair_value"],
            "equities_cost": s["equities_cost"],
            "fixed": s["fixed_maturities"],
            "equity_method": s["equity_method"],
            "debt": s["parent_debt"],
        },
        "insurance": {
            "float": s["float"],
            "premiums": s["premiums_earned_annual"],
            "premium_growth": 0.03,
            "premium_cpi_beta": 0.8,
            "premium_sd": 0.03,
            "combined_ratio": 0.96,
            "combined_ratio_sd": 0.025,
            "cat_prob": 0.15,
            "cat_severity": [0.04, 0.12],
        },
        "investments": {
            "bill_yield": bill,
            "bill_long_run": 0.03,
            "dividend_yield": 0.016,
            "retained_yield": 0.034,
            "portfolio_beta": 0.9,
        },
        "subsidiaries": {
            "bnsf": {"label": "BNSF", "earnings": e["bnsf"], "retention": 0.25, "roic": 0.10, "gdp_beta": 1.5, "cpi_beta": 0.7, "sd": 0.06, "multiple": 16},
            "bhe": {"label": "Berkshire Hathaway Energy", "earnings": e["bhe"], "retention": 1.0, "roic": 0.06, "gdp_beta": 0.2, "cpi_beta": 0.8, "sd": 0.05, "multiple": 15,
                    "event_prob": 0.08, "event_cost": 4.0},
            "msr": {"label": "Manufacturing, service and retailing", "earnings": e["msr"], "retention": 0.35, "roic": 0.12, "gdp_beta": 2.0, "cpi_beta": 0.6, "sd": 0.07, "multiple": 15},
            "other": {"label": "Other, net of corporate costs", "earnings": round(other, 3), "retention": 0.0, "roic": 0.0, "gdp_beta": 0.0, "cpi_beta": 0.0, "sd": 0.15, "multiple": 10},
        },
        "acquisitions": {
            "prob": 0.30,
            "size_median": 25.0,
            "size_sd_log": 0.6,
            "multiple": [11, 15, 22],    # price paid, times after-tax earnings
            "value_multiple": 17,        # what acquired earnings are worth once owned
            "growth": 0.04,
            "funding": "cash",          # cash | stock | cash_then_stock
        },
        "policy": {
            "min_cash": 30.0,
            "buyback": "below_value",   # below_value | always | never
            "buyback_threshold": 0.90,  # buy when price / intrinsic value is below this
            "buyback_max_share": 0.04,  # at most this fraction of market value a year
            "buyback_cash_share": 0.5,  # of cash above the reserve
            "dividend_payout": 0.0,
            "equity_allocation": 0.0,   # of cash above the reserve, into stocks each year
        },
        "valuation": {
            # Float is a debt-like obligation, so its cash flows are discounted near the
            # risk-free rate rather than at an equity cost of capital.
            "float_rate": 0.045,
            "float_growth_years": 10,
            "float_runoff_years": 10,
            "price_to_value_long_run": 1.0,
            "price_to_value_sd": 0.10,
        },
    }


def float_liability(F, cost, growth, rate, grow_years=10, runoff_years=10):
    """Present value of what the float will cost Berkshire, per dollar of float on the books.

    GAAP carries float at face value. Economically it is money that has to be paid back only as
    claims are settled, and when underwriting is profitable Berkshire is paid to hold it. The
    float grows for `grow_years`, bringing in new cash, then runs off evenly; each year costs
    (or earns) the underwriting result. Works on arrays.
    """
    F = np.asarray(F, float)
    cost = np.asarray(cost, float)
    growth = np.asarray(growth, float)
    pv = np.zeros_like(F)
    bal = F.copy()
    d = 1.0
    for _ in range(grow_years):
        d /= 1 + rate
        new = bal * growth
        pv += d * (cost * bal - new)
        bal = bal + new
    step = bal / runoff_years
    for _ in range(runoff_years):
        d /= 1 + rate
        pv += d * (cost * bal + step)
        bal = bal - step
    return pv


def simulate(p: dict, n: int = 10_000, seed: int = 11) -> dict:
    H = int(p["horizon"])
    macro = regimes.macro()
    names = macro["regimes"]
    rng_macro = np.random.default_rng(seed)
    rng = np.random.default_rng([seed, 2])
    states = regimes.simulate(n, H, names.index(p.get("start_regime", "neutral")), rng_macro)
    gdp, cpi = regimes.conditions(states, rng_macro)
    st = macro["stats"]
    mkt_mu = np.array([st[s]["spx_mean"] for s in names])[states]
    mkt_sd = np.array([st[s]["spx_sd"] for s in names])[states]
    bill_move = np.array([st[s]["bill_change"] for s in names])[states]
    # Fear moves the stock's price-to-value ratio as well: buyback windows open in downturns.
    sentiment = np.select([states == names.index("crisis"), states == names.index("recession")], [-0.15, -0.07], 0.0)

    b, ins, inv, pol, val, acq = p["balance"], p["insurance"], p["investments"], p["policy"], p["valuation"], p["acquisitions"]
    subs = p["subsidiaries"]

    shares = np.full(n, b["shares"])
    cash = np.full(n, b["cash"])
    eq = np.full(n, b["equities"])
    eq_cost = np.full(n, b["equities_cost"])
    book = np.full(n, b["book_value"])
    F = np.full(n, ins["float"])
    prem = np.full(n, ins["premiums"])
    float_ratio = ins["float"] / ins["premiums"]
    ratio = np.full(n, float_ratio)
    y = np.full(n, inv["bill_yield"])
    sub_earn = {k: np.full(n, s["earnings"]) for k, s in subs.items()}
    acq_earn = np.zeros(n)

    def intrinsic(cash, eq, eq_cost, F, prem, sub_earn, acq_earn, y):
        deferred = np.maximum(eq - eq_cost, 0) * TAX
        cost = (ins["combined_ratio"] - 1) * prem / F
        liab = float_liability(F, cost, ins["premium_growth"], val["float_rate"], val["float_growth_years"], val["float_runoff_years"])
        businesses = sum(sub_earn[k] * subs[k]["multiple"] for k in subs) + acq_earn * acq["value_multiple"]
        total = cash + eq - deferred + b["fixed"] + b["equity_method"] + businesses - b["debt"] - liab
        return total, liab

    iv0, liab0 = intrinsic(cash, eq, eq_cost, F, prem, sub_earn, acq_earn, y)
    price0 = p.get("price_per_share") or float(iv0[0] / b["shares"] * 1e3 * 0.95)
    p2v = np.full(n, np.log(price0 / (iv0[0] / b["shares"] * 1e3)))  # iv in $B, shares in millions -> $ per share
    lr = np.log(val["price_to_value_long_run"])

    keys = ["iv_ps", "bv_ps", "price", "op", "op_ps", "gaap", "gaap_ps", "look", "look_ps", "float", "uw", "interest",
            "cost_of_float", "shares", "cash", "buyback", "acq_cash", "acq_stock", "dividends", "eq_buy", "liab"]
    out = {k: np.zeros((n, H)) for k in keys}
    deals = np.zeros(n)
    deals_accretive = np.zeros(n)

    for t in range(H):
        # Insurance
        g_prem = ins["premium_growth"] + ins["premium_cpi_beta"] * cpi[:, t] + ins["premium_sd"] * rng.standard_normal(n)
        prem = prem * (1 + g_prem)
        ratio = ratio + 0.3 * (float_ratio - ratio) + 0.03 * rng.standard_normal(n)
        F_new = prem * ratio
        cr = ins["combined_ratio"] + ins["combined_ratio_sd"] * rng.standard_normal(n)
        cat = rng.random(n) < ins["cat_prob"]
        cr = cr + cat * rng.uniform(*ins["cat_severity"], n)
        uw = prem * (1 - cr) * (1 - TAX)
        d_float = F_new - F
        F = F_new

        # Investments
        y = np.maximum(y + 0.35 * (inv["bill_long_run"] - y) + bill_move[:, t] + 0.004 * rng.standard_normal(n), 0.0)
        interest = cash * y * (1 - TAX)
        mret = mkt_mu[:, t] + mkt_sd[:, t] * rng.standard_normal(n)
        price_chg = eq * (inv["portfolio_beta"] * (mret - inv["dividend_yield"]) + (1 - inv["portfolio_beta"]) * 0.05)
        divs = eq * inv["dividend_yield"] * (1 - DIVIDEND_TAX)
        retained = eq * inv["retained_yield"] * (1 - TAX)
        eq = np.maximum(eq + price_chg, 0)

        # Operating businesses: growth comes from what each keeps and earns on it, plus the economy.
        to_parent = np.zeros(n)
        op_subs = np.zeros(n)
        for k, s in subs.items():
            g = s["retention"] * s["roic"] + s["gdp_beta"] * gdp[:, t] + s["cpi_beta"] * cpi[:, t] + s["sd"] * rng.standard_normal(n)
            e = sub_earn[k] * (1 + g) if s["earnings"] > 0 else np.full(n, s["earnings"]) * (1 + s["sd"] * rng.standard_normal(n))
            sub_earn[k] = e
            hit = 0.0
            if s.get("event_prob"):
                # Utility liability events (wildfire claims at PacifiCorp): rare, expensive, one-off.
                hit = (rng.random(n) < s["event_prob"]) * rng.lognormal(np.log(s["event_cost"]), 0.5, n)
            op_subs += e - hit
            to_parent += e * (1 - s["retention"]) - hit
        acq_earn = acq_earn * (1 + acq["growth"] + gdp[:, t] + 0.05 * rng.standard_normal(n))
        op_subs += acq_earn
        to_parent += acq_earn * 0.7

        operating = uw + interest + divs + op_subs
        gaap = operating + price_chg * (1 - TAX)
        look = operating + retained

        # Cash arrives from underwriting, interest, dividends, what the subsidiaries send up, and
        # new float. New float is borrowed money, not earnings: it raises cash, not book value.
        cash = cash + uw + interest + divs + to_parent + d_float

        iv, liab = intrinsic(cash, eq, eq_cost, F, prem, sub_earn, acq_earn, y)
        iv_ps = iv / shares * 1e3
        p2v = p2v + 0.3 * (lr - p2v) + val["price_to_value_sd"] * rng.standard_normal(n) + sentiment[:, t]
        price = iv_ps * np.exp(p2v)
        mcap = price * shares / 1e3

        # Acquisitions: one candidate at most per year, priced as a multiple of its earnings.
        spare = np.maximum(cash - pol["min_cash"], 0)
        offer = rng.random(n) < acq["prob"]
        size = rng.lognormal(np.log(acq["size_median"]), acq["size_sd_log"], n)
        lo, mode, hi = acq["multiple"]
        mult = rng.triangular(lo, mode, hi, n)
        if acq["funding"] == "cash":
            by_cash, by_stock = offer & (size <= spare), np.zeros(n, bool)
        elif acq["funding"] == "stock":
            by_cash, by_stock = np.zeros(n, bool), offer
        else:
            by_cash = offer & (size <= spare)
            by_stock = offer & ~by_cash
        earn_bought = np.where(by_cash | by_stock, size / mult, 0)
        # Accretive to value per share when what the deal adds is worth more per share than the
        # shares (or cash) given up.
        added_value = earn_bought * acq["value_multiple"]
        new_shares = np.where(by_stock, size / price * 1e3, 0)
        iv_after = (iv + added_value - np.where(by_cash, size, 0)) / (shares + new_shares) * 1e3
        did = by_cash | by_stock
        deals += did
        deals_accretive += did & (iv_after > iv_ps)
        acq_earn = acq_earn + earn_bought
        cash = cash - np.where(by_cash, size, 0)
        shares = shares + new_shares
        stock_issued = np.where(by_stock, size, 0)

        # Buybacks, dividends and new stock purchases from what remains above the reserve.
        spare = np.maximum(cash - pol["min_cash"], 0)
        cap = pol["buyback_max_share"] * mcap
        if pol["buyback"] == "below_value":
            want = np.where(np.exp(p2v) < pol["buyback_threshold"], np.minimum(spare * pol["buyback_cash_share"], cap), 0)
        elif pol["buyback"] == "always":
            want = np.minimum(spare * pol["buyback_cash_share"], cap)
        else:
            want = np.zeros(n)
        cash = cash - want
        shares = shares - want / price * 1e3
        dividends = np.minimum(np.maximum(operating, 0) * pol["dividend_payout"], np.maximum(cash - pol["min_cash"], 0))
        cash = cash - dividends
        eq_buy = np.maximum(cash - pol["min_cash"], 0) * pol["equity_allocation"]
        cash, eq, eq_cost = cash - eq_buy, eq + eq_buy, eq_cost + eq_buy

        book = book + gaap - want - dividends + stock_issued
        iv, liab = intrinsic(cash, eq, eq_cost, F, prem, sub_earn, acq_earn, y)
        iv_ps = iv / shares * 1e3

        row = {
            "iv_ps": iv_ps, "bv_ps": book / shares * 1e3, "price": iv_ps * np.exp(p2v),
            "op": operating, "op_ps": operating / shares * 1e3, "gaap": gaap, "gaap_ps": gaap / shares * 1e3,
            "look": look, "look_ps": look / shares * 1e3, "float": F, "uw": uw, "interest": interest,
            "cost_of_float": -uw / (1 - TAX) / F, "shares": shares, "cash": cash, "buyback": want,
            "acq_cash": np.where(by_cash, size, 0), "acq_stock": stock_issued, "dividends": dividends, "eq_buy": eq_buy, "liab": liab,
        }
        for k in keys:
            out[k][:, t] = row[k]

    out["deals"] = deals
    out["deals_accretive"] = deals_accretive
    out["states"] = states
    out["start"] = {
        "iv_ps": float(iv0[0] / b["shares"] * 1e3), "bv_ps": b["book_value"] / b["shares"] * 1e3, "price": price0,
        "float": ins["float"], "liab": float(liab0[0]), "iv": float(iv0[0]),
    }
    return out


def _fan(a):
    q = np.percentile(a, [5, 25, 50, 75, 95], axis=0)
    return {k: q[i].tolist() for i, k in enumerate(["p5", "p25", "p50", "p75", "p95"])}


def _cagr(end, start, years):
    return np.where(end > 0, (np.maximum(end, 1e-9) / start) ** (1 / years) - 1, -1.0)


def summarize(p: dict, r: dict) -> dict:
    H = int(p["horizon"])
    s = r["start"]
    iv_cagr = _cagr(r["iv_ps"][:, -1], s["iv_ps"], H)
    bv_cagr = _cagr(r["bv_ps"][:, -1], s["bv_ps"], H)
    op_total_cagr = _cagr(r["op"][:, -1], np.median(r["op"][:, 0]), H - 1)
    op_ps_cagr = _cagr(r["op_ps"][:, -1], np.median(r["op_ps"][:, 0]), H - 1)
    holder = _cagr(r["price"][:, -1], s["price"], H)

    def yoy_sd(a):
        ch = np.diff(a, axis=1) / np.maximum(np.abs(a[:, :-1]), 1e-9)
        return float(np.median(np.std(ch, axis=1)))

    q = lambda a: {k: float(np.percentile(a, v)) for k, v in (("p5", 5), ("p25", 25), ("p50", 50), ("p75", 75), ("p95", 95))} | {"mean": float(np.mean(a))}
    deals = r["deals"].sum()
    return {
        "start": s,
        "years": list(range(1, H + 1)),
        "fans": {k: _fan(r[k]) for k in ("iv_ps", "bv_ps", "price", "op_ps", "op", "gaap", "look", "float", "cash", "shares", "cost_of_float")},
        "growth": {
            "iv_ps": q(iv_cagr), "bv_ps": q(bv_cagr), "holder": q(holder),
            "op_total": q(op_total_cagr), "op_ps": q(op_ps_cagr),
            "p_iv_beats_price": float((r["iv_ps"][:, -1] > s["price"]).mean()),
            "p_holder_loss": float((r["price"][:, -1] < s["price"]).mean()),
        },
        "earnings": {
            "median": {k: np.median(r[k], axis=0).tolist() for k in ("gaap", "op", "look")},
            "band": {k: _fan(r[k]) for k in ("gaap", "op", "look")},
            "volatility": {k: yoy_sd(r[k]) for k in ("gaap", "op", "look")},
            "sample": {k: r[k][0].tolist() for k in ("gaap", "op", "look")},
        },
        "allocation": {k: float(r[k].sum(axis=1).mean()) for k in ("buyback", "acq_cash", "acq_stock", "dividends", "eq_buy")}
                      | {"ending_cash": float(np.median(r["cash"][:, -1])), "share_change": float(np.median(r["shares"][:, -1] / p["balance"]["shares"] - 1))},
        "acquisitions": {
            "per_path": float(r["deals"].mean()),
            "accretive_share": float(r["deals_accretive"].sum() / deals) if deals else None,
        },
        "float": {
            "start": s["float"], "start_liability": s["liab"],
            "end": _fan(r["float"])["p50"][-1], "end_liability": float(np.median(r["liab"][:, -1])),
            "cost": q(r["cost_of_float"].mean(axis=1)),
            "p_costless": float((r["cost_of_float"].mean(axis=1) <= 0).mean()),
        },
    }


def run(overrides: dict | None = None, n: int = 10_000, seed: int = 11) -> dict:
    base = defaults()
    p = merged(base, overrides)
    r = simulate(p, n, seed)
    return {"params": p, "summary": summarize(p, r)}


POLICIES = {
    "baseline": ("Your settings", {}),
    "no_buybacks": ("No buybacks", {"policy": {"buyback": "never"}}),
    "buy_always": ("Buy back at any price", {"policy": {"buyback": "always"}}),
    "stock_deals": ("Pay for acquisitions in stock", {"acquisitions": {"funding": "stock"}}),
    "no_deals": ("No acquisitions", {"acquisitions": {"prob": 0.0}}),
    "dividend": ("Pay out half of operating earnings", {"policy": {"dividend_payout": 0.5}}),
}


def compare(overrides: dict | None = None, n: int = 6000, seed: int = 11) -> list[dict]:
    """Each policy on the same simulated futures, so the differences come from the policy alone."""
    base = merged(defaults(), overrides)
    H = int(base["horizon"])
    ref = None
    rows = []
    for key, (label, change) in POLICIES.items():
        p = merged(base, change)
        r = simulate(p, n, seed)
        # Shareholder outcome: intrinsic value per share at the end plus dividends received.
        divs_ps = (r["dividends"] / r["shares"] * 1e3).sum(axis=1)
        end = r["iv_ps"][:, -1] + divs_ps
        cagr = _cagr(end, r["start"]["iv_ps"], H)
        if ref is None:
            ref = cagr
        rows.append({
            "key": key, "label": label,
            "median": float(np.median(cagr)), "p10": float(np.percentile(cagr, 10)), "p90": float(np.percentile(cagr, 90)),
            "op_total": float(np.median(_cagr(r["op"][:, -1], np.median(r["op"][:, 0]), H - 1))),
            "op_ps": float(np.median(_cagr(r["op_ps"][:, -1], np.median(r["op_ps"][:, 0]), H - 1))),
            "beats_baseline": float((cagr > ref + 1e-12).mean()) if key != "baseline" else None,
        })
    return rows


def acquisition_lab(a: dict) -> dict:
    """One deal, worked through by hand: total earnings against value per share.

    Inputs (USD billions unless noted): earnings of the target, price paid, how it is paid for,
    Berkshire's operating earnings, intrinsic value, share count (millions) and the share price
    as a fraction of intrinsic value. The multiple says what the target's earnings are worth.
    """
    E, price, funding = a["target_earnings"], a["price"], a["funding"]
    op, iv, shares, p2v, multiple, yld = a["operating_earnings"], a["intrinsic_value"], a["shares"], a["price_to_value"], a["multiple"], a["bill_yield"]
    iv_ps = iv / shares
    px = iv_ps * p2v
    if funding == "stock":
        new_shares = price / px
        lost_interest = 0.0
        iv_after = iv + E * multiple
    else:
        new_shares = 0.0
        lost_interest = price * yld * (1 - TAX)
        iv_after = iv + E * multiple - price
    op_after = op + E - lost_interest
    sh_after = shares + new_shares
    eps, eps_after = op / shares, op_after / sh_after
    v, v_after = iv_ps, iv_after / sh_after
    # For a stock deal, value per share rises only if each dollar of Berkshire value handed over
    # buys at least a dollar of value: (E x multiple) / price >= intrinsic value / market price.
    breakeven = None if funding != "stock" else px / iv_ps * price / multiple
    return {
        "before": {"earnings": op, "shares": shares, "eps": eps, "iv_ps": v},
        "after": {"earnings": op_after, "shares": sh_after, "eps": eps_after, "iv_ps": v_after},
        "change": {"earnings": op_after / op - 1, "eps": eps_after / eps - 1, "iv_ps": v_after / v - 1},
        "share_price": px, "new_shares": new_shares, "lost_interest": lost_interest,
        "value_received": E * multiple, "breakeven_earnings": breakeven,
    }
