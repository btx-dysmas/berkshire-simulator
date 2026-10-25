import copy

import numpy as np

from sim import regimes
from sim.analysis import decision, run
from sim.engine import merged, simulate


def test_same_seed_same_answer(params):
    a = simulate(params, 2000, seed=3)["value"]
    b = simulate(params, 2000, seed=3)["value"]
    assert np.array_equal(a, b)


def test_values_are_never_negative(params):
    p = merged(params, {"net_debt": 40e9})
    assert simulate(p, 2000)["value"].min() >= 0


def test_faster_growth_is_worth_more(params):
    lo = np.median(simulate(params, 3000, fix={"growth": 0.02})["value"])
    hi = np.median(simulate(params, 3000, fix={"growth": 0.10})["value"])
    assert hi > lo


def test_competition_lowers_value(params):
    none = np.median(simulate(params, 3000, fix={"competition": "off"})["value"])
    some = np.median(simulate(params, 3000)["value"])
    assert none > some


def test_growth_costs_capital(params):
    # Less revenue per dollar invested means more reinvestment for the same growth.
    cheap = np.median(simulate(params, 3000, fix={"s2c": 4.0})["value"])
    dear = np.median(simulate(params, 3000, fix={"s2c": 0.8})["value"])
    assert cheap > dear


def test_recessions_cut_growth_and_margins_together(params):
    r = simulate(params, 4000)
    rec = regimes.macro()["regimes"].index("recession")
    year1 = r["states"][:, 0]
    g1 = np.log(r["revenue"][:, 0] / params["revenue"])
    in_rec, calm = year1 == rec, year1 == 0
    assert g1[in_rec].mean() < g1[calm].mean()
    assert r["margin"][in_rec, 0].mean() < r["margin"][calm, 0].mean()


def test_shared_seed_shares_the_economy(params):
    other = merged(params, {"revenue": 3e9})
    a = simulate(params, 1000, seed=5, key="AAA")
    b = simulate(other, 1000, seed=5, key="BBB")
    assert np.array_equal(a["states"], b["states"])
    assert not np.array_equal(a["drivers"]["growth"], b["drivers"]["growth"])


def test_merge_updates_one_point_of_a_list():
    out = merged({"m": [1, 2, 3], "x": {"y": 1}}, {"m": {"1": 9}, "x": {"z": 2}})
    assert out == {"m": [1, 9, 3], "x": {"y": 1, "z": 2}}


def test_decision_on_a_sure_thing():
    v = np.full(1000, 200.0)
    w = np.full(1000, 400.0)
    d = decision(v, w, 100.0, 10, 0.04)
    assert d["verdict"] == "Attractive"
    assert d["p_value_above_price"] == 1.0
    assert d["kelly"] == 1.0


def test_run_reports_everything(params):
    r = run(copy.deepcopy(params), 2000, with_tornado=False)
    assert set(r) >= {"distribution", "sensitivity", "tree", "decision", "implied_growth"}
    assert abs(sum(s["share"] for s in r["sensitivity"]) - 1) < 1e-9
    assert abs(sum(b["p"] for b in r["tree"]["branches"]) - 1) < 1e-9
