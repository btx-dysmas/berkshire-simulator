// Assumption forms built from a field list. Each field is [path, label, kind, note?]; kinds:
//   pct  stored as a decimal, shown as a percent      num  plain number
//   usd  raw dollars, shown in billions               bn   already in billions
//   sel  a list of [value, label] options in the note slot
import { esc, getPath, ok, setPath } from "./lib.js";

const toShow = (kind, v) => {
  if (!ok(v)) return "";
  if (kind === "pct") return +(v * 100).toFixed(2);
  if (kind === "usd") return +(v / 1e9).toFixed(3);
  return Math.abs(v) >= 1000 ? Math.round(v) : Number((+v).toPrecision(4));
};
const fromShow = (kind, s) => {
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return null;
  if (kind === "pct") return v / 100;
  if (kind === "usd") return v * 1e9;
  return v;
};
const unit = { pct: "%", usd: "$B", bn: "$B", num: "" };

/** Groups render collapsed except the first, which holds the assumptions most people change. */
export function fieldsHTML(groups, params) {
  return groups.map(([title, fields], gi) => `
    <details class="group${gi === 0 ? " key" : ""}" ${gi === 0 ? "open" : ""}><summary>${esc(title)}</summary><div class="rows">
      ${fields.map(([path, label, kind, note]) => {
        const id = `f-${path.replace(/\./g, "-")}`;
        const v = getPath(params, path);
        if (kind === "sel") {
          return `<div class="row" data-path="${path}"><label for="${id}">${esc(label)}</label>
            <select class="field" id="${id}" data-kind="sel">${note.map(([val, l]) => `<option value="${esc(val)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`;
        }
        return `<div class="row" data-path="${path}"><label for="${id}">${esc(label)}${unit[kind] ? ` <span class="muted">${unit[kind]}</span>` : ""}${note ? `<small>${esc(note)}</small>` : ""}</label>
          <input class="field" id="${id}" data-kind="${kind}" inputmode="decimal" value="${toShow(kind, v)}"></div>`;
      }).join("")}
    </div></details>`).join("");
}

/** Fields that differ from `base`, as an overrides object; their rows are marked. Untouched
 * fields are left out so the server keeps their exact values rather than the rounded display. */
export function readFields(root, base) {
  const out = {};
  for (const row of root.querySelectorAll(".row[data-path]")) {
    const path = row.dataset.path;
    const el = row.querySelector("input, select");
    const kind = el.dataset.kind;
    const v = kind === "sel" ? el.value : fromShow(kind, el.value);
    const b = getPath(base, path);
    const changed = v !== null && (kind === "sel" ? String(b) !== v : !(ok(b) && Math.abs(toShow(kind, b) - toShow(kind, v)) < 1e-9));
    row.classList.toggle("changed", changed);
    if (changed) setPath(out, path, v);
  }
  return out;
}

export function writeField(root, path, value) {
  const el = root.querySelector(`.row[data-path="${path}"] input, .row[data-path="${path}"] select`);
  if (el) el.value = el.dataset.kind === "sel" ? value : toShow(el.dataset.kind, value);
}
