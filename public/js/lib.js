// Shared helpers: API calls, formatting, local storage, charts and the theme.

const inflight = new Map();

async function parse(r) {
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(body?.detail || `Request failed (HTTP ${r.status})`);
  return body;
}

/** GET under /api. Identical requests share one fetch for five minutes. */
export function api(path) {
  if (inflight.has(path)) return inflight.get(path);
  const p = fetch(`/api${path}`).then(parse);
  inflight.set(path, p);
  p.then(() => setTimeout(() => inflight.delete(path), 300_000), () => inflight.delete(path));
  return p;
}

export function post(path, body) {
  return fetch(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(parse);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const ok = (v) => typeof v === "number" && Number.isFinite(v);

export function money(v, dp = 1) {
  if (!ok(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(dp + 1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(dp)}M`;
  return `${s}$${a.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** A per-share price: cents below $1,000, whole dollars above (Berkshire A shares). */
export function px(v) {
  if (!ok(v)) return "—";
  return Math.abs(v) >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
}

/** Billions, as the Berkshire model counts. */
export const bn = (v, dp = 1) => (ok(v) ? `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(dp)}B` : "—");

export function pct(v, dp = 1, sign = false) {
  if (!ok(v)) return "—";
  return `${sign && v > 0 ? "+" : ""}${(v * 100).toFixed(dp)}%`;
}
export const num = (v, dp = 0) => (ok(v) ? v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }) : "—");
export const tone = (v) => (ok(v) ? (v > 0 ? "pos" : v < 0 ? "neg" : "") : "");

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`bsim:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`bsim:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
  return obj;
}

let plotly = null;
export function loadPlotly() {
  if (!plotly) {
    plotly = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/plotly.js-basic-dist-min@3.1.0/plotly-basic.min.js";
      s.onload = () => resolve(window.Plotly);
      s.onerror = () => { plotly = null; reject(new Error("Chart library failed to load")); };
      document.head.appendChild(s);
    });
  }
  return plotly;
}

export const isDark = () => document.documentElement.classList.contains("dark");
export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Series colors. The dark set is lighter so lines stay readable on a dark panel.
const LIGHT = ["#1d5a4c", "#5b86b8", "#b7832f", "#8e5a9c", "#c46a5a", "#7fb3a5", "#6b7380"];
const DARK = ["#6cc1a6", "#7fa6de", "#d9a54a", "#b58bc6", "#e0907f", "#8ccab9", "#9aa4b4"];
export const color = (i) => (isDark() ? DARK : LIGHT)[i % LIGHT.length];

export function setTheme(dark) {
  document.documentElement.classList.toggle("dark", dark);
  store.set("theme", dark ? "dark" : "light");
  window.dispatchEvent(new Event("themechange"));
}

export async function chart(el, data, layout = {}) {
  if (!el) return;
  const Plotly = await loadPlotly();
  const grid = css("--line-2"), muted = css("--ink-3");
  const base = {
    font: { family: "IBM Plex Sans, Segoe UI, sans-serif", size: 13, color: muted },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    margin: { l: 58, r: 14, t: 18, b: 40 },
    // Light horizontal guides only; no frame, no vertical grid.
    xaxis: { showgrid: false, showline: false, zeroline: false, ticks: "", automargin: true, fixedrange: true },
    yaxis: { gridcolor: grid, griddash: "dot", showline: false, zeroline: false, ticks: "", automargin: true, fixedrange: true },
    legend: { orientation: "h", y: -0.18, x: 0, font: { size: 13, color: css("--ink-2") } },
    hoverlabel: { font: { family: "IBM Plex Sans, sans-serif", size: 13.5, color: css("--ink") }, bgcolor: css("--panel"), bordercolor: css("--line") },
    hovermode: "closest",
    bargap: 0.08,
    showlegend: false,
  };
  const merged = { ...base, ...layout, xaxis: { ...base.xaxis, ...layout.xaxis }, yaxis: { ...base.yaxis, ...layout.yaxis }, margin: { ...base.margin, ...layout.margin } };
  await Plotly.react(el, data, merged, { displayModeBar: false, responsive: true });
}

/** A percentile band chart: shaded 5-95 and 25-75 ranges around the median. */
export function fanTraces(x, f, i = 0, name = "Median", scale = 1) {
  const c = color(i);
  const s = (a) => a.map((v) => v * scale);
  return [
    { x, y: s(f.p95), mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
    { x, y: s(f.p5), mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: hexA(c, 0.10), hoverinfo: "skip", showlegend: false },
    { x, y: s(f.p75), mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
    { x, y: s(f.p25), mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: hexA(c, 0.20), hoverinfo: "skip", showlegend: false },
    { x, y: s(f.p50), mode: "lines", name, line: { color: c, width: 2.5, shape: "spline", smoothing: 0.6 } },
  ];
}

export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export const loading = (text = "Loading") => `<div class="loading">${esc(text)}…</div>`;
export const failure = (title, err) => `<div class="failure"><b>${esc(title)}</b><span>${esc(err?.message ?? err)}</span></div>`;

/** Attach ticker suggestions to a text input. `go` receives the chosen ticker. */
export function attachSuggest(form, input, box, go) {
  let items = [], on = -1, token = 0;
  const draw = () => {
    if (!items.length) { box.innerHTML = input.value.trim() ? '<div class="none">No matching company</div>' : ""; box.hidden = !input.value.trim(); return; }
    box.innerHTML = items.map((r, i) => `<a href="#/c/${encodeURIComponent(r.ticker)}" class="${i === on ? "on" : ""}" data-i="${i}"><b>${esc(r.ticker)}</b><span>${esc(r.name)}</span></a>`).join("");
    box.hidden = false;
  };
  input.addEventListener("input", async () => {
    const q = input.value.trim(), t = ++token;
    if (!q) { items = []; box.hidden = true; return; }
    try { const r = await api(`/search?q=${encodeURIComponent(q)}`); if (t === token) { items = r; on = r.length ? 0 : -1; draw(); } } catch { /* ignore */ }
  });
  input.addEventListener("keydown", (e) => {
    if (box.hidden || !items.length) return;
    if (e.key === "ArrowDown") { on = (on + 1) % items.length; draw(); e.preventDefault(); }
    if (e.key === "ArrowUp") { on = (on - 1 + items.length) % items.length; draw(); e.preventDefault(); }
    if (e.key === "Escape") box.hidden = true;
  });
  box.addEventListener("mousedown", (e) => {
    const a = e.target.closest("a");
    if (a) { e.preventDefault(); box.hidden = true; input.value = ""; go(items[+a.dataset.i].ticker); }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const pick = items[on] || items[0];
    const q = pick ? pick.ticker : input.value.trim().toUpperCase();
    if (!q) return;
    box.hidden = true;
    input.value = "";
    input.blur();
    go(q);
  });
  input.addEventListener("blur", () => setTimeout(() => { box.hidden = true; }, 150));
}

// One redraw hook for the page on screen; the router clears it on every navigation.
let themeHook = null;
export const onTheme = (fn) => { themeHook = fn; };
window.addEventListener("themechange", () => themeHook?.());
