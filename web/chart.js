// ---------------------------------------------------------------------------
// Small SVG line chart with a crosshair tooltip (no dependencies)
//
//   GypsyChart.line(container, {
//     title, xLabel, yLabel,
//     series: [{ label, slot (1-8), dash (0-5), x: [...], y: [...] }],
//     height,   // SVG height in px (default 280); width fills the container
//   })
//
// Colours come from CSS custom properties --series-1 .. --series-8 and the
// --chart-* chrome tokens, so light and dark mode are set in the stylesheet.
// x must be ascending within a series; NaN values break the line.
// GypsyChart.toSVGText(svg) serialises a chart with its colours resolved, for
// download.
// ---------------------------------------------------------------------------

(function (root) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const DASHES = ["", "7 4", "2 3", "10 3 2 3", "14 4", "4 4"];
  const M = { top: 12, right: 16, bottom: 40, left: 56 };

  function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  // Round tick values from the first at or above lo to the first at or
  // above hi, so the last tick covers the data
  function ticks(lo, hi, count) {
    if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; }
    const raw = (hi - lo) / count;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const first = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= raw);
    // The round step nearest the requested count whose last tick ends close
    // to the data, with at least two ticks (e.g. 50 ... 250 rather than 200,
    // 400 for data up to 250)
    const over = s => Math.ceil(hi / s - 1e-9) * s - hi;
    const n = s => Math.ceil(hi / s - 1e-9) - Math.ceil(lo / s - 1e-9) + 1;
    const step = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25].map(m => m * pow)
      .filter(s => s >= raw / 2.5 && s <= raw * 2.5)
      .sort((a, b) => Math.abs(Math.log(a / raw)) - Math.abs(Math.log(b / raw)))
      .find(s => over(s) <= 0.1 * (hi - lo) && n(s) >= 2 && n(s) <= Math.max(2 * count, count + 3)) || first;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; ; v += step) {
      out.push(+v.toPrecision(12));
      if (v >= hi - step * 1e-9) break;
    }
    return { values: out, step };
  }

  function fmt(v, step) {
    if (!Number.isFinite(v)) return "";
    const d = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
    return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtValue(v) {
    if (!Number.isFinite(v)) return "–";
    const a = Math.abs(v);
    const d = a >= 100 ? 1 : a >= 1 ? 2 : 3;
    return v.toLocaleString(undefined, { maximumFractionDigits: d });
  }

  // Index of the point nearest to x (x ascending)
  function nearest(xs, x) {
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid; else hi = mid; }
    return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
  }

  function line(container, { title, xLabel, yLabel, series, height = 280 }) {
    container.innerHTML = "";
    container.classList.add("chart");

    // Header: title and legend (legend only for two or more series)
    const head = document.createElement("div");
    head.className = "chart-head";
    const h = document.createElement("div");
    h.className = "chart-title";
    h.textContent = title;
    head.appendChild(h);
    if (series.length > 1) {
      const legend = document.createElement("div");
      legend.className = "chart-legend";
      for (const s of series) {
        const item = document.createElement("span");
        item.className = "chart-legend-item";
        const sw = el("svg", { width: 22, height: 10, "aria-hidden": "true" });
        el("line", { x1: 1, y1: 5, x2: 21, y2: 5, class: "series-line", style: `stroke: var(--series-${s.slot})`,
                     "stroke-dasharray": DASHES[s.dash || 0] }, sw);
        item.appendChild(sw);
        item.appendChild(document.createTextNode(s.label));
        legend.appendChild(item);
      }
      head.appendChild(legend);
    }
    container.appendChild(head);

    // Fill the container's width; height is the plot area plus axes
    const W = Math.max(280, container.clientWidth - 20 || 600), H = Math.max(160, height);
    const pw = W - M.left - M.right, ph = H - M.top - M.bottom;
    const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img",
                            "aria-label": `${title}: line chart of ${series.length} series` }, container);

    let xmin = Infinity, xmax = -Infinity, ymin = 0, ymax = -Infinity;
    for (const s of series) for (let i = 0; i < s.x.length; i++) {
      if (!Number.isFinite(s.y[i]) || !Number.isFinite(s.x[i])) continue;
      xmin = Math.min(xmin, s.x[i]); xmax = Math.max(xmax, s.x[i]);
      ymin = Math.min(ymin, s.y[i]); ymax = Math.max(ymax, s.y[i]);
    }
    if (!Number.isFinite(xmax)) {
      const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "chart-muted" }, svg);
      t.textContent = "No values to plot";
      return svg;
    }
    const xt = ticks(xmin, xmax, Math.max(2, Math.floor(pw / 80)));
    const yt = ticks(ymin, ymax || 1, 5);
    const x0 = Math.min(xmin, xt.values[0]), x1 = Math.max(xmax, xt.values[xt.values.length - 1]);
    const y0 = Math.min(ymin, yt.values[0]), y1 = yt.values[yt.values.length - 1];
    const sx = v => M.left + (v - x0) / (x1 - x0 || 1) * pw;
    const sy = v => M.top + ph - (v - y0) / (y1 - y0 || 1) * ph;

    // Grid and axes
    const g = el("g", {}, svg);
    for (const v of yt.values) {
      el("line", { x1: M.left, x2: M.left + pw, y1: sy(v), y2: sy(v), class: v === 0 ? "chart-axis" : "chart-grid" }, g);
      const t = el("text", { x: M.left - 8, y: sy(v) + 4, "text-anchor": "end", class: "chart-tick" }, g);
      t.textContent = fmt(v, yt.step);
    }
    for (const v of xt.values) {
      const t = el("text", { x: sx(v), y: M.top + ph + 18, "text-anchor": "middle", class: "chart-tick" }, g);
      t.textContent = fmt(v, xt.step);
    }
    el("line", { x1: M.left, x2: M.left + pw, y1: M.top + ph, y2: M.top + ph, class: "chart-axis" }, g);
    const xl = el("text", { x: M.left + pw / 2, y: H - 6, "text-anchor": "middle", class: "chart-label" }, g);
    xl.textContent = xLabel;
    const yl = el("text", { x: 14, y: M.top + ph / 2, "text-anchor": "middle", class: "chart-label",
                            transform: `rotate(-90 14 ${M.top + ph / 2})` }, g);
    yl.textContent = yLabel;

    // Lines (NaN breaks the path)
    const lines = el("g", {}, svg);
    for (const s of series) {
      let d = "", pen = false;
      for (let i = 0; i < s.x.length; i++) {
        if (!Number.isFinite(s.y[i])) { pen = false; continue; }
        d += (pen ? "L" : "M") + sx(s.x[i]).toFixed(1) + " " + sy(s.y[i]).toFixed(1);
        pen = true;
      }
      if (d) el("path", { d, class: "series-line", style: `stroke: var(--series-${s.slot})`,
                          "stroke-dasharray": DASHES[s.dash || 0] }, lines);
    }

    // Direct labels at the line ends for up to four series, nudged apart
    if (series.length > 1 && series.length <= 4) {
      const ends = series.map(s => {
        for (let i = s.x.length - 1; i >= 0; i--) if (Number.isFinite(s.y[i])) return { s, y: sy(s.y[i]), x: sx(s.x[i]) };
        return null;
      }).filter(Boolean).sort((a, b) => a.y - b.y);
      // Labels sit just above their line's end: keep them inside the plot
      // and at least 13 px apart
      for (const e of ends) e.y = Math.max(e.y, M.top + 16);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
      for (const e of ends) {
        const t = el("text", { x: e.x - 4, y: e.y - 6, "text-anchor": "end", class: "chart-direct" }, svg);
        t.textContent = e.s.label;
      }
    }

    // Crosshair and tooltip
    const cross = el("line", { y1: M.top, y2: M.top + ph, class: "chart-cross", visibility: "hidden" }, svg);
    const dots = series.map(s => el("circle", { r: 4, class: "chart-dot", style: `fill: var(--series-${s.slot})`, visibility: "hidden" }, svg));
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    container.appendChild(tip);
    const hit = el("rect", { x: M.left, y: M.top, width: pw, height: ph, fill: "transparent" }, svg);

    function hide() { cross.setAttribute("visibility", "hidden"); dots.forEach(d => d.setAttribute("visibility", "hidden")); tip.hidden = true; }
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("pointermove", ev => {
      const box = svg.getBoundingClientRect();
      const px = (ev.clientX - box.left) * (W / box.width);
      const xv = x0 + (px - M.left) / pw * (x1 - x0);
      let at = null;
      const rows = [];
      series.forEach((s, k) => {
        if (!s.x.length) return;
        const i = nearest(s.x, xv);
        if (!Number.isFinite(s.y[i])) { dots[k].setAttribute("visibility", "hidden"); return; }
        if (at === null) at = s.x[i];
        dots[k].setAttribute("cx", sx(s.x[i]));
        dots[k].setAttribute("cy", sy(s.y[i]));
        dots[k].setAttribute("visibility", "visible");
        rows.push({ s, v: s.y[i] });
      });
      if (at === null) { hide(); return; }
      cross.setAttribute("x1", sx(at)); cross.setAttribute("x2", sx(at));
      cross.setAttribute("visibility", "visible");
      rows.sort((a, b) => b.v - a.v);
      tip.innerHTML = "";
      const th = document.createElement("div");
      th.className = "chart-tip-head";
      th.textContent = `${xLabel} ${fmtValue(at)}`;
      tip.appendChild(th);
      for (const r of rows) {
        const line = document.createElement("div");
        line.className = "chart-tip-row";
        const sw = document.createElement("span");
        sw.className = "chart-tip-swatch";
        sw.style.background = `var(--series-${r.s.slot})`;
        const name = document.createElement("span");
        name.textContent = r.s.label;
        const val = document.createElement("span");
        val.className = "chart-tip-value";
        val.textContent = fmtValue(r.v);
        line.append(sw, name, val);
        tip.appendChild(line);
      }
      tip.hidden = false;
      const cbox = container.getBoundingClientRect();
      const left = ev.clientX - cbox.left + 14;
      tip.style.left = Math.min(left, cbox.width - tip.offsetWidth - 4) + "px";
      tip.style.top = (ev.clientY - cbox.top + 14) + "px";
    });
    return svg;
  }

  // Chart SVG -> standalone SVG text with colours and fonts resolved
  function toSVGText(svg) {
    const copy = svg.cloneNode(true);
    const src = svg.querySelectorAll("*"), dst = copy.querySelectorAll("*");
    src.forEach((node, i) => {
      const cs = getComputedStyle(node);
      for (const p of ["stroke", "fill", "stroke-width", "font-size", "font-family", "font-weight", "visibility"])
        dst[i].style.setProperty(p, cs.getPropertyValue(p));
    });
    copy.setAttribute("xmlns", NS);
    copy.style.background = getComputedStyle(svg.parentNode).backgroundColor;
    return new XMLSerializer().serializeToString(copy);
  }

  root.GypsyChart = { line, toSVGText };
})(typeof globalThis !== "undefined" ? globalThis : this);
