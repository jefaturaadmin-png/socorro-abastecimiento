/* Filtros tipo Excel en las tablas: en cada encabezado un ▾ para ordenar A→Z / Z→A y elegir qué valores mostrar
   (con buscador), como el autofiltro de Excel. Trabaja sobre la tabla ya pintada (el texto de cada celda); lo elegido
   queda guardado por tabla y se vuelve a aplicar al repintar. Lo usan la página principal y los módulos del kardex.
   window.fxAplicar(tabla, clave, columnasSinFiltro, alContar(visibles, total)) · window.fxActivo(clave) */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = s => String(s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const FX = {}; let abierto = null;
  if (!$("fxPop")) { const d = document.createElement("div"); d.id = "fxPop"; d.className = "fx-pop"; d.hidden = true; document.body.appendChild(d); }
  // texto de la celda (textContent: no obliga al navegador a recalcular la pantalla, a diferencia de innerText);
  // se guarda en la celda para no volver a leerlo
  const fxTxt = td => { if (!td) return "(vacías)"; if (td.fxT != null) return td.fxT;
    const t = [...td.childNodes].map(n => n.textContent).join(" ").replace(/\s+/g, " ").trim() || "(vacías)"; td.fxT = t; return t; };
  function fxAplicar(tabla, clave, omitir = [], alContar) {
    const st = FX[clave] ??= { f: {}, ord: null };
    tabla.dataset.fx = clave; tabla.fxOmitir = omitir; tabla.fxContar = alContar;
    [...tabla.querySelectorAll("thead th")].forEach((th, i) => {
      if (omitir.includes(i)) return;
      let b = th.querySelector(".fx-btn"); if (!b) { th.insertAdjacentHTML("beforeend", `<button type="button" class="fx-btn" data-fxi="${i}" title="Filtrar y ordenar" aria-label="Filtrar y ordenar">▾</button>`); b = th.querySelector(".fx-btn"); }
      b.classList.toggle("activo", !!st.f[i] || st.ord?.i === i); b.textContent = st.f[i] ? "⏷" : st.ord?.i === i ? (st.ord.dir > 0 ? "↑" : "↓") : "▾";
    });
    const tb = tabla.tBodies[0]; if (!tb) return;
    const filas = [...tb.rows].filter(r => !r.classList.contains("vacia") && r.cells.length > 1);
    if (st.ord) {
      const { i, dir } = st.ord, col = new Intl.Collator("es", { numeric: true }), k = filas.map(r => [fxTxt(r.cells[i]), r]);
      k.sort((a, b) => dir * col.compare(a[0], b[0]));
      const frag = document.createDocumentFragment(); for (const [, r] of k) frag.appendChild(r); tb.appendChild(frag);   // se mueven todas de una vez
    }
    let vis = 0; const fil = Object.entries(st.f);
    for (const r of filas) { const ok = fil.every(([i, set]) => set.has(fxTxt(r.cells[i]))); if (r.hidden !== !ok) r.hidden = !ok; if (ok) vis++; }
    alContar?.(vis, filas.length);
  }
  const fxActivo = clave => !!FX[clave] && (Object.keys(FX[clave].f).length > 0 || !!FX[clave].ord);
  const repintar = A => { fxAplicar(A.tabla, A.clave, A.tabla.fxOmitir, A.tabla.fxContar); A.tabla.dispatchEvent(new CustomEvent("fx-cambio", { bubbles: true })); };
  function abrir(btn) {
    const tabla = btn.closest("table"), clave = tabla.dataset.fx, st = FX[clave], i = +btn.dataset.fxi;
    const filas = [...tabla.tBodies[0].rows].filter(r => !r.classList.contains("vacia") && r.cells.length > 1);
    const otros = Object.entries(st.f).filter(([k]) => +k !== i);   // como en Excel: lo que queda con los filtros de las otras columnas
    const col = new Intl.Collator("es", { numeric: true });
    const vals = [...new Set(filas.filter(r => otros.every(([k, set]) => set.has(fxTxt(r.cells[k])))).map(r => fxTxt(r.cells[i])))].sort(col.compare);
    const sel = st.f[i] || new Set(vals), pop = $("fxPop");
    abierto = { tabla, clave, i, vals };
    pop.innerHTML = `<button type="button" class="fx-op" data-fxord="1">↑ Ordenar de A a Z</button><button type="button" class="fx-op" data-fxord="-1">↓ Ordenar de Z a A</button>
      <button type="button" class="fx-op" data-fxborrar ${st.f[i] || st.ord?.i === i ? "" : "disabled"}>✕ Borrar filtro de «${esc(fxTxt(tabla.tHead.rows[0].cells[i]).replace(/[▾⏷↑↓]$/, "").trim())}»</button>
      <input type="search" id="fxBus" placeholder="Buscar" autocomplete="off">
      <div class="fx-lista"><label class="fx-todo"><input type="checkbox" id="fxTodo" ${vals.every(v => sel.has(v)) ? "checked" : ""}> (Seleccionar todo)</label>
        ${vals.map(v => `<label><input type="checkbox" data-fxv="${esc(v)}" ${sel.has(v) ? "checked" : ""}> ${esc(v.length > 80 ? v.slice(0, 80) + "…" : v)}</label>`).join("")}</div>
      <div class="fx-bot"><button type="button" class="btn primario primary sm" id="fxOk">Aceptar</button><button type="button" class="btn sm" id="fxNo">Cancelar</button></div>`;
    pop.hidden = false;
    const r = btn.getBoundingClientRect(), w = Math.min(290, innerWidth - 16);
    pop.style.width = w + "px"; pop.style.left = Math.max(8, Math.min(r.left + scrollX, scrollX + innerWidth - w - 8)) + "px"; pop.style.top = (r.bottom + scrollY + 4) + "px";
    $("fxBus").focus();
  }
  const cerrar = () => { $("fxPop").hidden = true; abierto = null; };
  document.addEventListener("click", e => {
    const b = e.target.closest(".fx-btn"); if (b) { e.stopPropagation(); return abierto?.tabla === b.closest("table") && abierto.i === +b.dataset.fxi ? cerrar() : abrir(b); }
    if (!$("fxPop").hidden && !e.target.closest("#fxPop")) cerrar();
  }, true);
  $("fxPop").addEventListener("click", e => {
    const A = abierto; if (!A) return; const st = FX[A.clave];
    const o = e.target.closest("[data-fxord]"); if (o) { st.ord = { i: A.i, dir: +o.dataset.fxord }; cerrar(); return repintar(A); }
    if (e.target.closest("[data-fxborrar]")) { delete st.f[A.i]; if (st.ord?.i === A.i) st.ord = null; cerrar(); return repintar(A); }
    if (e.target.closest("#fxNo")) return cerrar();
    if (e.target.closest("#fxOk")) {
      const marc = new Set([...$("fxPop").querySelectorAll("[data-fxv]")].filter(x => x.checked).map(x => x.dataset.fxv));
      if (A.vals.every(v => marc.has(v))) delete st.f[A.i]; else st.f[A.i] = marc;
      cerrar(); return repintar(A);
    }
  });
  $("fxPop").addEventListener("change", e => {
    if (e.target.id === "fxTodo") $("fxPop").querySelectorAll("[data-fxv]").forEach(x => { if (!x.parentElement.hidden) x.checked = e.target.checked; });
    else if (e.target.dataset.fxv != null) { const xs = [...$("fxPop").querySelectorAll("[data-fxv]")]; $("fxTodo").checked = xs.every(x => x.checked); }
  });
  $("fxPop").addEventListener("input", e => {
    if (e.target.id !== "fxBus") return; const q = norm(e.target.value).trim();
    $("fxPop").querySelectorAll("[data-fxv]").forEach(x => { const ok = !q || norm(x.dataset.fxv).includes(q); x.parentElement.hidden = !ok; if (q) x.checked = ok; });
  });
  $("fxPop").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("fxOk").click(); } else if (e.key === "Escape") cerrar(); });
  window.fxAplicar = fxAplicar; window.fxActivo = fxActivo;
})();
