// Proyección de compras: guarda sus datos en Firebase (colecciones proy_*, solo administrador).
// Ofrece a la página del kardex la misma forma de guardar que tenía como artefacto (db + assets).
// Dentro del panel usa la conexión y la sesión de la página principal (window.parent.FB);
// abierta sola, inicia su propia conexión.
const PADRE = (() => { try { return window.parent !== window && window.parent.FB ? window.parent : null; } catch { return null; } })();
let F;
if (PADRE) F = PADRE.FB;
else {
  const V = "https://www.gstatic.com/firebasejs/13.0.0/";
  const [{ initializeApp }, A, FS, { firebaseConfig }] = await Promise.all([
    import(V + "firebase-app.js"), import(V + "firebase-auth.js"), import(V + "firebase-firestore.js"), import("./config.js?v=202610161000")]);
  const app = initializeApp(firebaseConfig);
  F = { auth: A.getAuth(app), db: FS.getFirestore(app), onAuthStateChanged: A.onAuthStateChanged,
    doc: FS.doc, getDoc: FS.getDoc, setDoc: FS.setDoc, deleteDoc: FS.deleteDoc, collection: FS.collection, getDocs: FS.getDocs, onSnapshot: FS.onSnapshot };
}
const { auth, db, onAuthStateChanged, doc, getDoc, deleteDoc, collection, getDocs, onSnapshot } = F;
// Firebase solo acepta objetos creados en su propia ventana: los datos se pasan a la ventana principal.
const setDoc = (ref, v, o) => F.setDoc(ref, PADRE ? PADRE.JSON.parse(JSON.stringify(v)) : v, ...(o ? [PADRE ? PADRE.JSON.parse(JSON.stringify(o)) : o] : []));
const col = n => "proy_" + n;
const ruta = p => { const [c, ...r] = p.split("/"); return [col(c), ...r]; };

const dbShim = {
  doc: p => {
    const r = doc(db, ...ruta(p));
    return {
      get: async () => { const s = await getDoc(r); return { exists: s.exists(), data: () => s.data() }; },
      set: v => setDoc(r, v),
      delete: () => deleteDoc(r)
    };
  },
  collection: n => ({
    onSnapshot: (ok, mal) => onSnapshot(collection(db, col(n)),
      s => ok({ docs: s.docs.map(d => ({ id: d.id, exists: true, data: () => d.data() })) }), mal)
  })
};

