// Router, theme switch and the search box in the top bar.
import { $, attachSuggest, esc, isDark, onTheme, setTheme } from "./lib.js";

const view = $("#view");

const routes = [
  [/^#?\/?$/, () => import("./views/home.js"), () => ({})],
  [/^#\/c\/([^/]+)$/, () => import("./views/company.js"), (m) => ({ ticker: decodeURIComponent(m[1]).toUpperCase() })],
  [/^#\/berkshire$/, () => import("./views/berkshire.js"), () => ({})],
  [/^#\/portfolio$/, () => import("./views/portfolio.js"), () => ({})],
  [/^#\/method$/, () => import("./views/method.js"), () => ({})],
];

let current = 0;
async function route() {
  const hash = location.hash || "#/";
  const token = ++current;
  for (const [re, load, params] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    const mod = await load();
    if (token !== current) return;
    onTheme(null);
    await mod.render(view, params(m));
    for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("on", hash.startsWith(a.getAttribute("href")));
    return;
  }
  view.innerHTML = `<div class="empty">No page at ${esc(hash)}. <a href="#/">Start over</a>.</div>`;
}
window.addEventListener("hashchange", () => route().then(() => window.scrollTo(0, 0)));
route();

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>';
const themeBtn = $("#theme");
function drawThemeButton() {
  const dark = isDark();
  themeBtn.innerHTML = dark ? SUN : MOON;
  themeBtn.title = dark ? "Switch to light mode" : "Switch to dark mode";
  themeBtn.setAttribute("aria-label", themeBtn.title);
}
themeBtn.addEventListener("click", () => setTheme(!isDark()));
// Views listen for themechange and redraw their charts in place, so a theme switch never
// throws away a simulation the user is looking at.
window.addEventListener("themechange", drawThemeButton);
drawThemeButton();

attachSuggest($("#omni"), $("#q"), $("#suggest"), (t) => { location.hash = `#/c/${encodeURIComponent(t)}`; });
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) { e.preventDefault(); ($("#home-q input") || $("#q")).focus(); }
});
