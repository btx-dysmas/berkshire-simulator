// Berkshire Hathaway: float, subsidiaries and capital allocation, simulated per share.
import { $, api, bn, chart, color, esc, failure, fanTraces, loading, num, ok, onTheme, pct, post, px, tone } from "../lib.js";
import { fieldsHTML, readFields } from "../forms.js";

const GROUPS = [
  ["Insurance", [
    ["insurance.combined_ratio", "Combined ratio, average", "num", "Below 1.00 means underwriting makes money"],
    ["insurance.combined_ratio_sd", "Combined ratio, yearly sd", "num"],
    ["insurance.cat_prob", "Catastrophe year, odds", "pct", "Adds 4 to 12 points to the combined ratio"],
    ["insurance.premium_growth", "Premium growth, real", "pct"],
  ]],
  ["Investments", [
    ["investments.bill_long_run", "T-bill yield, long run", "pct"],
    ["investments.dividend_yield", "Portfolio dividend yield", "pct"],
    ["investments.retained_yield", "Investees' retained earnings yield", "pct", "Earnings yield less dividends"],
    ["investments.portfolio_beta", "Portfolio beta", "num"],
  ]],
  ["Operating subsidiaries (after-tax earnings)", [
    ["subsidiaries.bnsf.earnings", "BNSF", "bn"],
    ["subsidiaries.bnsf.retention", "BNSF: share retained", "num"],
    ["subsidiaries.bhe.earnings", "BHE", "bn"],
    ["subsidiaries.bhe.event_prob", "BHE: wildfire-type loss, odds/yr", "pct"],
    ["subsidiaries.msr.earnings", "Manufacturing, service, retail", "bn"],
    ["subsidiaries.msr.roic", "MSR: return on retained earnings", "pct"],
    ["subsidiaries.msr.multiple", "Value multiple for MSR", "num"],
  ]],
  ["Acquisitions", [
    ["acquisitions.prob", "Chance of a deal each year", "pct"],
    ["acquisitions.size_median", "Typical deal size", "bn"],
    ["acquisitions.multiple.1", "Typical price, x earnings", "num"],
    ["acquisitions.value_multiple", "Value once owned, x earnings", "num"],
    ["acquisitions.funding", "Paid for with", "sel", [["cash", "Cash"], ["stock", "Berkshire stock"], ["cash_then_stock", "Cash, then stock"]]],
  ]],
  ["Capital allocation", [
    ["policy.min_cash", "Cash never below", "bn"],
    ["policy.buyback", "Buybacks", "sel", [["below_value", "Only below value"], ["always", "At any price"], ["never", "Never"]]],
    ["policy.buyback_threshold", "Buy when price / value below", "num"],
    ["policy.buyback_max_share", "Most bought in a year, of market value", "pct"],
    ["policy.dividend_payout", "Dividend, share of operating earnings", "pct"],
    ["policy.equity_allocation", "Spare cash into stocks each year", "pct"],
  ]],
  ["Valuation", [
    ["valuation.float_rate", "Discount rate for float", "pct", "Debt-like, so near the risk-free rate"],
    ["valuation.price_to_value_long_run", "Price / value, long run", "num"],
    ["horizon", "Years", "num"],
    ["start_regime", "Starting regime", "sel", [["expansion", "Expansion"], ["neutral", "Neutral"], ["inflation", "High inflation"], ["recession", "Recession"], ["crisis", "Severe crisis"]]],
  ]],
];

let st = null;

