// Company workbench: fitted assumptions on the left, the simulated distribution on the right.
import { $, api, chart, color, css, esc, failure, fanTraces, hexA, loading, money, num, ok, onTheme, pct, post, px, store, tone } from "../lib.js";
import { fieldsHTML, readFields, writeField } from "../forms.js";
import { scenarioTree } from "../tree.js";

const REGIMES = [["expansion", "Expansion"], ["neutral", "Neutral"], ["inflation", "High inflation"], ["recession", "Recession"], ["crisis", "Severe crisis"]];
const DRIVER_NAMES = {
  growth: "Long-run growth", margin: "Long-run margin", s2c: "Sales to capital", wacc: "Discount rate",
  economy: "Economy (avg. GDP gap)", competition: "Competitive shocks", shocks: "Year-to-year surprises",
};

const GROUPS = [
  ["Revenue growth", [
    ["growth.mean", "Long-run growth", "pct", "Fitted intercept blended with the last three years"],
    ["growth.se", "Uncertainty in that rate", "pct", "Posterior sd; drawn once per path"],
    ["growth.halflife", "Fade half-life, years", "num"],
    ["growth.sd", "Yearly surprise, sd", "pct"],
    ["growth.df", "Tail thickness (t df)", "num", "Lower is fatter; 30 is close to normal"],
    ["growth.gdp_beta", "Response to real GDP", "num"],
    ["growth.cpi_beta", "Response to inflation", "num"],
  ]],
  ["Operating margin", [
    ["margin.current", "Latest margin", "pct"],
    ["margin.long_run", "Long-run margin", "pct"],
    ["margin.long_run_sd", "Uncertainty in it", "pct"],
    ["margin.kappa", "Reversion per year", "num", "Share of the gap closed each year"],
    ["margin.sd", "Yearly surprise, sd", "pct"],
    ["margin.gdp_beta", "Response to real GDP", "num"],
    ["margin.cpi_beta", "Response to inflation", "num"],
    ["corr", "Growth-margin shock correlation", "num"],
  ]],
  ["Reinvestment", [
    ["reinvest.sales_to_capital", "Sales to capital", "num", "Revenue added per $1 of net investment"],
    ["reinvest.sd_log", "Uncertainty (log sd)", "num"],
  ]],
  ["Discount rate and terminal value", [
    ["wacc.mean", "Cost of capital", "pct"],
    ["wacc.sd", "Uncertainty in it", "pct"],
    ["terminal.growth", "Terminal growth", "pct"],
    ["terminal.ronic", "Return on new capital", "pct", "After year 10; falls to the cost of capital after disruption"],
    ["tax", "Tax rate", "pct"],
  ]],
  ["Competition, odds over the horizon", [
    ["competition.mild.prob", "Mild: growth -2 pts for 3 yrs", "pct"],
    ["competition.significant.prob", "Significant: margin -4 pts", "pct"],
    ["competition.disruptive.prob", "Disruptive: margin x0.6", "pct"],
  ]],
  ["Economy and market", [
    ["start_regime", "Starting regime", "sel", REGIMES],
    ["price", "Share price", "num"],
    ["shares", "Shares outstanding", "num"],
    ["net_debt", "Net debt", "usd"],
    ["horizon", "Forecast years", "num"],
  ]],
];

let state = null;

