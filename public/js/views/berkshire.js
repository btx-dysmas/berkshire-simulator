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
    <p class="lede">The company valuation treats a business as revenue, margins and reinvestment. That does not describe Berkshire. Here the
      balance sheet is simulated directly: underwriting results and float, interest on the T-bill pile, a stock portfolio that moves with the
      market regime, subsidiaries that keep part of what they earn, and a capital allocation policy deciding where the rest goes. Everything is
      tracked per share.</p>
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

const band = (q, f = pct) => `${f(q.p50)} <span class="muted">(${f(q.p5)} to ${f(q.p95)})</span>`;

function draw(r) {
  const s = r.summary, g = s.growth, p = r.params;
  const fl = s.float, al = s.allocation, e = s.earnings;
  const p2v = s.start.price / s.start.iv_ps;
  $("#out").innerHTML = `
    <section class="panel">
      <header><h2>Value per share over ${p.horizon} years</h2><span class="sub">10,000 paths</span></header>
      <dl class="kv two">
        <dt>Intrinsic value / share today</dt><dd>${px(s.start.iv_ps)}</dd>
        <dt>Price / intrinsic value</dt><dd>${p2v.toFixed(2)}</dd>
        <dt>Intrinsic value / share, yearly growth</dt><dd>${band(g.iv_ps)}</dd>
        <dt>Book value / share, yearly growth</dt><dd>${band(g.bv_ps)}</dd>
        <dt>Shareholder return from today's price</dt><dd>${band(g.holder)}</dd>
        <dt>Chance the stock is lower in year ${p.horizon}</dt><dd>${pct(g.p_holder_loss)}</dd>
        <dt>Operating earnings growth, total</dt><dd>${pct(g.op_total.p50)}</dd>
        <dt>Operating earnings growth, per share</dt><dd>${pct(g.op_ps.p50)}</dd>
      </dl>
      <div class="note">Intrinsic value is a sum of the parts: cash and bonds at face, stocks after the tax owed on their gains, each subsidiary at a
        multiple of its earnings, less parent debt and the <b>economic</b> cost of the float (below). The stock trades around that value with a
        mean-reverting discount or premium that widens in recessions; the shareholder return assumes it is sold at that price.</div>
    </section>
    <section class="panel"><header><h2>Per-share value paths</h2><span class="sub">intrinsic value with 25–75th and 5–95th percentile bands; medians for book value and price</span></header>
      <div class="chart" id="b-iv"></div></section>

    <div class="cols c2">
      <section class="panel"><header><h2>Three measures of earnings</h2><span class="sub">one simulated path</span></header>
        <div class="chart short" id="b-earn"></div>
        <table class="grid"><thead><tr><th>Measure</th><th class="r">Year 1, median</th><th class="r">Typical yearly swing</th></tr></thead><tbody>
          <tr><td>GAAP net income</td><td class="r">${bn(e.median.gaap[0])}</td><td class="r">${pct(e.volatility.gaap, 0)}</td></tr>
          <tr><td>Operating earnings</td><td class="r">${bn(e.median.op[0])}</td><td class="r">${pct(e.volatility.op, 0)}</td></tr>
          <tr><td>Look-through earnings</td><td class="r">${bn(e.median.look[0])}</td><td class="r">${pct(e.volatility.look, 0)}</td></tr>
        </tbody></table>
        <div class="note">Since 2018 GAAP has put the change in unrealized gains on stocks through net income, so it swings with the market. Operating
          earnings leave that out. Look-through earnings add Berkshire's share of what its investees earned and kept, less the tax due if it were
          paid out: closer to what the stock portfolio actually earns. The swing is the standard deviation of year-over-year change.</div>
      </section>
      <section class="panel"><header><h2>Float is a liability, not equity</h2></header>
        <dl class="kv">
          <dt>Float on the balance sheet</dt><dd>${bn(fl.start)}</dd>
          <dt>Carried in book value at</dt><dd>${bn(fl.start)} liability</dd>
          <dt>Present value of what it will cost</dt><dd>${bn(fl.start_liability)}</dd>
          <dt>Float in year ${p.horizon}, median</dt><dd>${bn(fl.end)}</dd>
          <dt>Cost of float, average per year</dt><dd class="${tone(-fl.cost.p50)}">${band(fl.cost)}</dd>
          <dt>Paths where float cost nothing on average</dt><dd>${pct(fl.p_costless)}</dd>
        </dl>
        <div class="chart short" id="b-float"></div>
        <div class="note">Float arrives as cash and is invested, but it belongs to policyholders and never counts as equity here: book value carries it
          at face and intrinsic value carries it at the present value of the claims and underwriting results it will cost, discounted at
          ${pct(p.valuation.float_rate)}, growing for ${p.valuation.float_growth_years} years and then running off. A negative cost of float means
          underwriting is profitable and Berkshire is paid to hold the money. As the combined ratio rises the economic liability climbs toward face value.</div>
      </section>
    </div>

    <section class="panel"><header><h2>Where the cash went</h2><span class="sub">average across paths, ${p.horizon} years</span></header>
      <div class="cols c2" style="gap:0">
        <table class="grid"><tbody>
          <tr><td>Acquisitions paid in cash</td><td class="r">${bn(al.acq_cash, 0)}</td></tr>
          <tr><td>Acquisitions paid in stock</td><td class="r">${bn(al.acq_stock, 0)}</td></tr>
          <tr><td>Buybacks</td><td class="r">${bn(al.buyback, 0)}</td></tr>
          <tr><td>Dividends</td><td class="r">${bn(al.dividends, 0)}</td></tr>
          <tr><td>New stock purchases</td><td class="r">${bn(al.eq_buy, 0)}</td></tr>
          <tr class="total"><td>Cash and T-bills at the end, median</td><td class="r">${bn(al.ending_cash, 0)}</td></tr>
        </tbody></table>
        <dl class="kv">
          <dt>Change in share count, median</dt><dd>${pct(al.share_change, 1, true)}</dd>
          <dt>Acquisitions per path</dt><dd>${s.acquisitions.per_path.toFixed(1)}</dd>
          <dt>Share that raised value per share</dt><dd>${pct(s.acquisitions.accretive_share, 0)}</dd>
        </dl>
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
    <div class="note">Every policy runs on the same simulated economies, underwriting years and deal offers, so a difference comes from the policy.
      Value per share includes dividends received. Compare total and per-share earnings growth: issuing stock for acquisitions adds earnings in
      total and subtracts them per share whenever the shares given up were worth more than what they bought.</div></section>`;
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
    <div class="cols c2" style="gap:0">
      <div class="inputs" style="position:static;max-height:none"><fieldset>${inputs.map(([k, l, v, u]) => `<div class="row"><label for="lab-${k}">${esc(l)}${u ? ` <span class="muted">${u}</span>` : ""}</label><input class="field" id="lab-${k}" data-k="${k}" value="${+(+v).toPrecision(5)}"></div>`).join("")}</fieldset></div>
      <div id="lab-out"></div>
    </div>
    <div class="note">A stock deal hands sellers a share of everything Berkshire owns. If Berkshire's stock trades below its value, each share given up
      is worth more than its price, so the deal must earn more than it costs on paper just to break even per share. This is the arithmetic behind
      Buffett's regret over paying for General Re with stock in 1998.</div>
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
