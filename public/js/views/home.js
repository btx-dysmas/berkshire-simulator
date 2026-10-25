// Start page: find a company, or open the Berkshire model.
import { $, attachSuggest, esc, store } from "../lib.js";

const EXAMPLES = ["KO", "AAPL", "COST", "CAT", "NVDA", "UNP", "MCO"];

export async function render(root) {
  document.title = "Berkshire Simulator";
  const recent = store.get("recent", []);
  root.innerHTML = `
    <div class="home">
      <h1>What is a business worth across ten thousand futures?</h1>
      <p class="lede">Pick a company. Its growth, margins, reinvestment and sensitivity to the economy are fitted to its own
        10-K history, then simulated through economic regimes estimated from U.S. data since 1961. The result is a
        distribution of intrinsic value, the odds that it exceeds today's price, and what drives the spread.</p>
      <form class="home-search" id="home-q" autocomplete="off">
        <input placeholder="Ticker or company name" aria-label="Find a company" spellcheck="false" autofocus>
        <div class="suggest" hidden></div>
        <button class="btn primary" style="height:36px">Simulate</button>
      </form>
      <div class="hint">Try ${EXAMPLES.map((t) => `<a href="#/c/${t}">${t}</a>`).join("")}</div>
      <div class="cols c2">
        <section class="panel">
          <header><h2>Berkshire Hathaway model</h2><span class="sub">float, subsidiaries, capital allocation</span></header>
          <div class="prose">
            <p>A separate simulation of how Berkshire compounds value per share: insurance float carried as a liability,
              the operating subsidiaries, acquisitions paid in cash or stock, and buybacks only below intrinsic value.
              It shows GAAP, operating and look-through earnings side by side, and why a deal can raise total earnings
              while lowering value per share.</p>
            <p><a href="#/berkshire">Open the Berkshire model</a></p>
          </div>
        </section>
        <section class="panel">
          <header><h2>Recently simulated</h2></header>
          ${recent.length ? `<table class="grid"><tbody>${recent.map((r) => `<tr><td style="width:80px"><a class="mono" href="#/c/${esc(r.ticker)}">${esc(r.ticker)}</a></td><td>${esc(r.name)}</td></tr>`).join("")}</tbody></table>`
            : '<div class="empty">Companies you simulate appear here.</div>'}
          <div class="note">Several holdings can be run through the same economic paths on the <a href="#/portfolio">portfolio</a> page.</div>
        </section>
      </div>
    </div>`;
  const form = $("#home-q");
  attachSuggest(form, $("input", form), $(".suggest", form), (t) => { location.hash = `#/c/${encodeURIComponent(t)}`; });
}
