// Comparativo de precios: nuestro precio (lista de Lolfar) vs Mifarma y Boticas Perú.
// Los precios de la competencia los deja cada noche GitHub Actions en data/competencia/ (sin costo de Firebase).
// En Firebase (solo administrador) se guardan: las parejas confirmadas (comp_config/pares),
// nuestra lista de precios y su historial (comp_blobs, comprimidos).
const PADRE = (() => { try { return window.parent !== window && window.parent.FB ? window.parent : null; } catch { return null; } })();
let F;
if (PADRE) F = PADRE.FB;
else {
  const V = "https://www.gstatic.com/firebasejs/13.0.0/";
  const [{ initializeApp }, A, FS, { firebaseConfig }] = await Promise.all([
    import(V + "firebase-app.js"), import(V + "firebase-auth.js"), import(V + "firebase-firestore.js"), import("./config.js?v=202610161000")]);
  const app = initializeApp(firebaseConfig);
  F = { auth: A.getAuth(app), db: FS.getFirestore(app), onAuthStateChanged: A.onAuthStateChanged,
    doc: FS.doc, getDoc: FS.getDoc, setDoc: FS.setDoc, deleteDoc: FS.deleteDoc, collection: FS.collection, getDocs: FS.getDocs };
}
const { auth, db, onAuthStateChanged, doc, getDoc, deleteDoc, collection, getDocs } = F;
const plano = v => PADRE ? PADRE.JSON.parse(JSON.stringify(v)) : v;   // Firebase solo acepta objetos de su ventana
const setDoc = (ref, v, o) => F.setDoc(ref, plano(v), ...(o ? [plano(o)] : []));