export async function render(root, { ticker }) {
  document.title = `${ticker} · Berkshire Simulator`;
  root.innerHTML = loading(`Fitting ${ticker} to its filings`);
  let fit;
  try {
    fit = await api(`/fit/${encodeURIComponent(ticker)}`);
  } catch (e) {
    root.innerHTML = failure(`Could not fit ${ticker}`, e);
    return;
  }
  const c = { ...fit.company, name: titleCase(fit.company.name) };
  document.title = `${c.ticker} · ${c.name} · Berkshire Simulator`;
  const recent = store.get("recent", []).filter((r) => r.ticker !== c.ticker);
  store.set("recent", [{ ticker: c.ticker, name: c.name }, ...recent].slice(0, 8));

  state = { fit, ticker: c.ticker, result: null, decision: store.get("decision", { margin_of_safety: 0.25, max_loss: 0.2, risk_aversion: 3, position: 0.1 }), paths: 10000 };
  const p = fit.params;
  root.innerHTML = `
    <div class="co">
      <h1>${esc(c.name)}</h1><span class="tk">${esc(c.ticker)}</span>
      <div class="facts">
        <span><b>Price</b>${px(p.price)}</span>
        <span><b>Revenue, last FY</b>${money(p.revenue)}</span>
        <span><b>Operating margin</b>${pct(p.margin.current)}</span>
        <span><b>Net debt</b>${money(p.net_debt)}</span>
        <span><b>Years fitted</b>${fit.fit.n}</span>
        <span><b>Economy now</b>${esc(REGIMES.find((r) => r[0] === fit.fit.macro_start.regime)?.[1] || "")} (${fit.fit.macro_start.year})</span>
      </div>
    </div>
    ${fit.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}
    <div class="bench">
      <form class="panel inputs" id="inputs" autocomplete="off">
        <header><h2>Assumptions</h2><span class="sub">fitted from filings</span></header>
        ${fieldsHTML(GROUPS, p)}
        <fieldset><legend>Simulation</legend>
          <div class="row"><label for="paths">Paths</label><select class="field" id="paths">${[5000, 10000, 20000].map((n) => `<option ${n === 10000 ? "selected" : ""}>${n}</option>`).join("")}</select></div>
          <div class="row"><label for="seed">Random seed</label><input class="field" id="seed" value="7" inputmode="numeric"></div>
        </fieldset>
        <div class="actions"><button class="btn primary" id="run">Run simulation</button><button class="btn" type="button" id="reset">Reset to fitted</button></div>
      </form>
      <div id="out">${loading("Simulating")}</div>
    </div>`;

  const form = $("#inputs");
  form.addEventListener("submit", (e) => { e.preventDefault(); simulate(); });
  form.addEventListener("input", () => readFields(form, fit.params));
  $("#reset").addEventListener("click", () => {
    form.querySelectorAll(".row[data-path]").forEach((row) => writeField(form, row.dataset.path, row.dataset.path.split(".").reduce((o, k) => o?.[k], fit.params)));
    readFields(form, fit.params);
    simulate();
  });
  onTheme(() => state.result && draw(state.result));
  simulate();
}

async function simulate() {
  const form = $("#inputs"), out = $("#out");
  const overrides = readFields(form, state.fit.params);
  state.paths = +$("#paths").value;
  out.classList.add("busy");
  $("#run").disabled = true;
  try {
    const r = await post(`/value/${encodeURIComponent(state.ticker)}`, { overrides, paths: state.paths, seed: +$("#seed").value || 7, decision: state.decision });
    state.result = r;
    draw(r);
  } catch (e) {
    out.innerHTML = failure("Simulation failed", e);
  } finally {
    out.classList.remove("busy");
    $("#run").disabled = false;
  }
}