// El archivo de pronósticos se guarda comprimido y partido en trozos (un documento de Firestore admite ~1 MB).
const TROZO = 800000;
const aB64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const deB64 = t => { const s = atob(t), b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
const partes = id => collection(db, "proy_blobs", id, "partes");
const assetsShim = {
  upload: async blob => {
    const gz = new Uint8Array(await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const t = aB64(gz), id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6), n = Math.ceil(t.length / TROZO);
    for (let i = 0; i < n; i++) await setDoc(doc(partes(id), String(i)), { d: t.slice(i * TROZO, (i + 1) * TROZO) });
    await setDoc(doc(db, "proy_blobs", id), { n, bytes: gz.length, fecha: new Date().toISOString() });
    return { id };
  },
  fetch: async id => {
    const meta = await getDoc(doc(db, "proy_blobs", id));
    if (!meta.exists()) return { ok: false };
    const s = await getDocs(partes(id));
    const t = s.docs.sort((a, b) => a.id - b.id).map(d => d.data().d).join("");
    const texto = await new Response(new Blob([deB64(t)]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return { ok: true, json: async () => JSON.parse(texto) };
  },
  delete: async id => {
    const s = await getDocs(partes(id));
    await Promise.all(s.docs.map(d => deleteDoc(d.ref)));
    await deleteDoc(doc(db, "proy_blobs", id));
  }
};

function bloquear(texto) {
  let av = document.getElementById("avisoSesion");
  if (!av) { av = document.createElement("div"); av.id = "avisoSesion"; av.className = "empty"; av.style.margin = "24px auto"; document.querySelector("main").prepend(av); }
  av.innerHTML = `<h2>Proyección de compras</h2><p>${texto}</p>`;
  document.querySelectorAll("main > section").forEach(s => s.dataset.oculto = "1");
  document.querySelector("main").classList.add("sin-sesion");
}
function desbloquear() { document.getElementById("avisoSesion")?.remove(); document.querySelector("main").classList.remove("sin-sesion"); }
let arrancado = false;
onAuthStateChanged(auth, async u => {
  if (!u) return bloquear("Ingresa como administrador en la página de Abastecimiento para ver la proyección.");
  try {
    const p = (await getDoc(doc(db, "usuarios", u.uid))).data() || {};
    // el administrador, o quien tenga asignado este módulo
    const modulo = { mapa: "mapa", est: "estadistica", suc: "sucursales", kar: "kardex" }[new URLSearchParams(location.search).get("solo")] || "proyeccion";
    if (String(p.rol || "").trim().toLowerCase() !== "admin" && !(p.vistas || []).includes(modulo)) return bloquear("No tienes acceso a este módulo. Pide a Abastecimiento que te lo habilite.");
  } catch { return bloquear("No se pudo comprobar tu usuario. Recarga la página."); }
  desbloquear();
  if (arrancado) return; arrancado = true;
  window.claude = { use: async n => n === "db" ? dbShim : n === "assets" ? assetsShim : null };
  window.iniciarKardex();
  escucharBloqueos();
});

/* =====================================================================
   KARDEX DE LOLFAR (.TXT) → resumen por mes en Firebase → pronósticos
   Cantidades en cajas: enteras + fracciones ÷ unidades por caja (stkfra).
   ===================================================================== */
const COL0 = { despro: 0, stkE: 1, stkM: 2, feckar: 8, destka: 10, coscom: 18, fra: 20, numkar: 24, codpro: 25, desalm: 27, iE: 30, iM: 31, sE: 32, sM: 33, n: 34, cus: 15 };
let COL = COL0;
// Columnas según la cabecera de cada archivo (los kardex de otros años pueden traerlas en otro orden o con otras de más).
function columnasDe(cab) {
  const h = cab.split("\t").map(t => t.trim().toLowerCase()), i = n => h.indexOf(n);
  const c = { despro: i("despro"), stkE: i("stkalm"), stkM: i("stkalm_m"), feckar: i("feckar"), destka: i("destka"), coscom: i("coscom"), fra: i("stkfra"),
    numkar: i("numkar"), codpro: i("codpro"), desalm: i("desalm"), iE: i("icant_e"), iM: i("icant_m"), sE: i("scant_e"), sM: i("scant_m"), n: h.length, cus: i("cusnam") };
  return ["despro", "feckar", "destka", "numkar", "codpro", "desalm"].every(k => c[k] >= 0) ? c : COL0;
}
const num = v => { const t = String(v ?? "").trim(); return +(/,\d{1,3}$/.test(t) && !t.includes(".") ? t.replace(",", ".") : t.replace(/,/g, "")) || 0; };
const VENTA = "DESCARGO POR VENTA", ANULA = "CARGO POR ANULACIONES", DROG = "DROGUERIA FS";
const ignorar = alm => /CANJE/i.test(alm) || !alm;

// Algunas filas traen el nombre del cliente partido por tabulaciones: se rearma la fila a 34 columnas.
function campos(linea) {
  let x = linea.split("\t"); const n = COL.n, cus = COL.cus;
  if (x.length > n && cus >= 0) x = [...x.slice(0, cus), x.slice(cus, cus + x.length - n + 1).join(" "), ...x.slice(cus + x.length - n + 1)];
  return x.length === n ? x : null;
}
// Fecha del kardex: 15/8/2024, 15-08-2024 o 2024-08-15 (con o sin hora).
const fechaISO = f => {
  let m = /^\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})[ T]*(\S*)/.exec(f || "");
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")} ${m[4]}`;
  m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T]*(\S*)/.exec(f || "");
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")} ${m[4]}` : "";
};

async function* lineas(file, avance) {
  const lector = file.stream().pipeThrough(new TextDecoderStream("windows-1252")).getReader();
  let resto = "", leidos = 0;
  for (;;) {
    const { value, done } = await lector.read();
    if (done) break;
    leidos += value.length; avance(leidos);
    const partes = (resto + value).split(/\r?\n/); resto = partes.pop();
    for (const l of partes) yield l;
  }
  if (resto) yield resto;
}

// Mes guardado: { d: {cod: {alm: {destka: [ingCajas, salCajas, ingSoles, salSoles]}}}, k: "numkar ordenados en diferencias",
//                 v: {cod: {alm: {día: venta neta en cajas}}}, kd: true (todas las ventas del mes están por día) o "numkar con detalle diario" }
let paso = "";
// La lista de meses guardados vive en proy_config/meses (un solo documento: { m: { "2026-10": {asset, …} } }).
const mesesMeta = async () => { paso = "leer la lista de meses (proy_config/meses)"; const s = await getDoc(doc(db, "proy_config", "meses")); return new Map(Object.entries(s.exists() ? s.data().m || {} : {})); };
const desDif = t => { let n = 0; return new Set((t ? t.split(",") : []).map(x => (n += +x))); };
const aDif = set => { const ks = [...set].sort((a, b) => a - b); let prev = 0; return ks.map(x => { const d = x - prev; prev = x; return d; }).join(","); };
async function leerMes(meta) {
  if (!meta?.asset) return { d: {}, k: new Set(), v: {}, kd: null };
  paso = "leer un mes guardado (proy_blobs)";
  const r = await assetsShim.fetch(meta.asset); if (!r.ok) throw new Error("No se pudo leer un mes guardado.");
  const o = await r.json();
  // kd: null = el detalle diario ya está completo; Set = movimientos que ya tienen detalle diario (meses guardados antes de existir)
  return { d: o.d, k: desDif(o.k), v: o.v || {}, kd: o.kd === true ? null : desDif(typeof o.kd === "string" ? o.kd : "") };
}
async function guardarMes(mes, m, metaPrev, filas) {
  paso = `guardar el mes ${mes} (proy_blobs / proy_config)`;
  const completo = !m.kd || m.kd.size >= m.k.size;
  const { id } = await assetsShim.upload(new Blob([JSON.stringify({ d: m.d, k: aDif(m.k), v: m.v, kd: completo ? true : aDif(m.kd) })]));
  await setDoc(doc(db, "proy_config", "meses"), { m: { [mes]: { asset: id, movimientos: m.k.size, nuevos: filas, diario: completo, actualizado: new Date().toISOString() } } }, { merge: true });
  if (metaPrev?.asset) assetsShim.delete(metaPrev.asset).catch(() => {});
}
async function leerMaestro() {
  paso = "leer productos y stock (proy_config/maestro)";
  const c = await getDoc(doc(db, "proy_config", "maestro"));
  if (!c.exists()) return { prod: {}, stock: {}, corte: "" };
  const r = await assetsShim.fetch(c.data().asset); return r.ok ? await r.json() : { prod: {}, stock: {}, corte: "" };
}
async function guardarMaestro(m) {
  paso = "guardar productos y stock (proy_config/maestro)";
  const prev = await getDoc(doc(db, "proy_config", "maestro"));
  const { id } = await assetsShim.upload(new Blob([JSON.stringify(m)]));
  await setDoc(doc(db, "proy_config", "maestro"), { asset: id, corte: m.corte, actualizado: new Date().toISOString() });
  if (prev.exists() && prev.data().asset) assetsShim.delete(prev.data().asset).catch(() => {});
}