export async function render(root) {
  document.title = "Berkshire Hathaway model · Berkshire Simulator";
  root.innerHTML = loading("Loading Berkshire's balance sheet");
  let d;
  try { d = await api("/berkshire/defaults"); } catch (e) { root.innerHTML = failure("Could not load the model", e); return; }
  st = { base: d.params, seed: d.seed, result: null, policies: null };
  const s = d.seed, b = d.params.balance;
  root.innerHTML = `
    <div class="co">
      <h1>Berkshire Hathaway</h1><span class="tk">BRK.A</span>
      <div class="facts">
        <span><b>Price</b>${px(d.params.price_per_share)}</span>
        <span><b>Book value / share</b>${px(b.book_value / b.shares * 1e3)}</span>
        <span><b>Float</b>${bn(s.float)}</span>
        <span><b>Cash and T-bills</b>${bn(s.cash_and_tbills)}</span>
        <span><b>Stocks</b>${bn(s.equities_fair_value)}</span>
        <span><b>Operating earnings, 2025</b>${bn(s.earnings_2025.operating)}</span>
        <span><b>Balance sheet as of</b>${esc(s.as_of)}</span>
      </div>
    </div>
    <p class="lede">Berkshire is not revenue and margins, so this model simulates its balance sheet instead: underwriting and float, the T-bill pile, the stock portfolio, the subsidiaries, and a capital allocation policy. Everything is tracked per share.</p>
    <div class="bench">
      <form class="panel inputs" id="inputs" autocomplete="off">
        <header><h2>Assumptions</h2><span class="sub">seeded from the 10-Q</span></header>
        ${fieldsHTML(GROUPS, d.params)}
        <div class="actions"><button class="btn primary" id="run">Run simulation</button></div>
      </form>
      <div>
        <div id="out">${loading("Simulating 10,000 paths")}</div>
        <div id="policies"></div>
        ${labHTML(d)}
      </div>
    </div>`;
  const form = $("#inputs");
  form.addEventListener("input", () => readFields(form, st.base));
  form.addEventListener("submit", (e) => { e.preventDefault(); run(); });
  bindLab();
  onTheme(() => { if (st.result) draw(st.result); if (st.policies) drawPolicies(st.policies); });
  run();
}

async function run() {
  const overrides = readFields($("#inputs"), st.base);
  $("#out").classList.add("busy");
  $("#run").disabled = true;
  try {
    const [r, cmp] = await Promise.all([post("/berkshire", { overrides }), post("/berkshire/compare", { overrides })]);
    st.result = r;
    st.policies = cmp;
    // The worked example starts from the model's own estimate of intrinsic value.
    const iv = $("#lab-intrinsic_value");
    if (iv && !iv.dataset.touched) { iv.value = Math.round(r.summary.start.iv); lab(); }
    draw(r);
    drawPolicies(cmp);
  } catch (e) {
    $("#out").innerHTML = failure("Simulation failed", e);
  } finally {
    $("#out").classList.remove("busy");
    $("#run").disabled = false;
  }
}

const range = (q, f = pct) => `${f(q.p5)} to ${f(q.p95)}`;

