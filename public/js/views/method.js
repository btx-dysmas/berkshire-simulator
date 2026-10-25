// How the models work, and the regime data they are fitted to.
import { api, esc, failure, loading, pct } from "../lib.js";

export async function render(root) {
  document.title = "Method · Berkshire Simulator";
  root.innerHTML = loading("Loading");
  let m;
  try { m = await api("/macro"); } catch (e) { root.innerHTML = failure("Could not load the regime data", e); return; }
  const names = m.regimes.map((r) => r.label);
  root.innerHTML = `
    <div class="co"><h1>Method</h1></div>
    <div class="cols wl">
      <section class="panel"><header><h2>Company valuation</h2></header><div class="prose">
        <h3>Fitting</h3>
        <p>Up to twelve years of 10-K data from SEC company facts. Each fiscal year is paired with the U.S. economy of the calendar year it
          mostly falls in. Two Bayesian linear regressions with weak normal priors are fitted:</p>
        <div class="eq">log growth_t  = a + b·GDPgap_t + c·CPIgap_t + e_t
Δmargin_t     = −κ·(margin_t−1 − m̄) + d·GDPgap_t + f·CPIgap_t + u_t</div>
        <p>A gap is that year's real GDP growth or inflation minus its 1961–2024 average. With a dozen observations, ordinary least squares lets
          one unusual year set a coefficient; the priors (shown next to every fitted value in the app) pull uncertain estimates toward ordinary ones.
          The posterior standard deviation of <code>a</code> becomes the uncertainty in long-run growth, drawn once per path.</p>
        <p>The tails of <code>e</code> come from its excess kurtosis, matched to a Student-t and shrunk toward 5 degrees of freedom. The correlation
          between <code>e</code> and <code>u</code> is estimated from the residuals and shrunk toward 0.3. Sales-to-capital is revenue added per dollar of
          capex less depreciation plus acquisitions, averaged on the log scale with 2.0.</p>
        <h3>Simulating</h3>
        <p>Each path draws its own long-run growth, long-run margin, sales-to-capital and cost of capital, then steps through the years:</p>
        <div class="eq">regime_t      ~ Markov chain (table below)
GDPgap, CPIgap ~ Normal around the regime's averages
(e, u)        ~ bivariate t, correlation ρ, one quarter of e shared market-wide
growth_t      = g_T + (g_path − g_T)·0.5^(t/half-life) + b·GDPgap + c·CPIgap + σ·e + competition
margin_t      = margin_t−1 + κ·(m̄_path − margin_t−1) + d·GDPgap + f·CPIgap + σ_m·u
FCFF_t        = revenue_t·margin_t·(1 − tax) − Δrevenue_t / (sales to capital)</div>
        <p>Recessions lower growth and margins together because both equations respond to the same GDP gap, and the shocks are correlated on top
          of that. Competitive events arrive as hazards over the horizon: mild ones cut growth for three years, significant ones cut the margin
          target permanently, and a disruptive one cuts the margin by 40% and drives the return on new capital down to the cost of capital.</p>
        <p>Cash flows are discounted at the path's cost of capital, which rises when an inflationary regime lifts interest rates. After year ten
          a value-driver terminal value takes over, on a normalized margin:</p>
        <div class="eq">TV = NOPAT_T+1 · (1 − g / RONIC) / (WACC − g)</div>
        <h3>Deciding</h3>
        <p>The decision layer asks three questions: does the median value clear the price by the required margin of safety; how often does a
          ten-year holder lose money; and does a position of a given size raise the certainty-equivalent return of a Treasury portfolio, under
          constant relative risk aversion. The Kelly fraction is found by maximizing expected log wealth over the simulated outcomes.</p>
        <h3>Sensitivity</h3>
        <p>Two views. The tornado holds one driver at a low and a high setting and reruns with the same random numbers. The variance shares come
          from a standardized rank regression of value on each path's draws, which copes with the curvature in a DCF better than a linear fit.</p>
      </div></section>
      <div>
        <section class="panel"><header><h2>Economic regimes</h2><span class="sub">U.S., ${m.years[0].year}–${m.years.at(-1).year}</span></header>
          <table class="grid"><thead><tr><th>Regime</th><th class="r">Years</th><th class="r">Real GDP</th><th class="r">Inflation</th><th class="r">S&amp;P 500</th><th class="r">Long run</th></tr></thead><tbody>
            ${m.regimes.map((r, i) => `<tr><td>${esc(r.label)}</td><td class="r">${r.years}</td><td class="r">${pct(r.gdp)}</td><td class="r">${pct(r.cpi)}</td><td class="r">${pct(r.spx_mean)}</td><td class="r">${pct(m.stationary[i])}</td></tr>`).join("")}
          </tbody></table>
          <div class="note">Crisis: real GDP below −1.5%. Recession: below 1%. High inflation: CPI above 5% with growth above 1%. Expansion: growth of 3% or
            more. S&amp;P 500 return is July to June around each year, since the market moves ahead of the economy. Long run is the chain's
            stationary share. Sources: ${m.sources.map(esc).join(", ")}.</div></section>
        <section class="panel"><header><h2>Transition probabilities</h2><span class="sub">row: this year, column: next year</span></header>
          <div class="scroll"><table class="grid"><thead><tr><th></th>${names.map((n) => `<th class="r">${esc(n)}</th>`).join("")}</tr></thead><tbody>
            ${m.transition.map((row, i) => `<tr><td>${esc(names[i])}</td>${row.map((v) => `<td class="r">${pct(v, 0)}</td>`).join("")}</tr>`).join("")}
          </tbody></table></div>
          <div class="note">Counts of consecutive years, plus one pseudo-count per row spread by how common each regime is, so transitions missing from the
            sample are rare rather than impossible.</div></section>
        <section class="panel"><header><h2>Berkshire model</h2></header><div class="prose">
          <p>The Berkshire page simulates the balance sheet rather than revenue and margins. Float is carried as a liability at face in book value and at
            the present value of what it will cost in intrinsic value. Operating, GAAP and look-through earnings are computed on the same path.
            Acquisitions arrive at random and are paid in cash or stock; buybacks happen only below intrinsic value unless the policy says otherwise.</p>
          <p>Seed figures come from the 10-Q for June 30, 2026 and the 2025 and Q2 2026 earnings releases. Where a figure is a modeling choice rather
            than a filing (multiples, retention, return on retained earnings), it is an editable assumption.</p>
        </div></section>
        <section class="panel"><header><h2>Year by year</h2></header>
          <div class="scroll" style="max-height:420px;overflow-y:auto"><table class="grid"><thead><tr><th>Year</th><th>Regime</th><th class="r">GDP</th><th class="r">CPI</th><th class="r">S&amp;P</th><th class="r">T-bill</th></tr></thead><tbody>
            ${[...m.years].reverse().map((y) => `<tr><td>${y.year}</td><td>${esc(m.regimes.find((r) => r.key === y.regime).label)}</td><td class="r">${pct(y.gdp)}</td><td class="r">${pct(y.cpi)}</td><td class="r">${pct(y.spx)}</td><td class="r">${pct(y.bill, 2)}</td></tr>`).join("")}
          </tbody></table></div></section>
      </div>
    </div>`;
}
