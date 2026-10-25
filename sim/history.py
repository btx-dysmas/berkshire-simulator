"""A company's annual history from SEC company facts (XBRL), in the shape the fitter needs."""
from __future__ import annotations

from datetime import date

from .net import DAY, NotFound, get_json
from .store import memoize

# Each line item can be reported under several us-gaap tags; the first that has data wins per year.
TAGS = {
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet",
                "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueGoodsNet"],
    "operating_income": ["OperatingIncomeLoss"],
    "pretax": ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
               "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],
    "tax": ["IncomeTaxExpenseBenefit"],
    "dna": ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization",
            "Depreciation"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
    "acquisitions": ["PaymentsToAcquireBusinessesNetOfCashAcquired"],
    "rnd": ["ResearchAndDevelopmentExpense"],
    "cash": ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
    "securities": ["MarketableSecuritiesCurrent", "ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"],
    "debt": ["LongTermDebt", "LongTermDebtNoncurrent", "DebtInstrumentCarryingAmount"],
    "debt_current": ["LongTermDebtCurrent", "DebtCurrent"],
    "short_debt": ["CommercialPaper", "ShortTermBorrowings"],
    "equity": ["StockholdersEquity"],
    "shares": ["WeightedAverageNumberOfDilutedSharesOutstanding"],
}
FLOWS = {"revenue", "operating_income", "pretax", "tax", "dna", "capex", "acquisitions", "rnd", "shares"}


@memoize("tickers", DAY)
def tickers() -> list[list]:
    raw = get_json("https://www.sec.gov/files/company_tickers.json", 7 * DAY)
    return [[r["ticker"], r["title"], r["cik_str"]] for r in raw.values()]


def lookup(ticker: str) -> dict:
    t = ticker.upper().replace(".", "-")
    for tk, name, cik in tickers():
        if tk == t:
            return {"ticker": tk, "name": name, "cik": cik}
    raise NotFound(f"No SEC registrant with ticker {ticker}")


def search(q: str, limit: int = 8) -> list[dict]:
    q = q.strip().upper()
    if not q:
        return []
    exact, starts, contains = [], [], []
    for tk, name, cik in tickers():
        n = name.upper()
        if tk == q:
            exact.append((tk, name, cik))
        elif tk.startswith(q) or n.startswith(q):
            starts.append((tk, name, cik))
        elif len(q) > 2 and q in n:
            contains.append((tk, name, cik))
    rows = (exact + sorted(starts, key=lambda r: len(r[0])) + contains)[:limit]
    return [{"ticker": tk, "name": name, "cik": cik} for tk, name, cik in rows]


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _annual(units: list[dict], flow: bool) -> dict[str, float]:
    """Value per fiscal-year end date, from 10-K filings. Later filings replace earlier ones,
    so restated figures win."""
    out: dict[str, tuple[str, float]] = {}
    for f in units:
        if not f.get("form", "").startswith("10-K"):
            continue
        if flow and ("start" not in f or not 340 <= _days(f["start"], f["end"]) <= 390):
            continue
        prev = out.get(f["end"])
        if prev is None or f["filed"] >= prev[0]:
            out[f["end"]] = (f["filed"], f["val"])
    return {end: v for end, (_, v) in out.items()}


def _quarters(units: list[dict]) -> dict[str, float]:
    out: dict[str, tuple[str, float]] = {}
    for f in units:
        if "start" in f and 80 <= _days(f["start"], f["end"]) <= 100:
            prev = out.get(f["end"])
            if prev is None or f["filed"] >= prev[0]:
                out[f["end"]] = (f["filed"], f["val"])
    return {end: v for end, (_, v) in out.items()}


@memoize("history:v1", DAY)
def history(ticker: str) -> dict:
    co = lookup(ticker)
    facts = get_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{int(co['cik']):010d}.json")
    gaap = facts.get("facts", {}).get("us-gaap", {})
    sic = None
    try:
        sub = get_json(f"https://data.sec.gov/submissions/CIK{int(co['cik']):010d}.json")
        sic = int(sub.get("sic") or 0) or None
        fy_end = sub.get("fiscalYearEnd")
    except Exception:
        fy_end = None

    series: dict[str, dict[str, float]] = {}
    quarterly_revenue: dict[str, float] = {}
    for key, tags in TAGS.items():
        merged: dict[str, float] = {}
        for tag in tags:
            units = gaap.get(tag, {}).get("units", {})
            vals = units.get("USD") or units.get("shares") or []
            for end, v in _annual(vals, key in FLOWS).items():
                merged.setdefault(end, v)
            if key == "revenue":
                for end, v in _quarters(vals).items():
                    quarterly_revenue.setdefault(end, v)
        series[key] = merged

    # Fiscal years are keyed by their end date. Companies with 52/53-week years end on different
    # days, so group by the year-end month and keep one row per fiscal year.
    ends = sorted(series["revenue"])
    rows, seen = [], set()
    for end in ends:
        fy = int(end[:4]) if int(end[5:7]) > 3 else int(end[:4]) - 1
        if fy in seen:
            continue
        seen.add(fy)
        row = {"fy": fy, "end": end}
        for key in TAGS:
            row[key] = series[key].get(end)
        rows.append(row)
    rows = [r for r in rows if r["revenue"]][-16:]

    shares_out = None
    dei = facts.get("facts", {}).get("dei", {}).get("EntityCommonStockSharesOutstanding", {}).get("units", {}).get("shares", [])
    if dei:
        latest = max(f["end"] for f in dei)
        # Companies with several share classes report one figure per class on the same date.
        shares_out = sum(f["val"] for f in dei if f["end"] == latest and f.get("form", "").startswith("10-"))
        if not shares_out:
            shares_out = sum(f["val"] for f in dei if f["end"] == latest)

    q = sorted(quarterly_revenue.items())
    latest_q = None
    if q:
        end, val = q[-1]
        year_ago = [v for e, v in q if 350 <= _days(e, end) <= 380]
        if year_ago and year_ago[-1] > 0:
            latest_q = {"end": end, "revenue": val, "prior": year_ago[-1], "growth": val / year_ago[-1] - 1}

    return {**co, "sic": sic, "fiscal_year_end": fy_end, "rows": rows, "shares_outstanding": shares_out, "latest_quarter": latest_q}
