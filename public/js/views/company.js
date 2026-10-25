// Company workbench: fitted assumptions on the left, what the simulation found on the right.
import { $, api, chart, color, css, esc, failure, fanTraces, hexA, loading, money, num, ok, onTheme, pct, post, px, store, tone } from "../lib.js";
import { fieldsHTML, readFields, writeField } from "../forms.js";
import { scenarioTree } from "../tree.js";

const REGIMES = [["expansion", "Expansion"], ["neutral", "Neutral"], ["inflation", "High inflation"], ["recession", "Recession"], ["crisis", "Severe crisis"]];
const DRIVER_NAMES = {
  growth: "Long-run growth", margin: "Long-run margin", s2c: "Sales to capital", wacc: "Discount rate",
  economy: "Economy", competition: "Competitive shocks", shocks: "Year-to-year surprises",
};

const GROUPS = [
  ["Key assumptions", [
    ["growth.mean", "Long-run growth", "pct", "Fitted to the filings; fades toward terminal growth"],
    ["margin.long_run", "Long-run operating margin", "pct"],
    ["wacc.mean", "Cost of capital", "pct"],
    ["terminal.growth", "Terminal growth", "pct"],
    ["price", "Share price", "num"],
    ["start_regime", "Economy today", "sel", REGIMES],
  ]],
  ["Revenue growth", [
    ["growth.se", "Uncertainty in long-run growth", "pct", "Posterior sd, drawn once per path"],
    ["growth.halflife", "Fade half-life, years", "num"],
    ["growth.sd", "Yearly surprise, sd", "pct"],
    ["growth.df", "Tail thickness (t df)", "num", "Lower is fatter; 30 is close to normal"],
    ["growth.gdp_beta", "Response to real GDP", "num"],
    ["growth.cpi_beta", "Response to inflation", "num"],
  ]],
  ["Operating margin", [
    ["margin.current", "Latest margin", "pct"],
    ["margin.long_run_sd", "Uncertainty in long-run margin", "pct"],
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
    ["wacc.sd", "Uncertainty in cost of capital", "pct"],
    ["terminal.ronic", "Return on new capital", "pct", "After the forecast; falls to the cost of capital after disruption"],
    ["tax", "Tax rate", "pct"],
  ]],
  ["Competition", [
    ["competition.mild.prob", "Mild: growth -2 pts for 3 yrs", "pct"],
    ["competition.significant.prob", "Significant: margin -4 pts", "pct"],
    ["competition.disruptive.prob", "Disruptive: margin x0.6", "pct"],
  ]],
  ["Shares and horizon", [
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

  state = { fit, name: c.name, ticker: c.ticker, result: null, distMode: "hist", decision: store.get("decision", { margin_of_safety: 0.25, max_loss: 0.2, risk_aversion: 3, position: 0.1 }), paths: 10000 };
  const p = fit.params;
  root.innerHTML = `
    <div class="co">
      <h1>${esc(c.name)}</h1><span class="tk">${esc(c.ticker)}</span>
      <div class="facts">
        <span><b>Price</b>${px(p.price)}</span>
        <span><b>Revenue, last FY</b>${money(p.revenue)}</span>
        <span><b>Operating margin</b>${pct(p.margin.current)}</span>
        <span><b>Net debt</b>${money(p.net_debt)}</span>
        <span><b>Economy now</b>${esc(REGIMES.find((r) => r[0] === fit.fit.macro_start.regime)?.[1] || "")} (${fit.fit.macro_start.year})</span>
      </div>
    </div>
    ${fit.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}
    <div class="bench">
      <form class="panel inputs" id="inputs" autocomplete="off">
        <header><h2>Assumptions</h2><span class="sub">fitted from ${fit.fit.n} years of filings</span></header>
        ${fieldsHTML(GROUPS, p)}
        <details class="group"><summary>Simulation</summary><div class="rows">
          <div class="row"><label for="paths">Paths</label><select class="field" id="paths">${[5000, 10000, 20000].map((n) => `<option ${n === 10000 ? "selected" : ""}>${n}</option>`).join("")}</select></div>
          <div class="row"><label for="seed">Random seed</label><input class="field" id="seed" value="7" inputmode="numeric"></div>
        </div></details>
        <div class="actions"><button class="btn primary" id="run">Run simulation</button><button class="btn" type="button" id="reset">Reset</button></div>
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

/** One sentence that says what the simulation found, in words. */
function claim(r) {
  const d = r.distribution, p = r.params, price = p.price, dec = r.decision, name = esc(state.name);
  if (!price || !dec) return `The median simulated future values ${name} at <b>${px(d.median)}</b> a share.`;
  const ch = dec.p_value_above_price;
  const odds = ch < 0.005 ? "almost none" : ch > 0.995 ? "nearly all" : pct(ch, ch < 0.1 ? 1 : 0);
  const gap = d.median / price - 1;
  let s = `${name} is worth more than its ${px(price)} price in <b>${odds}</b> of the simulated futures. The median future puts it at <b>${px(d.median)}</b>, ${pct(Math.abs(gap), 0)} ${gap < 0 ? "below" : "above"} the price.`;
  if (ok(r.implied_growth) && gap < 0) s += ` The price assumes long-run growth near ${pct(r.implied_growth, 0)}; the filings support about ${pct(p.growth.mean, 0)}.`;
  return s;
}

function bucketLabel(b) {
  if (b.hi_x == null) return `More than ${b.lo_x}x the price`;
  if (b.lo_x === 0) return `Less than ${b.hi_x}x the price`;
  return `${b.lo_x}x to ${b.hi_x}x the price`;
}

function draw(r) {
  const out = $("#out");
  const d = r.distribution, p = r.params, dec = r.decision;
  const price = p.price;
  const vsPrice = price ? d.median / price - 1 : null;
  const chance = dec?.p_value_above_price;
  out.innerHTML = `
    <section class="panel hero">
      <div class="hero-top">${dec ? `<span class="verdict ${dec.verdict}">${dec.verdict}</span>` : ""}<h2>${num(d.n)} simulated futures · ${p.horizon}-year forecast plus terminal value</h2></div>
      <p class="claim">${claim(r)}</p>
      <div class="metrics">
        <div class="metric"><div class="k">Chance value exceeds price</div><div class="v ${ok(chance) ? (chance >= 0.5 ? "pos" : chance < 0.2 ? "neg" : "") : ""}">${pct(chance, chance < 0.1 ? 1 : 0)}</div><div class="s">at ${px(price)} a share</div></div>
        <div class="metric"><div class="k">Median intrinsic value</div><div class="v">${px(d.median)}</div><div class="s ${tone(vsPrice)}">${pct(vsPrice, 0, true)} against the price</div></div>
        <div class="metric"><div class="k">Growth the price implies</div><div class="v">${pct(r.implied_growth)}</div><div class="s">${pct(p.growth.mean)} fitted from filings</div></div>
        ${dec ? `<div class="metric"><div class="k">${p.horizon}-year return, median</div><div class="v ${tone(dec.return.median)}">${pct(dec.return.median)}</div><div class="s">${pct(dec.return.p_loss, 0)} chance of losing money</div></div>` : ""}
      </div>
    </section>

    <section class="panel">
      <header><h2>Distribution of intrinsic value</h2>
        <span class="right"><span class="seg" id="dist-mode"><button type="button" data-m="hist" class="${state.distMode === "hist" ? "on" : ""}">Histogram</button><button type="button" data-m="exceed" class="${state.distMode === "exceed" ? "on" : ""}">Probability curve</button></span></span></header>
      <div class="split">
        <div><div class="chart tall" id="c-dist"></div></div>
        <div>
          ${d.buckets ? `<table class="grid"><thead><tr><th>Value per share</th><th class="r">Probability</th><th></th></tr></thead><tbody>
            ${d.buckets.map((b) => `<tr><td>${bucketLabel(b)}<div class="muted" style="font-size:13px">${b.hi == null ? `above ${px(b.lo)}` : b.lo_x === 0 ? `below ${px(b.hi)}` : `${px(b.lo)} to ${px(b.hi)}`}</div></td>
              <td class="r">${pct(b.p)}</td><td class="bar-cell"><i style="width:${(b.p * 100).toFixed(1)}%;${b.lo_x >= 1 ? "" : "background:var(--ink-3);opacity:.4"}"></i></td></tr>`).join("")}
          </tbody></table>` : '<div class="empty">Enter a share price to compare.</div>'}
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Expected value</div><div class="v">${px(d.mean)} <small>95% CI ${px(d.mean_ci95[0])}–${px(d.mean_ci95[1])}</small></div></div>
        <div class="stat"><div class="k">90% of outcomes</div><div class="v">${px(d.ranges["90"][0])} – ${px(d.ranges["90"][1])}</div></div>
        <div class="stat"><div class="k">99% of outcomes</div><div class="v">${px(d.ranges["99"][0])} – ${px(d.ranges["99"][1])}</div></div>
        <div class="stat"><div class="k">Cost of capital</div><div class="v">${pct(p.wacc.mean)} <small>${pct(p.wacc.rf, 2)} + ${p.wacc.beta.toFixed(2)} × ${pct(p.wacc.erp, 2)}</small></div></div>
        <div class="stat"><div class="k">Value beyond year ${p.horizon}</div><div class="v">${pct(r.tv_share, 0)} <small>of enterprise value</small></div></div>
      </div>
      <details class="explain"><summary>How to read this</summary>
        <p>Each bar is the share of simulated futures that ended at that value per share; green bars are above today's price. The probability curve reads the other way:
          pick any price and it gives the chance the business is worth more.</p>
        <p>The confidence interval belongs to the expected value itself, which ${num(d.n)} paths pin down closely. The range of outcomes is much wider, and it is the
          range that matters for a decision.</p>
      </details>
    </section>

    ${dec ? decisionHTML(dec, p) : ""}

    <section class="panel">
      <header><h2>What drives the value</h2><span class="sub">one driver at a time, same random draws</span></header>
      <div class="split">
        <div><div class="chart" id="c-tornado"></div></div>
        <div>
          <table class="grid"><thead><tr><th>Share of the spread in value</th><th class="r"></th><th></th></tr></thead><tbody>
            ${[...r.sensitivity].sort((a, b) => b.share - a.share).map((s) => `<tr><td>${esc(DRIVER_NAMES[s.driver] || s.driver)}</td><td class="r">${pct(s.share, 0)}</td><td class="bar-cell"><i style="width:${(s.share * 100).toFixed(1)}%"></i></td></tr>`).join("")}
          </tbody></table>
        </div>
      </div>
      <details class="explain"><summary>Method</summary>
        <p>Left: the median value with each driver held at a low and a high setting while everything else stays random. Right: a standardized rank regression of value on
          each path's draws, with squared coefficients normalized to shares. Together the drivers explain ${pct(r.sensitivity[0]?.r2, 0)} of the rank variance.</p>
      </details>
    </section>

    <section class="panel"><header><h2>Scenarios</h2><span class="sub">paths grouped by the worst economy in years 1–5, then the worst competitive event</span></header>
      <div class="body">${scenarioTree(r.tree, price, d.n)}</div></section>

    <div class="cols c2">
      <section class="panel"><header><h2>Revenue</h2><span class="sub">median with 50% and 90% bands</span></header><div class="chart short" id="c-rev"></div></section>
      <section class="panel"><header><h2>Operating margin</h2><span class="sub">reverting toward ${pct(p.margin.long_run)}</span></header><div class="chart short" id="c-margin"></div></section>
    </div>

    <div class="cols c2">
      ${bayesHTML()}
      <section class="panel"><header><h2>Economy across the paths</h2><span class="sub">regimes fitted to U.S. data since 1961</span></header>
        <table class="grid"><thead><tr><th>Regime</th><th class="r">Share of years</th><th class="r">Paths with one or more</th></tr></thead><tbody>
          ${r.regimes.map((g) => `<tr><td>${esc(g.label)}</td><td class="r">${pct(g.share)}</td><td class="r">${pct(g.ever, 0)}</td></tr>`).join("")}
        </tbody></table>
        <details class="explain"><summary>Where these come from</summary><p>A Markov chain estimated from World Bank GDP and inflation data, 1961–2024. The <a href="#/method">Method</a> page has the transition table.</p></details>
      </section>
    </div>

    ${historyHTML()}`;

  out.querySelectorAll("#dist-mode button").forEach((b) => b.addEventListener("click", () => {
    state.distMode = b.dataset.m;
    out.querySelectorAll("#dist-mode button").forEach((x) => x.classList.toggle("on", x === b));
    drawDistribution(r);
  }));
  drawCharts(r);
  bindDecision();
  bindBayes();
}

function decisionHTML(dec, p) {
  const s = dec.settings, rt = dec.return;
  return `<section class="panel" id="decision">
    <header><h2>Is the price worth paying?</h2><span class="sub">${esc(dec.note)}</span></header>
    <div class="split">
      <table class="grid"><tbody>
        ${dec.checks.map((c) => `<tr><td style="width:44px"><span class="check ${c.pass ? "ok" : "no"}">${c.pass ? "✓" : "✕"}</span></td><td>${esc(c.test)}</td><td class="r ${c.pass ? "" : "muted"}">${pct(c.value)}</td></tr>`).join("")}
      </tbody></table>
      <div class="stats" style="padding-top:14px">
        <div class="stat"><div class="k">Expected value against price</div><div class="v ${tone(dec.upside_expected)}">${pct(dec.upside_expected, 0, true)}</div></div>
        <div class="stat"><div class="k">5th-percentile value</div><div class="v">${px(dec.p5_value)}</div></div>
        <div class="stat"><div class="k">${p.horizon}-year return range</div><div class="v">${pct(rt.p5, 0)} to ${pct(rt.p95, 0)} <small>a year</small></div></div>
        <div class="stat"><div class="k">Certainty equivalent</div><div class="v">${pct(rt.certainty_equivalent, 2)} <small>vs. ${pct(rt.risk_free, 2)}</small></div></div>
        <div class="stat"><div class="k">Kelly fraction</div><div class="v">${pct(dec.kelly, 0)}</div></div>
        <div class="stat"><div class="k">Value 30%+ below price</div><div class="v">${pct(dec.p_value_below_70, 0)}</div></div>
      </div>
    </div>
    <details class="explain"><summary>Decision settings</summary>
      <p style="display:flex;flex-wrap:wrap;gap:12px 20px;margin:8px 0 10px">
        <label class="inline-input">Margin of safety <input class="field" data-d="margin_of_safety" value="${s.margin_of_safety * 100}">%</label>
        <label class="inline-input">Max chance of loss <input class="field" data-d="max_loss" value="${s.max_loss * 100}">%</label>
        <label class="inline-input">Risk aversion <input class="field" data-d="risk_aversion" value="${s.risk_aversion}"></label>
        <label class="inline-input">Position size <input class="field" data-d="position" value="${s.position * 100}">%</label>
      </p>
      <p>Returns assume the owner collects free cash flow after interest each year and sells at intrinsic value in year ${p.horizon}. The certainty equivalent is for a
        position of this size in a portfolio otherwise held in Treasuries, under constant relative risk aversion. Kelly maximizes expected log wealth over the
        simulated outcomes; most investors who use it bet half.</p>
    </details>
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
  return `<section class="panel" id="bayes"><header><h2>Update on new results</h2><span class="sub">Bayesian update of long-run growth</span></header>
    <div class="stats">
      <div class="stat"><div class="k">Current belief</div><div class="v">${pct(g.mean)} <small>± ${pct(g.se)}</small></div></div>
      <div class="stat"><div class="k">Latest quarter${q ? `, ended ${esc(q.end)}` : ""}</div><div class="v ${tone(q?.growth)}">${q ? `${pct(q.growth, 1, true)} <small>year over year</small>` : "None reported"}</div></div>
      <div class="stat"><div class="k">Reading to use (log growth)</div><div class="v"><label class="inline-input"><input class="field" style="width:76px" id="b-obs" value="${(obs * 100).toFixed(2)}">%</label></div></div>
      <div class="stat"><div class="k">Noise in one reading</div><div class="v"><label class="inline-input"><input class="field" style="width:76px" id="b-noise" value="${(g.sd * 100).toFixed(2)}">%</label></div></div>
    </div>
    <div style="padding:0 22px 16px"><button class="btn small" id="b-apply" type="button">Apply update and rerun</button></div>
    <div id="b-result"></div>
    <details class="explain"><summary>How the update works</summary><p>One quarter's year-over-year growth is treated as a single noisy reading of the long-run rate,
      with the noise of a normal year's surprise. Belief and reading are combined by precision, and the result replaces the growth assumption.</p></details>
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
      readFields($("#inputs"), state.fit.params);
      state.lastUpdate = u;
      await simulate();
    } catch (e) {
      $("#b-result").innerHTML = failure("Update failed", e);
    }
  });
  const u = state.lastUpdate;
  if (u) {
    $("#b-result").innerHTML = `<table class="grid"><thead><tr><th></th><th class="r">Mean</th><th class="r">Sd</th></tr></thead><tbody>
      <tr><td>Before</td><td class="r">${pct(u.prior.mean, 2)}</td><td class="r">${pct(u.prior.sd, 2)}</td></tr>
      <tr><td>New reading</td><td class="r">${pct(u.observation.value, 2)}</td><td class="r">${pct(u.observation.sd, 2)}</td></tr>
      <tr class="total"><td>After</td><td class="r">${pct(u.posterior.mean, 2)}</td><td class="r">${pct(u.posterior.sd, 2)}</td></tr></tbody></table>
      <div class="chart short" id="c-bayes"></div>
      <p class="muted" style="margin:0 22px 14px;font-size:13.5px">The new reading got ${pct(u.weight_on_data, 0)} of the weight: a precise belief moves little, a vague one moves a lot.</p>`;
    const xs = [], pdf = (m, s) => xs.map((x) => Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI)));
    const lo = Math.min(u.prior.mean - 3.5 * u.prior.sd, u.observation.value - 2 * u.observation.sd);
    const hi = Math.max(u.prior.mean + 3.5 * u.prior.sd, u.observation.value + 2 * u.observation.sd);
    for (let i = 0; i <= 120; i++) xs.push(lo + ((hi - lo) * i) / 120);
    chart($("#c-bayes"), [
      { x: xs.map((x) => x * 100), y: pdf(u.prior.mean, u.prior.sd), mode: "lines", name: "Before", line: { color: color(6), dash: "dot" } },
      { x: xs.map((x) => x * 100), y: pdf(u.observation.value, u.observation.sd), mode: "lines", name: "New reading", line: { color: color(2), width: 1.5 } },
      { x: xs.map((x) => x * 100), y: pdf(u.posterior.mean, u.posterior.sd), mode: "lines", name: "After", line: { color: color(0), width: 2.5 }, fill: "tozeroy", fillcolor: hexA(color(0), 0.08) },
    ], { showlegend: true, xaxis: { ticksuffix: "%" }, yaxis: { showticklabels: false, showgrid: false }, margin: { l: 16 } });
  }
}

function historyHTML() {
  const f = state.fit;
  const fg = f.fit.growth, fm = f.fit.margin, pr = f.fit.priors;
  const coef = (label, post, se, ols, prior, fmt = (v) => v.toFixed(3)) =>
    `<tr><td>${label}</td><td class="r">${fmt(post)} <span class="muted">± ${fmt(se)}</span></td><td class="r muted">${ols == null ? "—" : fmt(ols)}</td><td class="r muted">${fmt(prior[0])} ± ${fmt(prior[1])}</td></tr>`;
  return `<details class="panel" style="padding-bottom:0"><summary style="cursor:pointer;padding:18px 22px;list-style:none"><h2 style="display:inline;font-size:15px">How the model was fitted</h2>
      <span class="muted" style="margin-left:10px;font-size:13px">${f.fit.n} years of 10-K data, Bayesian regressions, fitted coefficients</span></summary>
    <div class="split" style="border-top:1px solid var(--line-2)">
      <div class="scroll"><table class="grid"><thead><tr><th>FY</th><th class="r">Revenue</th><th class="r">Growth</th><th class="r">Margin</th><th>U.S. economy</th><th class="r">Capex</th><th class="r">D&amp;A</th></tr></thead><tbody>
        ${[...f.history].reverse().map((h) => `<tr><td>${h.fy}</td><td class="r">${money(h.revenue)}</td><td class="r ${tone(h.growth)}">${pct(h.growth)}</td><td class="r">${pct(h.margin)}</td>
          <td>${esc(REGIMES.find((r) => r[0] === h.regime)?.[1] || "—")}</td><td class="r">${money(h.capex)}</td><td class="r">${money(h.dna)}</td></tr>`).join("")}
      </tbody></table></div>
      <div>
        <table class="grid"><thead><tr><th>Coefficient</th><th class="r">Posterior</th><th class="r">Least squares</th><th class="r">Prior</th></tr></thead><tbody>
          <tr class="sub"><td colspan="4">Log revenue growth</td></tr>
          ${coef("Intercept", fg.coef[0], fg.se[0], fg.ols[0], pr.growth_intercept)}
          ${coef("Real GDP gap", fg.coef[1], fg.se[1], fg.ols[1], pr.growth_gdp)}
          ${coef("Inflation gap", fg.coef[2], fg.se[2], fg.ols[2], pr.growth_cpi)}
          <tr class="sub"><td colspan="4">Change in operating margin</td></tr>
          ${coef("Reversion speed", fm.coef[0], fm.se[0], fm.ols?.[0], pr.margin_kappa)}
          ${coef("Real GDP gap", fm.coef[1], fm.se[1], fm.ols?.[1], pr.margin_gdp)}
          ${coef("Inflation gap", fm.coef[2], fm.se[2], fm.ols?.[2], pr.margin_cpi)}
        </tbody></table>
        <div class="stats">
          <div class="stat"><div class="k">Growth residual sd</div><div class="v">${pct(fg.resid_sd)}</div></div>
          <div class="stat"><div class="k">Excess kurtosis</div><div class="v">${ok(fg.kurtosis) ? fg.kurtosis.toFixed(2) : "—"}</div></div>
          <div class="stat"><div class="k">Sales to capital, raw → used</div><div class="v">${ok(f.fit.sales_to_capital_raw) ? f.fit.sales_to_capital_raw.toFixed(2) : "—"} → ${f.params.reinvest.sales_to_capital.toFixed(2)}</div></div>
          <div class="stat"><div class="k">Shock correlation, raw → used</div><div class="v">${f.fit.corr_raw.toFixed(2)} → ${f.params.corr.toFixed(2)}</div></div>
          <div class="stat"><div class="k">Return on capital, last FY</div><div class="v">${pct(f.fit.roic)}</div></div>
          <div class="stat"><div class="k">Beta, raw → adjusted</div><div class="v">${f.fit.beta ? `${f.fit.beta.raw.toFixed(2)} → ${f.fit.beta.adjusted.toFixed(2)}` : "—"}</div></div>
        </div>
      </div>
    </div>
    <details class="explain"><summary>Why priors</summary><p>Gaps are each year's GDP growth and inflation minus their 1961–2024 averages. With a dozen observations, least squares lets one odd
      year set a coefficient; the priors pull uncertain estimates toward ordinary values. The least-squares column shows what the data alone would say.</p></details>
  </details>`;
}

const vline = (x, c, dash = "solid") => ({ type: "line", x0: x, x1: x, yref: "paper", y0: 0, y1: 1, line: { color: c, width: 1.5, dash } });
const tag = (x, text, c, y = 1) => ({ x, yref: "paper", y, text, showarrow: false, yanchor: "bottom", font: { size: 11.5, color: "#fff" }, bgcolor: c, borderpad: 3 });

function drawDistribution(r) {
  const d = r.distribution, price = r.params.price;
  const el = $("#c-dist");
  if (state.distMode === "exceed") {
    const c = color(0);
    chart(el, [{ x: d.exceed.x, y: d.exceed.p.map((v) => v * 100), mode: "lines", line: { color: c, width: 2.5, shape: "spline" }, fill: "tozeroy", fillcolor: hexA(c, 0.08), hovertemplate: "Worth more than $%{x:,.0f}: %{y:.1f}%<extra></extra>" }],
      { shapes: price ? [vline(price, css("--ink-2"), "dot")] : [], annotations: price ? [tag(price, `price ${px(price)}`, css("--ink-2"))] : [], xaxis: { tickprefix: "$" }, yaxis: { ticksuffix: "%", range: [0, 104] }, margin: { t: 28 } });
    return;
  }
  const e = d.histogram.edges;
  const mids = e.slice(0, -1).map((x, i) => (x + e[i + 1]) / 2);
  const above = mids.map((m) => price && m >= price);
  const shapes = [vline(d.median, color(0), "dot")];
  const notes = [tag(d.median, `median ${px(d.median)}`, color(0))];
  if (price) { shapes.push(vline(price, css("--ink-2"), "dot")); notes.push(tag(price, `price ${px(price)}`, css("--ink-2"), 0.86)); }
  chart(el, [{ type: "bar", x: mids, y: d.histogram.counts.map((v) => v * 100), marker: { color: above.map((a) => (a ? css("--pos") : hexA(color(0), 0.55))) }, hovertemplate: "$%{x:,.0f}: %{y:.2f}% of paths<extra></extra>" }],
    { shapes, annotations: notes, xaxis: { tickprefix: "$" }, yaxis: { ticksuffix: "%" }, margin: { t: 28 } });
}

function drawCharts(r) {
  drawDistribution(r);
  if (r.tornado) {
    const t = [...r.tornado].reverse();
    const base = t[0].base;
    chart($("#c-tornado"), [
      { type: "bar", orientation: "h", y: t.map((x) => x.driver), x: t.map((x) => Math.min(x.low, x.high) - base), base, marker: { color: hexA(css("--neg"), 0.65) }, customdata: t.map((x) => x.setting), hovertemplate: "%{customdata}<br>%{x:$,.2f} against the median<extra></extra>" },
      { type: "bar", orientation: "h", y: t.map((x) => x.driver), x: t.map((x) => Math.max(x.low, x.high) - base), base, marker: { color: hexA(color(0), 0.75) }, customdata: t.map((x) => x.setting), hovertemplate: "%{customdata}<br>+%{x:$,.2f} against the median<extra></extra>" },
    ], { barmode: "overlay", bargap: 0.35, xaxis: { tickprefix: "$", showgrid: true, gridcolor: css("--line-2"), griddash: "dot" }, yaxis: { showgrid: false }, margin: { l: 130 },
      shapes: [{ type: "line", x0: base, x1: base, yref: "paper", y0: 0, y1: 1, line: { color: css("--ink-3"), width: 1 } }] });
  }
  const years = r.fan.revenue.p50.map((_, i) => i + 1);
  chart($("#c-rev"), fanTraces(years, r.fan.revenue, 0, "Revenue", 1e-9), { yaxis: { tickprefix: "$", ticksuffix: "B" }, xaxis: { dtick: 1, title: { text: "Year", font: { size: 11.5 } } } });
  chart($("#c-margin"), fanTraces(years, r.fan.margin, 1, "Margin", 100), { yaxis: { ticksuffix: "%" }, xaxis: { dtick: 1, title: { text: "Year", font: { size: 11.5 } } } });
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
