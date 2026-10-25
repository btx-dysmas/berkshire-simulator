"""JSON API under /api. Locally the same app also serves the front end from public/."""
from __future__ import annotations

import os

from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse

from . import analysis, berkshire, fit, history, portfolio, regimes
from .engine import merged
from .net import NotFound, Upstream

app = FastAPI(title="Berkshire Simulator", docs_url="/api/docs", openapi_url="/api/openapi.json")
MAX_PATHS = 20_000


@app.exception_handler(NotFound)
def not_found(_: Request, e: NotFound):
    return JSONResponse({"detail": str(e)}, status_code=404)


@app.exception_handler(Upstream)
def upstream(_: Request, e: Upstream):
    return JSONResponse({"detail": str(e)}, status_code=502)


@app.exception_handler(ValueError)
def bad_input(_: Request, e: ValueError):
    return JSONResponse({"detail": str(e)}, status_code=422)


def cached(body, seconds: int = 3600):
    return JSONResponse(body, headers={"Cache-Control": f"public, s-maxage={seconds}, stale-while-revalidate={seconds * 4}"})


def _paths(n) -> int:
    return int(min(max(int(n or 10_000), 500), MAX_PATHS))


@app.get("/api/health")
def health():
    return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})


@app.get("/api/search")
def search(q: str = ""):
    return cached(history.search(q), 3600)


@app.get("/api/macro")
def macro():
    m = regimes.macro()
    return cached({
        "regimes": [{"key": k, "label": regimes.LABELS[k], **m["stats"][k]} for k in m["regimes"]],
        "transition": m["transition"],
        "stationary": m["stationary"],
        "years": m["years"],
        "sources": m["sources"],
        "current": regimes.current(),
    }, 86400)


@app.get("/api/fit/{ticker}")
def company_fit(ticker: str):
    return cached(fit.fit(ticker), 3600)


@app.post("/api/value/{ticker}")
def value(ticker: str, body: dict = Body(default={})):
    f = fit.fit(ticker)
    p = merged(f["params"], body.get("overrides"))
    if not p.get("shares"):
        raise ValueError("No share count in the filings; enter one.")
    result = analysis.run(p, _paths(body.get("paths")), int(body.get("seed") or 7), key=f["company"]["ticker"],
                          decide=body.get("decision"), with_tornado=body.get("tornado", True))
    return JSONResponse({"params": p, **result})


@app.post("/api/bayes")
def bayes(body: dict = Body(...)):
    return JSONResponse(fit.update_growth(float(body["mean"]), float(body["se"]), float(body["observed"]), float(body["noise"])))


@app.get("/api/berkshire/defaults")
def brk_defaults():
    return cached({"params": berkshire.defaults(), "seed": berkshire.seed_data()}, 900)


@app.post("/api/berkshire")
def brk_run(body: dict = Body(default={})):
    return JSONResponse(berkshire.run(body.get("overrides"), _paths(body.get("paths")), int(body.get("seed") or 11)))


@app.post("/api/berkshire/compare")
def brk_compare(body: dict = Body(default={})):
    return JSONResponse(berkshire.compare(body.get("overrides"), min(_paths(body.get("paths") or 6000), 10_000), int(body.get("seed") or 11)))


@app.post("/api/berkshire/deal")
def brk_deal(body: dict = Body(...)):
    return JSONResponse(berkshire.acquisition_lab(body))


@app.post("/api/portfolio")
def portfolio_run(body: dict = Body(...)):
    holdings = [h for h in body.get("holdings", []) if h.get("ticker")][:12]
    if not holdings:
        raise ValueError("Add at least one holding.")
    return JSONResponse(portfolio.run(holdings, min(_paths(body.get("paths") or 6000), 10_000), int(body.get("seed") or 7), int(body.get("horizon") or 10)))


if not os.environ.get("VERCEL"):
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(os.path.dirname(__file__)), "public"), html=True), name="public")
