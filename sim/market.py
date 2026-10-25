"""Prices and rates from Yahoo Finance's chart endpoint."""
from __future__ import annotations

import numpy as np

from .net import HOUR, Upstream, get_json
from .store import memoize


def _chart(symbol: str, rng: str, interval: str, ttl: int) -> dict:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={rng}&interval={interval}"
    res = get_json(url, ttl).get("chart", {}).get("result")
    if not res:
        raise Upstream(f"No price data for {symbol}")
    return res[0]


def _closes(chart: dict) -> np.ndarray:
    adj = chart.get("indicators", {}).get("adjclose")
    c = (adj[0]["adjclose"] if adj else chart["indicators"]["quote"][0]["close"])
    return np.array([np.nan if v is None else v for v in c], dtype=float)


def price(ticker: str) -> float | None:
    try:
        meta = _chart(ticker.replace(".", "-"), "5d", "1d", HOUR // 4)["meta"]
        return meta.get("regularMarketPrice")
    except Exception:
        return None


def rate(symbol: str, fallback: float) -> float:
    """A Yahoo yield index (^TNX, ^IRX) as a decimal."""
    try:
        v = _chart(symbol, "5d", "1d", HOUR)["meta"].get("regularMarketPrice")
        return v / 100 if v else fallback
    except Exception:
        return fallback


@memoize("beta:v1", 24 * HOUR)
def beta(ticker: str) -> dict | None:
    """Five-year monthly beta against the S&P 500, and the Blume-adjusted value used for the
    cost of equity (raw betas drift toward 1 over time)."""
    try:
        a = _chart(ticker.replace(".", "-"), "5y", "1mo", 24 * HOUR)
        m = _chart("%5EGSPC", "5y", "1mo", 24 * HOUR)
    except Exception:
        return None
    sa = dict(zip(a["timestamp"], _closes(a)))
    sm = dict(zip(m["timestamp"], _closes(m)))
    common = sorted(set(sa) & set(sm))
    x = np.array([sm[t] for t in common])
    y = np.array([sa[t] for t in common])
    ok = ~(np.isnan(x) | np.isnan(y))
    x, y = x[ok], y[ok]
    if len(x) < 24:
        return None
    rx, ry = np.diff(np.log(x)), np.diff(np.log(y))
    raw = float(np.cov(ry, rx)[0, 1] / np.var(rx, ddof=1))
    return {"raw": raw, "adjusted": 0.67 * raw + 0.33, "months": int(len(rx))}