function draw(r) {
  const s = r.summary, g = s.growth, p = r.params;
  const fl = s.float, al = s.allocation, e = s.earnings;
  const p2v = s.start.price / s.start.iv_ps;
  const swing = e.volatility.gaap / e.volatility.op;
  $("#out").innerHTML = `
    <section class="panel hero">
      <div class="hero-top"><h2>10,000 simulated decades · balance sheet as of the June 2026 10-Q</h2></div>
      <p class="claim">The model values Berkshire at <b>${px(s.start.iv_ps)}</b> a Class A share, against a price of ${px(s.start.price)}.
        Value per share compounds at about <b>${pct(g.iv_ps.p50)}</b> a year in the median future, and a buyer at today's price earns ${pct(g.holder.p50)}
        because the stock ${p2v > 1 ? "starts at a premium to" : "starts below"} its value.</p>
      <div class="metrics">
        <div class="metric"><div class="k">Intrinsic value per share</div><div class="v">${px(s.start.iv_ps)}</div><div class="s">price is ${p2v.toFixed(2)}x value</div></div>
        <div class="metric"><div class="k">Value per share growth</div><div class="v">${pct(g.iv_ps.p50)}</div><div class="s">${range(g.iv_ps)} a year</div></div>
        <div class="metric"><div class="k">Return from today's price</div><div class="v">${pct(g.holder.p50)}</div><div class="s">${pct(g.p_holder_loss, 0)} chance of a loss</div></div>
        <div class="metric"><div class="k">Economic cost of float</div><div class="v">${bn(fl.start_liability, 0)}</div><div class="s">carried at ${bn(fl.start, 1)} in book value</div></div>
      </div>
    </section>

    <section class="panel"><header><h2>Value per share</h2><span class="sub">intrinsic value with 50% and 90% bands; median price and book value</span></header>
      <div class="chart tall" id="b-iv"></div>
      <div class="stats">
        <div class="stat"><div class="k">Book value per share growth</div><div class="v">${pct(g.bv_ps.p50)} <small>${range(g.bv_ps)}</small></div></div>
        <div class="stat"><div class="k">Operating earnings growth, total</div><div class="v">${pct(g.op_total.p50)}</div></div>
        <div class="stat"><div class="k">Operating earnings growth, per share</div><div class="v">${pct(g.op_ps.p50)}</div></div>
        <div class="stat"><div class="k">Shares outstanding, year ${p.horizon}</div><div class="v">${pct(al.share_change, 1, true)}</div></div>
      </div>
      <details class="explain"><summary>How intrinsic value is built</summary>
        <p>A sum of the parts: cash and bonds at face, stocks less the tax owed on their gains, each subsidiary at a multiple of its earnings, minus parent debt and the
          economic cost of the float. The stock trades around that value with a discount or premium that reverts over time and widens in recessions.</p>
      </details>
    </section>

    <div class="cols c2">
      <section class="panel"><header><h2>Three measures of earnings</h2><span class="sub">one simulated path</span></header>
        <div class="chart short" id="b-earn"></div>
        <table class="grid"><thead><tr><th>Measure</th><th class="r">Year 1, median</th><th class="r">Typical yearly swing</th></tr></thead><tbody>
          <tr><td>GAAP net income</td><td class="r">${bn(e.median.gaap[0])}</td><td class="r">${pct(e.volatility.gaap, 0)}</td></tr>
          <tr><td>Operating earnings</td><td class="r">${bn(e.median.op[0])}</td><td class="r">${pct(e.volatility.op, 0)}</td></tr>
          <tr><td>Look-through earnings</td><td class="r">${bn(e.median.look[0])}</td><td class="r">${pct(e.volatility.look, 0)}</td></tr>
        </tbody></table>
        <details class="explain"><summary>Why GAAP swings ${Math.round(swing)} times as much</summary>
          <p>Since 2018 GAAP has run the change in unrealized gains on stocks through net income, so it moves with the market. Operating earnings leave that out.
            Look-through earnings add Berkshire's share of what its investees earned and kept, less the tax due if it were paid out.</p>
        </details>
      </section>
      <section class="panel"><header><h2>Float is a liability, not equity</h2></header>
        <div class="stats">
          <div class="stat"><div class="k">Book value carries it at</div><div class="v">${bn(fl.start)}</div></div>
          <div class="stat"><div class="k">Present value of its cost</div><div class="v">${bn(fl.start_liability)}</div></div>
          <div class="stat"><div class="k">Cost of float per year</div><div class="v ${tone(-fl.cost.p50)}">${pct(fl.cost.p50)} <small>${range(fl.cost)}</small></div></div>
          <div class="stat"><div class="k">Float in year ${p.horizon}</div><div class="v">${bn(fl.end, 0)}</div></div>
        </div>
        <div class="chart short" id="b-float"></div>
        <details class="explain"><summary>How the float is valued</summary>
          <p>Float arrives as cash and is invested, but it belongs to policyholders. Book value carries it at face. Intrinsic value carries it at the present value of the claims
            and underwriting results it will cost, discounted at ${pct(p.valuation.float_rate)}, growing for ${p.valuation.float_growth_years} years and then running off. A negative
            cost means underwriting is profitable and Berkshire is paid to hold the money; as the combined ratio rises the liability climbs toward face value.</p>
        </details>
      </section>
    </div>

    <section class="panel"><header><h2>Where the cash went</h2><span class="sub">average across paths, ${p.horizon} years</span></header>
      <div class="split">
        <table class="grid"><tbody>
          <tr><td>Acquisitions paid in cash</td><td class="r">${bn(al.acq_cash, 0)}</td></tr>
          <tr><td>Acquisitions paid in stock</td><td class="r">${bn(al.acq_stock, 0)}</td></tr>
          <tr><td>Buybacks</td><td class="r">${bn(al.buyback, 0)}</td></tr>
          <tr><td>Dividends</td><td class="r">${bn(al.dividends, 0)}</td></tr>
          <tr><td>New stock purchases</td><td class="r">${bn(al.eq_buy, 0)}</td></tr>
          <tr class="total"><td>Cash and T-bills at the end, median</td><td class="r">${bn(al.ending_cash, 0)}</td></tr>
        </tbody></table>
        <div class="stats" style="padding-top:14px">
          <div class="stat"><div class="k">Acquisitions per path</div><div class="v">${s.acquisitions.per_path.toFixed(1)}</div></div>
          <div class="stat"><div class="k">Deals that raised value per share</div><div class="v">${pct(s.acquisitions.accretive_share, 0)}</div></div>
          <div class="stat"><div class="k">Change in share count</div><div class="v">${pct(al.share_change, 1, true)}</div></div>
        </div>
      </div>
    </section>`;

  const years = s.years;
  const x0 = [0, ...years];
  const withStart = (f, v) => Object.fromEntries(Object.entries(f).map(([k, a]) => [k, [v, ...a]]));
  chart($("#b-iv"), [
    ...fanTraces(x0, withStart(s.fans.iv_ps, s.start.iv_ps), 0, "Intrinsic value"),
    { x: x0, y: [s.start.bv_ps, ...s.fans.bv_ps.p50], mode: "lines", name: "Book value", line: { color: color(2), width: 1.5, dash: "dot" } },
    { x: x0, y: [s.start.price, ...s.fans.price.p50], mode: "lines", name: "Price", line: { color: color(4), width: 1.5 } },
  ], { showlegend: true, yaxis: { tickprefix: "$" }, xaxis: { dtick: 1, title: { text: "Year" } } });
  chart($("#b-earn"), [
    { type: "bar", x: years, y: e.sample.gaap, name: "GAAP net income", marker: { color: color(6) } },
    { x: years, y: e.sample.op, mode: "lines+markers", name: "Operating", line: { color: color(0), width: 2 } },
    { x: years, y: e.sample.look, mode: "lines+markers", name: "Look-through", line: { color: color(2), width: 2 } },
  ], { showlegend: true, bargap: 0.35, yaxis: { tickprefix: "$", ticksuffix: "B" }, xaxis: { dtick: 1 } });
  chart($("#b-float"), fanTraces(x0, withStart(s.fans.float, s.start.float), 1, "Float"), { yaxis: { tickprefix: "$", ticksuffix: "B" }, xaxis: { dtick: 1 } });
}