function draw(r) {
  const out = $("#out");
  const d = r.distribution, p = r.params, dec = r.decision;
  const price = p.price;
  out.innerHTML = `
    <section class="panel">
      <header><h2>Intrinsic value per share</h2><span class="sub">${num(d.n)} simulated futures, ${p.horizon}-year forecast plus terminal value</span>
        ${dec ? `<span class="right"><span class="verdict ${dec.verdict}">${dec.verdict}</span></span>` : ""}</header>
      <dl class="kv two">
        <dt>Share price</dt><dd>${px(price)}</dd>
        <dt>Chance value exceeds price</dt><dd>${dec ? `<b>${pct(dec.p_value_above_price)}</b>` : "—"}</dd>
        <dt>Median value</dt><dd>${px(d.median)}</dd>
        <dt>Expected value</dt><dd>${px(d.mean)} <span class="muted">(95% CI ${px(d.mean_ci95[0])}–${px(d.mean_ci95[1])})</span></dd>
        <dt>5th percentile</dt><dd>${px(d.percentiles["5"])}</dd>
        <dt>95th percentile</dt><dd>${px(d.percentiles["95"])}</dd>
        <dt>Median value against price</dt><dd class="${tone(d.median - price)}">${price ? pct(d.median / price - 1, 1, true) : "—"}</dd>
        <dt>Long-run growth the price implies</dt><dd>${ok(r.implied_growth) ? `${pct(r.implied_growth)} <span class="muted">vs. ${pct(p.growth.mean)} fitted</span>` : "—"}</dd>
        <dt>Terminal value share of EV</dt><dd>${pct(r.tv_share, 0)}</dd>
        <dt>Cost of capital</dt><dd>${pct(p.wacc.mean)} <span class="muted">(${pct(p.wacc.rf, 2)} Treasury + ${p.wacc.beta.toFixed(2)} × ${pct(p.wacc.erp, 2)})</span></dd>
      </dl>
      <div class="note">The confidence interval is for the <b>expected value</b> itself: how precisely ${num(d.n)} paths estimate it. The spread of
        outcomes is the percentile range below, which is far wider. ${dec ? esc(dec.note) : ""}</div>
    </section>

    <div class="cols c2">
      <section class="panel"><header><h2>Distribution of value</h2><span class="sub">share of paths per bin</span></header><div class="chart" id="c-hist"></div></section>
      <section class="panel"><header><h2>Probability value exceeds…</h2><span class="sub">read across from any price</span></header><div class="chart" id="c-exceed"></div></section>
    </div>

    <div class="cols c2">
      <section class="panel"><header><h2>Outcomes against today's price</h2></header>
        ${d.buckets ? `<table class="grid"><thead><tr><th>Value per share</th><th class="r">Range</th><th class="r">Probability</th><th></th></tr></thead><tbody>
          ${d.buckets.map((b) => `<tr><td>${b.hi_x == null ? `Above ${b.lo_x}x price` : b.lo_x === 0 ? `Below ${b.hi_x}x price` : `${b.lo_x}x to ${b.hi_x}x price`}</td>
            <td class="r muted">${b.hi == null ? `> ${px(b.lo)}` : b.lo_x === 0 ? `< ${px(b.hi)}` : `${px(b.lo)}–${px(b.hi)}`}</td>
            <td class="r">${pct(b.p)}</td><td class="bar-cell"><i style="width:${(b.p * 100).toFixed(1)}%"></i></td></tr>`).join("")}
        </tbody></table>` : '<div class="empty">Enter a share price to compare.</div>'}
      </section>
      <section class="panel"><header><h2>Ranges of outcomes</h2></header>
        <table class="grid"><thead><tr><th>Interval</th><th class="r">Low</th><th class="r">High</th></tr></thead><tbody>
          ${["90", "95", "99"].map((k) => `<tr><td>${k}% of paths</td><td class="r">${px(d.ranges[k][0])}</td><td class="r">${px(d.ranges[k][1])}</td></tr>`).join("")}
        </tbody></table>
        <div class="scroll"><table class="grid"><thead><tr><th>Percentile</th>${Object.keys(d.percentiles).map((k) => `<th class="r">${k}th</th>`).join("")}</tr></thead>
          <tbody><tr><td>Value</td>${Object.values(d.percentiles).map((v) => `<td class="r">${px(v)}</td>`).join("")}</tr></tbody></table></div>
      </section>
    </div>

    ${dec ? decisionHTML(dec, p) : ""}

    <div class="cols c2">
      <section class="panel"><header><h2>What moves the median</h2><span class="sub">one driver at a time, same random draws</span></header><div class="chart" id="c-tornado"></div>
        <div class="note">Each bar holds one driver at a low and a high setting while everything else stays random.</div></section>
      <section class="panel"><header><h2>Where the spread comes from</h2><span class="sub">standardized rank regression</span></header>
        <table class="grid"><thead><tr><th>Driver</th><th class="r">Coefficient</th><th class="r">Share of explained variance</th><th></th></tr></thead><tbody>
          ${[...r.sensitivity].sort((a, b) => b.share - a.share).map((s) => `<tr><td>${esc(DRIVER_NAMES[s.driver] || s.driver)}</td><td class="r">${s.coef.toFixed(2)}</td><td class="r">${pct(s.share, 0)}</td><td class="bar-cell"><i style="width:${(s.share * 100).toFixed(1)}%"></i></td></tr>`).join("")}
        </tbody></table>
        <div class="note">Ranks of value regressed on ranks of each path's draws. The drivers together explain ${pct(r.sensitivity[0]?.r2, 0)} of the rank variance.</div></section>
    </div>

    <section class="panel"><header><h2>Scenario tree</h2><span class="sub">paths grouped by what happened to them</span></header>
      <div class="body">${scenarioTree(r.tree, price, d.n)}</div></section>

    <div class="cols c2">
      <section class="panel"><header><h2>Revenue paths</h2><span class="sub">median, 25–75th and 5–95th percentiles</span></header><div class="chart short" id="c-rev"></div></section>
      <section class="panel"><header><h2>Operating margin paths</h2><span class="sub">mean-reverting toward the long-run margin</span></header><div class="chart short" id="c-margin"></div></section>
    </div>

    <div class="cols c2">
      <section class="panel"><header><h2>Economy across the paths</h2></header>
        <table class="grid"><thead><tr><th>Regime</th><th class="r">Share of path-years</th><th class="r">Paths with at least one</th></tr></thead><tbody>
          ${r.regimes.map((g) => `<tr><td>${esc(g.label)}</td><td class="r">${pct(g.share)}</td><td class="r">${pct(g.ever)}</td></tr>`).join("")}
        </tbody></table>
        <div class="note">Transitions fitted to U.S. GDP and inflation, 1961 onward. See <a href="#/method">Method</a>.</div></section>
      ${bayesHTML()}
    </div>

    ${historyHTML()}`;

  drawCharts(r);
  bindDecision();
  bindBayes();
}

