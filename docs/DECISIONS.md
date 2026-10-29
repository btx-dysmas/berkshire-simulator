# Design decisions

Choices that shape the results, and why they were made.

## 1. Fit to each company's history, with priors

Revenue growth and margin changes are regressed on U.S. GDP and inflation gaps over up to twelve fiscal years. Twelve points is too few for ordinary least squares. In early versions Coca-Cola came out with a GDP beta near 2.4 because of its 2017–2018 refranchising, which has nothing to do with the economy. Bayesian regression with weak normal priors (revenue moves about one-for-one with GDP, margins close a third of their gap each year) keeps estimates like that in check. The app shows the least-squares values next to the posteriors so the shrinkage is visible.

Twelve years rather than all available history: Apple's 2011 and 2012 (66% and 45% growth) made its yearly volatility look like a startup's.

## 2. Correlated drivers

In a recession, growth and margins fall together. That happens through two channels here: both equations respond to the same simulated GDP gap, and the residual shocks are drawn as a bivariate Student-t with a fitted correlation (shrunk toward 0.3). Sampling growth and margins independently would understate how bad the bad paths get.

## 3. Fat tails

Shocks are Student-t, with degrees of freedom matched to the residuals' excess kurtosis and shrunk toward 5. Sample kurtosis from a dozen points is very noisy, so the prior does most of the work for short histories.

## 4. Regimes from data, not guesses

Five regimes are classified from World Bank GDP and CPI data for 1961–2024. The transition matrix is counts of consecutive years. The first version smoothed it by adding half a count to every cell, which nearly doubled the frequency of severe crises (there were only three crisis years in the sample). Smoothing now adds one pseudo-count per row, spread in proportion to how common each regime is. The chain's long-run shares match history within a point.

S&P 500 returns are paired with each regime using the July-to-June window around the year, because markets move ahead of the economy. Calendar-year returns put 2009's rebound in the crisis bucket.

## 5. Recessions don't lower the discount rate

T-bill yields fall in downturns. Letting that flow into the discount rate made recessions raise intrinsic value, which is backwards. In a downturn the risk premium widens about as much as yields fall. So only inflationary regimes move the discount rate, upward.

## 6. Terminal value on a normalized margin

The terminal value uses the path's long-run margin, not its final-year margin. Otherwise one cyclical year sets the value of everything after it. The value-driver formula ties terminal growth to the reinvestment it needs: NOPAT·(1 − g/RONIC)/(WACC − g).

## 7. Sales-to-capital is shrunk too

Divestitures shrink revenue without releasing capital in this measure, so Coca-Cola's raw ratio came out near 0.4. That would make every dollar of its growth absurdly expensive. The fitted ratio is averaged on the log scale with a typical 2.0.

## 8. Certainty equivalent at the portfolio level

The first decision layer computed a certainty-equivalent return on the stock alone with a risk aversion of 3. A handful of paths where the company went to zero made that number −60%. CRRA treats any total loss as ruin. The test now asks whether a position of a given size (10% by default) raises the certainty-equivalent return of a portfolio otherwise held in Treasuries. That is the question an investor actually faces.

## 9. Berkshire: float at its economic cost

Book value carries float at face: a $177.5B liability. Treating float as equity would be wrong, because it belongs to policyholders and has to be paid back. Treating it as a debt at face ignores that Berkshire has usually been paid to hold it. Intrinsic value uses the present value of its future cash flows instead. Float grows with premiums for ten years and then runs off over ten. Each year it costs the underwriting result after tax, since losses are deductible and profits are taxed. It is discounted near the risk-free rate because the obligation is debt-like. At a 0.96 combined ratio that is about $37B. At 1.00 it is about $74B, and at 1.06 about $129B. It passes face value only when underwriting losses run high enough to outweigh the new float coming in.

## 10. Policies compared on the same futures

Capital allocation policies are compared with common random numbers: the same economies, underwriting years and deal offers. So a difference comes from the policy, not from luck. The table shows total and per-share operating earnings side by side, because the gap between them is the point. A stock-funded acquisition program grows total earnings faster and per-share earnings slower.