/* ---------- utilidades ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sol = v => v == null ? "–" : "S/ " + v.toFixed(2);
const pct = v => v == null ? "–" : (v > 0 ? "+" : "") + Math.round(v * 100) + " %";
const fechaL = f => f ? f.split("-").reverse().join("/") : "";
const msg = (t, err) => { const m = $("msg"); m.hidden = !t; m.textContent = t || ""; m.className = "msg" + (err ? " error" : ""); };
const toast = t => { const x = $("toast"); x.textContent = t; x.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => x.hidden = true, 3500); };
const PAGINA = 100;

/* ---------- guardado comprimido en trozos (un documento de Firestore admite ~1 MB) ---------- */
const TROZO = 800000;
const aB64 = b => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const deB64 = t => { const s = atob(t), b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
const partes = id => collection(db, "comp_blobs", id, "partes");
async function subirBlob(obj) {
  const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const t = aB64(gz), id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6), n = Math.ceil(t.length / TROZO);
  for (let i = 0; i < n; i++) await setDoc(doc(partes(id), String(i)), { d: t.slice(i * TROZO, (i + 1) * TROZO) });
  await setDoc(doc(db, "comp_blobs", id), { n, bytes: gz.length, fecha: new Date().toISOString() });
  return id;
}
async function leerBlob(id) {
  const s = await getDocs(partes(id));
  const t = s.docs.sort((a, b) => a.id - b.id).map(d => d.data().d).join("");
  return JSON.parse(await new Response(new Blob([deB64(t)]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
}
async function borrarBlob(id) {
  const s = await getDocs(partes(id)); await Promise.all(s.docs.map(d => deleteDoc(d.ref))); await deleteDoc(doc(db, "comp_blobs", id));
}
// Mismo formato que usa Proyección (proy_blobs) para leer el costo del kardex.
async function leerBlobProy(id) {
  const s = await getDocs(collection(db, "proy_blobs", id, "partes"));
  const t = s.docs.sort((a, b) => a.id - b.id).map(d => d.data().d).join("");
  return JSON.parse(await new Response(new Blob([deB64(t)]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
}

/* ---------- estado ---------- */
const TIENDAS = [{ k: "mf", archivo: "mifarma", nombre: "Mifarma" }, { k: "bp", archivo: "boticasperu", nombre: "Boticas Perú" }];
const S = {
  cat: [],            // nuestro catálogo [{c, n, l, ln}]
  comp: {},           // mf/bp: { fecha, p: {id: [nombre, marca, pres, unidades, precio, oferta, tarjeta, url]} }
  idx: {},            // índice de palabras de cada tienda
  pares: {},          // confirmados: {cod: {mf: id|"" , bp: id|""}}  ("" = no lo vende)
  sug: {},            // sugeridos: {cod: {mf: [id, score], bp: [id, score]}}
  lista: null,        // nuestra lista de precios {fecha, p: {cod: precio}}
  costo: {},          // costo del kardex {cod: [nombre, fra, coscom, fecha]}
  hist: {},           // historial de la competencia (se carga al abrir un producto)
  histPropio: null,
  filtro: "comparados", q: "", lab: "", mostrar: PAGINA, ficha: null
};

/* ---------- emparejamiento por nombre ---------- */
const VACIAS = new Set(("X CAJA CJ CAJ FRASCO FCO FRA TABLETA TABLETAS TAB TABS COMPRIMIDO COMPRIMIDOS COMP CAPSULA CAPSULAS CAP CAPS " +
  "SOBRE SOBRES SOB BLISTER BLIS UN UND UNID UNIDAD UNIDADES MG ML G GR GRAMOS MCG UI LT L DE DEL LA EL CON PARA Y EN " +
  "RECUBIERTA RECUBIERTAS RECUB ORAL SUSP SUSPENSION SOLUCION SOL JARABE JBE INY INYECTABLE AMPOLLA AMP TUBO CREMA CRE GEL UNG " +
  "POLVO GOTAS GTS SPRAY BOLSA PACK X1 VIAL FCOX").split(" "));
const sinTildes = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
function rasgos(nombre) {
  const t = sinTildes(nombre).replace(/(\d),(\d)/g, "$1.$2");
  const tokens = t.match(/[A-Z]+|\d+(?:\.\d+)?/g) || [];
  const pal = [], nums = [];
  for (const k of tokens) {
    if (/^\d/.test(k)) nums.push(String(+k));
    else if (k.length >= 3 && !VACIAS.has(k)) pal.push(k);
  }
  return { pal: [...new Set(pal)], nums: [...new Set(nums)] };
}
// Unidades por presentación: "X 100TAB", "X20SOB", "Caja 100 UN"
function unidadesDe(nombre) {
  const t = sinTildes(nombre);
  const m = [...t.matchAll(/X\s*(\d+)\s*(TAB|CAP|COMP|SOB|AMP|UN|UND|GRAG|OVU|PAR|PZA)?/g)].pop()
    || /(\d+)\s*(UN|UND|TAB|CAP|SOB|AMP|COMP)\b/.exec(t);
  return m ? +m[1] : null;
}
function indexar(k) {
  const idx = new Map(), info = new Map();
  for (const [id, p] of Object.entries(S.comp[k].p)) {
    const r = rasgos(p[0] + " " + (p[2] || "")); info.set(id, r);
    for (const w of r.pal) (idx.get(w) || idx.set(w, []).get(w)).push(id);
  }
  S.idx[k] = { idx, info };
}
function candidatos(k, nombre, max = 6) {
  const I = S.idx[k]; if (!I) return [];
  const r = rasgos(nombre); if (!r.pal.length) return [];
  const votos = new Map();
  for (const w of r.pal) for (const id of I.idx.get(w) || []) votos.set(id, (votos.get(id) || 0) + 1);
  const res = [];
  for (const [id, v] of votos) {
    const o = I.info.get(id);
    const pal = v / new Set([...r.pal, ...o.pal]).size;
    const comunes = r.nums.filter(n => o.nums.includes(n)).length;
    const num = r.nums.length || o.nums.length ? comunes / Math.max(r.nums.length, o.nums.length) : 0.5;
    const primera = o.pal.includes(r.pal[0]) ? 1 : 0;   // la primera palabra suele ser el producto o la marca
    res.push([id, Math.round((pal * 0.5 + num * 0.35 + primera * 0.15) * 100) / 100]);
  }
  return res.sort((a, b) => b[1] - a[1]).slice(0, max);
}
const UMBRAL = 0.7;    // por debajo no se sugiere nada (exige que coincidan los números: mg, ml, unidades)
function sugerir() {
  for (const p of S.cat) {
    const s = {};
    for (const t of TIENDAS) { const c = candidatos(t.k, p.n, 1)[0]; if (c && c[1] >= UMBRAL) s[t.k] = c; }
    S.sug[p.c] = s;
  }
}
// Pareja vigente: la confirmada manda; si no, la sugerida.
function pareja(cod, k) {
  const conf = S.pares[cod]?.[k];
  if (conf !== undefined) return { id: conf || null, ok: true };
  const s = S.sug[cod]?.[k];
  return s ? { id: s[0], ok: false, score: s[1] } : { id: null, ok: false };
}

/* ---------- comparación ---------- */
const efectivo = p => p ? Math.min(p[4], p[5] || Infinity) : null;   // oferta para todos, si existe (sin tarjeta)
function fila(prod) {
  const nuestro = S.lista?.p[prod.c] ?? null, u = unidadesDe(prod.n), cos = S.costo[prod.c];
  const r = { prod, nuestro, u, costo: cos ? cos[2] : null, t: {}, min: null, dif: null, pendiente: false };
  for (const t of TIENDAS) {
    const pa = pareja(prod.c, t.k), p = pa.id ? S.comp[t.k]?.p[pa.id] : null;
    if (pa.id && !pa.ok) r.pendiente = true;
    if (!p) { r.t[t.k] = { pa }; continue; }
    const pr = efectivo(p), uc = p[3] || unidadesDe(p[0] + " " + (p[2] || ""));
    // Si las presentaciones tienen distinto número de unidades, se compara por unidad
    const porU = u && uc && u !== uc, eq = porU ? pr / uc * u : pr;
    r.t[t.k] = { pa, p, pr, uc, porU, eq };
    if (r.min == null || eq < r.min) r.min = eq;
  }
  if (nuestro != null && r.min != null) r.dif = nuestro / r.min - 1;
  return r;
}

/* ---------- carga ---------- */
async function cargar() {
  msg("Cargando precios de la competencia…");
  const v = "?d=" + new Date().toISOString().slice(0, 10);
  const [cat, ...comps] = await Promise.all([
    fetch("catalogo.json" + v).then(r => r.json()),
    ...TIENDAS.map(t => fetch(`data/competencia/${t.archivo}.json` + v).then(r => r.ok ? r.json() : null).catch(() => null))
  ]);
  S.cat = cat;
  TIENDAS.forEach((t, i) => { if (comps[i]) { S.comp[t.k] = comps[i]; indexar(t.k); } });
  msg("Leyendo parejas y precios guardados…");
  const [pares, cfg, maestro] = await Promise.all([
    getDoc(doc(db, "comp_config", "pares")), getDoc(doc(db, "comp_config", "lista")), getDoc(doc(db, "proy_config", "maestro")).catch(() => null)]);
  S.pares = pares.exists() ? pares.data().m || {} : {};
  if (cfg.exists() && cfg.data().asset) S.lista = await leerBlob(cfg.data().asset);
  if (maestro?.exists() && maestro.data().asset) S.costo = (await leerBlobProy(maestro.data().asset)).prod || {};
  msg("Buscando coincidencias…");
  await new Promise(r => setTimeout(r));
  sugerir();
  const labs = [...new Set(S.cat.map(p => p.ln).filter(Boolean))].sort();
  $("lab").innerHTML = `<option value="">Todos los laboratorios</option>` + labs.map(l => `<option>${esc(l)}</option>`).join("");
  msg("");
  pintarFuente(); pintar();
}
function pintarFuente() {
  const f = TIENDAS.map(t => S.comp[t.k]
    ? `<span><b>${t.nombre}</b> ${Object.keys(S.comp[t.k].p).length.toLocaleString("es-PE")} productos · ${fechaL(S.comp[t.k].fecha)}</span>`
    : `<span class="falta"><b>${t.nombre}</b> sin datos aún (se descarga cada noche)</span>`);
  f.unshift(S.lista
    ? `<span><b>Nuestra lista</b> ${Object.keys(S.lista.p).length.toLocaleString("es-PE")} precios · ${fechaL(S.lista.fecha)}</span>`
    : `<span class="falta"><b>Nuestra lista</b> sin subir</span>`);
  $("fuente").innerHTML = f.join("");
}

/* ---------- tabla ---------- */
function filtrados() {
  const ws = sinTildes(S.q).split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of S.cat) {
    if (S.lab && p.ln !== S.lab) continue;
    if (ws.length) { const t = sinTildes(p.c + " " + p.n + " " + p.ln); if (!ws.every(w => t.includes(w))) continue; }
    const r = fila(p);
    const algo = TIENDAS.some(t => r.t[t.k].p);
    if (S.filtro === "comparados" && !(algo && r.nuestro != null)) continue;
    if (S.filtro === "caro" && !(r.dif != null && r.dif > 0.005)) continue;
    if (S.filtro === "barato" && !(r.dif != null && r.dif < -0.005)) continue;
    if (S.filtro === "confirmar" && !r.pendiente) continue;
    if (S.filtro === "sin" && algo) continue;
    out.push(r);
  }
  if (S.filtro === "caro") out.sort((a, b) => b.dif - a.dif);
  else if (S.filtro === "barato") out.sort((a, b) => a.dif - b.dif);
  else out.sort((a, b) => a.prod.n.localeCompare(b.prod.n));
  return out;
}
function celdaTienda(r, k) {
  const x = r.t[k];
  if (!x.p) return `<td class="t vacio">${x.pa.ok && !x.pa.id ? "no lo vende" : "–"}</td>`;
  const p = x.p, of = p[5] && p[5] < p[4];
  const cls = r.min != null && Math.abs(x.eq - r.min) < 0.005 ? " min" : "";
  return `<td class="t${cls}"><div class="pr">${of ? `<s>${sol(p[4])}</s> ` : ""}${sol(x.pr)}${x.pa.ok ? "" : ` <span class="sug" title="Sugerido (${Math.round(x.pa.score * 100)} %). Ábrelo para confirmar.">?</span>`}</div>` +
    `<div class="nm">${esc(p[0])}</div>${x.porU ? `<div class="nm u">${x.uc} un · equiv. ${sol(x.eq)} por ${r.u}</div>` : ""}${p[6] ? `<div class="nm">con tarjeta ${sol(p[6])}</div>` : ""}</td>`;
}
function pintar() {
  const lista = filtrados();
  const conDif = lista.filter(r => r.dif != null);
  const caro = conDif.filter(r => r.dif > 0.005).length, barato = conDif.filter(r => r.dif < -0.005).length;
  const med = conDif.length ? conDif.map(r => r.dif).sort((a, b) => a - b)[Math.floor(conDif.length / 2)] : null;
  $("k1").textContent = conDif.length.toLocaleString("es-PE");
  $("k2").textContent = caro.toLocaleString("es-PE");
  $("k3").textContent = barato.toLocaleString("es-PE");
  $("k4").textContent = pct(med);
  $("cuenta").textContent = `${lista.length.toLocaleString("es-PE")} productos`;
  const vis = lista.slice(0, S.mostrar);
  $("tabla").innerHTML = `<thead><tr><th class="l">Producto</th><th>Nuestro precio</th><th>Costo</th><th>Margen</th>` +
    TIENDAS.map(t => `<th class="t">${t.nombre}</th>`).join("") + `<th>Dif. vs más barato</th></tr></thead><tbody>` +
    (vis.map(r => `<tr data-cod="${esc(r.prod.c)}"><td class="l"><b>${esc(r.prod.n)}</b><div class="nm">${esc(r.prod.c)} · ${esc(r.prod.ln || r.prod.l || "")}</div></td>` +
      `<td class="n">${sol(r.nuestro)}</td><td class="n muted">${sol(r.costo)}</td>` +
      `<td class="n muted">${r.nuestro && r.costo ? pct(1 - r.costo / r.nuestro) : "–"}</td>` +
      TIENDAS.map(t => celdaTienda(r, t.k)).join("") +
      `<td class="n dif ${r.dif > 0.005 ? "caro" : r.dif < -0.005 ? "barato" : ""}">${pct(r.dif)}</td></tr>`).join("") ||
      `<tr><td colspan="7" class="vacio-tabla">${S.lista || S.filtro !== "comparados" ? "Nada con estos filtros." : "Sube la lista de precios de Lolfar para ver la comparación, o cambia el filtro a «Todos»."}</td></tr>`) +
    `</tbody>`;
  $("mas").hidden = lista.length <= S.mostrar;
}

/* ---------- ficha: historial y corrección de parejas ---------- */
let grafico;
async function abrir(cod) {
  S.ficha = cod; const prod = S.cat.find(p => p.c === cod); if (!prod) return;
  $("vLista").hidden = true; $("vFicha").hidden = false; scrollTo({ top: 0 });
  $("fTitulo").textContent = prod.n; $("fSub").textContent = `${prod.c} · ${prod.ln || ""}`;
  pintarFicha();
  // historiales (se cargan una sola vez)
  await Promise.all(TIENDAS.filter(t => !S.hist[t.k]).map(async t => {
    S.hist[t.k] = await fetch(`data/competencia/hist-${t.archivo}.json?d=${S.comp[t.k]?.fecha}`).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  }));
  if (!S.histPropio) { const h = await getDoc(doc(db, "comp_config", "historial")); S.histPropio = h.exists() && h.data().asset ? await leerBlob(h.data().asset) : {}; }
  if (S.ficha === cod) pintarGrafico();
}
function pintarFicha() {
  const prod = S.cat.find(p => p.c === S.ficha), r = fila(prod);
  $("fPrecios").innerHTML = `<div class="kp"><span>Nuestro precio</span><b>${sol(r.nuestro)}</b></div><div class="kp"><span>Costo (kardex)</span><b>${sol(r.costo)}</b></div>` +
    TIENDAS.map(t => `<div class="kp"><span>${t.nombre}</span><b>${r.t[t.k].p ? sol(r.t[t.k].pr) : "–"}</b></div>`).join("") +
    `<div class="kp"><span>Dif. vs más barato</span><b class="${r.dif > 0.005 ? "caro" : r.dif < -0.005 ? "barato" : ""}">${pct(r.dif)}</b></div>`;
  $("fPares").innerHTML = TIENDAS.map(t => {
    const pa = pareja(S.ficha, t.k), cands = candidatos(t.k, prod.n, 6);
    if (pa.id && !cands.some(c => c[0] === pa.id)) cands.unshift([pa.id, null]);
    const opciones = cands.map(([id, sc]) => {
      const p = S.comp[t.k]?.p[id]; if (!p) return "";
      return `<label class="op"><input type="radio" name="p-${t.k}" value="${esc(id)}" ${pa.id === id ? "checked" : ""}>` +
        `<span><b>${esc(p[0])}</b><small>${esc(p[1] || "")} · ${sol(efectivo(p))}${sc != null ? ` · ${Math.round(sc * 100)} % parecido` : ""} · <a href="${esc(p[7])}" target="_blank" rel="noopener">ver</a></small></span></label>`;
    }).join("");
    return `<section class="card par"><div class="ch"><h2>${t.nombre}</h2><span class="pill ${pa.ok ? "ok" : "sug"}">${pa.ok ? "confirmado" : pa.id ? "sugerido" : "sin pareja"}</span></div>` +
      `<div class="ops">${opciones || `<p class="muted">No se encontró nada parecido. Búscalo abajo.</p>`}` +
      `<label class="op"><input type="radio" name="p-${t.k}" value="" ${pa.ok && !pa.id ? "checked" : ""}><span><b>No lo vende</b></span></label></div>` +
      `<div class="buscar"><input type="search" data-buscar="${t.k}" placeholder="Buscar otro en ${t.nombre}…"><div class="res" id="res-${t.k}"></div></div>` +
      `<button class="btn primary" data-guardar="${t.k}">Guardar ${t.nombre}</button></section>`;
  }).join("");
}
function pintarGrafico() {
  const fechas = new Set(), series = [];
  const agregar = (nombre, color, h) => { if (!h?.length) return; h.forEach(x => fechas.add(x[0])); series.push({ nombre, color, h }); };
  agregar("Nuestro precio", css("--accent"), (S.histPropio[S.ficha] || []).map(([f, p]) => [f, p]));
  TIENDAS.forEach((t, i) => { const id = pareja(S.ficha, t.k).id; if (id) agregar(t.nombre, css(i ? "--s3" : "--s2"), (S.hist[t.k][id] || []).map(([f, p, o]) => [f, o && o < p ? o : p])); });
  const ejes = [...fechas].sort(); const hoy = new Date().toISOString().slice(0, 10); if (ejes.length && ejes[ejes.length - 1] < hoy) ejes.push(hoy);
  // el precio se mantiene hasta que cambia (solo se guardan los cambios)
  const datos = s => { let i = 0, v = null; return ejes.map(f => { while (i < s.h.length && s.h[i][0] <= f) v = s.h[i++][1]; return v; }); };
  grafico?.destroy();
  $("fVacio").hidden = series.length > 0;
  if (!series.length) return;
  grafico = new Chart($("fGraf"), {
    type: "line",
    data: { labels: ejes.map(fechaL), datasets: series.map(s => ({ label: s.nombre, data: datos(s), borderColor: s.color, backgroundColor: s.color, stepped: true, pointRadius: ejes.length > 40 ? 0 : 3, borderWidth: 2, spanGaps: false })) },
    options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      scales: { y: { ticks: { callback: v => "S/ " + v } } },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${sol(c.raw)}` } } } }
  });
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

async function guardarPar(k) {
  const marcado = document.querySelector(`input[name="p-${k}"]:checked`);
  if (!marcado) return toast("Elige una opción o «No lo vende».");
  const id = marcado.value;
  try {
    await setDoc(doc(db, "comp_config", "pares"), { m: { [S.ficha]: { [k]: id } } }, { merge: true });
    (S.pares[S.ficha] ??= {})[k] = id;
    toast("Pareja guardada"); pintarFicha(); if (S.hist[k]) pintarGrafico();
  } catch (e) { toast("No se pudo guardar: " + (e.code || e.message)); }
}
function buscarEn(k, q) {
  const ws = sinTildes(q).split(/\s+/).filter(Boolean), box = $("res-" + k);
  if (ws.length === 0 || !S.comp[k]) { box.innerHTML = ""; return; }
  const res = [];
  for (const [id, p] of Object.entries(S.comp[k].p)) {
    const t = sinTildes(p[0] + " " + (p[1] || "")); if (ws.every(w => t.includes(w))) res.push([id, p]);
    if (res.length >= 15) break;
  }
  box.innerHTML = res.map(([id, p]) => `<label class="op"><input type="radio" name="p-${k}" value="${esc(id)}"><span><b>${esc(p[0])}</b><small>${esc(p[1] || "")} · ${sol(efectivo(p))}</small></span></label>`).join("") || `<p class="muted">Sin resultados.</p>`;
}
// Confirma de una vez todas las sugeridas que se ven en la tabla (las que superan 80 %).
async function confirmarVisibles() {
  const lista = filtrados().slice(0, S.mostrar), m = {};
  for (const r of lista) for (const t of TIENDAS) { const pa = r.t[t.k].pa; if (pa.id && !pa.ok && pa.score >= 0.8) (m[r.prod.c] ??= {})[t.k] = pa.id; }
  const n = Object.values(m).reduce((a, o) => a + Object.keys(o).length, 0);
  if (!n) return toast("No hay sugerencias de 80 % o más en la tabla.");
  if (!confirm(`Se confirmarán ${n} parejas sugeridas con 80 % o más de parecido. ¿Continuar?`)) return;
  await setDoc(doc(db, "comp_config", "pares"), { m }, { merge: true });
  for (const [c, o] of Object.entries(m)) Object.assign(S.pares[c] ??= {}, o);
  toast(`${n} parejas confirmadas`); pintar();
}

/* ---------- nuestra lista de precios (Lolfar) ---------- */
// Busca en la cabecera una columna de código y una de precio de venta.
// TODO: ajustar los nombres de columna con el archivo real de Lolfar.
const COL_COD = ["codpro", "codigo", "código", "cod", "cod_producto"];
const COL_PRE = ["precio", "preven", "pvp", "precio_venta", "pventa", "prevta", "prepub"];
async function subirLista(f) {
  try {
    msg(`Leyendo ${f.name}…`);
    const texto = new TextDecoder("windows-1252").decode(await f.arrayBuffer());
    const lineas = texto.split(/\r?\n/).filter(l => l.trim());
    const sep = ["\t", ";", ","].sort((a, b) => lineas[0].split(b).length - lineas[0].split(a).length)[0];
    const cab = lineas[0].split(sep).map(x => x.trim().toLowerCase().replace(/"/g, ""));
    const ic = cab.findIndex(h => COL_COD.includes(h)), ip = cab.findIndex(h => COL_PRE.includes(h));
    if (ic < 0 || ip < 0) throw new Error(`No encontré las columnas de código y precio. Columnas del archivo: ${cab.join(", ")}`);
    const p = {};
    for (const l of lineas.slice(1)) {
      const x = l.split(sep), cod = (x[ic] || "").replace(/"/g, "").trim();
      const t = (x[ip] || "").replace(/"/g, "").trim(), v = +(/,\d{1,2}$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, ""));
      if (cod && v > 0) p[cod] = Math.round(v * 100) / 100;
    }
    const n = Object.keys(p).length; if (!n) throw new Error("El archivo no trajo precios.");
    const fecha = new Date().toISOString().slice(0, 10);
    msg("Guardando lista e historial…");
    // historial propio: solo cambios
    const hDoc = await getDoc(doc(db, "comp_config", "historial"));
    const hist = hDoc.exists() && hDoc.data().asset ? await leerBlob(hDoc.data().asset) : {};
    let cambios = 0;
    for (const [c, v] of Object.entries(p)) { const h = hist[c] ??= []; if (!h.length || h[h.length - 1][1] !== v) { h.push([fecha, v]); cambios++; } }
    const prevL = (await getDoc(doc(db, "comp_config", "lista"))).data()?.asset, prevH = hDoc.data()?.asset;
    const idL = await subirBlob({ fecha, p }), idH = await subirBlob(hist);
    await setDoc(doc(db, "comp_config", "lista"), { asset: idL, fecha, n });
    await setDoc(doc(db, "comp_config", "historial"), { asset: idH, fecha });
    if (prevL) borrarBlob(prevL).catch(() => {}); if (prevH) borrarBlob(prevH).catch(() => {});
    S.lista = { fecha, p }; S.histPropio = hist;
    msg(""); toast(`${n.toLocaleString("es-PE")} precios cargados · ${cambios.toLocaleString("es-PE")} cambiaron`);
    pintarFuente(); pintar();
  } catch (e) { console.error(e); msg("No se pudo leer la lista. " + (e.message || e.code), true); }
}

/* ---------- Excel ---------- */
function exportar() {
  const lista = filtrados();
  const filas = lista.map(r => ({
    Codigo: r.prod.c, Producto: r.prod.n, Laboratorio: r.prod.ln, "Nuestro precio": r.nuestro, Costo: r.costo,
    ...Object.fromEntries(TIENDAS.flatMap(t => { const x = r.t[t.k]; return [[t.nombre + " producto", x.p?.[0] ?? ""], [t.nombre + " precio", x.pr ?? ""], [t.nombre + " confirmado", x.p ? (x.pa.ok ? "sí" : "sugerido") : ""]]; })),
    "Dif. vs más barato %": r.dif == null ? "" : Math.round(r.dif * 1000) / 10
  }));
  const ws = XLSX.utils.json_to_sheet(filas), wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Comparativo");
  XLSX.writeFile(wb, `comparativo_precios_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/* ---------- eventos ---------- */
document.querySelectorAll("[data-f]").forEach(b => b.onclick = () => {
  S.filtro = b.dataset.f; S.mostrar = PAGINA;
  document.querySelectorAll("[data-f]").forEach(x => x.setAttribute("aria-pressed", x === b)); pintar();
});
let tq; $("q").addEventListener("input", e => { clearTimeout(tq); tq = setTimeout(() => { S.q = e.target.value; S.mostrar = PAGINA; pintar(); }, 200); });
$("lab").addEventListener("change", e => { S.lab = e.target.value; S.mostrar = PAGINA; pintar(); });
$("mas").onclick = () => { S.mostrar += PAGINA; pintar(); };
$("tabla").addEventListener("click", e => { const tr = e.target.closest("tr[data-cod]"); if (tr) abrir(tr.dataset.cod); });
$("fVolver").onclick = () => { $("vFicha").hidden = true; $("vLista").hidden = false; S.ficha = null; pintar(); };
$("fPares").addEventListener("click", e => { const b = e.target.closest("[data-guardar]"); if (b) guardarPar(b.dataset.guardar); });
let tb; $("fPares").addEventListener("input", e => { const i = e.target.closest("[data-buscar]"); if (i) { clearTimeout(tb); tb = setTimeout(() => buscarEn(i.dataset.buscar, i.value), 200); } });
$("fLista").addEventListener("change", e => { if (e.target.files[0]) subirLista(e.target.files[0]); e.target.value = ""; });
$("confirmar").onclick = confirmarVisibles;
$("excel").onclick = exportar;

/* ---------- sesión: solo administrador ---------- */
let arrancado = false;
onAuthStateChanged(auth, async u => {
  const bloquear = t => { $("vLista").hidden = true; msg(t, true); };
  if (!u) return bloquear("Ingresa como administrador en la página de Abastecimiento para ver el comparativo.");
  try {
    const p = (await getDoc(doc(db, "usuarios", u.uid))).data() || {};
    if (String(p.rol || "").trim().toLowerCase() !== "admin") return bloquear("Esta sección es solo para el administrador.");
  } catch { return bloquear("No se pudo comprobar tu usuario. Recarga la página."); }
  if (arrancado) return; arrancado = true;
  $("vLista").hidden = false;
  cargar().catch(e => { console.error(e); msg("No se pudo cargar el comparativo. " + (e.code === "permission-denied" ? "Revisa que las reglas de firestore.rules estén publicadas." : e.message || ""), true); });
});