function decisionHTML(dec, p) {
  const s = dec.settings, rt = dec.return;
  return `<section class="panel" id="decision">
    <header><h2>Decision</h2><span class="sub">is the price worth paying?</span>
      <span class="right">
        <label class="muted">Margin of safety <input class="field" style="width:56px" data-d="margin_of_safety" value="${s.margin_of_safety * 100}">%</label>
        <label class="muted">Max loss odds <input class="field" style="width:56px" data-d="max_loss" value="${s.max_loss * 100}">%</label>
        <label class="muted">Risk aversion <input class="field" style="width:48px" data-d="risk_aversion" value="${s.risk_aversion}"></label>
        <label class="muted">Position <input class="field" style="width:48px" data-d="position" value="${s.position * 100}">%</label>
      </span></header>
    <div class="cols c2" style="gap:0">
      <table class="grid"><thead><tr><th>Test</th><th class="r">Result</th><th class="r"></th></tr></thead><tbody>
        ${dec.checks.map((c) => `<tr><td>${esc(c.test)}</td><td class="r">${pct(c.value)}</td><td class="r ${c.pass ? "ok" : "no"}">${c.pass ? "Pass" : "Fail"}</td></tr>`).join("")}
      </tbody></table>
      <dl class="kv">
        <dt>Expected upside to expected value</dt><dd class="${tone(dec.upside_expected)}">${pct(dec.upside_expected, 1, true)}</dd>
        <dt>Chance value is 30%+ below price</dt><dd>${pct(dec.p_value_below_70)}</dd>
        <dt>Average of the worst 5% of values</dt><dd>${px(dec.downside_mean_worst5)}</dd>
        <dt>${p.horizon}-year return, median (5th–95th)</dt><dd>${pct(rt.median)} <span class="muted">(${pct(rt.p5)} to ${pct(rt.p95)})</span></dd>
        <dt>Chance of losing money over ${p.horizon} years</dt><dd>${pct(rt.p_loss)}</dd>
        <dt>Certainty-equivalent return, ${pct(s.position, 0)} position</dt><dd>${pct(rt.certainty_equivalent, 2)} <span class="muted">vs. ${pct(rt.risk_free, 2)} Treasuries</span></dd>
        <dt>Kelly fraction (log-optimal)</dt><dd>${pct(dec.kelly, 0)}</dd>
      </dl>
    </div>
    <div class="note">Returns assume the owner collects free cash flow after interest each year and sells at intrinsic value in year ${p.horizon}: the market
      price converges to value, but not before then. Kelly is computed from the simulated distribution, not a formula; most investors who use it bet half.</div>
  </section>`;
}

function bindDecision() {
  const box = $("#decision");
  if (!box) return;
  box.querySelectorAll("[data-d]").forEach((el) => el.addEventListener("change", () => {
    const k = el.dataset.d, v = parseFloat(el.value);
    if (!Number.isFinite(v)) return;
    state.decision[k] = k === "risk_aversion" ? v : v / 100;
    store.set("decision", state.decision);
    simulate();
  }));
}

