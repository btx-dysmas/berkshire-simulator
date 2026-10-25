import pytest


@pytest.fixture
def params():
    """A plain, mid-sized company: enough to exercise the engine without the network."""
    return {
        "revenue": 10e9, "shares": 1e9, "net_debt": 2e9, "price": 30.0, "tax": 0.21, "horizon": 10,
        "growth": {"mean": 0.06, "se": 0.02, "gdp_beta": 1.0, "cpi_beta": 0.7, "sd": 0.06, "df": 6.0, "halflife": 4.0},
        "margin": {"current": 0.18, "long_run": 0.16, "long_run_sd": 0.02, "kappa": 0.3, "gdp_beta": 0.3, "cpi_beta": -0.1, "sd": 0.02},
        "corr": 0.3,
        "reinvest": {"sales_to_capital": 2.0, "sd_log": 0.3},
        "terminal": {"growth": 0.03, "ronic": 0.12},
        "wacc": {"rf": 0.045, "beta": 1.0, "erp": 0.0425, "kd": 0.06, "weight_debt": 0.1, "mean": 0.085, "sd": 0.0075},
        "competition": {
            "mild": {"prob": 0.30, "growth": -0.02, "years": 3},
            "significant": {"prob": 0.15, "growth": -0.04, "margin": -0.04, "years": 3},
            "disruptive": {"prob": 0.05, "growth": -0.10, "margin_mult": 0.6, "years": 4},
        },
        "start_regime": "neutral",
    }