function drawPolicies(rows) {
  const base = rows[0];
  $("#policies").innerHTML = `<section class="panel"><header><h2>Capital allocation policies, same futures</h2><span class="sub">6,000 paths each, common random numbers</span></header>
    <div class="scroll"><table class="grid"><thead><tr><th>Policy</th><th class="r">Value / share growth, median</th><th class="r">10th–90th</th>
      <th class="r">Operating earnings growth, total</th><th class="r">Per share</th><th class="r">Beats your settings</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.key === "baseline" ? "on" : ""}"><td>${esc(r.label)}</td><td class="r">${pct(r.median, 2)}</td>
        <td class="r muted">${pct(r.p10)} to ${pct(r.p90)}</td>
        <td class="r ${r.key !== "baseline" ? tone(r.op_total - base.op_total) : ""}">${pct(r.op_total, 2)}</td>
        <td class="r ${r.key !== "baseline" ? tone(r.op_ps - base.op_ps) : ""}">${pct(r.op_ps, 2)}</td>
        <td class="r">${r.beats_baseline == null ? "—" : pct(r.beats_baseline, 0)}</td></tr>`).join("")}
    </tbody></table></div>
    <details class="explain"><summary>How to read this</summary><p>Every policy runs on the same simulated economies, underwriting years and deal offers, so a difference comes from the policy.
      Value per share includes dividends received. Compare total and per-share earnings growth: issuing stock for acquisitions adds earnings in
      total and subtracts them per share whenever the shares given up were worth more than what they bought.</p></details></section>`;
}

function labHTML(d) {
  const b = d.params.balance;
  const inputs = [
    ["target_earnings", "Target's after-tax earnings", 1.0, "$B"],
    ["price", "Price paid", 22, "$B"],
    ["multiple", "What those earnings are worth, x", 15, ""],
    ["price_to_value", "Berkshire's price / intrinsic value", 0.85, ""],
    ["operating_earnings", "Berkshire operating earnings", d.seed.earnings_2025.operating, "$B"],
    ["intrinsic_value", "Berkshire intrinsic value", b.book_value, "$B"],
    ["shares", "Shares, millions of A-equivalent", b.shares, ""],
    ["bill_yield", "T-bill yield given up (cash deals)", d.params.investments.bill_yield, ""],
  ];
  return `<section class="panel" id="lab"><header><h2>One acquisition, worked through</h2><span class="sub">why total earnings can rise while value per share falls</span>
      <span class="right"><span class="seg" id="lab-fund"><button type="button" class="on" data-f="stock">Pay in stock</button><button type="button" data-f="cash">Pay in cash</button></span></span></header>
    <div class="split">
      <div class="inputs" style="position:static;max-height:none"><div class="rows" style="padding:8px 22px 12px">${inputs.map(([k, l, v, u]) => `<div class="row"><label for="lab-${k}">${esc(l)}${u ? ` <span class="muted">${u}</span>` : ""}</label><input class="field" id="lab-${k}" data-k="${k}" value="${+(+v).toPrecision(5)}"></div>`).join("")}</div></div>
      <div id="lab-out"></div>
    </div>
    <details class="explain"><summary>Why a stock deal can destroy value</summary><p>A stock deal hands sellers a share of everything Berkshire owns. If Berkshire's stock trades below its value, each share given up
      is worth more than its price, so the deal must earn more than it costs on paper just to break even per share. This is the arithmetic behind
      Buffett's regret over paying for General Re with stock in 1998.</p></details>
  </section>`;
}

let fund = "stock";
function bindLab() {
  const box = $("#lab");
  box.querySelectorAll("#lab-fund button").forEach((b) => b.addEventListener("click", () => {
    fund = b.dataset.f;
    box.querySelectorAll("#lab-fund button").forEach((x) => x.classList.toggle("on", x === b));
    lab();
  }));
  box.querySelectorAll("input[data-k]").forEach((el) => el.addEventListener("input", () => { el.dataset.touched = "1"; lab(); }));
  lab();
}

async function lab() {
  const body = { funding: fund };
  for (const el of $("#lab").querySelectorAll("input[data-k]")) body[el.dataset.k] = parseFloat(el.value);
  if (Object.values(body).some((v) => typeof v === "number" && !Number.isFinite(v))) return;
  try {
    const r = await post("/berkshire/deal", body);
    const row = (label, a, b, c, f) => `<tr><td>${label}</td><td class="r">${f(a)}</td><td class="r">${f(b)}</td><td class="r ${tone(c)}">${pct(c, 1, true)}</td></tr>`;
    const perShare = (v) => px(v * 1e3); // $B per million shares is thousands of dollars per share
    $("#lab-out").innerHTML = `<table class="grid"><thead><tr><th></th><th class="r">Before</th><th class="r">After</th><th class="r">Change</th></tr></thead><tbody>
      ${row("Operating earnings", r.before.earnings, r.after.earnings, r.change.earnings, (v) => bn(v, 2))}
      ${row("Shares, millions", r.before.shares, r.after.shares, r.after.shares / r.before.shares - 1, (v) => num(v, 4))}
      ${row("Earnings per share", r.before.eps, r.after.eps, r.change.eps, perShare)}
      ${row("Intrinsic value per share", r.before.iv_ps, r.after.iv_ps, r.change.iv_ps, perShare)}
    </tbody></table>
    <dl class="kv">
      <dt>Berkshire share price used</dt><dd>${perShare(r.share_price)}</dd>
      <dt>Value received</dt><dd>${bn(r.value_received)} for ${bn(body.price)}</dd>
      ${r.new_shares ? `<dt>New shares issued</dt><dd>${num(r.new_shares * 1e6)}</dd>` : `<dt>Interest given up, after tax</dt><dd>${bn(r.lost_interest, 2)} a year</dd>`}
      ${ok(r.breakeven_earnings) ? `<dt>Earnings needed to break even per share</dt><dd>${bn(r.breakeven_earnings, 2)}</dd>` : ""}
    </dl>`;
  } catch (e) {
    $("#lab-out").innerHTML = failure("Could not compute the deal", e);
  }
}