function bayesHTML() {
  const q = state.fit.latest_quarter;
  const g = readGrowth();
  const obs = q ? Math.log(1 + q.growth) : g.mean;
  return `<section class="panel" id="bayes"><header><h2>Update on new results</h2><span class="sub">normal-normal Bayesian update of long-run growth</span></header>
    <dl class="kv">
      <dt>Prior: long-run growth</dt><dd>${pct(g.mean)} ± ${pct(g.se)}</dd>
      <dt>Latest quarter</dt><dd>${q ? `${pct(q.growth, 1, true)} year over year <span class="muted">(quarter ended ${esc(q.end)})</span>` : "None reported"}</dd>
      <dt>Observed growth (log)</dt><dd><input class="field" style="width:80px" id="b-obs" value="${(obs * 100).toFixed(2)}"> %</dd>
      <dt>Noise in one reading, sd</dt><dd><input class="field" style="width:80px" id="b-noise" value="${(g.sd * 100).toFixed(2)}"> %</dd>
    </dl>
    <div id="b-result"></div>
    <div class="note">One quarter's year-over-year growth is treated as a single noisy reading of the long-run rate, with the noise of a normal year's
      surprise. The posterior replaces the growth assumption and the simulation reruns. <button class="btn small" id="b-apply" type="button">Apply update</button></div>
  </section>`;
}

function readGrowth() {
  const f = $("#inputs");
  const get = (path) => parseFloat(f.querySelector(`.row[data-path="${path}"] input`).value) / 100;
  return { mean: get("growth.mean"), se: get("growth.se"), sd: get("growth.sd") };
}

function bindBayes() {
  $("#b-apply")?.addEventListener("click", async () => {
    const g = readGrowth();
    const observed = parseFloat($("#b-obs").value) / 100, noise = parseFloat($("#b-noise").value) / 100;
    try {
      const u = await post("/bayes", { mean: g.mean, se: g.se, observed, noise });
      writeField($("#inputs"), "growth.mean", u.posterior.mean);
      writeField($("#inputs"), "growth.se", u.posterior.sd);
      state.lastUpdate = u;
      await simulate();
    } catch (e) {
      $("#b-result").innerHTML = failure("Update failed", e);
    }
  });
  const u = state.lastUpdate;
  if (u) {
    $("#b-result").innerHTML = `<table class="grid"><thead><tr><th></th><th class="r">Mean</th><th class="r">Sd</th></tr></thead><tbody>
      <tr><td>Prior</td><td class="r">${pct(u.prior.mean, 2)}</td><td class="r">${pct(u.prior.sd, 2)}</td></tr>
      <tr><td>Observation</td><td class="r">${pct(u.observation.value, 2)}</td><td class="r">${pct(u.observation.sd, 2)}</td></tr>
      <tr class="total"><td>Posterior</td><td class="r">${pct(u.posterior.mean, 2)}</td><td class="r">${pct(u.posterior.sd, 2)}</td></tr></tbody></table>
      <div class="chart short" id="c-bayes"></div>
      <div class="note">The new reading got ${pct(u.weight_on_data, 0)} of the weight: a precise prior moves little, a vague one moves a lot.</div>`;
    const xs = [], pdf = (m, s) => xs.map((x) => Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI)));
    const lo = Math.min(u.prior.mean - 3.5 * u.prior.sd, u.observation.value - 2 * u.observation.sd);
    const hi = Math.max(u.prior.mean + 3.5 * u.prior.sd, u.observation.value + 2 * u.observation.sd);
    for (let i = 0; i <= 120; i++) xs.push(lo + ((hi - lo) * i) / 120);
    chart($("#c-bayes"), [
      { x: xs.map((x) => x * 100), y: pdf(u.prior.mean, u.prior.sd), mode: "lines", name: "Prior", line: { color: color(6), dash: "dot" } },
      { x: xs.map((x) => x * 100), y: pdf(u.observation.value, u.observation.sd), mode: "lines", name: "Observation", line: { color: color(2), width: 1 } },
      { x: xs.map((x) => x * 100), y: pdf(u.posterior.mean, u.posterior.sd), mode: "lines", name: "Posterior", line: { color: color(0), width: 2 } },
    ], { showlegend: true, xaxis: { ticksuffix: "%" }, yaxis: { showticklabels: false }, margin: { l: 16 } });
  }
}

