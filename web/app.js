// ---------------------------------------------------------------------------
// GYPSY web app, multiple stands mode: input table, simulations, charts and
// results
//
// Uses gypsy-api.js (input and run helpers), SheetJS (spreadsheets),
// chart.js and ui.js (the model, tabs and shared helpers).
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const FIELDS = GypsyAPI.FIELDS;
  const { SPP_NAMES, download, fileStem, button, checkbox, message, enableTab } = GypsyUI;
  const MAX_SERIES_SLOTS = 8;

  const EXAMPLE = `stand,stand_age,spp,n,si,age,ht,ps,ba
1,35,PL,2400,,35,13.5,,18.2
2,48,AW,1100,,48,19.8,70,21.5
2,48,SW,450,,31,9.6,25,4.1
3,62,SB,2900,12.5,,13.2,,22.8
3,62,PL,600,16.0,,18.1,,6.3
4,25,AW,6500,,25,9.2,,8.9
4,25,SB,300,,21,3.4,,0.3
4,25,SW,900,,18,3.1,,0.6
4,25,PL,250,,20,4.8,,0.4
5,15,PL,4000,,15,4.1,,
`;

  // Stand totals offered in the charts, each for all species, conifers or
  // deciduous (aspen is the only deciduous species, so deciduous volume is
  // the AW volume). MAI rows are under "More" in the picker.
  const TOTALS = [
    { key: "tvol",  label: "Total volume",        unit: "m³/ha",    more: false,
      cols: { all: "tvol_all",  con: "tvol_con",  dec: "tvol_aw" } },
    { key: "mvol",  label: "Merchantable volume", unit: "m³/ha",    more: false,
      cols: { all: "mvol_all",  con: "mvol_con",  dec: "mvol_aw" } },
    { key: "mai_t", label: "Total MAI",           unit: "m³/ha/yr", more: true,
      cols: { all: "mai_t_all", con: "mai_t_con", dec: "mai_t_dec" } },
    { key: "mai_m", label: "Merchantable MAI",    unit: "m³/ha/yr", more: true,
      cols: { all: "mai_m_all", con: "mai_m_con", dec: "mai_m_dec" } },
  ];
  const GROUPS = { all: ["All", "all species"], con: ["Con", "conifers"], dec: ["Dec", "deciduous"] };
  // Per-species outputs: [column prefix, label, unit, short label, under "More"]
  const MEASURES = [
    ["topht_",  "Top height",              "m",          "Top ht",      false],
    ["tvol_",   "Total volume",            "m³/ha",      "Total vol",   false],
    ["mvol_",   "Merchantable volume",     "m³/ha",      "Merch vol",   false],
    ["n_",      "Density",                 "stems/ha",   "Density",     false],
    ["ba_",     "Basal area",              "m²/ha",      "BA",          false],
    ["qmd_",    "Quadratic mean diameter", "cm",         "QMD",         true],
    ["sc_",     "Species composition",     "proportion", "Composition", true],
    ["mn_",     "Merchantable stems",      "stems/ha",   "Merch stems", true],
    ["mai_t_",  "Total MAI",               "m³/ha/yr",   "Total MAI",   true],
    ["mai_m_",  "Merchantable MAI",        "m³/ha/yr",   "Merch MAI",   true],
  ];
  const X_LABELS = { year: "Years from start", totage: "Leading species total age (years)", standage: "Stand age (years)" };

  // ---- State ------------------------------------------------------------------
  const state = {
    gypsy: null,
    source: null,      // { kind: "text" | "xlsx" | "new", name, text, sheets }
    names: [],         // column names
    header: null,      // original header row (to restore when the header is turned off)
    rows: [],          // data rows, arrays of strings
    mapping: {},       // field -> column index (-1 when unassigned)
    edited: false,
    locked: false,     // Lock table: read only
    page: 0,
    runs: [],          // { id, name, slot, options, result, ms }
    runCount: 0,
    chartRuns: new Set(),
    chartStands: new Map(),                       // stand label -> colour slot
    chartVars: new Set(),                         // species columns, e.g. "ba_pl"
    chartTotals: { tvol: { on: false, group: "all" }, mvol: { on: true, group: "all" },
                   mai_t: { on: false, group: "all" }, mai_m: { on: false, group: "all" } },
    chartSizes: {},                               // variable -> { wide, height }
  };

  // ---- Model ------------------------------------------------------------------
  GypsyUI.model.then(m => {
    state.gypsy = m;
    $("run").disabled = false;
    $("status").textContent = "Ready";
  }).catch(e => { $("status").textContent = "Could not load the model: " + e; });

  // ---- Messages -------------------------------------------------------------------
  const clearMessages = box => { $(box).innerHTML = ""; };

  // ---- Loading input ------------------------------------------------------------------
  function confirmDiscard() {
    return !state.edited || confirm("Replace the table? Your edits will be lost.");
  }

  const SPREADSHEET_EXT = ["xlsx", "xlsm", "xlsb", "xls", "ods", "fods"];

  async function loadFile(file) {
    if (!confirmDiscard()) return;
    clearMessages("inputMessages");
    const name = file.name, ext = name.toLowerCase().split(".").pop();
    try {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      // Zip (xlsx, ods) or compound file (xls) signatures, in case the
      // extension is missing or wrong
      const binary = (head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0xd0 && head[1] === 0xcf);
      if (SPREADSHEET_EXT.includes(ext) || binary) {
        const sheets = readSpreadsheet(buf);
        if (!sheets.length) throw new Error("No worksheets found in " + name);
        setSource({ kind: "xlsx", name, sheets });
      } else {
        setSource({ kind: "text", name, text: new TextDecoder().decode(buf) });
      }
    } catch (e) {
      message("inputMessages", `Could not read ${name}: ${e.message}`, "err");
    }
  }

  // Spreadsheet (SheetJS) -> [{ name, rows }] with cells as text. Raw cell
  // values are used, so numbers keep full precision rather than the cell's
  // display format; dates come through as Excel serial numbers.
  function readSpreadsheet(buf) {
    const wb = XLSX.read(buf, { type: "array", cellDates: false });
    return wb.SheetNames.map(name => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "", blankrows: true });
      while (rows.length && rows[rows.length - 1].every(c => c === "")) rows.pop();
      return { name, rows: rows.map(r => r.map(c => String(c))) };
    });
  }

  function setSource(src) {
    state.source = src;
    $("delimiter").value = "auto";
    if (src.kind === "xlsx") {
      const sel = $("sheet");
      sel.innerHTML = "";
      src.sheets.forEach((s, i) => sel.add(new Option(`${s.name} (${s.rows.length} rows)`, i)));
      // Start on the sheet with the most rows (skips notes and readme sheets)
      let best = 0;
      src.sheets.forEach((s, i) => { if (s.rows.length > src.sheets[best].rows.length) best = i; });
      sel.value = String(best);
    }
    applySource();
  }

  // Source -> table, using the separator, sheet and header settings
  function applySource() {
    const src = state.source;
    let all;
    if (src.kind === "text") {
      const d = $("delimiter").value;
      all = GypsyAPI.parseDelimited(src.text, { delimiter: d === "auto" ? undefined : d });
    } else if (src.kind === "xlsx") {
      all = src.sheets[Number($("sheet").value)].rows.map(r => r.slice());
    } else {
      const blank = FIELDS.filter(f => !f.extra);   // other types can be assigned later
      all = [blank.map(f => f.key), blank.map(() => "")];
    }
    const ncol = Math.max(0, ...all.map(r => r.length));
    all = all.map(r => { while (r.length < ncol) r.push(""); return r.map(c => String(c)); });

    if ($("hasHeader").checked && all.length) {
      state.header = all.shift();
      state.names = state.header.map((h, j) => h.trim() || `Column ${j + 1}`);
      state.mapping = GypsyAPI.guessMapping(state.names);
    } else {
      state.header = null;
      state.names = Array.from({ length: ncol }, (_, j) => `Column ${j + 1}`);
      state.mapping = positionalMapping(ncol);
    }
    state.rows = all;
    state.edited = false;
    clearHistory();
    state.page = 0;

    $("sourceName").textContent = src.name;
    $("sheetField").classList.toggle("hidden", src.kind !== "xlsx");
    $("delimField").classList.toggle("hidden", src.kind === "xlsx");   // a spreadsheet has none
    $("headerField").classList.remove("hidden");                         // the separator moves right of it
    $("gridArea").classList.remove("hidden");
    $("drop").classList.add("hidden");   // the table takes its place
    $("lockGrid").after($("moreInput"));     // and More options goes beside Lock table
    $("moreHome").hidden = true;
    showGrid(true);                      // a new table is shown, to check its columns
    // Opened locked: Edit table unlocks it. A new empty table opens ready to
    // fill in. (lockGrid draws the table.)
    lockGrid(src.kind !== "new");
  }

  // Without column names, assume the standard column order
  function positionalMapping(ncol) {
    const m = {};
    FIELDS.forEach((f, i) => { m[f.key] = ncol >= 4 && i < ncol ? i : -1; });
    return m;
  }

  // Header on/off without re-reading the source, so edits are kept
  $("hasHeader").addEventListener("change", () => {
    if (!state.source) return;
    remember(!$("hasHeader").checked);   // as it was before this click
    if ($("hasHeader").checked) {
      if (!state.rows.length) return;
      state.header = state.rows.shift();
      state.names = state.header.map((h, j) => h.trim() || `Column ${j + 1}`);
      state.mapping = GypsyAPI.guessMapping(state.names);
    } else {
      if (state.header) state.rows.unshift(state.header);
      state.header = null;
      state.names = state.names.map((_, j) => `Column ${j + 1}`);
    }
    state.page = 0;
    renderGrid();
  });
  // Before a table is loaded, the separator is kept for the next text read
  $("delimiter").addEventListener("change", () => { if (state.source?.kind === "text" && confirmDiscard()) applySource(); });
  $("sheet").addEventListener("change", () => { if (confirmDiscard()) applySource(); });

  // Drag and drop: anywhere on the input card. Before a table is loaded the
  // drop box lights up; after, the table shows an overlay and is replaced.
  const card = $("inputSection");
  const target = () => ($("gridArea").classList.contains("hidden") ? $("drop") : $("gridArea"));
  const dragOff = () => { $("drop").classList.remove("over"); $("gridArea").classList.remove("over"); };
  // With a table loaded only files count, so text dragged within the table
  // (between cells) is dropped as usual
  const ours = e => $("gridArea").classList.contains("hidden") || [...e.dataTransfer.types].includes("Files");
  ["dragenter", "dragover"].forEach(t => card.addEventListener(t, e => {
    if (!ours(e)) return;
    e.preventDefault();
    target().classList.add("over");
  }));
  card.addEventListener("dragleave", e => { if (!card.contains(e.relatedTarget)) dragOff(); });
  card.addEventListener("drop", e => {
    dragOff();
    if (!ours(e)) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
    else {
      const text = e.dataTransfer.getData("text/plain");
      if (text && confirmDiscard()) setSource({ kind: "text", name: "Dropped text", text });
    }
  });
  // Stop a file dropped elsewhere on the page from opening in the browser
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => e.preventDefault());

  $("chooseFile").addEventListener("click", () => $("file").click());
  $("drop").addEventListener("click", () => $("file").click());
  $("drop").addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); }
  });
  $("file").addEventListener("change", e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; });
  $("pasteToggle").addEventListener("click", () => { $("pasteBox").classList.toggle("hidden"); $("pasteText").focus(); });
  $("pasteUse").addEventListener("click", () => {
    const text = $("pasteText").value;
    if (!text.trim() || !confirmDiscard()) return;
    clearMessages("inputMessages");
    setSource({ kind: "text", name: "Pasted text", text });
    $("pasteBox").classList.add("hidden");
    $("moreInput").open = false;
  });
  $("loadExample").addEventListener("click", () => {
    if (!confirmDiscard()) return;
    $("hasHeader").checked = true;
    setSource({ kind: "text", name: "Example data (5 stands)", text: EXAMPLE });
    $("moreInput").open = false;
  });
  $("newTable").addEventListener("click", () => {
    if (!confirmDiscard()) return;
    $("hasHeader").checked = true;
    setSource({ kind: "new", name: "New table" });
    $("moreInput").open = false;
  });
  // Reset: the table, run options and simulations back to how the page opens
  $("mReset").addEventListener("click", () => {
    if (!confirm("Reset the table, run options and all simulations?")) return;
    Object.assign(state, { source: null, names: [], header: null, rows: [], mapping: {}, edited: false, page: 0,
                           runs: [], runCount: 0, locked: false, chartSizes: {} });
    state.chartRuns.clear();
    state.chartStands.clear();
    clearHistory();
    $("gridArea").classList.add("hidden");
    $("gridArea").classList.remove("locked");
    $("lockGrid").textContent = "Edit table";
    $("drop").classList.remove("hidden");
    $("moreHome").appendChild($("moreInput"));
    $("moreHome").hidden = false;
    $("moreInput").open = false;
    $("pasteBox").classList.add("hidden");
    $("pasteText").value = "";
    $("headerField").classList.add("hidden");
    $("sheetField").classList.add("hidden");
    $("delimField").classList.remove("hidden");
    $("hasHeader").checked = true;
    // Run options: each box's value or tick as the page has it
    for (const el of $("m-input").querySelectorAll("section:not(#inputSection) input")) {
      if (el.type === "checkbox") el.checked = el.defaultChecked;
      else el.value = el.defaultValue;
    }
    merchTableFilled = false;
    for (const id of ["customMerch", "merchBySpp"]) $(id).dispatchEvent(new Event("change"));
    $("runName").placeholder = "Run 1";
    for (const id of ["inputMessages", "runMessages"]) $(id).innerHTML = "";
    if (state.gypsy) $("status").textContent = "Ready";
    renderRuns(); renderChartControls(); renderCharts(); renderTableControls();
    GypsyUI.selectTab("m-input");
  });

  // A click elsewhere closes More options
  document.addEventListener("click", e => { if (!e.target.closest("#moreInput")) $("moreInput").open = false; });

  // ---- Editable table ----------------------------------------------------------------
  const pageSize = () => Number($("pageSize").value);
  const fieldOfColumn = () => {
    const f = [];
    for (const [k, j] of Object.entries(state.mapping)) if (j >= 0) f[j] = FIELDS.find(x => x.key === k);
    return f;
  };

  function cellProblem(field, value) {
    if (!field) return false;
    const v = String(value).trim();
    if (v === "") return field.required;
    if (field.key === "spp") return !GypsyAPI.SPECIES.includes(v.toUpperCase());
    if (field.numeric) return v !== "." && v.toUpperCase() !== "NA" && !Number.isFinite(Number(v));
    return false;
  }
  const isBlankRow = r => r.every(c => String(c).trim() === "");

  function renderGrid() {
    const grid = $("grid");
    const fcol = fieldOfColumn();
    grid.innerHTML = "";

    // Header: column name and what the column holds
    const thead = grid.createTHead(), hr = thead.insertRow();
    const corner = document.createElement("th");
    corner.className = "rownum";
    corner.textContent = "#";
    hr.appendChild(corner);
    state.names.forEach((name, j) => {
      const th = document.createElement("th");
      if (fcol[j]) th.className = "mapped";
      const span = document.createElement("span");
      span.className = "colname";
      span.textContent = name;
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", `Use of column ${name}`);
      sel.add(new Option("Not used", ""));
      for (const f of FIELDS) sel.add(new Option(f.label + (f.required ? " *" : ""), f.key));
      sel.value = fcol[j] ? fcol[j].key : "";
      sel.disabled = state.locked;
      sel.addEventListener("change", () => {
        remember();
        for (const k of Object.keys(state.mapping)) if (state.mapping[k] === j) state.mapping[k] = -1;
        if (sel.value) state.mapping[sel.value] = j;
        renderGrid();
      });
      th.append(span, sel);
      hr.appendChild(th);
    });
    // Beside the last column (above the rows' delete buttons): a round + to
    // add a column
    const addTh = document.createElement("th");
    addTh.className = "add-col";
    addTh.appendChild(plusButton("Add column", addColumn));
    hr.appendChild(addTh);

    // Rows on this page
    const size = pageSize();
    const pages = Math.max(1, Math.ceil(state.rows.length / size));
    state.page = Math.min(state.page, pages - 1);
    const first = state.page * size, last = Math.min(state.rows.length, first + size);
    const tbody = grid.createTBody();
    for (let r = first; r < last; r++) {
      const tr = tbody.insertRow();
      tr.dataset.row = r;
      const num = tr.insertCell();
      num.className = "rownum";
      num.textContent = r + 1;
      state.rows[r].forEach((v, j) => {
        const td = tr.insertCell();
        if (cellProblem(fcol[j], v)) td.className = "bad";
        const inp = fcol[j] && fcol[j].key === "spp" ? speciesSelect(v) : document.createElement("input");
        if (inp.tagName === "INPUT") inp.value = v;
        inp.dataset.col = j;
        inp.setAttribute("aria-label", `Row ${r + 1}, ${state.names[j]}`);
        if (state.locked) { if (inp.tagName === "INPUT") inp.readOnly = true; else inp.disabled = true; }
        td.appendChild(inp);
      });
      const del = tr.insertCell();
      del.className = "del";
      const b = document.createElement("button");
      b.className = "link";
      b.textContent = "×";
      b.ariaLabel = `Remove row ${r + 1}`;
      b.dataset.tip = "Remove row";
      b.dataset.del = r;
      del.appendChild(b);
    }
    // A gap under the rows: a red × under each column to remove it, and on
    // the last page a round + below the row numbers to add a row
    const tr = grid.createTFoot().insertRow();
    const cell = tr.insertCell();
    cell.className = "rownum add-cell";
    if (last === state.rows.length) cell.appendChild(plusButton("Add row", addRow));
    state.names.forEach((name, j) => {
      const td = tr.insertCell();
      td.className = "del-col";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link";
      b.textContent = "×";
      b.ariaLabel = `Remove column ${name}`;
      b.dataset.tip = "Remove column";
      b.dataset.delCol = j;
      td.appendChild(b);
    });
    tr.insertCell();

    $("pageInfo").textContent = `Rows ${state.rows.length ? first + 1 : 0}–${last} of ${state.rows.length}`;
    $("prevPage").disabled = state.page === 0;
    $("nextPage").disabled = state.page >= pages - 1;
    updateGridStatus();
    updateUndo();
    sizeColumns();
  }

  // Each column as wide as its widest entry (over every row, not just this
  // page), its name or its column-use menu, within limits
  const textWidth = (() => {
    const ctx = document.createElement("canvas").getContext("2d");
    const cache = new Map();
    return (text, font) => {
      const k = font + "|" + text;
      if (!cache.has(k)) { ctx.font = font; cache.set(k, ctx.measureText(text).width); }
      return cache.get(k);
    };
  })();
  // A species cell's menu text, as speciesSelect shows it
  const SPP_LABEL = v => (GypsyAPI.SPECIES.includes(String(v).trim().toUpperCase())
    ? String(v).trim().toUpperCase() : String(v).trim() ? `${String(v).trim()} (not a species group)` : "–");
  function sizeColumns() {
    const grid = $("grid"), heads = [...grid.tHead.rows[0].cells].slice(1, state.names.length + 1);
    if (!heads.length) return;
    const font = el => (el ? getComputedStyle(el).font : "14px sans-serif");
    // Room around a box's text: its padding and borders, and for a menu its arrow
    const room = (el, arrow) => {
      if (!el) return arrow ? 40 : 16;
      const c = getComputedStyle(el), px = k => parseFloat(c[k]) || 0;
      return px("paddingLeft") + px("paddingRight") + px("borderLeftWidth") + px("borderRightWidth") +
             (arrow && c.appearance !== "none" ? 24 : 0) + 2;
    };
    const cellIn = grid.querySelector("tbody input"), cellSel = grid.querySelector("tbody select");
    const menu = grid.querySelector("thead select");
    const cellFont = font(cellIn || cellSel), nameFont = font(grid.querySelector("thead .colname"));
    const menuFont = font(menu), inRoom = room(cellIn, false), selRoom = room(cellSel, true), menuRoom = room(menu, true);
    const fcol = fieldOfColumn();
    heads.forEach((th, j) => {
      const sel = th.querySelector("select");
      const spp = fcol[j] && fcol[j].key === "spp";
      let w = Math.max(textWidth(state.names[j], nameFont), textWidth(sel.selectedOptions[0]?.text ?? "", menuFont) + menuRoom);
      const seen = new Set();
      for (const r of state.rows) {
        const v = r[j] ?? "";
        if (seen.has(v)) continue;
        seen.add(v);
        // Cells fill the column, which has no padding of its own (the
        // heading's 12 px is added below, so take it off here)
        w = Math.max(w, (spp ? textWidth(SPP_LABEL(v), cellFont) + selRoom : textWidth(v, cellFont) + inRoom) - 12);
      }
      // With the heading's padding (12 px); between 64 and 320 px
      th.style.width = th.style.minWidth = Math.round(Math.min(320, Math.max(64, w + 12))) + "px";
    });
  }

  function updateGridStatus() {
    const fcol = fieldOfColumn();
    let bad = 0;
    const stands = new Set();
    const sj = state.mapping.stand;
    for (const r of state.rows) {
      if (isBlankRow(r)) continue;
      r.forEach((v, j) => { if (cellProblem(fcol[j], v)) bad++; });
      if (sj >= 0) stands.add(String(r[sj]).trim());
    }
    const parts = [`${state.rows.length} rows`];
    if (sj >= 0) parts.push(`${stands.size} stands`);
    if (bad) parts.push(`${bad} cell${bad === 1 ? "" : "s"} to check (highlighted)`);
    const missing = FIELDS.filter(f => f.required && !(state.mapping[f.key] >= 0)).map(f => f.label);
    if (missing.length) parts.push("not assigned: " + missing.join(", "));
    $("gridStatus").textContent = parts.join(" · ");
  }

  // Species cells: a menu of the four species groups. A value that isn't one
  // of them (e.g. from a file) stays listed so it isn't lost, and is
  // highlighted; lower case codes are shown as the group they match.
  function speciesSelect(value) {
    const sel = document.createElement("select");
    sel.className = "spp";
    const v = String(value).trim();
    sel.add(new Option("–", ""));
    // By code only (e.g. "AW"); the full name shows on hover
    for (const s of GypsyAPI.SPECIES) sel.add(Object.assign(new Option(s, s), { title: SPP_NAMES[s] }));
    if (v && !GypsyAPI.SPECIES.includes(v.toUpperCase())) sel.add(new Option(`${v} (not a species group)`, v));
    sel.value = GypsyAPI.SPECIES.includes(v.toUpperCase()) ? v.toUpperCase() : v;
    const named = () => { sel.title = SPP_NAMES[sel.value] || ""; };
    named();
    sel.addEventListener("change", named);
    return sel;
  }

  const tbodyRow = el => Number(el.closest("tr").dataset.row);
  $("grid").addEventListener("focusin", () => { editing = null; });
  $("grid").addEventListener("input", e => {
    if (e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT") return;
    const r = tbodyRow(e.target), j = Number(e.target.dataset.col);
    // Typing in one cell is one step (remembered before its first change)
    if (editing !== `${r},${j}`) { remember(); editing = `${r},${j}`; }
    state.rows[r][j] = e.target.value;
    state.edited = true;
    e.target.parentNode.classList.toggle("bad", cellProblem(fieldOfColumn()[j], e.target.value));
    clearTimeout(updateGridStatus.timer);
    updateGridStatus.timer = setTimeout(updateGridStatus, 200);
  });
  $("grid").addEventListener("keydown", e => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === "z" || key === "y")) {
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo(); else undo();
      return;
    }
    if (e.target.tagName !== "INPUT" || e.key !== "Enter") return;
    e.preventDefault();
    const tr = e.target.closest("tr");
    const next = e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling;
    if (next) next.querySelector(`input[data-col="${e.target.dataset.col}"]`).focus();
  });
  // A block pasted from a spreadsheet fills cells below and to the right
  $("grid").addEventListener("paste", e => {
    if (e.target.tagName !== "INPUT" || state.locked) return;
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\n]/.test(text.replace(/\r?\n$/, ""))) return;
    e.preventDefault();
    remember();
    const block = text.replace(/\r?\n$/, "").split(/\r?\n/).map(l => l.split("\t"));
    const r0 = tbodyRow(e.target), j0 = Number(e.target.dataset.col);
    block.forEach((cells, i) => {
      if (!state.rows[r0 + i]) state.rows[r0 + i] = state.names.map(() => "");
      cells.forEach((v, k) => { if (j0 + k < state.names.length) state.rows[r0 + i][j0 + k] = v; });
    });
    state.edited = true;
    renderGrid();
  });
  $("grid").addEventListener("click", e => {
    const col = e.target.closest("button[data-del-col]");
    if (col) { removeColumn(Number(col.dataset.delCol)); return; }
    const b = e.target.closest("button[data-del]");
    if (!b) return;
    remember();
    state.rows.splice(Number(b.dataset.del), 1);
    state.edited = true;
    renderGrid();
  });

  // Remove column j: what each later column holds moves with it
  function removeColumn(j) {
    remember();
    state.names.splice(j, 1);
    if (state.header) state.header.splice(j, 1);
    for (const r of state.rows) r.splice(j, 1);
    for (const k of Object.keys(state.mapping)) {
      const m = state.mapping[k];
      state.mapping[k] = m === j ? -1 : m > j ? m - 1 : m;
    }
    state.edited = true;
    renderGrid();
  }

  // Tooltips for the table's add and remove buttons (data-tip), shown at once
  // on hover or focus, above the page so the table's scrolling doesn't clip them
  const tip = Object.assign(document.createElement("div"), { className: "hover-tip", hidden: true });
  document.body.appendChild(tip);
  const showTip = e => {
    const b = e.target.closest?.("#grid [data-tip], #runs [data-tip]");
    if (!b) return;
    tip.textContent = b.dataset.tip;
    tip.hidden = false;
    const r = b.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2)) + "px";
    tip.style.top = (r.top - tip.offsetHeight - 6 < 4 ? r.bottom + 6 : r.top - tip.offsetHeight - 6) + "px";
  };
  const hideTip = e => { if (e.target.closest?.("#grid [data-tip], #runs [data-tip]")) tip.hidden = true; };
  for (const box of [$("grid"), $("runs")]) {
    box.addEventListener("mouseover", showTip);
    box.addEventListener("mouseout", hideTip);
    box.addEventListener("focusin", showTip);
    box.addEventListener("focusout", hideTip);
  }
  $("gridWrap").addEventListener("scroll", () => { tip.hidden = true; });
  $("grid").addEventListener("click", () => { tip.hidden = true; });   // the button may be redrawn away
  window.addEventListener("scroll", () => { tip.hidden = true; }, { passive: true });
  // Undo and redo for the table: each edit remembers the table as it was
  // (column names, rows, column uses and the column names box). A new table
  // or Reset starts afresh.
  const history = { undo: [], redo: [] };
  const HISTORY_MAX = 100;
  let editing = null;   // the cell being typed in, "row,col"
  const snapshot = (header = $("hasHeader").checked) => ({
    names: [...state.names], header: state.header && [...state.header],
    rows: state.rows.map(r => [...r]), mapping: { ...state.mapping }, hasHeader: header,
  });
  function remember(header) {
    history.undo.push(snapshot(header));
    if (history.undo.length > HISTORY_MAX) history.undo.shift();
    history.redo = [];
    updateUndo();
  }
  function step(from, to) {
    if (!from.length || state.locked) return;
    to.push(snapshot());
    const s = from.pop();
    Object.assign(state, { names: s.names, header: s.header, rows: s.rows, mapping: s.mapping, edited: true });
    $("hasHeader").checked = s.hasHeader;
    editing = null;
    renderGrid();
  }
  const undo = () => step(history.undo, history.redo);
  const redo = () => step(history.redo, history.undo);
  function clearHistory() {
    history.undo = [];
    history.redo = [];
    editing = null;
    updateUndo();
  }
  function updateUndo() {
    $("undoGrid").disabled = !history.undo.length || state.locked;
    $("redoGrid").disabled = !history.redo.length || state.locked;
  }
  $("undoGrid").addEventListener("click", undo);
  $("redoGrid").addEventListener("click", redo);

  // Locked, the table is read only (no typing, pasting, column uses, or adding
  // and removing rows and columns); the button says what it will do: Edit
  // table, then Lock table. A new file still replaces a locked table.
  function lockGrid(on) {
    state.locked = on;
    $("gridArea").classList.toggle("locked", on);
    $("lockGrid").textContent = on ? "Edit table" : "Lock table";
    renderGrid();
  }
  $("lockGrid").addEventListener("click", () => lockGrid(!state.locked));

  // Hide or show the table (its buttons and row count stay)
  function showGrid(on) {
    $("gridArea").classList.toggle("collapsed", !on);
    $("toggleGrid").textContent = on ? "Hide table" : "Show table";
    $("toggleGrid").setAttribute("aria-expanded", on);
  }
  $("toggleGrid").addEventListener("click", () => showGrid($("gridArea").classList.contains("collapsed")));

  // Small round + (adding a row or a column)
  function plusButton(label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "add-row";
    // Drawn rather than a "+" character, so it sits in the middle of the circle
    b.innerHTML = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    b.ariaLabel = b.dataset.tip = label;
    b.addEventListener("click", onClick);
    return b;
  }

  // A new, unused column at the right; choose what it holds from its menu
  function addColumn() {
    remember();
    const j = state.names.length;
    state.names.push(`Column ${j + 1}`);
    if (state.header) state.header.push("");
    for (const r of state.rows) r.push("");
    state.edited = true;
    renderGrid();
    const wrap = $("gridWrap");
    wrap.scrollLeft = wrap.scrollWidth;
    const sel = $("grid").querySelector(`thead th:nth-child(${j + 2}) select`);
    if (sel) sel.focus();
  }

  function addRow() {
    remember();
    state.rows.push(state.names.map(() => ""));
    state.edited = true;
    state.page = Math.ceil(state.rows.length / pageSize()) - 1;
    renderGrid();
    const inputs = $("grid").querySelectorAll("tbody tr:last-child input, tbody tr:last-child select");
    if (inputs[0]) inputs[0].focus();
  }
  $("prevPage").addEventListener("click", () => { state.page--; renderGrid(); });
  $("nextPage").addEventListener("click", () => { state.page++; renderGrid(); });
  $("pageSize").addEventListener("change", () => { state.page = 0; renderGrid(); });

  // ---- Running --------------------------------------------------------------------
  const num = id => Number($(id).value);

  $("run").addEventListener("click", async () => {
    clearMessages("runMessages");
    if (!state.source) { message("runMessages", "Load or enter input data first.", "err"); return; }
    let input, warnings, rowLabels;
    try {
      const keep = [];
      state.rows.forEach((r, i) => { if (!isBlankRow(r)) keep.push(i); });
      if (!keep.length) throw new Error("The input table has no data rows.");
      rowLabels = keep.map(i => i + 1);
      ({ input, warnings } = GypsyAPI.inputFromRows(keep.map(i => state.rows[i]), state.mapping, {
        ti: $("tiflag").checked, rowLabels }));
    } catch (e) { message("runMessages", e.message, "err"); return; }

    // Merchantability settings only apply while their box is ticked;
    // otherwise the defaults (shown beside the box) are used. Site index, age
    // and density types come with each row's columns.
    const options = {
      simlen: num("simlen"), psflag: $("psflag").checked, baflag: $("baflag").checked, ti: $("tiflag").checked,
      ...merchCriteria(),
    };
    $("run").disabled = true;
    $("status").textContent = "Running…";
    try {
      const t0 = performance.now();
      const result = await GypsyAPI.runAsync(state.gypsy, input, {
        ...options, rowLabels,
        onProgress: (done, total) => { $("status").textContent = `Running… ${done} of ${total} stands`; },
      });
      const ms = performance.now() - t0;
      for (const w of [...warnings, ...result.warnings]) message("runMessages", w, "warn");
      addRun(options, result, ms);
      $("status").textContent = `${result.standLabels.length} stand(s) projected in ${ms < 1000 ? ms.toFixed(0) + " ms" : (ms / 1000).toFixed(1) + " s"}`;
    } catch (e) {
      message("runMessages", e.message, "err");
      $("status").textContent = "Stopped with an error";
    } finally {
      $("run").disabled = false;
    }
  });

  function freeSlot(used) {
    for (let s = 1; s <= MAX_SERIES_SLOTS; s++) if (!used.has(s)) return s;
    return null;
  }

  function addRun(options, result, ms) {
    state.runCount++;
    const name = $("runName").value.trim() || `Run ${state.runCount}`;
    const slot = freeSlot(new Set(state.runs.map(r => r.slot))) || ((state.runCount - 1) % MAX_SERIES_SLOTS) + 1;
    const run = { id: state.runCount, name, slot, options, result, ms };
    state.runs.push(run);
    $("runName").value = "";
    $("runName").placeholder = `Run ${state.runCount + 1}`;

    if (state.chartRuns.size < MAX_SERIES_SLOTS) state.chartRuns.add(run.id);
    if (!state.chartStands.size && result.standLabels.length) state.chartStands.set(result.standLabels[0], 1);
    renderRuns();
    renderChartControls();
    renderCharts();
    renderTableControls(run.id);
  }

  // ---- Merchantability criteria --------------------------------------------------------
  // One set for all species, or one per species (table rows built here,
  // filled from the all-species values the first time they're shown)
  const MERCH = [["stumpHt", "0.05", 0.3], ["stumpDob", "0.5", 15], ["topDib", "0.5", 10]];
  for (const s of GypsyAPI.SPECIES) {
    const tr = $("merchTable").tBodies[0].insertRow();
    tr.insertCell().textContent = `${s} – ${SPP_NAMES[s]}`;
    for (const [id, step, def] of MERCH) {
      const inp = document.createElement("input");
      Object.assign(inp, { type: "number", step, value: def, defaultValue: def, id: `${id}_${s}` });
      if (id === "stumpHt") inp.max = "0.3";
      inp.setAttribute("aria-label", `${s} ${id === "stumpHt" ? "stump height" : id === "stumpDob" ? "stump DOB" : "top DIB"}`);
      tr.insertCell().appendChild(inp);
    }
  }
  let merchTableFilled = false;
  // Universal or species-specific: either side of the switch flips it
  $("merchMode").addEventListener("click", () => {
    $("merchBySpp").checked = !$("merchBySpp").checked;
    $("merchBySpp").dispatchEvent(new Event("change"));
  });
  $("merchBySpp").addEventListener("change", () => {
    const by = $("merchBySpp").checked;
    for (const b of $("merchMode").querySelectorAll("[data-util]"))
      b.setAttribute("aria-checked", (b.dataset.util === "spp") === by);
    if (by && !merchTableFilled) {
      for (const s of GypsyAPI.SPECIES) for (const [id] of MERCH) $(`${id}_${s}`).value = $(id).value;
      merchTableFilled = true;
    }
    $("merchTable").classList.toggle("hidden", !by);
    $("merchAll").classList.toggle("hidden", by);
  });

  // Criteria for a run: defaults unless "Custom merchantability" is ticked
  function merchCriteria() {
    const out = {};
    for (const [id, , def] of MERCH) {
      if (!$("customMerch").checked) out[id] = [def, def, def, def];
      else if ($("merchBySpp").checked) out[id] = GypsyAPI.SPECIES.map(s => num(`${id}_${s}`));
      else out[id] = Array(4).fill(num(id));
    }
    return out;
  }

  function merchText(o) {
    const one = i => `${o.stumpHt[i]} m stump, ${o.stumpDob[i]} cm DOB, ${o.topDib[i]} cm DIB`;
    const same = [1, 2, 3].every(i => o.stumpHt[i] === o.stumpHt[0] && o.stumpDob[i] === o.stumpDob[0] && o.topDib[i] === o.topDib[0]);
    return same ? one(0) : "by species: " + GypsyAPI.SPECIES.map((s, i) => `${s} ${o.stumpHt[i]}/${o.stumpDob[i]}/${o.topDib[i]}`).join(", ");
  }

  // ---- Runs list ----------------------------------------------------------------------
  function renderRuns() {
    const box = $("runs");
    box.innerHTML = "";
    $("runsSection").classList.toggle("hidden", !state.runs.length);
    for (const run of state.runs) {
      const o = run.options;
      const div = document.createElement("div");
      div.className = "run";
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = `var(--series-${run.slot})`;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = run.name;
      const info = document.createElement("span");
      info.className = "small";
      info.textContent = `${run.result.standLabels.length} stands · ${o.simlen} years · ${merchText(o)} · ` +
        `stocking ${o.psflag ? "on" : "off"}, BA ${o.baflag ? "on" : "off"}` +
        (o.ti ? " · tree improvement" : "");
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      const b1 = button("Export results (CSV)", () => download(GypsyAPI.toCSV(run.result.rows, run.result.standLabels), `${fileStem(run.name)}_yearly.csv`));
      const b2 = button("Export stand summary (CSV)", () => download(GypsyAPI.toCSV(run.result.init, run.result.standLabels), `${fileStem(run.name)}_stands.csv`));
      // A red ×, as for the table's rows and columns
      const b3 = button("×", () => {
        tip.hidden = true;
        state.runs = state.runs.filter(r => r !== run);
        state.chartRuns.delete(run.id);
        renderRuns(); renderChartControls(); renderCharts(); renderTableControls();
      }, "link x-del");
      b3.type = "button";
      b3.ariaLabel = `Remove ${run.name}`;
      b3.dataset.tip = "Remove run";
      div.append(sw, name, info, spacer, b1, b2, b3);
      box.appendChild(div);
    }
  }

  // ---- Charts ----------------------------------------------------------------------------
  function allStands() {
    const set = new Set();
    for (const r of state.runs) for (const s of r.result.standLabels) set.add(s);
    return GypsyAPI.sortStands([...set]);
  }

  function renderChartControls() {
    enableTab("m-charts", state.runs.length > 0);
    if (!state.runs.length) return;

    const pr = $("pickRuns");
    pr.innerHTML = "";
    for (const run of state.runs)
      pr.appendChild(checkbox(run.name, state.chartRuns.has(run.id), on => {
        if (on) state.chartRuns.add(run.id); else state.chartRuns.delete(run.id);
        renderCharts();
      }));

    renderStandPicker();

    $("pickTotals").replaceChildren(totalsPicker(state.chartTotals, "chartTotalsMore", renderCharts));
    $("pickSpecies").replaceChildren(speciesPicker(col => state.chartVars.has(col),
      (cols, on) => { setAll(state.chartVars, cols, on); renderCharts(); }, "chartSpeciesMore"));
  }

  function setAll(set, cols, on) {
    for (const c of cols) { if (on) set.add(c); else set.delete(c); }
  }

  // ---- Variable pickers (shared by the charts and the yield table) ----------

  // "More" / "Less" button below a list: shows or hides the extra rows, and
  // remembers the choice (state[openKey]). Opens by itself when one of the
  // extra rows is in use.
  function moreToggle(openKey, startOpen, rows) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "more-toggle";
    const set = open => {
      state[openKey] = open;
      rows.forEach(r => r.classList.toggle("hidden", !open));
      b.textContent = open ? "Less" : "More";
      b.setAttribute("aria-expanded", open);
      b.classList.toggle("open", open);
    };
    b.addEventListener("click", () => set(!state[openKey]));
    set(state[openKey] ?? startOpen);
    return b;
  }

  // Stand totals: a box and an All / Con / Dec menu per measure, MAI under
  // "More". sel: { tvol: { on, group }, ... }; onChange() after any change.
  function totalsPicker(sel, openKey, onChange) {
    const box = document.createElement("div");
    const extra = [];
    for (const t of TOTALS) {
      const s = sel[t.key];
      const row = document.createElement("div");
      row.className = "total-row";
      const cb = checkbox(t.label, s.on, on => { s.on = on; onChange(); });
      const menu = document.createElement("select");
      menu.setAttribute("aria-label", `${t.label}: species group`);
      for (const [g, [short, long]] of Object.entries(GROUPS)) {
        const o = new Option(short, g);
        o.title = long;
        menu.add(o);
      }
      menu.value = s.group;
      menu.addEventListener("change", () => {
        s.group = menu.value;
        s.on = true;
        cb.querySelector("input").checked = true;
        onChange();
      });
      row.append(cb, menu);
      box.appendChild(row);
      if (t.more) extra.push(row);
    }
    box.appendChild(moreToggle(openKey, TOTALS.some(t => t.more && sel[t.key].on), extra));
    return box;
  }

  // By species: one grid, with the less common measures shown by "More".
  // onSet(columns, on) sets one or more species columns.
  function speciesPicker(isChecked, onSet, openKey) {
    const box = document.createElement("div");
    const table = speciesMatrix(MEASURES, isChecked, onSet);
    const extra = [...table.rows].slice(1).filter((_, i) => MEASURES[i][4]);
    const used = MEASURES.some(m => m[4] && GypsyAPI.SPECIES.some(s => isChecked(m[0] + s.toLowerCase())));
    box.append(table, moreToggle(openKey, used, extra));
    return box;
  }

  // Checkbox grid: one row per measure, one column per species, and an "All"
  // box per row (shows a dash when only some species are ticked)
  function speciesMatrix(measures, isChecked, onSet) {
    const table = document.createElement("table");
    table.className = "varmatrix";
    const hr = table.insertRow();
    hr.appendChild(document.createElement("th"));
    for (const [text, title] of [...GypsyAPI.SPECIES.map(s => [s, SPP_NAMES[s]]), ["All", "All species"]]) {
      const th = document.createElement("th");
      th.textContent = text;
      th.title = title;
      hr.appendChild(th);
    }
    for (const [p, label] of measures) {
      const tr = table.insertRow();
      tr.insertCell().textContent = label;
      const cols = GypsyAPI.SPECIES.map(s => p + s.toLowerCase());
      const boxes = cols.map((col, i) => {
        const c = document.createElement("input");
        c.type = "checkbox";
        c.checked = isChecked(col);
        c.setAttribute("aria-label", `${label}, ${SPP_NAMES[GypsyAPI.SPECIES[i]]}`);
        tr.insertCell().appendChild(c);
        return c;
      });
      const all = document.createElement("input");
      all.type = "checkbox";
      all.setAttribute("aria-label", `${label}, all species`);
      const cell = tr.insertCell();
      cell.className = "all";
      cell.appendChild(all);
      const syncAll = () => {
        const n = boxes.filter(b => b.checked).length;
        all.checked = n === boxes.length;
        all.indeterminate = n > 0 && n < boxes.length;
      };
      boxes.forEach((c, i) => c.addEventListener("change", () => { syncAll(); onSet([cols[i]], c.checked); }));
      all.addEventListener("change", () => {
        boxes.forEach(b => { b.checked = all.checked; });
        all.indeterminate = false;
        onSet(cols, all.checked);
      });
      syncAll();
    }
    return table;
  }

  // Stand list (filtered, at most 200 shown); up to 8 stands at a time,
  // each keeping its colour while selected
  function renderStandPicker() {
    const stands = allStands();
    for (const s of [...state.chartStands.keys()]) if (!stands.includes(s)) state.chartStands.delete(s);
    const q = $("standFilter").value.trim().toLowerCase();
    const matches = stands.filter(s => s.toLowerCase().includes(q));
    const box = $("pickStands");
    box.innerHTML = "";
    const full = state.chartStands.size >= MAX_SERIES_SLOTS;
    for (const s of matches.slice(0, 200)) {
      const on = state.chartStands.has(s);
      box.appendChild(checkbox(s, on, checked => {
        if (checked) state.chartStands.set(s, freeSlot(new Set(state.chartStands.values())));
        else state.chartStands.delete(s);
        renderStandPicker();
        renderCharts();
      }, !on && full));
    }
    if (matches.length > 200) {
      const more = document.createElement("div");
      more.className = "small";
      more.textContent = `${matches.length - 200} more; type to filter`;
      box.appendChild(more);
    }
    $("standCount").textContent = `(${state.chartStands.size} of max ${MAX_SERIES_SLOTS} selected)`;
  }
  $("standFilter").addEventListener("input", renderStandPicker);
  $("xAxis").addEventListener("change", () => renderCharts());

  function renderCharts() {
    const box = $("charts");
    box.innerHTML = "";
    $("chartNote").textContent = "";
    const runs = state.runs.filter(r => state.chartRuns.has(r.id));
    const stands = GypsyAPI.sortStands([...state.chartStands.keys()]);
    // One panel per stand total, and one per species measure holding every
    // species selected for it
    const panels = [];
    for (const t of TOTALS) {
      const sel = state.chartTotals[t.key];
      if (!sel.on) continue;
      const col = t.cols[sel.group];
      panels.push({ key: col, label: `${t.label}, ${GROUPS[sel.group][1]}`, unit: t.unit, cols: [{ col, spp: null }] });
    }
    for (const [p, label, unit] of MEASURES) {
      const cols = GypsyAPI.SPECIES.filter(s => state.chartVars.has(p + s.toLowerCase()))
                                   .map(s => ({ col: p + s.toLowerCase(), spp: s }));
      if (cols.length) panels.push({ key: p.replace(/_$/, ""), label, unit, cols });
    }
    if (!runs.length || !stands.length || !panels.length) {
      $("chartNote").textContent = "Choose at least one simulation, stand and variable to chart.";
      return;
    }
    const xKey = $("xAxis").value;
    const notes = new Set();

    for (const panel of panels) {
      const multiSpp = panel.cols.length > 1;
      // Colour carries one thing per chart: species when the chart has
      // several, else stands when several are shown, else simulations. Line
      // style then separates the remaining stand/simulation combinations
      // (up to 4).
      let combos = [];
      runs.forEach(run => stands.forEach(s => combos.push({ run, s })));
      let colourBy;
      if (multiSpp) colourBy = "spp";
      else if (stands.length > 1) colourBy = "stand";
      else colourBy = "run";
      const dashGroups = colourBy === "spp" ? combos.length : colourBy === "stand" ? runs.length : 1;
      if (dashGroups > 4) {
        if (colourBy === "spp") {
          combos = combos.slice(0, 4);
          notes.add("Charts with several species show up to 4 stand and simulation combinations (one line style each).");
        } else {
          const keep = new Set(runs.slice(0, 4));
          combos = combos.filter(c => keep.has(c.run));
          notes.add("With several stands, up to 4 simulations are shown (one line style each).");
        }
      }
      const comboRuns = [...new Set(combos.map(c => c.run))];

      const series = [];
      combos.forEach(({ run, s }, ci) => {
        const { names, columns } = run.result.rows;
        const k = run.result.standLabels.indexOf(s);
        if (k < 0) return;
        const per = run.options.simlen;
        const xc = columns[names.indexOf(xKey)];
        for (const { col, spp } of panel.cols) {
          const yc = columns[names.indexOf(col)];
          const y = yc.subarray(k * per, (k + 1) * per);
          if (!y.some(Number.isFinite)) continue;   // e.g. species not in this stand
          const parts = [];
          if (multiSpp) parts.push(spp);
          if (stands.length > 1) parts.push(`Stand ${s}`);
          if (runs.length > 1 || !parts.length) parts.push(run.name);
          series.push({
            label: parts.join(" · "),
            slot: colourBy === "spp" ? GypsyAPI.SPECIES.indexOf(spp) + 1
                : colourBy === "stand" ? state.chartStands.get(s) : run.slot,
            dash: colourBy === "spp" ? ci : colourBy === "stand" ? comboRuns.indexOf(run) : 0,
            x: xc.subarray(k * per, (k + 1) * per),
            y,
          });
        }
      });

      const what = multiSpp ? panel.label
                 : panel.cols[0].spp ? `${panel.label}, ${SPP_NAMES[panel.cols[0].spp]} (${panel.cols[0].spp})`
                 : panel.label;
      const title = stands.length === 1 ? `${what} — Stand ${stands[0]}` : what;
      chartPanel(box, panel.key, { title, xLabel: X_LABELS[xKey],
                                   yLabel: `${panel.label.split(",")[0]} (${panel.unit})`, series,
                                   markMax: panel.key.startsWith("mai_") });
    }
    $("chartNote").textContent = [...notes].join(" ");
  }

  // ---- Chart panels: size, resizing and new windows ---------------------------
  // Each variable remembers its own size (full width, dragged height) until
  // the chart size setting is changed
  const SIZES = { small: { min: 340, height: 220 }, medium: { min: 440, height: 280 }, large: { min: 680, height: 400 } };
  const chartSize = v => state.chartSizes[v] || (state.chartSizes[v] = { wide: false, height: null });

  function chartPanel(box, v, spec) {
    const size = chartSize(v);
    const panel = document.createElement("div");
    panel.className = "chart-panel" + (size.wide ? " wide" : "");
    const chartBox = document.createElement("div");
    panel.appendChild(chartBox);
    box.appendChild(panel);

    const height = () => size.height || SIZES[$("chartSize").value].height;
    let svg;
    panel.draw = () => { svg = GypsyChart.line(chartBox, { ...spec, height: height() }); };

    // Drag the handle under the chart (or use the arrow keys on it) to change
    // the height
    const grip = document.createElement("div");
    grip.className = "chart-grip";
    grip.tabIndex = 0;
    grip.title = "Drag to change the chart height";
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.setAttribute("aria-label", `Resize ${spec.title}`);
    const setHeight = h => { size.height = Math.round(Math.min(900, Math.max(180, h))); panel.draw(); };
    grip.addEventListener("pointerdown", e => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const y0 = e.clientY, h0 = height();
      const move = ev => setHeight(h0 + ev.clientY - y0);
      const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    grip.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHeight(height() + (e.key === "ArrowDown" ? 20 : -20));
      }
    });

    const actions = document.createElement("div");
    actions.className = "chart-actions";
    const wide = button(size.wide ? "Half width" : "Full width", () => {
      size.wide = !size.wide;
      panel.classList.toggle("wide", size.wide);
      wide.textContent = size.wide ? "Half width" : "Full width";
      redrawCharts();
    }, "link");
    actions.append(
      wide,
      button("Open in new window", () => GypsyUI.openChartWindow(spec, `gypsy_${v}.svg`, t => message("chartMessages", t, "warn")), "link"),
      button("Download SVG", () => download(GypsyChart.toSVGText(svg), `gypsy_${v}.svg`, "image/svg+xml"), "link"));
    panel.append(grip, actions);
    panel.draw();
  }

  function redrawCharts() {
    for (const p of $("charts").querySelectorAll(".chart-panel")) p.draw();
  }

  // Redraw when the chart area changes width (window resize, full-width toggle)
  let resizeTimer, lastWidth = 0;
  new ResizeObserver(entries => {
    const w = entries[0].contentRect.width;
    if (Math.abs(w - lastWidth) < 1) return;
    lastWidth = w;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawCharts, 100);
  }).observe($("charts"));

  function applyChartSize() {
    $("charts").style.setProperty("--chart-min", SIZES[$("chartSize").value].min + "px");
  }
  $("chartSize").addEventListener("change", () => {
    state.chartSizes = {};
    applyChartSize();
    renderCharts();
  });
  applyChartSize();

  // ---- Yield table -------------------------------------------------------------------------
  // Columns: Stand and Year always, then the chosen ones in a fixed order
  const AGE_COLS = [["totage", "Total age", "Leading species total age (years)"],
                    ["standage", "Stand age", "Stand age (years)"]];
  const TOTAL_SHORT = { tvol: "Total vol", mvol: "Merch vol", mai_t: "Total MAI", mai_m: "Merch MAI" };
  state.tableCols = new Set(["totage", "standage"]);   // ages and species columns
  state.tableTotals = { tvol: { on: true, group: "all" }, mvol: { on: true, group: "all" },
                        mai_t: { on: false, group: "all" }, mai_m: { on: true, group: "all" } };

  // Column -> { short, long, digits } (digits used when Decimals is Auto)
  function colMeta(col) {
    const a = AGE_COLS.find(c => c[0] === col);
    if (a) return { short: a[1], long: a[2], digits: 1 };
    for (const t of TOTALS)
      for (const [g, c] of Object.entries(t.cols))
        if (c === col) return { short: TOTAL_SHORT[t.key] + (g === "all" ? "" : ` (${GROUPS[g][0]})`),
                                long: `${t.label}, ${GROUPS[g][1]} (${t.unit})`, digits: t.key.startsWith("mai") ? 2 : 1 };
    for (const [p, label, unit, short] of MEASURES)
      if (col.startsWith(p) && col.length === p.length + 2) {
        const s = col.slice(p.length).toUpperCase();
        return { short: `${short} ${s}`, long: `${label}, ${SPP_NAMES[s]} (${unit})`,
                 digits: p === "sc_" ? 3 : p.startsWith("mai") ? 2 : (p === "n_" || p === "mn_") ? 0 : 1 };
      }
    return { short: col, long: col, digits: 2 };
  }
  // Ages, then stand totals, then species columns, each once
  const tableColumns = () => [
    ...AGE_COLS.map(c => c[0]).filter(c => state.tableCols.has(c)),
    ...TOTALS.filter(t => state.tableTotals[t.key].on).map(t => t.cols[state.tableTotals[t.key].group]),
    ...MEASURES.flatMap(([p]) => GypsyAPI.SPECIES.map(s => p + s.toLowerCase())).filter(c => state.tableCols.has(c)),
  ].filter((c, i, a) => a.indexOf(c) === i);

  // Column picker: ages, stand totals and by species, laid out like the
  // chart pickers
  function renderTableColumnPicker() {
    const panel = (title, content) => {
      const div = document.createElement("div");
      div.className = "picker";
      const h = document.createElement("h3");
      h.textContent = title;
      div.append(h, content);
      return div;
    };
    const ages = document.createElement("div");
    for (const [c, label] of AGE_COLS)
      ages.appendChild(checkbox(label, state.tableCols.has(c), on => { setAll(state.tableCols, [c], on); renderTable(); }));
    $("tableCols").replaceChildren(
      panel("Ages", ages),
      panel("Stand totals", totalsPicker(state.tableTotals, "tableTotalsMore", renderTable)),
      panel("By species", speciesPicker(c => state.tableCols.has(c),
        (cols, on) => { setAll(state.tableCols, cols, on); renderTable(); }, "tableSpeciesMore")));
  }

  function renderTableControls(selectRun) {
    enableTab("m-table", state.runs.length > 0);
    if (!state.runs.length) return;
    const sel = $("tableRun"), keep = selectRun ?? Number(sel.value);
    sel.innerHTML = "";
    for (const r of state.runs) sel.add(new Option(r.name, r.id));
    sel.value = String(state.runs.some(r => r.id === keep) ? keep : state.runs[state.runs.length - 1].id);
    fillStandSelect();
  }
  function fillStandSelect() {
    const run = state.runs.find(r => r.id === Number($("tableRun").value));
    const sel = $("tableStand"), keep = sel.value;
    sel.innerHTML = "";
    sel.add(new Option("All stands", ""));
    for (const s of run.result.standLabels) sel.add(new Option(`Stand ${s}`, s));
    sel.value = run.result.standLabels.includes(keep) ? keep : "";
    renderTable();
  }
  // Merchantable yield and By species: the single stand Yield table's columns,
  // for each stand, at every step of stand age. [column, label, unit, digits]
  const DETAIL = [["topht_", "Top height", "m", 1], ["n_", "Density", "stems/ha", 0], ["mn_", "Merch. density", "stems/ha", 0],
                  ["ba_", "BA", "m²/ha", 1], ["qmd_", "QMD", "cm", 1], ["sc_", "Composition", "", 3],
                  ["tvol_", "Total vol.", "m³/ha", 1], ["mvol_", "Merch. vol.", "m³/ha", 1], ["mai_m_", "Merch. MAI", "m³/ha/yr", 3]];
  const YIELD = {
    con: ["Conifer",   [["mvol_con", "Merch. vol.", "m³/ha", 1], ["mai_sa_con", "MAI", "m³/ha/yr", 3], ["pc_con", "Piece size", "trees/m³", 1]]],
    dec: ["Deciduous", [["mvol_dec", "Merch. vol.", "m³/ha", 1], ["mai_sa_dec", "MAI", "m³/ha/yr", 3], ["pc_dec", "Piece size", "trees/m³", 1]]],
    all: ["Total",     [["mvol_all", "Merch. vol.", "m³/ha", 1], ["mai_sa_all", "MAI", "m³/ha/yr", 3]]],
  };

  // A run's column, or one worked out as in single stand mode: MAI over stand
  // age, and piece size (merchantable stems per m³ of merchantable volume)
  function runColumn(run, n) {
    const { names, columns } = run.result.rows;
    const get = k => columns[names.indexOf(k)];
    if (n === "mvol_dec") return get("mvol_aw");
    const z = v => (Number.isFinite(v) ? v : 0);
    const sa = get("standage");
    const make = f => { const out = new Float64Array(sa.length); for (let r = 0; r < sa.length; r++) out[r] = f(r); return out; };
    if (n.startsWith("mai_sa_")) {
      const v = runColumn(run, "mvol_" + n.slice(7));
      return make(r => z(v[r]) / sa[r]);
    }
    if (n === "pc_con") {
      const v = get("mvol_con"), [a, b, c] = ["mn_sb", "mn_sw", "mn_pl"].map(get);
      return make(r => (v[r] > 1e-4 ? (z(a[r]) + z(b[r]) + z(c[r])) / v[r] : NaN));
    }
    if (n === "pc_dec") {
      const v = get("mvol_aw"), m = get("mn_aw");
      return make(r => (v[r] > 1e-4 ? z(m[r]) / v[r] : NaN));
    }
    return get(n);
  }

  // Rows for the yield tables: per stand, the row nearest each multiple of the
  // step in stand age (within half a year), as in single stand mode
  function yieldRowsOf(run, keep, step, from, to) {
    const { names, columns } = run.result.rows;
    const idx = columns[names.indexOf("stand_idx")], sa = columns[names.indexOf("standage")];
    const out = [];
    for (let a = 0; a < idx.length;) {
      let b = a;
      while (b < idx.length && idx[b] === idx[a]) b++;
      if (keep(idx[a])) {
        let r = a;
        for (let age = step; age <= sa[b - 1] + 1e-9; age += step) {
          while (r + 1 < b && Math.abs(sa[r + 1] - age) <= Math.abs(sa[r] - age)) r++;
          if (Math.abs(sa[r] - age) < 0.5 && sa[r] > 0 && age >= from && age <= to) out.push(r);
        }
      }
      a = b;
    }
    return out;
  }

  // Rows and cells for the current table settings: { headers, titles, rows,
  // and for the yield tables groups, units, csv } with rows as arrays of
  // display strings (all matching rows)
  function tableContent() {
    const run = state.runs.find(r => r.id === Number($("tableRun").value));
    if (!run) return null;
    const kind = $("tableKind").value;
    if (kind !== "custom") return yieldContent(run, kind);
    const { names, columns } = run.result.rows;
    const col = n => columns[names.indexOf(n)];
    const idx = col("stand_idx"), year = col("year"), step = Number($("step").value);
    const only = $("tableStand").value;
    const from = Number($("yearFrom").value) || 1, to = Number($("yearTo").value) || Infinity;
    const dec = $("decimals").value;
    const cols = tableColumns().map(c => ({ c, data: col(c), meta: colMeta(c) }));
    const fmt = (v, d) => (Number.isNaN(v) ? "" : v.toFixed(dec === "auto" ? d : Number(dec)));

    const rows = [];
    for (let r = 0; r < idx.length; r++) {
      if (year[r] < from || year[r] > to || year[r] % step !== 0) continue;
      const label = run.result.standLabels[idx[r] - 1];
      if (only && label !== only) continue;
      rows.push([label, String(year[r]), ...cols.map(c => fmt(c.data[r], c.meta.digits))]);
    }
    return {
      run,
      headers: ["Stand", "Year", ...cols.map(c => c.meta.short)],
      titles:  ["Stand", "Years from start", ...cols.map(c => c.meta.long)],
      rows,
    };
  }

  function yieldContent(run, kind) {
    const { names, columns } = run.result.rows;
    const get = k => columns[names.indexOf(k)];
    const only = $("tableStand").value, labels = run.result.standLabels;
    const keep = i => !only || labels[i - 1] === only;
    const from = Number($("yearFrom").value) || 0, to = Number($("yearTo").value) || Infinity;
    const rowIdx = yieldRowsOf(run, keep, Number($("step").value), from, to);
    const dec = $("decimals").value;
    const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(dec === "auto" ? d : Number(dec)) : "");

    // Species, and conifer and deciduous groups, in the rows shown
    const has = s => { const n = get("n_" + s.toLowerCase()); return rowIdx.some(r => n[r] > 0); };
    const present = GypsyAPI.SPECIES.filter(has);
    const cols = [], groups = [["", 2]];
    if (kind === "detail") {
      for (const s of present) {
        groups.push([`${s} – ${SPP_NAMES[s]}`, DETAIL.length]);
        for (const [p, label, unit, d] of DETAIL) cols.push({ c: p + s.toLowerCase(), label, unit, d, group: s });
      }
    } else {
      const hasCon = present.some(s => s !== "AW"), hasDec = present.includes("AW");
      for (const g of [hasCon && "con", hasDec && "dec", "all"].filter(Boolean)) {
        const [name, list] = YIELD[g];
        groups.push([name, list.length]);
        for (const [c, label, unit, d] of list) cols.push({ c, label, unit, d, group: name });
      }
    }
    for (const c of cols) c.data = runColumn(run, c.c);
    const idx = get("stand_idx"), sa = get("standage");
    const long = c => `${c.group}: ${c.label}${c.unit ? ` (${c.unit})` : ""}`;
    return {
      run, groups,
      note: kind === "yield"
        ? "MAI is merchantable volume over stand age. Piece size is merchantable stems per cubic metre of merchantable volume."
        : "Merchantable MAI by species is over the species' total age.",
      headers: ["Stand", "Stand age", ...cols.map(c => c.label)],
      units:   ["", "years", ...cols.map(c => c.unit)],
      titles:  ["Stand", "Stand age (years)", ...cols.map(long)],
      csv:     ["Stand", "Stand age (years)", ...cols.map(long)],
      rows: rowIdx.map(r => [labels[idx[r] - 1], fmt(sa[r], 0), ...cols.map(c => fmt(c.data[r], c.d))]),
    };
  }

  const TABLE_MAX = 2000;
  function renderTable() {
    const t = tableContent();
    if (!t) return;
    const table = $("results");
    table.innerHTML = "";
    const head = table.createTHead();
    if (t.groups) {
      const gr = head.insertRow();
      for (const [text, span] of t.groups) {
        const th = document.createElement("th");
        th.textContent = text;
        th.colSpan = span;
        if (text) th.className = "group";
        gr.appendChild(th);
      }
    }
    const hr = head.insertRow();
    t.headers.forEach((h, i) => {
      const th = document.createElement("th");
      th.textContent = h;
      if (t.units?.[i]) th.appendChild(Object.assign(document.createElement("span"), { className: "unit", textContent: t.units[i] }));
      th.title = t.titles[i];
      hr.appendChild(th);
    });
    const tbody = table.createTBody();
    for (const row of t.rows.slice(0, TABLE_MAX)) {
      const tr = tbody.insertRow();
      for (const v of row) tr.insertCell().textContent = v;
    }
    $("tableNote").textContent = (t.rows.length > TABLE_MAX
      ? `Showing the first ${TABLE_MAX.toLocaleString()} of ${t.rows.length.toLocaleString()} rows. Export table includes them all.`
      : `${t.rows.length.toLocaleString()} rows.`) + (t.note ? " " + t.note : "");
  }

  $("tableExport").addEventListener("click", () => {
    const t = tableContent();
    if (!t) return;
    const quote = s => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    const lines = [t.csv || t.headers, ...t.rows].map(r => r.map(quote).join(","));
    download(lines.join("\n") + "\n", `${fileStem(t.run.name)}_table.csv`);
  });
  $("tableRun").addEventListener("change", fillStandSelect);
  for (const id of ["tableStand", "step", "decimals"]) $(id).addEventListener("change", renderTable);
  // Custom columns: the column picker is shown, and rows are by year. The
  // yield tables are by stand age, and so are their From and To boxes.
  $("tableKind").addEventListener("change", () => {
    const custom = $("tableKind").value === "custom";
    $("tableColsBox").classList.toggle("hidden", !custom);
    $("fromLabel").textContent = custom ? "From year" : "From stand age";
    $("toLabel").textContent = custom ? "To year" : "To stand age";
    renderTable();
  });
  $("tableKind").dispatchEvent(new Event("change"));
  for (const id of ["yearFrom", "yearTo"]) $(id).addEventListener("input", renderTable);
  renderTableColumnPicker();

  // Optional settings: show the inputs, or the defaults in use
  for (const [box, group, note] of [["customMerch", "merchOptions", "merchDefault"]]) {
    const sync = () => {
      $(group).classList.toggle("hidden", !$(box).checked);
      $(note).classList.toggle("hidden", $(box).checked);
    };
    $(box).addEventListener("change", sync);
    sync();
  }
})();
