// ---------------------------------------------------------------------------
// GYPSY web app: input table, simulations, charts and results
//
// Uses gypsy.js (the model), gypsy-api.js (input and run helpers),
// xlsx-reader.js and chart.js.
// ---------------------------------------------------------------------------

(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const FIELDS = GypsyAPI.FIELDS;
  const SPP_NAMES = { AW: "Aspen", SB: "Black spruce", SW: "White spruce", PL: "Lodgepole pine" };
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

  // Output variables offered in the charts: [column, label, unit]
  const TOTALS = [
    ["mvol_all", "Merchantable volume, all species", "m³/ha"],
    ["tvol_all", "Total volume, all species", "m³/ha"],
    ["mvol_con", "Merchantable volume, conifers", "m³/ha"],
    ["tvol_con", "Total volume, conifers", "m³/ha"],
    ["mai_m_all", "Merchantable MAI, all species", "m³/ha/yr"],
    ["mai_t_all", "Total MAI, all species", "m³/ha/yr"],
    ["mai_m_con", "Merchantable MAI, conifers", "m³/ha/yr"],
    ["mai_t_con", "Total MAI, conifers", "m³/ha/yr"],
    ["mai_m_dec", "Merchantable MAI, deciduous", "m³/ha/yr"],
    ["mai_t_dec", "Total MAI, deciduous", "m³/ha/yr"],
  ];
  const MEASURES = [
    ["topht_", "Top height", "m"],
    ["n_", "Density", "stems/ha"],
    ["ba_", "Basal area", "m²/ha"],
    ["qmd_", "Quadratic mean diameter", "cm"],
    ["sc_", "Species composition", "proportion"],
    ["tvol_", "Total volume", "m³/ha"],
    ["mvol_", "Merchantable volume", "m³/ha"],
    ["mn_", "Merchantable stems", "stems/ha"],
    ["mai_t_", "Total MAI", "m³/ha/yr"],
    ["mai_m_", "Merchantable MAI", "m³/ha/yr"],
  ];
  const X_LABELS = { year: "Years from start", totage: "Leading species total age (years)", standage: "Stand age (years)" };

  function varInfo(col) {
    const t = TOTALS.find(v => v[0] === col);
    if (t) return { label: t[1], unit: t[2] };
    for (const [p, label, unit] of MEASURES)
      if (col.startsWith(p) && col.length === p.length + 2) {
        const s = col.slice(p.length).toUpperCase();
        return { label: `${label}, ${SPP_NAMES[s]} (${s})`, unit };
      }
    return { label: col, unit: "" };
  }

  // ---- State ------------------------------------------------------------------
  const state = {
    gypsy: null,
    source: null,      // { kind: "text" | "xlsx" | "new", name, text, sheets }
    names: [],         // column names
    header: null,      // original header row (to restore when the header is turned off)
    rows: [],          // data rows, arrays of strings
    mapping: {},       // field -> column index (-1 when unassigned)
    edited: false,
    page: 0,
    runs: [],          // { id, name, slot, options, result, ms }
    runCount: 0,
    chartRuns: new Set(),
    chartStands: new Map(),                       // stand label -> colour slot
    chartVars: new Set(["mvol_all", "mai_m_all"]),
  };

  // ---- Model ------------------------------------------------------------------
  createGypsy().then(m => {
    state.gypsy = m;
    $("run").disabled = false;
    $("status").textContent = "Ready";
  }).catch(e => { $("status").textContent = "Could not load the model: " + e; });

  // ---- Messages -------------------------------------------------------------------
  function message(box, text, cls) {
    const div = document.createElement("div");
    div.className = "msg " + cls;
    div.textContent = text;
    $(box).appendChild(div);
  }
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
      all = [FIELDS.map(f => f.key), FIELDS.map(() => "")];
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
    state.page = 0;

    $("sourceBar").classList.remove("hidden");
    $("sourceName").textContent = src.name;
    $("sheetField").classList.toggle("hidden", src.kind !== "xlsx");
    $("delimField").classList.toggle("hidden", src.kind !== "text");
    $("gridArea").classList.remove("hidden");
    renderGrid();
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
  $("delimiter").addEventListener("change", () => { if (confirmDiscard()) applySource(); });
  $("sheet").addEventListener("change", () => { if (confirmDiscard()) applySource(); });

  // Drag and drop
  const drop = $("drop");
  ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => {
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
  $("file").addEventListener("change", e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; });
  $("pasteToggle").addEventListener("click", () => { $("pasteBox").classList.toggle("hidden"); $("pasteText").focus(); });
  $("pasteUse").addEventListener("click", () => {
    const text = $("pasteText").value;
    if (!text.trim() || !confirmDiscard()) return;
    clearMessages("inputMessages");
    setSource({ kind: "text", name: "Pasted text", text });
    $("pasteBox").classList.add("hidden");
  });
  $("loadExample").addEventListener("click", () => {
    if (!confirmDiscard()) return;
    $("hasHeader").checked = true;
    setSource({ kind: "text", name: "Example data (5 stands)", text: EXAMPLE });
  });
  $("newTable").addEventListener("click", () => {
    if (!confirmDiscard()) return;
    $("hasHeader").checked = true;
    setSource({ kind: "new", name: "New table" });
  });

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
      sel.addEventListener("change", () => {
        for (const k of Object.keys(state.mapping)) if (state.mapping[k] === j) state.mapping[k] = -1;
        if (sel.value) state.mapping[sel.value] = j;
        renderGrid();
      });
      th.append(span, sel);
      hr.appendChild(th);
    });
    hr.appendChild(document.createElement("th"));

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
        const inp = document.createElement("input");
        inp.value = v;
        inp.dataset.col = j;
        inp.setAttribute("aria-label", `Row ${r + 1}, ${state.names[j]}`);
        td.appendChild(inp);
      });
      const del = tr.insertCell();
      del.className = "del";
      const b = document.createElement("button");
      b.className = "link";
      b.textContent = "×";
      b.title = b.ariaLabel = `Delete row ${r + 1}`;
      b.dataset.del = r;
      del.appendChild(b);
    }
    $("pageInfo").textContent = `Rows ${state.rows.length ? first + 1 : 0}–${last} of ${state.rows.length}`;
    $("prevPage").disabled = state.page === 0;
    $("nextPage").disabled = state.page >= pages - 1;
    updateGridStatus();
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

  const tbodyRow = el => Number(el.closest("tr").dataset.row);
  $("grid").addEventListener("input", e => {
    if (e.target.tagName !== "INPUT") return;
    const r = tbodyRow(e.target), j = Number(e.target.dataset.col);
    state.rows[r][j] = e.target.value;
    state.edited = true;
    e.target.parentNode.classList.toggle("bad", cellProblem(fieldOfColumn()[j], e.target.value));
    clearTimeout(updateGridStatus.timer);
    updateGridStatus.timer = setTimeout(updateGridStatus, 200);
  });
  $("grid").addEventListener("keydown", e => {
    if (e.target.tagName !== "INPUT" || e.key !== "Enter") return;
    e.preventDefault();
    const tr = e.target.closest("tr");
    const next = e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling;
    if (next) next.querySelector(`input[data-col="${e.target.dataset.col}"]`).focus();
  });
  // A block pasted from a spreadsheet fills cells below and to the right
  $("grid").addEventListener("paste", e => {
    if (e.target.tagName !== "INPUT") return;
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\n]/.test(text.replace(/\r?\n$/, ""))) return;
    e.preventDefault();
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
    const b = e.target.closest("button[data-del]");
    if (!b) return;
    state.rows.splice(Number(b.dataset.del), 1);
    state.edited = true;
    renderGrid();
  });
  $("addRow").addEventListener("click", () => {
    state.rows.push(state.names.map(() => ""));
    state.edited = true;
    state.page = Math.ceil(state.rows.length / pageSize()) - 1;
    renderGrid();
    const inputs = $("grid").querySelectorAll("tbody tr:last-child input");
    if (inputs[0]) inputs[0].focus();
  });
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
      ({ input, warnings } = GypsyAPI.inputFromRows(keep.map(i => state.rows[i]), state.mapping));
      rowLabels = keep.map(i => i + 1);
    } catch (e) { message("runMessages", e.message, "err"); return; }

    const per4 = v => [v, v, v, v];
    const options = {
      simlen: num("simlen"), sitype: $("sitype").value, agetype: $("agetype").value,
      psflag: $("psflag").checked, baflag: $("baflag").checked,
      stumpHt: per4(num("stumpHt")), stumpDob: per4(num("stumpDob")), topDib: per4(num("topDib")),
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

  // ---- Runs list ----------------------------------------------------------------------
  function download(text, name, type = "text/csv") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const fileStem = name => name.replace(/[^\w.-]+/g, "_");

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
      info.textContent = `${run.result.standLabels.length} stands · ${o.simlen} years · ` +
        `stump ${o.stumpHt[0]} m, ${o.stumpDob[0]} cm DOB, top ${o.topDib[0]} cm DIB · ` +
        `SI type ${o.sitype}, age type ${o.agetype} · stocking ${o.psflag ? "on" : "off"}, BA ${o.baflag ? "on" : "off"}`;
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      const b1 = button("Yearly results (CSV)", () => download(GypsyAPI.toCSV(run.result.rows, run.result.standLabels), `${fileStem(run.name)}_yearly.csv`));
      const b2 = button("Stand summary (CSV)", () => download(GypsyAPI.toCSV(run.result.init, run.result.standLabels), `${fileStem(run.name)}_stands.csv`));
      const b3 = button("Remove", () => {
        state.runs = state.runs.filter(r => r !== run);
        state.chartRuns.delete(run.id);
        renderRuns(); renderChartControls(); renderCharts(); renderTableControls();
      });
      div.append(sw, name, info, spacer, b1, b2, b3);
      box.appendChild(div);
    }
  }

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

  // ---- Charts ----------------------------------------------------------------------------
  function allStands() {
    const set = new Set();
    for (const r of state.runs) for (const s of r.result.standLabels) set.add(s);
    return GypsyAPI.sortStands([...set]);
  }

  function renderChartControls() {
    $("chartSection").classList.toggle("hidden", !state.runs.length);
    if (!state.runs.length) return;

    const pr = $("pickRuns");
    pr.innerHTML = "";
    for (const run of state.runs)
      pr.appendChild(checkbox(run.name, state.chartRuns.has(run.id), on => {
        if (on) state.chartRuns.add(run.id); else state.chartRuns.delete(run.id);
        renderCharts();
      }));

    renderStandPicker();

    const pt = $("pickTotals");
    pt.innerHTML = "";
    for (const [col, label] of TOTALS)
      pt.appendChild(checkbox(label, state.chartVars.has(col), on => toggleVar(col, on)));

    const ps = $("pickSpecies");
    ps.innerHTML = "";
    const hr = ps.insertRow();
    hr.appendChild(document.createElement("th"));
    for (const s of GypsyAPI.SPECIES) {
      const th = document.createElement("th");
      th.textContent = s;
      th.title = SPP_NAMES[s];
      hr.appendChild(th);
    }
    for (const [p, label] of MEASURES) {
      const tr = ps.insertRow();
      tr.insertCell().textContent = label;
      for (const s of GypsyAPI.SPECIES) {
        const col = p + s.toLowerCase();
        const c = document.createElement("input");
        c.type = "checkbox";
        c.checked = state.chartVars.has(col);
        c.setAttribute("aria-label", `${label}, ${SPP_NAMES[s]}`);
        c.addEventListener("change", () => toggleVar(col, c.checked));
        tr.insertCell().appendChild(c);
      }
    }
  }

  function toggleVar(col, on) {
    if (on) state.chartVars.add(col); else state.chartVars.delete(col);
    renderCharts();
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
      box.appendChild(checkbox(`Stand ${s}`, on, checked => {
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
    const order = [...TOTALS.map(t => t[0]), ...MEASURES.flatMap(([p]) => GypsyAPI.SPECIES.map(s => p + s.toLowerCase()))];
    const vars = order.filter(v => state.chartVars.has(v));
    if (!runs.length || !stands.length || !vars.length) {
      $("chartNote").textContent = "Choose at least one simulation, stand and variable to chart.";
      return;
    }

    // Colour by stand when several stands are shown (line style by run);
    // otherwise colour by run
    let useRuns = runs;
    if (stands.length > 1 && runs.length > 4) {
      useRuns = runs.slice(0, 4);
      $("chartNote").textContent = "With several stands, up to 4 simulations are shown (one line style each).";
    }
    const xKey = $("xAxis").value;

    for (const v of vars) {
      const info = varInfo(v);
      const series = [];
      useRuns.forEach((run, ri) => {
        const { names, columns } = run.result.rows;
        const xc = columns[names.indexOf(xKey)], yc = columns[names.indexOf(v)];
        const per = run.options.simlen;
        for (const s of stands) {
          const k = run.result.standLabels.indexOf(s);
          if (k < 0) continue;
          const multiStand = stands.length > 1;
          series.push({
            label: multiStand ? (useRuns.length > 1 ? `Stand ${s} · ${run.name}` : `Stand ${s}`) : run.name,
            slot: multiStand ? state.chartStands.get(s) : run.slot,
            dash: multiStand && useRuns.length > 1 ? ri : 0,
            x: xc.subarray(k * per, (k + 1) * per),
            y: yc.subarray(k * per, (k + 1) * per),
          });
        }
      });
      const panel = document.createElement("div");
      box.appendChild(panel);
      const chartBox = document.createElement("div");
      panel.appendChild(chartBox);
      const title = stands.length === 1 ? `${info.label} — Stand ${stands[0]}` : info.label;
      const svg = GypsyChart.line(chartBox, { title, xLabel: X_LABELS[xKey], yLabel: `${info.label.split(",")[0]} (${info.unit})`, series });
      const actions = document.createElement("div");
      actions.className = "chart-actions";
      actions.appendChild(button("Download SVG", () => download(GypsyChart.toSVGText(svg), `gypsy_${v}.svg`, "image/svg+xml"), "link"));
      panel.appendChild(actions);
    }
  }
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCharts, 150); });

  // ---- Results table -----------------------------------------------------------------------
  const TABLE_COLS = [
    ["year", "Year", 0], ["totage", "Total age", 1], ["standage", "Stand age", 1],
    ["tvol_con", "Conifer vol", 1], ["tvol_all", "Total vol", 1],
    ["mvol_con", "Conifer merch vol", 1], ["mvol_all", "Merch vol", 1],
    ["mai_t_all", "Total MAI", 2], ["mai_m_all", "Merch MAI", 2],
  ];

  function renderTableControls(selectRun) {
    $("tableSection").classList.toggle("hidden", !state.runs.length);
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
  function renderTable() {
    const run = state.runs.find(r => r.id === Number($("tableRun").value));
    if (!run) return;
    const { names, columns } = run.result.rows;
    const col = n => columns[names.indexOf(n)];
    const idx = col("stand_idx"), year = col("year"), step = Number($("step").value);
    const only = $("tableStand").value;
    const fmt = (v, d) => (Number.isNaN(v) ? "" : v.toFixed(d));

    const table = $("results");
    table.innerHTML = "";
    const hr = table.createTHead().insertRow();
    for (const t of ["Stand", ...TABLE_COLS.map(c => c[1])]) {
      const th = document.createElement("th");
      th.textContent = t;
      hr.appendChild(th);
    }
    const tbody = table.createTBody();
    let shown = 0;
    for (let r = 0; r < idx.length && shown < 2000; r++) {
      if (year[r] % step !== 0) continue;
      const label = run.result.standLabels[idx[r] - 1];
      if (only && label !== only) continue;
      const tr = tbody.insertRow();
      tr.insertCell().textContent = label;
      for (const [n, , d] of TABLE_COLS) tr.insertCell().textContent = fmt(col(n)[r], d);
      shown++;
    }
    if (shown >= 2000) {
      const tr = tbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = TABLE_COLS.length + 1;
      td.className = "small";
      td.textContent = "First 2,000 rows shown; choose a stand, or download the CSV for everything.";
    }
  }
  $("tableRun").addEventListener("change", fillStandSelect);
  $("tableStand").addEventListener("change", renderTable);
  $("step").addEventListener("change", renderTable);

  // Start with the example data
  setSource({ kind: "text", name: "Example data (5 stands)", text: EXAMPLE });
})();