function historyHTML() {
  const f = state.fit;
  const fg = f.fit.growth, fm = f.fit.margin, pr = f.fit.priors;
  const coef = (label, post, se, ols, prior, fmt = (v) => v.toFixed(3)) =>
    `<tr><td>${label}</td><td class="r">${fmt(post)} <span class="muted">± ${fmt(se)}</span></td><td class="r muted">${ols == null ? "—" : fmt(ols)}</td><td class="r muted">${fmt(prior[0])} ± ${fmt(prior[1])}</td></tr>`;
  return `<div class="cols wl">
    <section class="panel"><header><h2>History the model was fitted to</h2><span class="sub">annual 10-K figures, SEC company facts</span></header>
      <div class="scroll"><table class="grid"><thead><tr><th>FY</th><th class="r">Revenue</th><th class="r">Growth</th><th class="r">Op. margin</th><th>U.S. economy</th><th class="r">Capex</th><th class="r">D&amp;A</th><th class="r">Acquisitions</th></tr></thead><tbody>
        ${[...f.history].reverse().map((h) => `<tr><td>${h.fy}</td><td class="r">${money(h.revenue)}</td><td class="r ${tone(h.growth)}">${pct(h.growth)}</td><td class="r">${pct(h.margin)}</td>
          <td>${esc(REGIMES.find((r) => r[0] === h.regime)?.[1] || "—")}</td><td class="r">${money(h.capex)}</td><td class="r">${money(h.dna)}</td><td class="r">${money(h.acquisitions)}</td></tr>`).join("")}
      </tbody></table></div></section>
    <section class="panel"><header><h2>Fitted coefficients</h2><span class="sub">Bayesian regression, ${f.fit.n} years</span></header>
      <table class="grid"><thead><tr><th>Coefficient</th><th class="r">Posterior</th><th class="r">Least squares</th><th class="r">Prior</th></tr></thead><tbody>
        <tr class="sub"><td colspan="4"><b>Log revenue growth</b></td></tr>
        ${coef("Intercept", fg.coef[0], fg.se[0], fg.ols[0], pr.growth_intercept)}
        ${coef("Real GDP gap", fg.coef[1], fg.se[1], fg.ols[1], pr.growth_gdp)}
        ${coef("Inflation gap", fg.coef[2], fg.se[2], fg.ols[2], pr.growth_cpi)}
        <tr class="sub"><td colspan="4"><b>Change in operating margin</b></td></tr>
        ${coef("Reversion speed", fm.coef[0], fm.se[0], fm.ols?.[0], pr.margin_kappa)}
        ${coef("Real GDP gap", fm.coef[1], fm.se[1], fm.ols?.[1], pr.margin_gdp)}
        ${coef("Inflation gap", fm.coef[2], fm.se[2], fm.ols?.[2], pr.margin_cpi)}
      </tbody></table>
      <dl class="kv">
        <dt>Growth residual sd</dt><dd>${pct(fg.resid_sd)}</dd>
        <dt>Residual excess kurtosis</dt><dd>${ok(fg.kurtosis) ? fg.kurtosis.toFixed(2) : "—"}</dd>
        <dt>Sales to capital, raw → used</dt><dd>${ok(f.fit.sales_to_capital_raw) ? f.fit.sales_to_capital_raw.toFixed(2) : "—"} → ${f.params.reinvest.sales_to_capital.toFixed(2)}</dd>
        <dt>Shock correlation, raw → used</dt><dd>${f.fit.corr_raw.toFixed(2)} → ${f.params.corr.toFixed(2)}</dd>
        <dt>Return on invested capital, last FY</dt><dd>${pct(f.fit.roic)}</dd>
        <dt>Beta (5y monthly, raw → adjusted)</dt><dd>${f.fit.beta ? `${f.fit.beta.raw.toFixed(2)} → ${f.fit.beta.adjusted.toFixed(2)}` : "—"}</dd>
      </dl>
      <div class="note">Gaps are this year's GDP growth and inflation minus their 1961–2024 averages. With a dozen observations the priors keep one odd
        year from setting the estimate; the least-squares column shows what the data alone would say.</div></section>
  </div>`;
}

