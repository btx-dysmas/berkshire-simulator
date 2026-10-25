import numpy as np

from sim import regimes


def test_transition_rows_are_probabilities():
    P = np.array(regimes.macro()["transition"])
    assert np.allclose(P.sum(axis=1), 1)
    assert (P > 0).all()


def test_stationary_matches_history():
    m = regimes.macro()
    counts = np.array([m["stats"][k]["years"] for k in m["regimes"]], float)
    assert np.allclose(m["stationary"], counts / counts.sum(), atol=0.03)


def test_simulated_frequencies_converge():
    m = regimes.macro()
    s = regimes.simulate(20000, 30, 1, np.random.default_rng(0))
    freq = np.bincount(s[:, 10:].ravel(), minlength=5) / s[:, 10:].size
    assert np.allclose(freq, m["stationary"], atol=0.01)
