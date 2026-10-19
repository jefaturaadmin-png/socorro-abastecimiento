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
    if (String(p.rol || "").trim().toLowerCase() !== "admin") return bloquear("Esta sección es solo para el administrador.");
  } catch { return bloquear("No se pudo comprobar tu usuario. Recarga la página."); }
  desbloquear();
  if (arrancado) return; arrancado = true;
  window.claude = { use: async n => n === "db" ? dbShim : n === "assets" ? assetsShim : null };
  window.iniciarKardex();
  escucharBloqueos(); escucharPedidos();
});

/* =====================================================================
   KARDEX DE LOLFAR (.TXT) → resumen por mes en Firebase → pronósticos
   Cantidades en cajas: enteras + fracciones ÷ unidades por caja (stkfra).
   ===================================================================== */
const COL = { despro: 0, stkE: 1, stkM: 2, feckar: 8, destka: 10, coscom: 18, fra: 20, numkar: 24, codpro: 25, desalm: 27, iE: 30, iM: 31, sE: 32, sM: 33 };
const VENTA = "DESCARGO POR VENTA", ANULA = "CARGO POR ANULACIONES", DROG = "DROGUERIA FS";
const ignorar = alm => /CANJE/i.test(alm) || !alm;

// Algunas filas traen el nombre del cliente partido por tabulaciones: se rearma la fila a 34 columnas.
function campos(linea) {
  let x = linea.split("\t");
  if (x.length > 34) x = [...x.slice(0, 15), x.slice(15, x.length - 18).join(" "), ...x.slice(x.length - 18)];
  return x.length === 34 ? x : null;
}
const fechaISO = f => { const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\S*)/.exec(f || ""); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")} ${m[4]}` : ""; };

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
    for (const f of files) {
      for await (const l of lineas(f, n => { leidosArch = n; pct(n); })) {
        if (!l || l.startsWith("despro")) continue;
        const x = campos(l); if (!x) { ignoradas++; continue; }
        filas++;
        const alm = x[COL.desalm].trim(); if (ignorar(alm)) continue;
        const fecha = fechaISO(x[COL.feckar]), mes = fecha.slice(0, 7), nk = +x[COL.numkar], cod = x[COL.codpro].trim();
        if (!mes || !nk || !cod) { ignoradas++; continue; }
        if (!meses.has(mes)) { msg(`Abriendo ${mes}…`); meses.set(mes, await leerMes(metas.get(mes))); nuevosMes.set(mes, 0); }
        const M = meses.get(mes), fra = +x[COL.fra] || 1, cos = +x[COL.coscom] || 0;
        // datos del producto y stock actual del almacén (el más reciente gana), aunque el movimiento ya estuviera cargado:
        // el stock de cada fila (stkalm) es el del momento en que se descargó el archivo
        const pr = maestro.prod[cod];
        if (!pr || fecha >= pr[3]) maestro.prod[cod] = [x[COL.despro].trim(), fra, cos, fecha];
        const st = (maestro.stock[cod] ??= {}), previo = st[alm], stk = Math.round(((+x[COL.stkE] || 0) + (+x[COL.stkM] || 0) / fra) * 1000) / 1000;
        if (!previo || fecha >= previo[1]) { if (!previo || previo[0] !== stk || previo[1] !== fecha) stockCambio = true; st[alm] = [stk, fecha]; }
        if (fecha > maestro.corte) { maestro.corte = fecha; stockCambio = true; }
        const tipo = x[COL.destka].trim();
        const ing = (+x[COL.iE] || 0) + (+x[COL.iM] || 0) / fra, sal = (+x[COL.sE] || 0) + (+x[COL.sM] || 0) / fra;
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
    msg([aviso, alDia ? `Stock actualizado al ${corte} con el kardex.` : "", ignoradas ? `${ignoradas} filas no se pudieron leer y se omitieron.` : ""].filter(Boolean).join(" "));
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

async function recalcular() {
  const metas = await mesesMeta(); if (!metas.size) { msg("Todavía no hay kardex cargado."); return; }
  const maestro = await leerMaestro(), lista = [...metas.keys()].sort();
  const corte = maestro.corte.slice(0, 10), mesCorte = corte.slice(0, 7);
  const diasMesCorte = new Date(+mesCorte.slice(0, 4), +mesCorte.slice(5), 0).getDate();
  // el mes del corte cuenta como completo solo si llega a su último día
  const ultimoCompleto = +corte.slice(8, 10) >= diasMesCorte ? mesCorte : sumaM(mesCorte, -1);
  const meses = []; for (let m = lista[0]; m <= ultimoCompleto; m = sumaM(m, 1)) meses.push(m);
  if (meses.length < 4) return `Los pronósticos siguen siendo los del archivo de pronósticos: con el kardex se necesitan al menos 4 meses completos para calcularlos (hay ${meses.length}).`;
  // demanda mensual por producto y farmacia (ventas − anulaciones) y movimientos por farmacia
  const dem = new Map(), farmVol = new Map(), conDatos = new Set();
  // ventas por día de los últimos 90 días hasta el corte (para "ventas de los últimos N días")
  const DIAS = 90, finD = new Date(corte + "T12:00:00"), dias = [];
  for (let i = DIAS - 1; i >= 0; i--) { const d = new Date(finD); d.setDate(d.getDate() - i); dias.push(d.toISOString().slice(0, 10)); }
  const diaIdx = new Map(dias.map((d, i) => [d, i])), mesesDia = [...new Set(dias.map(d => d.slice(0, 7)))];
  const vd = new Map(); let conDiario = 0;
  for (let i = 0; i < meses.length; i++) {
    const meta = metas.get(meses[i]); if (!meta) continue;
    msg(`Leyendo ${meses[i]}…`); conDatos.add(i);
    const { d } = await leerMes(meta);
    for (const cod in d) for (const alm in d[cod]) {
      if (alm === DROG) continue;
      const t = d[cod][alm], v = (t[VENTA]?.[1] || 0) - (t[ANULA]?.[0] || 0);
      if (!t[VENTA] && !t[ANULA]) continue;
      const pf = (dem.get(cod) ?? dem.set(cod, new Map()).get(cod));
      (pf.get(alm) ?? pf.set(alm, Array(meses.length).fill(0)).get(alm))[i] += v;
      farmVol.set(alm, (farmVol.get(alm) || 0) + Math.max(0, v));
    }
  }
  for (const mes of mesesDia) {
    const meta = metas.get(mes); if (!meta) continue;
    const { v, kd } = await leerMes(meta);
    if (kd === null || (kd && kd.size)) conDiario++;
    for (const cod in v) for (const alm in v[cod]) for (const dd in v[cod][alm]) {
      const i = diaIdx.get(`${mes}-${dd}`); if (i == null) continue;
      (((vd.get(cod) ?? vd.set(cod, {}).get(cod))[alm] ??= [])).push([i, v[cod][alm][dd]]);
    }
  }
  const farmacias = [...farmVol.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const bm = meses.slice(-6), fm = [0, 1, 2].map(j => sumaM(ultimoCompleto, j + 1)), hfm = meses.slice(-15);
  msg("Calculando pronósticos…");
  const p = [];
  for (const [cod, pf] of dem) {
    const h = meses.map((_, i) => conDatos.has(i) ? r1([...pf.values()].reduce((a, v) => a + v[i], 0)) : null);
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
      const v = pf.get(fa); if (v) { hf[fa] = v.slice(-15).map(r1); const x = Math.max(0, media(v.slice(-3))); if (tot3 && x) s[fa] = Math.round(x / tot3 * 1e4) / 1e4; }
      const sk = maestro.stock[cod]?.[fa]; if (sk) st[fa] = sk[0];
    }
    const pr = maestro.prod[cod] || [cod, 1, 0];
    p.push({ c: cod, n: pr[0], k: pr[2] || 0, fr: +pr[1] || 1, a: apto, h, b: bOk, f: fOk, s, st, hf, sd: maestro.stock[cod]?.[DROG]?.[0] || 0,
      dv: vd.get(cod) || {}, um: (maestro.prod[cod] || [])[3]?.slice(0, 10) || "", uv: maestro.uv?.[cod]?.slice(0, 10) || "" });
  }
  // productos que aparecen en el kardex pero sin ninguna venta registrada (solo compras, envíos…): se listan sin pronóstico
  for (const cod of Object.keys(maestro.prod)) {
    if (dem.has(cod)) continue;
    const st = maestro.stock[cod] || {}, pr = maestro.prod[cod] || [cod, 1, 0], stf = {};
    for (const fa of farmacias) if (st[fa]) stf[fa] = st[fa][0];
    p.push({ c: cod, n: pr[0], k: pr[2] || 0, fr: +pr[1] || 1, a: false, h: meses.map(() => 0), b: {}, f: {}, s: {}, st: stf, hf: {}, sd: st[DROG]?.[0] || 0,
      sinVentas: true, dv: {}, um: (pr[3] || "").slice(0, 10), uv: "" });
  }
  const o = { corte, meses, hfm, bm, fm, metodos: METODOS.filter(m => p.some(x => x.f[m])), farmacias, p, origen: "kardex",
    dias: { desde: dias[0], hasta: dias[DIAS - 1], n: DIAS, completo: conDiario === mesesDia.length } };
  msg("Guardando pronósticos…"); paso = "guardar los pronósticos (proy_config/datos)";
  const prev = await getDoc(doc(db, "proy_config", "datos"));
  const { id } = await assetsShim.upload(new Blob([JSON.stringify(o)]));
  await setDoc(doc(db, "proy_config", "datos"), { asset: id, archivo: "kardex", corte, subido: new Date().toISOString() });
  if (prev.exists() && prev.data().asset) assetsShim.delete(prev.data().asset).catch(() => {});
  window.STOCK_TODOS = maestro.stock;
  usarPron(o, false); pintarFuente(`kardex al ${corte.split("-").reverse().join("/")}`); msg("");
  return "";
}
window.stockKardex = async () => { try { return await leerMaestro(); } catch (e) { console.warn(e); return null; } };
window.recalcularPron = recalcular;

/* ---------- bloqueos: lo bloqueado por una sucursal no se compra ni se le reparte ---------- */
window.BLOQ = new Set();
// pedidos urgentes que registran las sucursales (pestaña Pedidos)
function escucharPedidos() {
  onSnapshot(collection(db, "pedidos"), s => {
    window.PEDIDOS = s.docs.map(d => { const x = d.data(); return { f: x.farmacia, c: String(x.codpro || ""), n: x.producto || "", cant: x.cantidad || null,
      fecha: x.fecha?.toMillis ? x.fecha.toMillis() : Date.now(), por: x.porNombre || "", com: x.comentario || "", estado: x.estado || "pendiente" }; });
    if (S.P && S.vista === "ped") render();
  }, () => { window.PEDIDOS = null; });
}
function escucharBloqueos() {
  onSnapshot(collection(db, "bloqueos"), s => {
    window.BLOQ = new Set(s.docs.filter(d => d.data().estado === "bloqueado").map(d => d.id));
    if (S.P) render();
  }, () => {});
}
