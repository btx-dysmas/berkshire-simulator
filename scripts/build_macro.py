"""Build data/macro.json: U.S. economic regimes by year and the statistics the simulator draws from.

Sources: World Bank (real GDP growth, CPI inflation), Yahoo Finance (S&P 500) and FRED (3-month
T-bill, series TB3MS; needs FRED_API_KEY). Run it again after the World Bank publishes a new year:
    FRED_API_KEY=... python scripts/build_macro.py
"""
import json
import os
import statistics as st
from datetime import datetime, timedelta, timezone

import httpx

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "macro.json")
REGIMES = ["expansion", "neutral", "inflation", "recession", "crisis"]


def worldbank(indicator):
    url = f"https://api.worldbank.org/v2/country/USA/indicator/{indicator}?format=json&per_page=200"
    rows = httpx.get(url, timeout=30).json()[1]
    return {int(r["date"]): r["value"] for r in rows if r["value"] is not None}


def yahoo_daily(symbol):
    # range=max with monthly bars only reaches back to 1985; daily bars go back to the 1920s.
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1=-347155200&period2=4102444800&interval=1d"
    r = httpx.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60).json()["chart"]["result"][0]
    out = []
    for ts, c in zip(r["timestamp"], r["indicators"]["quote"][0]["close"]):
        if c is not None:
            out.append((datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=ts), c))
    return out


def fred_annual(series):
    key = os.environ.get("FRED_API_KEY")
    if not key:
        print("FRED_API_KEY not set; T-bill statistics left out")
        return {}
    url = f"https://api.stlouisfed.org/fred/series/observations?series_id={series}&file_type=json&frequency=a&api_key={key}"
    obs = httpx.get(url, timeout=30).json()["observations"]
    return {int(o["date"][:4]): float(o["value"]) / 100 for o in obs if o["value"] != "."}


def classify(gdp, cpi):
    # The order matters: a year with negative growth and high inflation (1974, 1980) counts as a
    # recession, because falling output does more damage to earnings than rising prices.
    if gdp < -1.5:
        return "crisis"
    if gdp < 1.0:
        return "recession"
    if cpi > 5.0:
        return "inflation"
    if gdp >= 3.0:
        return "expansion"
    return "neutral"


def main():
    gdp = worldbank("NY.GDP.MKTP.KD.ZG")
    cpi = worldbank("FP.CPI.TOTL.ZG")
    spx = yahoo_daily("%5EGSPC")
    bill_avg = fred_annual("TB3MS")

    # Stocks move ahead of the economy, so a year's regime is paired with the market return from
    # the start of July before it to the end of June. Calendar-year returns put 2009's rebound in
    # the crisis bucket and 2008's crash in the year before; this window lines them up.
    june = {d.year: c for d, c in spx if d.month == 6}  # later days overwrite earlier: last June close
    spx_ret = {y: june[y] / june[y - 1] - 1 for y in june if y - 1 in june}

    years = sorted(y for y in gdp if y in cpi)
    rows = []
    for y in years:
        rows.append({
            "year": y,
            "gdp": gdp[y] / 100,
            "cpi": cpi[y] / 100,
            "regime": classify(gdp[y], cpi[y]),
            "spx": spx_ret.get(y),
            "bill": bill_avg.get(y),
        })

    stats = {}
    for name in REGIMES:
        sub = [r for r in rows if r["regime"] == name]
        rets = [r["spx"] for r in sub if r["spx"] is not None]
        moves = [r["bill"] - p["bill"] for p, r in zip(rows, rows[1:]) if r["regime"] == name and r["bill"] is not None and p["bill"] is not None]
        stats[name] = {
            "years": len(sub),
            "gdp": st.mean(r["gdp"] for r in sub),
            "cpi": st.mean(r["cpi"] for r in sub),
            "spx_mean": st.mean(rets) if rets else None,
            "spx_sd": st.stdev(rets) if len(rets) > 2 else None,
            "bill_change": st.mean(moves) if moves else 0.0,
        }

    # Transition counts between consecutive years, plus one pseudo-count per row spread in
    # proportion to how often each regime occurs. A transition missing from 64 years of data
    # becomes rare rather than impossible, without making crises more common than they were
    # (an even half-count per cell nearly doubled their frequency).
    k = len(REGIMES)
    share = [sum(r["regime"] == name for r in rows) / len(rows) for name in REGIMES]
    counts = [[share[j] for j in range(k)] for _ in range(k)]
    for a, b in zip(rows, rows[1:]):
        counts[REGIMES.index(a["regime"])][REGIMES.index(b["regime"])] += 1
    matrix = [[c / sum(row) for c in row] for row in counts]

    out = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "sources": ["World Bank NY.GDP.MKTP.KD.ZG", "World Bank FP.CPI.TOTL.ZG", "Yahoo Finance ^GSPC", "FRED TB3MS"],
        "regimes": REGIMES,
        "years": rows,
        "stats": stats,
        "transition": matrix,
        "gdp_mean": st.mean(r["gdp"] for r in rows),
    }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print(f"{len(rows)} years, {years[0]}-{years[-1]}")
    for name in REGIMES:
        s = stats[name]
        print(f"  {name:10s} {s['years']:3d}  gdp {s['gdp']:+.3f}  cpi {s['cpi']:.3f}  spx {s['spx_mean'] if s['spx_mean'] is None else round(s['spx_mean'], 3)}")


if __name__ == "__main__":
    main()
