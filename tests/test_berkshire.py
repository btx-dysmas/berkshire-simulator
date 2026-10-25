import numpy as np
import pytest

from sim import berkshire as B
from sim.berkshire import acquisition_lab, float_liability

DEAL = dict(target_earnings=1.0, price=22, operating_earnings=44, intrinsic_value=1000, shares=1.43, multiple=15, bill_yield=0.04)


@pytest.fixture
def offline(monkeypatch):
    monkeypatch.setattr(B.market, "price", lambda t: 800_000.0)
    monkeypatch.setattr(B.market, "rate", lambda s, f: 0.04)


def test_free_float_that_never_grows_is_worth_less_than_face():
    # No growth and no underwriting cost: the only cost is paying claims over ten years.
    liab = float_liability([100.0], [0.0], [0.0], 0.05, grow_years=0, runoff_years=10)[0]
    assert 70 < liab < 100


def test_float_costs_more_than_face_when_underwriting_loses_money():
    good = float_liability([100.0], [-0.02], [0.03], 0.045)[0]
    bad = float_liability([100.0], [0.06], [0.0], 0.045)[0]
    assert good < 100 < bad


def test_stock_deal_below_value_raises_earnings_and_cuts_value_per_share():
    r = acquisition_lab({**DEAL, "funding": "stock", "price_to_value": 0.85})
    assert r["change"]["earnings"] > 0
    assert r["change"]["iv_ps"] < 0


def test_cash_deal_at_a_fair_price_does_not_lose_value():
    r = acquisition_lab({**DEAL, "price": 15, "funding": "cash", "price_to_value": 0.85})
    assert r["change"]["iv_ps"] >= -1e-12


def test_overvalued_stock_makes_a_good_currency():
    r = acquisition_lab({**DEAL, "price": 15, "funding": "stock", "price_to_value": 1.3})
    assert r["change"]["iv_ps"] > 0


def test_unrealized_gains_make_gaap_earnings_swing(offline):
    vol = B.run(n=2000)["summary"]["earnings"]["volatility"]
    assert vol["gaap"] > 3 * vol["op"]


def test_stock_funded_deals_add_earnings_but_not_per_share(offline):
    rows = {r["key"]: r for r in B.compare(n=2000)}
    stock, base = rows["stock_deals"], rows["baseline"]
    assert stock["op_total"] > base["op_total"]
    assert stock["op_ps"] < base["op_ps"]
    assert np.isfinite([r["median"] for r in rows.values()]).all()