window.subirKardex = async function (files) {
  const total = files.reduce((a, f) => a + f.size, 0); let base = 0, leidosArch = 0;
  const pct = n => msg(`Leyendo kardex… ${Math.min(99, Math.round((base + n) / total * 100))} %`);
  try {
    msg("Preparando…");
    const metas = await mesesMeta(), maestro = await leerMaestro(), meses = new Map(), nuevosMes = new Map();
    let filas = 0, nuevas = 0, repetidas = 0, ignoradas = 0, stockCambio = false, diarias = 0;
    const cambioDia = new Set();
    maestro.uv ??= {};
    const malas = [];
    for (const f of files) {
      COL = COL0; const ign0 = ignoradas;
      for await (const l of lineas(f, n => { leidosArch = n; pct(n); })) {
        if (!l) continue;
        if (/(^|\t)\s*codpro\s*(\t|$)/i.test(l) && /(^|\t)\s*desalm\s*(\t|$)/i.test(l)) { COL = columnasDe(l); continue; }
        const x = campos(l); if (!x) { ignoradas++; continue; }
        filas++;
        const alm = x[COL.desalm].trim(); if (ignorar(alm)) continue;
        const fecha = fechaISO(x[COL.feckar]), mes = fecha.slice(0, 7), nk = num(x[COL.numkar]), cod = x[COL.codpro].trim();
        if (!mes || !nk || !cod) { ignoradas++; continue; }
        if (!meses.has(mes)) { msg(`Abriendo ${mes}…`); meses.set(mes, await leerMes(metas.get(mes))); nuevosMes.set(mes, 0); }
        const M = meses.get(mes), fra = num(x[COL.fra]) || 1, cos = num(x[COL.coscom]);
        // datos del producto y stock actual del almacén (el más reciente gana), aunque el movimiento ya estuviera cargado:
        // el stock de cada fila (stkalm) es el del momento en que se descargó el archivo
        const pr = maestro.prod[cod];
        if (!pr || fecha >= pr[3]) maestro.prod[cod] = [x[COL.despro].trim(), fra, cos, fecha];
        const st = (maestro.stock[cod] ??= {}), previo = st[alm], stk = Math.round((num(x[COL.stkE]) + num(x[COL.stkM]) / fra) * 1000) / 1000;
        if (!previo || fecha >= previo[1]) { if (!previo || previo[0] !== stk || previo[1] !== fecha) stockCambio = true; st[alm] = [stk, fecha]; }
        if (fecha > maestro.corte) { maestro.corte = fecha; stockCambio = true; }
        const tipo = x[COL.destka].trim();
        const ing = num(x[COL.iE]) + num(x[COL.iM]) / fra, sal = num(x[COL.sE]) + num(x[COL.sM]) / fra;
        // última venta del producto (para los que dejaron de moverse)
        if (tipo === VENTA && (!maestro.uv[cod] || fecha > maestro.uv[cod])) { maestro.uv[cod] = fecha; stockCambio = true; }
        // ventas por día (ventas − anulaciones) de cada almacén; los meses guardados antes se completan al volver a subir el kardex
        const nuevo = !M.k.has(nk);
        if ((tipo === VENTA || tipo === ANULA) && alm !== DROG && (M.kd ? !M.kd.has(nk) : nuevo)) {
          const dia = fecha.slice(8, 10), dv = (M.v[cod] ??= {})[alm] ??= {};
          dv[dia] = Math.round(((dv[dia] || 0) + (tipo === VENTA ? sal : -ing)) * 1000) / 1000;
          if (M.kd) M.kd.add(nk); cambioDia.add(mes); diarias++;
        } else if (M.kd && !M.kd.has(nk)) M.kd.add(nk);
        if (!nuevo) { repetidas++; continue; }
        M.k.add(nk); nuevas++; nuevosMes.set(mes, nuevosMes.get(mes) + 1);
        const a = ((M.d[cod] ??= {})[alm] ??= {})[tipo] ??= [0, 0, 0, 0];
        a[0] += ing; a[1] += sal; a[2] += ing * cos; a[3] += sal * cos;
      }
      base += f.size;
      if (ignoradas > ign0) malas.push(`${f.name}: ${(ignoradas - ign0).toLocaleString("es-PE")} filas`);
    }
    for (const [mes, M] of meses) {
      if (!nuevosMes.get(mes) && !cambioDia.has(mes)) continue;
      msg(`Guardando ${mes}…`);
      for (const c in M.d) for (const al in M.d[c]) for (const t in M.d[c][al]) M.d[c][al][t] = M.d[c][al][t].map(v => Math.round(v * 1000) / 1000);
      await guardarMes(mes, M, metas.get(mes), nuevosMes.get(mes));
    }
    if (nuevas || stockCambio || diarias) { msg("Guardando productos y stock…"); await guardarMaestro(maestro); }
    msg("Calculando pronósticos…");
    const aviso = await recalcular();
    // si los pronósticos siguen siendo los del archivo de Colab (faltan meses de kardex), se les pone el stock de este kardex
    const alDia = window.aplicarStock ? window.aplicarStock(maestro) : false;
    const corte = maestro.corte ? maestro.corte.slice(0, 10).split("-").reverse().join("/") : "";
    toast(nuevas
      ? `${nuevas.toLocaleString("es-PE")} movimientos nuevos · ${repetidas.toLocaleString("es-PE")} repetidos descartados`
      : diarias ? `Kardex ya cargado: se completaron las ventas por día (${diarias.toLocaleString("es-PE")} movimientos)`
      : `Este kardex ya estaba cargado (${repetidas.toLocaleString("es-PE")} movimientos repetidos)${corte ? ` · stock al ${corte}` : ""}`);
    msg([aviso, alDia ? `Stock actualizado al ${corte} con el kardex.` : "", ignoradas ? `${ignoradas.toLocaleString("es-PE")} filas no se pudieron leer y se omitieron (${malas.join("; ")}).` : ""].filter(Boolean).join(" "));
    // con el kardex nuevo se actualiza todo: las listas de faltantes y de cada sucursal, y los demás módulos abiertos
    if ((nuevas || diarias || stockCambio) && window.publicarFaltantes && !S.ejemplo) {
      const antes = $("msg").textContent; msg((antes ? antes + " " : "") + "Actualizando las listas de las sucursales y de faltantes…");
      try { const r = await window.publicarFaltantes(); msg((antes ? antes + " " : "") + (r?.ok ? "Listas de las sucursales y de faltantes actualizadas." : "No se pudieron actualizar las listas: " + (r?.error || ""))); }
      catch (e) { console.warn(e); }
      try { window.parent?.recargarModulos?.(window); } catch {}
    }
  } catch (e) {
    console.error(e);
    msg(e.code === "permission-denied"
      ? `Firebase no dio permiso al ${paso}. Revisa que las reglas de firestore.rules estén publicadas (botón Publicar), espera un minuto y vuelve a intentarlo.`
      : `No se pudo procesar el kardex (paso: ${paso || "lectura del archivo"}). ` + (e.message || "") + (e.code ? ` (${e.code})` : ""), true);
  }
};

