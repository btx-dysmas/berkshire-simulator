// Scenario tree: all paths, split by the worst economy in the first five years, then by the
// worst competitive event. Drawn as SVG so it can be read without hovering.
import { esc, num, pct, px } from "./lib.js";

export function scenarioTree(tree, price, n) {
  const branches = tree.branches.filter((b) => b.p > 0);
  const leaves = branches.flatMap((b) => b.children.filter((c) => c.p > 0).map((c) => ({ ...c, parent: b })));
  const rowH = 30, top = 36;
  const H = top + leaves.length * rowH + 12;
  const x0 = 10, x1 = 210, x2 = 470, W = 1000;
  const parts = [];
  parts.push(`<text x="${x0}" y="18" class="sub">All paths</text><text x="${x1}" y="18" class="sub">Worst economy, years 1–5</text><text x="${x2}" y="18" class="sub">Worst competitive event</text>`);
  parts.push(`<text x="${x2 + 230}" y="18" class="sub">Probability</text><text x="${x2 + 330}" y="18" class="sub">Median value</text>${price ? `<text x="${x2 + 450}" y="18" class="sub">Above price</text>` : ""}`);

  const rootY = top + (leaves.length * rowH) / 2;
  let i = 0;
  for (const b of branches) {
    const kids = leaves.filter((l) => l.parent === b);
    const yMid = top + (i + kids.length / 2) * rowH;
    parts.push(`<path class="edge" d="M${x0 + 170},${rootY} C${x0 + 190},${rootY} ${x1 - 20},${yMid} ${x1 - 4},${yMid}"/>`);
    parts.push(`<rect class="node" x="${x1 - 4}" y="${yMid - 20}" width="220" height="40" rx="6"/>`);
    parts.push(`<text x="${x1 + 4}" y="${yMid - 4}">${esc(b.label)}</text><text x="${x1 + 4}" y="${yMid + 13}" class="sub">${pct(b.p)} of paths · median ${px(b.median)}</text>`);
    for (const c of kids) {
      const y = top + i * rowH + rowH / 2;
      parts.push(`<path class="edge" d="M${x1 + 216},${yMid} C${x1 + 210},${yMid} ${x2 - 16},${y} ${x2 - 4},${y}"/>`);
      const tone = price ? (c.median >= price ? "var(--pos)" : "var(--neg)") : "var(--ink)";
      parts.push(`<text x="${x2}" y="${y + 5}">${esc(c.label)}</text>`);
      parts.push(`<text x="${x2 + 230}" y="${y + 5}">${pct(c.p)}</text><text x="${x2 + 330}" y="${y + 5}" style="fill:${tone}">${px(c.median)}</text>`);
      if (price) parts.push(`<text x="${x2 + 450}" y="${y + 5}">${pct(c.p_above, 0)}</text>`);
      i++;
    }
  }
  parts.push(`<rect class="node" x="${x0}" y="${rootY - 20}" width="170" height="40" rx="6"/>`);
  parts.push(`<text x="${x0 + 8}" y="${rootY - 4}">${num(n)} futures</text><text x="${x0 + 8}" y="${rootY + 13}" class="sub">median ${px(tree.root.median)}</text>`);
  return `<div class="tree"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Scenario tree">${parts.join("")}</svg></div>`;
}