function drawCharts(r) {
  const d = r.distribution, price = r.params.price;
  const e = d.histogram.edges;
  const mids = e.slice(0, -1).map((x, i) => (x + e[i + 1]) / 2);
  const vline = (x, c, dash = "solid") => ({ type: "line", x0: x, x1: x, yref: "paper", y0: 0, y1: 1, line: { color: c, width: 1.5, dash } });
  const shapes = [vline(d.median, color(0), "dot")];
  const notes = [{ x: d.median, yref: "paper", y: 1, text: "median", showarrow: false, yanchor: "bottom", font: { size: 11, color: color(0) } }];
  if (price) {
    shapes.push(vline(price, color(4)));
    notes.push({ x: price, yref: "paper", y: 0.92, text: "price", showarrow: false, xanchor: "left", font: { size: 11, color: color(4) } });
  }
  chart($("#c-hist"), [{ type: "bar", x: mids, y: d.histogram.counts.map((v) => v * 100), marker: { color: hexA(color(0), 0.75) }, hovertemplate: "$%{x:,.0f}: %{y:.2f}% of paths<extra></extra>" }],
    { shapes, annotations: notes, xaxis: { tickprefix: "$" }, yaxis: { ticksuffix: "%" }, margin: { t: 18 } });
  chart($("#c-exceed"), [{ x: d.exceed.x, y: d.exceed.p.map((v) => v * 100), mode: "lines", line: { color: color(0), width: 2 }, hovertemplate: "P(value > $%{x:,.0f}) = %{y:.1f}%<extra></extra>" }],
    { shapes: price ? [vline(price, color(4))] : [], xaxis: { tickprefix: "$" }, yaxis: { ticksuffix: "%", range: [0, 101] } });

  if (r.tornado) {
    const t = [...r.tornado].reverse();
    const base = t[0].base;
    chart($("#c-tornado"), [
      { type: "bar", orientation: "h", y: t.map((x) => x.driver), x: t.map((x) => Math.min(x.low, x.high) - base), base, marker: { color: hexA(color(4), 0.75) }, customdata: t.map((x) => x.setting), hovertemplate: "%{customdata}<br>low: $%{x:,.2f} vs base<extra></extra>" },
      { type: "bar", orientation: "h", y: t.map((x) => x.driver), x: t.map((x) => Math.max(x.low, x.high) - base), base, marker: { color: hexA(color(0), 0.75) }, customdata: t.map((x) => x.setting), hovertemplate: "%{customdata}<br>high: +$%{x:,.2f} vs base<extra></extra>" },
    ], { barmode: "overlay", xaxis: { tickprefix: "$" }, margin: { l: 120 }, shapes: [{ type: "line", x0: base, x1: base, yref: "paper", y0: 0, y1: 1, line: { color: css("--ink-3"), width: 1 } }] });
  }
  const years = r.fan.revenue.p50.map((_, i) => i + 1);
  chart($("#c-rev"), fanTraces(years, r.fan.revenue, 0, "Revenue", 1e-9), { yaxis: { tickprefix: "$", ticksuffix: "B" }, xaxis: { title: { text: "Year" }, dtick: 1 } });
  chart($("#c-margin"), fanTraces(years, r.fan.margin, 1, "Margin", 100), { yaxis: { ticksuffix: "%" }, xaxis: { title: { text: "Year" }, dtick: 1 } });
}

// SEC names are upper case ("COCA COLA CO"). Keep short all-caps words that are acronyms.
const KEEP = new Set(["II", "III", "IV", "LP", "LLC", "PLC", "NV", "SA", "AG", "SE", "ASA", "USA", "US", "NA", "REIT", "ETF", "PJSC", "IBM", "AT&T"]);
export function titleCase(s) {
  if (!s || s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/[a-z0-9&.']+/g, (w) => {
    const up = w.toUpperCase();
    if (KEEP.has(up.replace(/\./g, ""))) return up;
    return w[0].toUpperCase() + w.slice(1);
  });
}
