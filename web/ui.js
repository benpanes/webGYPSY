// ---------------------------------------------------------------------------
// Shared page pieces: the model, single / multiple stand modes, tabs, and
// small helpers used by app.js (multiple stands) and single.js (one stand)
//
//   GypsyUI.model                     promise of the loaded model
//   GypsyUI.enableTab(id, on)         enable or disable a tab (by panel id)
//   GypsyUI.selectTab(id)             show a tab (by panel id)
//   GypsyUI.download(text, name, type)
//   GypsyUI.openChartWindow(spec, fileName, onBlocked)
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  const $ = id => document.getElementById(id);

  const SPP_NAMES = { AW: "Aspen", SB: "Black spruce", SW: "White spruce", PL: "Lodgepole pine" };

  // Remembered between visits where the browser allows it
  const store = {
    get(k) { try { return localStorage.getItem("gypsy." + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("gypsy." + k, v); } catch (e) { /* not available */ } },
  };

  // ---- Tabs ------------------------------------------------------------------
  // Each tab is a button[role=tab] with aria-controls naming its panel; the
  // tab list's panels are shown one at a time
  const tabsOf = list => [...list.querySelectorAll("[role=tab]")];
  const tabFor = panelId => document.querySelector(`[role=tab][aria-controls="${panelId}"]`);

  function selectTab(panelId) {
    const tab = tabFor(panelId);
    if (!tab || tab.disabled) return;
    for (const t of tabsOf(tab.closest("[role=tablist]"))) {
      const on = t === tab;
      t.setAttribute("aria-selected", on);
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
  }

  // A disabled tab that is showing hands over to the first tab
  function enableTab(panelId, on) {
    const tab = tabFor(panelId);
    tab.disabled = !on;
    if (!on && tab.getAttribute("aria-selected") === "true")
      selectTab(tabsOf(tab.closest("[role=tablist]"))[0].getAttribute("aria-controls"));
  }

  for (const list of document.querySelectorAll("[role=tablist]")) {
    list.addEventListener("click", e => {
      const t = e.target.closest("[role=tab]");
      if (t) selectTab(t.getAttribute("aria-controls"));
    });
    // Arrow keys move between the enabled tabs
    list.addEventListener("keydown", e => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const tabs = tabsOf(list).filter(t => !t.disabled);
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next.getAttribute("aria-controls"));
      next.focus();
      e.preventDefault();
    });
    selectTab(tabsOf(list)[0].getAttribute("aria-controls"));
  }

  // ---- Modes ---------------------------------------------------------------------
  // Single stand (the default) or multiple stands, remembered per browser
  function setMode(mode) {
    for (const b of document.querySelectorAll("#modeSwitch [data-mode]")) {
      const on = b.dataset.mode === mode;
      b.setAttribute("aria-checked", on);
      $("mode-" + b.dataset.mode).hidden = !on;
    }
    document.body.dataset.mode = mode;
    store.set("mode", mode);
  }
  $("modeSwitch").addEventListener("click", e => {
    const b = e.target.closest("[data-mode]");
    if (b) setMode(b.dataset.mode);
  });
  setMode(store.get("mode") === "multi" ? "multi" : "single");

  // Scrolling over a focused number box moves the page, not the value:
  // leaving the box first stops the browser changing it
  document.addEventListener("wheel", e => {
    const el = document.activeElement;
    if (el && el.type === "number" && e.target === el) el.blur();
  }, { passive: true });

  // ---- Helpers -------------------------------------------------------------------
  function download(data, name, type = "text/csv") {
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const fileStem = name => name.replace(/[^\w.-]+/g, "_");

  function button(text, onClick, cls = "secondary") {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  function checkbox(label, checked, onChange, disabled = false) {
    const l = document.createElement("label");
    l.className = "check";
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = checked;
    c.disabled = disabled;
    c.addEventListener("change", () => onChange(c.checked));
    l.append(c, document.createTextNode(label));
    return l;
  }

  function message(box, text, cls) {
    const div = document.createElement("div");
    div.className = "msg " + cls;
    div.textContent = text;
    $(box).appendChild(div);
  }

  // A chart in its own window: fills the window and redraws when it's resized.
  // The window gets this page's styles, so it follows the same light/dark theme.
  function openChartWindow(spec, fileName, onBlocked) {
    const w = window.open("", "_blank", "width=960,height=640");
    if (!w) {
      onBlocked("The browser blocked the new window. Allow pop-ups for this page and try again.");
      return;
    }
    const css = [...document.styleSheets].map(s => {
      try { return [...s.cssRules].map(r => r.cssText).join("\n"); } catch (e) { return ""; }
    }).join("\n");
    w.document.open();
    w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Chart</title><style>${css}
body { padding: 12px; } .popup-bar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 8px; }
</style></head><body><div class="popup-bar"><button class="secondary" id="dl">Download SVG</button></div><div id="chart"></div></body></html>`);
    w.document.close();
    w.document.title = spec.title;

    const box = w.document.getElementById("chart");
    let svg, timer;
    const head = () => box.querySelector(".chart-head")?.offsetHeight || 60;
    const draw = () => {
      svg = GypsyChart.line(box, { ...spec, height: 300 });   // first pass to measure the legend
      svg = GypsyChart.line(box, { ...spec, height: Math.max(240, w.innerHeight - head() - 90) });
    };
    draw();
    let size = "";
    new w.ResizeObserver(() => {
      const now = w.innerWidth + "x" + w.innerHeight;
      if (now === size) return;
      size = now;
      clearTimeout(timer);
      timer = setTimeout(draw, 100);
    }).observe(w.document.documentElement);
    w.document.getElementById("dl").addEventListener("click", () =>
      download(GypsyChart.toSVGText(svg), fileName, "image/svg+xml"));
  }

  window.GypsyUI = {
    model: createGypsy(),
    SPP_NAMES, store, selectTab, enableTab, download, fileStem, button, checkbox, message, openChartWindow,
  };
})();
