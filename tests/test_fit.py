import numpy as np

from sim.fit import bayes_regression, tail_df, update_growth


def test_regression_recovers_coefficients_with_plenty_of_data():
    rng = np.random.default_rng(0)
    x = rng.normal(0, 0.02, 400)
    y = 0.04 + 1.8 * x + rng.normal(0, 0.01, 400)
    X = np.column_stack([np.ones_like(x), x])
    mean, sd, *_ = bayes_regression(X, y, [0.0, 1.0], [0.1, 0.75])
    assert abs(mean[0] - 0.04) < 0.003
    assert abs(mean[1] - 1.8) < 0.1


def test_prior_dominates_a_short_noisy_history():
    rng = np.random.default_rng(1)
    x = rng.normal(0, 0.01, 6)
    y = 0.05 + rng.normal(0, 0.15, 6)  # no real GDP effect, lots of noise
    X = np.column_stack([np.ones_like(x), x])
    mean, *_, ols = bayes_regression(X, y, [0.05, 1.0], [0.1, 0.75])
    assert abs(mean[1] - 1.0) < abs(ols[1] - 1.0)


def test_tail_df_is_lower_for_fat_tails():
    # Sample kurtosis is noisy at these sizes, so compare averages over many samples.
    rng = np.random.default_rng(2)
    normal = np.mean([tail_df(rng.normal(size=60))[0] for _ in range(30)])
    fat = np.mean([tail_df(rng.standard_t(3, size=60))[0] for _ in range(30)])
    assert fat < normal - 5


def test_bayes_update_is_precision_weighted():
    u = update_growth(0.08, 0.02, 0.14, 0.02)
    assert abs(u["posterior"]["mean"] - 0.11) < 1e-12
    assert abs(u["weight_on_data"] - 0.5) < 1e-12
    assert u["posterior"]["sd"] < 0.02