/* ---------- pronósticos calculados en la página ---------- */
const media = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const ultimos = (h, n) => h.filter(v => v != null).slice(-n);
function sesFit(y) {
  let best = null;
  for (let al = .1; al < .95; al += .1) { let l = y[0], e = 0; for (let i = 1; i < y.length; i++) { e += (y[i] - l) ** 2; l = al * y[i] + (1 - al) * l; } if (!best || e < best.e) best = { e, l }; }
  return best ? best.l : 0;
}
function holtFit(y, k) {
  const phi = .9; let best = null;
  for (let al = .1; al < .95; al += .2) for (let be = .05; be < .5; be += .1) {
    let l = y[0], b = y.length > 1 ? y[1] - y[0] : 0, e = 0;
    for (let i = 1; i < y.length; i++) { const p = l + phi * b; e += (y[i] - p) ** 2; const nl = al * y[i] + (1 - al) * p; b = be * (nl - l) + (1 - be) * phi * b; l = nl; }
    if (!best || e < best.e) best = { e, l, b };
  }
  const out = []; let s = 0, ph = 1;
  for (let j = 0; j < k; j++) { ph *= phi; s += ph; out.push(best.l + s * best.b); }
  return out;
}
// índice estacional por mes del año (solo con 12+ meses de historia)
function indices(h, meses) {
  const ok = h.map((v, i) => [v, meses[i]]).filter(([v]) => v != null);
  if (ok.length < 12) return null;
  const g = media(ok.map(([v]) => v)); if (!g) return null;
  const idx = Array(12).fill(0).map((_, m) => { const v = ok.filter(([, mm]) => +mm.slice(5) - 1 === m).map(([v]) => v); return v.length ? media(v) / g : 1; });
  return idx.map(v => Math.min(3, Math.max(.2, v)));
}
// SARIMA simplificado: y_t = c + a·y_{t-1} + b·y_{t-12} (mínimos cuadrados), pronóstico paso a paso
function arEstacional(y, k) {
  const X = [], Y = [];
  for (let i = 12; i < y.length; i++) if (y[i] != null && y[i - 1] != null && y[i - 12] != null) { X.push([1, y[i - 1], y[i - 12]]); Y.push(y[i]); }
  if (X.length < 10) return null;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0];
  X.forEach((r, n) => { for (let i = 0; i < 3; i++) { B[i] += r[i] * Y[n]; for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; } });
  for (let i = 0; i < 3; i++) A[i][i] += 1e-6;
  const c = resolver(A, B); if (!c) return null;
  const s = [...y], out = [];
  for (let j = 0; j < k; j++) { const t = s.length, v = c[0] + c[1] * (s[t - 1] ?? 0) + c[2] * (s[t - 12] ?? 0); out.push(v); s.push(v); }
  return out;
}
function resolver(A, b) {
  const n = 3, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (Math.abs(M[p][i]) < 1e-9) return null; [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < n; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
const METODOS = ["Media 3 meses", "Media 6 meses", "Media 3m × estac.", "SES", "Holt amortiguado", "SARIMA AR estacional"];
// pronostica k meses después de la historia h (meses = etiquetas de h, futuros = etiquetas a pronosticar)
function pronosticar(h, meses, futuros, apto) {
  const y = h.filter(v => v != null), r = {}, k = futuros.length, fija = v => Array(k).fill(Math.max(0, v));
  if (!y.length) return r;
  r["Media 3 meses"] = fija(media(ultimos(h, 3)));
  r["Media 6 meses"] = fija(media(ultimos(h, 6)));
  const idx = indices(h, meses);
  if (idx) {
    const des = h.map((v, i) => v == null ? null : v / idx[+meses[i].slice(5) - 1]);
    const b = media(ultimos(des, 3)); r["Media 3m × estac."] = futuros.map(m => Math.max(0, b * idx[+m.slice(5) - 1]));
  }
  r["SES"] = fija(sesFit(y));
  if (apto) {
    r["Holt amortiguado"] = holtFit(y, k).map(v => Math.max(0, v));
    const ar = arEstacional(h, k); if (ar) r["SARIMA AR estacional"] = ar.map(v => Math.max(0, v));
  }
  return r;
}
const sumaM = (m, k) => { const [a, b] = m.split("-").map(Number), t = a * 12 + b - 1 + k; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, "0")}`; };
const r1 = v => Math.round(v * 10) / 10;

// ventas por día de los últimos 90 días hasta el corte, leídas de los meses guardados.
// primero = índice del primer día con datos (los días anteriores no se conocen); null si no hay ninguno.
async function ventasDiarias(corte, metas, leer = leerMes) {
  metas ??= await mesesMeta();
  const DIAS = 90, finD = new Date(corte + "T12:00:00"), dias = [];
  for (let i = DIAS - 1; i >= 0; i--) { const d = new Date(finD); d.setDate(d.getDate() - i); dias.push(d.toISOString().slice(0, 10)); }
  const diaIdx = new Map(dias.map((d, i) => [d, i])), mesesDia = [...new Set(dias.map(d => d.slice(0, 7)))];
  const vd = new Map(); let conDiario = 0, primero = null;
  for (const mes of mesesDia) {
    const meta = metas.get(mes); if (!meta) continue;
    const { v, kd } = await leer(meta, mes);
    if (kd === null || (kd && kd.size)) conDiario++;
    for (const cod in v) for (const alm in v[cod]) for (const dd in v[cod][alm]) {
      const i = diaIdx.get(`${mes}-${dd}`); if (i == null) continue;
      if (primero == null || i < primero) primero = i;
      (((vd.get(cod) ?? vd.set(cod, {}).get(cod))[alm] ??= [])).push([i, v[cod][alm][dd]]);
    }
  }
  return { vd, dias: { desde: dias[0], hasta: dias[DIAS - 1], n: DIAS, completo: conDiario === mesesDia.length, primero } };
}
window.ventasDiarias = async corte => { try { return await ventasDiarias(String(corte).slice(0, 10)); } catch { return null; } };

// Base histórica: el último archivo de pronósticos de Colab (proy_config/base). Si aún no se guardó aparte,
// se toma de proy_config/datos mientras esos datos sigan siendo los de Colab (no recalculados con el kardex).
async function leerBase() {
  paso = "leer el historial de Colab (proy_config/base)";
  let id = null;
  const b = await getDoc(doc(db, "proy_config", "base"));
  if (b.exists()) id = b.data().asset;
  else {
    const d = await getDoc(doc(db, "proy_config", "datos"));
    if (d.exists() && d.data().asset && d.data().archivo !== "kardex") {
      id = d.data().asset;
      await setDoc(doc(db, "proy_config", "base"), { asset: id, archivo: d.data().archivo || "", corte: d.data().corte || "", guardado: new Date().toISOString() });
    }
  }
  if (!id) return null;
  const r = await assetsShim.fetch(id); if (!r.ok) return null;
  const o = await r.json();
  return { id, o: window.validar ? window.validar(o) : o };
}

// Resumen por mes (proy_config/resumen): la venta neta por producto y farmacia de cada mes guardado, y las ventas
// por día de los meses recientes. Así, al subir el kardex del día solo se vuelven a leer los meses que cambiaron
// (normalmente el mes en curso) y no todos desde 2024. Cada mes se reconoce por su archivo (asset): si se vuelve a
// guardar, cambia su asset y se relee.
const RES_VER = 1;
async function leerResumen() {
  try {
    const c = await getDoc(doc(db, "proy_config", "resumen")); if (!c.exists()) return null;
    const r = await assetsShim.fetch(c.data().asset); if (!r.ok) return null;
    const o = await r.json(); return o.ver === RES_VER ? { id: c.data().asset, m: o.m || {} } : null;
  } catch (e) { console.warn(e); return null; }
}
async function guardarResumen(prev, m) {
  try {
    const { id } = await assetsShim.upload(new Blob([JSON.stringify({ ver: RES_VER, m })]));
    await setDoc(doc(db, "proy_config", "resumen"), { asset: id, actualizado: new Date().toISOString() });
    if (prev?.id) assetsShim.delete(prev.id).catch(() => {});
  } catch (e) { console.warn("No se pudo guardar el resumen por mes", e); }
}

// Versión del cálculo: si cambia, los pronósticos guardados se rehacen solos al abrir la página.
const CALC_VER = 5; window.CALC_VER = CALC_VER;
async function recalcular() {
  const metas = await mesesMeta(); if (!metas.size) return "";
  const maestro = await leerMaestro(), lista = [...metas.keys()].sort();
  const base = await leerBase(), B = base?.o, bMeses = B?.meses || [], bFin = bMeses[bMeses.length - 1] || "";
  const corte = maestro.corte.slice(0, 10), mesCorte = corte.slice(0, 7);
  const diasMesCorte = new Date(+mesCorte.slice(0, 4), +mesCorte.slice(5), 0).getDate();
  // el mes del corte cuenta como completo solo si llega a su último día
  const ultimoCompleto = +corte.slice(8, 10) >= diasMesCorte ? mesCorte : sumaM(mesCorte, -1);
  // historia completa: los meses del archivo de Colab y, después de su último mes, los meses del kardex
  const ini = bMeses.length && bMeses[0] < lista[0] ? bMeses[0] : lista[0];
  const meses = []; for (let m = ini; m <= ultimoCompleto; m = sumaM(m, 1)) meses.push(m);
  if (meses.length < 4) return `Los pronósticos siguen siendo los del archivo de pronósticos: se necesitan al menos 4 meses completos para calcularlos (hay ${meses.length}).`;
  // demanda mensual por producto y farmacia (ventas − anulaciones) y movimientos por farmacia
  // Kardex: todos sus meses. Colab: su historia total y por farmacia, solo como respaldo. Cada mes usa el kardex si
  // está completo (vende al menos el 90 % de lo que dice Colab para ese mes); si no, Colab para los productos que están en Colab.
  const demK = new Map(), conK = new Set(), conDatos = new Set(), hBase = new Map(), pfB = new Map(), bIdx = new Map((B?.p || []).map(p => [p.c, p]));
  const iDe = new Map(meses.map((m, i) => [m, i]));
  if (B) {
    msg("Uniendo el historial de Colab…");
    bMeses.forEach(m => { if (iDe.has(m)) conDatos.add(iDe.get(m)); });
    for (const bp of B.p) {
      const h = Array(meses.length).fill(null); bMeses.forEach((m, j) => { if (iDe.has(m)) h[iDe.get(m)] = bp.h?.[j] ?? null; }); hBase.set(bp.c, h);
      const pf = new Map(); pfB.set(bp.c, pf);
      for (const [alm, arr] of Object.entries(bp.hf || {})) (B.hfm || []).forEach((m, j) => {
        if (!iDe.has(m) || arr[j] == null) return;
        (pf.get(alm) ?? pf.set(alm, Array(meses.length).fill(0)).get(alm))[iDe.get(m)] += arr[j];
      });
      for (const alm of Object.keys(bp.s || {})) if (!pf.has(alm)) pf.set(alm, Array(meses.length).fill(0));
    }
  }
  // meses cuyas ventas por día se usan (los 90 días hasta el corte)
  const finD = new Date(corte + "T12:00:00"), iniD = new Date(finD); iniD.setDate(iniD.getDate() - 89);
  const mesesV = new Set(); for (let m = iniD.toISOString().slice(0, 7); m <= mesCorte; m = sumaM(m, 1)) mesesV.add(m);
  const res = await leerResumen(), cache = res?.m || {}, nuevoRes = {}; let releidos = 0;
  const compras = new Map();   // compras en soles de cada producto en todos los meses del kardex (para el módulo Compras)
  async function resumenMes(mes, meta) {
    const c = cache[mes], conV = mesesV.has(mes);
    // c.cm: compras del mes (los resúmenes guardados antes no lo tienen: ese mes se vuelve a leer una vez)
    if (c && c.a === meta.asset && (!conV || c.v) && c.cm) return (nuevoRes[mes] = conV ? c : { a: c.a, d: c.d, cm: c.cm });
    msg(`Leyendo ${mes}…`); releidos++;
    const { d, v, kd } = await leerMes(meta), dm = {}, cm = {};
    for (const cod in d) for (const alm in d[cod]) {
      // compras del mes en soles (costo): CARGO COMPRA menos devoluciones al proveedor, en cualquier almacén
      for (const [tipo, a] of Object.entries(d[cod][alm])) {
        if (/^CARGO COMPRA/.test(tipo)) cm[cod] = (cm[cod] || 0) + (a[2] || 0);
        else if (/DEVOL.*PROVE/.test(tipo)) cm[cod] = (cm[cod] || 0) - (a[3] || 0);
      }
      if (alm === DROG) continue;
      const t = d[cod][alm]; if (!t[VENTA] && !t[ANULA]) continue;
      (dm[cod] ??= {})[alm] = Math.round(((t[VENTA]?.[1] || 0) - (t[ANULA]?.[0] || 0)) * 1000) / 1000;
    }
    for (const cod in cm) cm[cod] = Math.round(cm[cod] * 100) / 100;
    const r = { a: meta.asset, d: dm, cm }; if (conV) { r.v = v; r.kd = kd === null || !!(kd && kd.size) ? 1 : 0; }
    return (nuevoRes[mes] = r);
  }
  for (let i = 0; i < meses.length; i++) {
    const meta = metas.get(meses[i]); if (!meta) continue;
    conDatos.add(i); conK.add(i);
    const { d, cm } = await resumenMes(meses[i], meta);
    for (const cod in cm) (compras.get(cod) ?? compras.set(cod, Array(meses.length).fill(0)).get(cod))[i] += cm[cod];
    for (const cod in d) for (const alm in d[cod]) {
      const pf = (demK.get(cod) ?? demK.set(cod, new Map()).get(cod));
      (pf.get(alm) ?? pf.set(alm, Array(meses.length).fill(0)).get(alm))[i] += d[cod][alm];
    }
  }
  const totK = Array(meses.length).fill(0), totB = Array(meses.length).fill(0);
  for (const pf of demK.values()) for (const a of pf.values()) a.forEach((v, i) => totK[i] += v);
  for (const h of hBase.values()) h.forEach((v, i) => totB[i] += v || 0);
  const kOk = meses.map((m, i) => conK.has(i) && (!(bFin && m <= bFin) || totK[i] >= .9 * totB[i]));
  const usaBase = (cod, m) => { const i = iDe.get(m); return hBase.has(cod) && bFin && m <= bFin && !kOk[i]; };
  const dem = new Map(), hTot = new Map(), farmVol = new Map();
  for (const cod of new Set([...demK.keys(), ...hBase.keys()])) {
    const pk = demK.get(cod) || new Map(), pb = pfB.get(cod) || new Map(), pf = new Map();
    for (const alm of new Set([...pk.keys(), ...pb.keys()])) {
      const a = meses.map((m, i) => usaBase(cod, m) ? (pb.get(alm)?.[i] || 0) : (pk.get(alm)?.[i] || 0));
      pf.set(alm, a); farmVol.set(alm, (farmVol.get(alm) || 0) + a.reduce((x, v) => x + Math.max(0, v), 0));
    }
    dem.set(cod, pf);
    hTot.set(cod, meses.map((m, i) => !conDatos.has(i) ? null : usaBase(cod, m) ? hBase.get(cod)[i]
      : conK.has(i) ? r1([...pk.values()].reduce((x, v) => x + v[i], 0)) : 0));
  }
  // ventas por día de los últimos 90 días hasta el corte (para "ventas de los últimos N días")
  msg("Leyendo ventas por día…");
  const { vd, dias: diasInfo } = await ventasDiarias(corte, metas, async (meta, mes) => {
    const r = await resumenMes(mes, meta); return { v: r.v || {}, kd: r.kd ? null : new Set() };
  });
  if (releidos || Object.keys(cache).some(m => !nuevoRes[m])) { msg("Guardando resumen por mes…"); await guardarResumen(res, nuevoRes); }
  // también las farmacias que solo aparecen en el stock o las ventas por día del kardex
  for (const st of Object.values(maestro.stock || {})) for (const alm in st) if (alm !== DROG && !ignorar(alm) && !farmVol.has(alm)) farmVol.set(alm, 0);
  for (const fs of vd.values()) for (const alm in fs) if (!farmVol.has(alm)) farmVol.set(alm, 0);
  const farmacias = [...farmVol.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const bm = meses.slice(-6), fm = [0, 1, 2].map(j => sumaM(ultimoCompleto, j + 1)), hfm = meses.slice(-36);
  msg("Calculando pronósticos…");
  const p = [];
  for (const [cod, pf] of dem) {
    const bp = bIdx.get(cod), h = hTot.get(cod);
    // se incluyen todos los productos con historia (también los que dejaron de venderse: categoría E)
    const prom = media(ultimos(h, 12)), apto = h.filter(v => v != null).length >= 24 && prom >= 10;
    // prueba: pronóstico de cada mes de bm con lo conocido hasta el mes anterior
    const b = {}; METODOS.forEach(m => b[m] = []);
    for (const mb of bm) {
      const i = meses.indexOf(mb), r = pronosticar(h.slice(0, i), meses.slice(0, i), [mb], apto);
      METODOS.forEach(m => b[m].push(r[m] ? r1(r[m][0]) : null));
    }
    const f = pronosticar(h, meses, fm, apto);
    const bOk = {}, fOk = {};
    for (const m of METODOS) if (f[m] && b[m].every(v => v != null)) { bOk[m] = b[m]; fOk[m] = f[m].map(r1); }
    // participación de cada farmacia en los últimos 3 meses
    const tot3 = farmacias.reduce((a, fa) => a + Math.max(0, media((pf.get(fa) || []).slice(-3))), 0);
    const s = {}, st = {}, hf = {};
    for (const fa of farmacias) {
      const v = pf.get(fa); if (v) { hf[fa] = v.slice(-36).map(r1); const x = Math.max(0, media(v.slice(-3))); if (tot3 && x) s[fa] = Math.round(x / tot3 * 1e4) / 1e4; }
      const sk = maestro.stock[cod]?.[fa]; if (sk) st[fa] = sk[0]; else if (bp?.st?.[fa] != null) st[fa] = bp.st[fa];
    }
    const pr = maestro.prod[cod] || (bp ? [bp.n, bp.fr || 1, bp.k || 0] : [cod, 1, 0]);
    p.push({ c: cod, n: pr[0], k: pr[2] || 0, fr: +pr[1] || 1, a: apto, h, b: bOk, f: fOk, s, st, hf, sd: maestro.stock[cod]?.[DROG]?.[0] ?? bp?.sd ?? 0,
      dv: vd.get(cod) || {}, um: (maestro.prod[cod] || [])[3]?.slice(0, 10) || "", uv: maestro.uv?.[cod]?.slice(0, 10) || "",
      ...(compras.has(cod) ? { cm: compras.get(cod).map(v => Math.round(v)) } : {}) });
  }
  // productos que aparecen en el kardex pero sin ninguna venta registrada (solo compras, envíos…): se listan sin pronóstico
  for (const cod of Object.keys(maestro.prod)) {
    if (dem.has(cod)) continue;
    const st = maestro.stock[cod] || {}, pr = maestro.prod[cod] || [cod, 1, 0], stf = {};
    for (const fa of farmacias) if (st[fa]) stf[fa] = st[fa][0];
    p.push({ c: cod, n: pr[0], k: pr[2] || 0, fr: +pr[1] || 1, a: false, h: meses.map(() => 0), b: {}, f: {}, s: {}, st: stf, hf: {}, sd: st[DROG]?.[0] || 0,
      sinVentas: true, dv: {}, um: (pr[3] || "").slice(0, 10), uv: "", ...(compras.has(cod) ? { cm: compras.get(cod).map(v => Math.round(v)) } : {}) });
  }
  const cmM = meses.slice();   // meses de p.cm (compras): toda la historia, más el mes en curso (aunque esté incompleto)
  if (metas.has(mesCorte) && !cmM.includes(mesCorte)) {
    const { cm } = await resumenMes(mesCorte, metas.get(mesCorte)); cmM.push(mesCorte);
    for (const a of compras.values()) a.push(0);
    for (const cod in cm) (compras.get(cod) ?? compras.set(cod, Array(cmM.length).fill(0)).get(cod))[cmM.length - 1] += cm[cod];
    for (const p0 of p) if (compras.has(p0.c)) p0.cm = compras.get(p0.c).map(v => Math.round(v));
  }
  const o = { ver: CALC_VER, corte, meses, hfm, bm, fm, metodos: METODOS.filter(m => p.some(x => x.f[m])), farmacias, p, origen: "kardex", cmM,
    dias: diasInfo };
  msg("Guardando pronósticos…"); paso = "guardar los pronósticos (proy_config/datos)";
  const prev = await getDoc(doc(db, "proy_config", "datos"));
  const { id } = await assetsShim.upload(new Blob([JSON.stringify(o)]));
  await setDoc(doc(db, "proy_config", "datos"), { asset: id, archivo: "kardex", corte, subido: new Date().toISOString() });
  if (prev.exists() && prev.data().asset && prev.data().asset !== base?.id) assetsShim.delete(prev.data().asset).catch(() => {});
  window.STOCK_TODOS = maestro.stock;
  usarPron(o, false); pintarFuente(`kardex al ${corte.split("-").reverse().join("/")}`); msg("");
  return "";
}
window.stockKardex = async () => { try { return await leerMaestro(); } catch (e) { console.warn(e); return null; } };
window.recalcularPron = recalcular;
window.pronosticar = pronosticar; window.METODOS = METODOS;

/* ---------- bloqueos: lo bloqueado por una sucursal no se compra ni se le reparte ---------- */
window.BLOQ = new Set();
function escucharBloqueos() {
  onSnapshot(collection(db, "bloqueos"), s => {
    window.BLOQ = new Set(s.docs.filter(d => d.data().estado === "bloqueado").map(d => d.id));
    if (S.P) render();
  }, () => {});
}
