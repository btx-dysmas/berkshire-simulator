// Several holdings through the same simulated economies.
import { $, chart, color, esc, failure, hexA, loading, onTheme, pct, post, px, store } from "../lib.js";
import { titleCase } from "./company.js";

const DEFAULT = [{ ticker: "KO", weight: 25 }, { ticker: "AAPL", weight: 25 }, { ticker: "UNP", weight: 25 }, { ticker: "COST", weight: 25 }];
let last = null;

export async function render(root) {
  document.title = "Portfolio · Berkshire Simulator";
  const rows = store.get("portfolio", DEFAULT);
  root.innerHTML = `
    <div class="co"><h1>Portfolio</h1></div>
    <p class="lede">Each holding is simulated with its own fitted parameters, but every company lives through the same sequence of economic
      regimes and a shared market-wide growth shock on each path. That is what makes holdings fall together in a recession, and what limits
      diversification. Returns assume each position is held ten years and sold at intrinsic value.</p>
    <div class="bench">
      <form class="panel inputs" id="pf" autocomplete="off">
        <header><h2>Holdings</h2><span class="sub">ticker and weight</span></header>
        <fieldset id="pf-rows">${rows.map(rowHTML).join("")}</fieldset>
        <div class="actions"><button class="btn primary">Simulate</button><button class="btn" type="button" id="pf-add">Add holding</button></div>
      </form>
      <div id="pf-out"><div class="empty">Run the simulation to see the combined distribution.</div></div>
    </div>`;
  $("#pf-add").addEventListener("click", () => $("#pf-rows").insertAdjacentHTML("beforeend", rowHTML({ ticker: "", weight: 10 })));
  $("#pf-rows").addEventListener("click", (e) => { if (e.target.dataset.del != null) e.target.closest(".row").remove(); });
  $("#pf").addEventListener("submit", (e) => { e.preventDefault(); run(); });
  onTheme(() => last && draw(last));
  if (last) draw(last); else run();
}

function rowHTML(r) {
  return `<div class="row" style="grid-template-columns:1fr 70px 24px"><input class="field wide" data-t value="${esc(r.ticker)}" placeholder="Ticker" style="text-transform:uppercase">
    <input class="field" data-w value="${r.weight}" inputmode="decimal"><button type="button" class="btn small" data-del title="Remove" aria-label="Remove">×</button></div>`;
}

async function run() {
  const holdings = [...document.querySelectorAll("#pf-rows .row")].map((r) => ({ ticker: r.querySelector("[data-t]").value.trim().toUpperCase(), weight: parseFloat(r.querySelector("[data-w]").value) || 0 })).filter((h) => h.ticker);
  store.set("portfolio", holdings);
  const out = $("#pf-out");
  out.innerHTML = loading(`Fitting and simulating ${holdings.length} companies`);
  try {
    last = await post("/portfolio", { holdings });
    draw(last);
  } catch (e) {
    out.innerHTML = failure("Portfolio simulation failed", e);
  }
}

function draw(r) {
  const P = r.portfolio, tickers = r.holdings.map((h) => h.ticker);
  const line = (label, s) => `<tr><td>${label}</td><td class="r">${pct(s.median)}</td><td class="r">${pct(s.mean)}</td><td class="r">${pct(s.p5)}</td><td class="r">${pct(s.p_loss)}</td><td class="r">${pct(s.p_beat_treasuries)}</td><td class="r">${pct(s.ce, 2)}</td></tr>`;
  const weights = (w) => w.map((x, i) => `${tickers[i]} ${pct(x, 0)}`).join(", ");
  $("#pf-out").innerHTML = `
    <section class="panel"><header><h2>Holdings</h2><span class="sub">${r.horizon}-year outcomes per company</span></header>
      <div class="scroll"><table class="grid"><thead><tr><th>Ticker</th><th>Company</th><th class="r">Weight</th><th class="r">Price</th><th class="r">Median value</th><th class="r">Value above price</th><th class="r">Median return / yr</th><th class="r">Chance of loss</th></tr></thead><tbody>
        ${r.holdings.map((h, i) => `<tr><td><a class="mono" href="#/c/${esc(h.ticker)}">${esc(h.ticker)}</a></td><td>${esc(titleCase(h.name))}</td><td class="r">${pct(r.weights[i], 0)}</td><td class="r">${px(h.price)}</td><td class="r">${px(h.median_value)}</td><td class="r">${pct(h.p_above, 0)}</td><td class="r">${pct(h.median_return)}</td><td class="r">${pct(h.p_loss, 0)}</td></tr>`).join("")}
      </tbody></table></div></section>
    <section class="panel"><header><h2>Portfolio outcomes</h2><span class="sub">annual return over ${r.horizon} years</span></header>
      <div class="scroll"><table class="grid"><thead><tr><th>Weights</th><th class="r">Median</th><th class="r">Mean</th><th class="r">5th pct.</th><th class="r">Chance of loss</th><th class="r">Beats Treasuries</th><th class="r">Certainty equiv.</th></tr></thead><tbody>
        ${line("Your weights", P)}
        ${line("Equal weights", r.equal)}
        ${line(`Highest expected return <div class="muted">${weights(r.best.max_expected.weights)}</div>`, r.best.max_expected)}
        ${line(`Lowest chance of loss <div class="muted">${weights(r.best.min_loss.weights)}</div>`, r.best.min_loss)}
        ${line(`Best certainty equivalent <div class="muted">${weights(r.best.max_ce.weights)}</div>`, r.best.max_ce)}
      </tbody></table></div>
      <div class="note">The three optimized rows come from 3,000 random long-only weightings scored on the same simulated paths. Certainty equivalent uses
        a risk aversion of 3. Treasuries yield ${pct(r.risk_free, 2)}.</div></section>
    <div class="cols c2">
      <section class="panel"><header><h2>Distribution of portfolio return</h2><span class="sub">your weights</span></header><div class="chart short" id="pf-hist"></div></section>
      <section class="panel"><header><h2>Correlation of outcomes</h2><span class="sub">log ${r.horizon}-year wealth multiples</span></header>
        <div class="scroll"><table class="grid"><thead><tr><th></th>${tickers.map((t) => `<th class="r">${esc(t)}</th>`).join("")}</tr></thead><tbody>
          ${r.correlation.map((row, i) => `<tr><td class="mono">${esc(tickers[i])}</td>${row.map((v) => `<td class="r">${v.toFixed(2)}</td>`).join("")}</tr>`).join("")}
        </tbody></table></div></section>
    </div>`;
  const edges = Array.from({ length: 57 }, (_, i) => -0.3 + (0.7 * i) / 56);
  const n = r.histogram.reduce((a, b) => a + b, 0) || 1;
  chart($("#pf-hist"), [{ type: "bar", x: edges.slice(0, -1).map((x, i) => ((x + edges[i + 1]) / 2) * 100), y: r.histogram.map((c) => (c / n) * 100), marker: { color: hexA(color(0), 0.75) }, hovertemplate: "%{x:.1f}%/yr: %{y:.2f}% of paths<extra></extra>" }],
    { xaxis: { ticksuffix: "%" }, yaxis: { ticksuffix: "%" }, shapes: [{ type: "line", x0: r.risk_free * 100, x1: r.risk_free * 100, yref: "paper", y0: 0, y1: 1, line: { color: color(4), width: 1.5 } }] });
}
