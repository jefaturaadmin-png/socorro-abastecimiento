// Módulo «Rutas de reparto»: ubicaciones editables (droguería y sucursales), grupos de sucursales y la ruta más corta
// de cada grupo saliendo y volviendo al punto de salida, con el método que se elija. Se ve en un mapa y se abre en Google Maps.
// Se guarda en rutas/config = { puntos: [{ id, n, lat, lon, salida }], grupos: [{ id, n, ids: [...], modelo }] }
//
// Distancias: por calles con OSRM (servicio público de OpenStreetMap) si responde; si no, línea recta × 1,3.

export const MODELOS = [
  ["auto", "Automático (exacto hasta 9 paradas; si son más, recocido simulado)"],
  ["exacto", "Exacto: prueba todos los órdenes (hasta 9 paradas)"],
  ["nnopt", "Vecino más cercano + 2-opt (NNOPT)"],
  ["sa", "Recocido simulado (SA)"],
  ["nn", "Vecino más cercano (NN)"],
  ["naive", "Como están en el grupo, sin reordenar (NAIVE)"]];
export const COLORES_G = ["#E4572E", "#1E6BB8", "#2E9E5B", "#9B5DE5", "#F28C1E", "#00A6A6", "#C2185B", "#6D4C41"];

// Ubicaciones iniciales (de la evaluación de envío de sucursales)
export const PUNTOS_INICIALES = [
  ["DROGUERIA", `12°04'09.34"S 75°12'34.34"W`, true], ["SOCORRO PUNO", `12°04'10.08"S 75°12'49.37"W`], ["ANDALUZ", `12°04'15.19"S 75°12'15.82"W`],
  ["SOCORRO REAL", `12°04'09.13"S 75°12'35.39"W`], ["TUPAC", `12°03'37.69"S 75°12'16.33"W`], ["PARRA", `12°03'45.23"S 75°13'09.37"W`],
  ["SUMAR", `12°03'13.54"S 75°13'30.56"W`], ["MERCADO TAMBO", `12°03'26.66"S 75°12'50.60"W`], ["HUANCAS", `12°04'02.11"S 75°12'11.04"W`],
  ["LOS HEROES", `12°05'11.31"S 75°12'29.09"W`], ["MERCADO", `12°04'19.66"S 75°12'18.20"W`], ["ORTEGA", `12°04'14.61"S 75°12'56.96"W`],
  ["CONCEPCION", `11°55'06.89"S 75°18'51.67"W`], ["LIBERTAD", `12°03'04.47"S 75°11'25.13"W`], ["PIOPATA", `12°03'44.50"S 75°13'33.82"W`]];

// «12°04'09.34"S 75°12'34.34"W» o «-12.0692, -75.2095» → [lat, lon]
export function leerUbicacion(t) {
  t = String(t || "").trim().replace(/[′’]/g, "'").replace(/[″”]/g, '"').replace(/''/g, '"');
  const g = [...t.matchAll(/(\d+(?:[.,]\d+)?)\s*°\s*(?:(\d+(?:[.,]\d+)?)\s*'\s*)?(?:(\d+(?:[.,]\d+)?)\s*"\s*)?([NSEWO])/gi)];
  if (g.length === 2) {
    const num = x => +String(x || 0).replace(",", ".") || 0;
    const v = g.map(([, d, m, s, h]) => { const x = num(d) + num(m) / 60 + num(s) / 3600; return /[SWO]/i.test(h) ? -x : x; });
    return /[NS]/i.test(g[0][4]) ? v : [v[1], v[0]];
  }
  const n = t.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
  if (n) { const a = +n[1], b = +n[2]; if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [a, b]; }
  return null;
}
export const fmtDMS = (lat, lon) => {
  const f = (v, p, q) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
    return `${d}°${String(m).padStart(2, "0")}'${s.toFixed(2).padStart(5, "0")}"${v < 0 ? q : p}`; };
  return f(lat, "N", "S") + " " + f(lon, "E", "W");
};

const rad = x => x * Math.PI / 180;
export const kmRecta = (a, b) => { const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h)); };

// ---------- métodos de ruta: n paradas (índices 1..n de la matriz; 0 = salida), devuelven el orden de visita ----------
const largo = (M, o) => { let d = 0, p = 0; for (const x of o) { d += M[p][x]; p = x; } return d + M[p][0]; };
function exacto(M, ids) {
  let mejor = null;
  const per = (pref, resto) => {
    if (mejor && largo(M, pref) - M[pref.at(-1) ?? 0][0] >= mejor.d) return;   // poda: ya es más largo que el mejor
    if (!resto.length) { const d = largo(M, pref); if (!mejor || d < mejor.d) mejor = { d, o: pref }; return; }
    for (let i = 0; i < resto.length; i++) per([...pref, resto[i]], [...resto.slice(0, i), ...resto.slice(i + 1)]);
  };
  per([], ids); return mejor.o;
}
function vecino(M, ids) {
  const o = [], q = new Set(ids); let p = 0;
  while (q.size) { let b = null; for (const x of q) if (b == null || M[p][x] < M[p][b]) b = x; o.push(b); q.delete(b); p = b; }
  return o;
}
function dosOpt(M, o) {
  let r = [...o], mejoro = true;
  while (mejoro) {
    mejoro = false;
    for (let i = 0; i < r.length - 1; i++) for (let k = i + 1; k < r.length; k++) {
      const n = [...r.slice(0, i), ...r.slice(i, k + 1).reverse(), ...r.slice(k + 1)];
      if (largo(M, n) + 1e-9 < largo(M, r)) { r = n; mejoro = true; }
    }
  }
  return r;
}
function recocido(M, ids) {
  let semilla = 7; const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647;
  let act = dosOpt(M, vecino(M, ids)), dAct = largo(M, act), mejor = act, dMejor = dAct;
  if (ids.length < 3) return act;
  for (let t = 2, it = 0; it < 20000; it++, t *= 0.9995) {
    let i = Math.floor(azar() * act.length), k = Math.floor(azar() * act.length); if (i > k) [i, k] = [k, i]; if (i === k) continue;
    const n = [...act.slice(0, i), ...act.slice(i, k + 1).reverse(), ...act.slice(k + 1)], dn = largo(M, n);
    if (dn < dAct || azar() < Math.exp((dAct - dn) / Math.max(t, 1e-6))) { act = n; dAct = dn; if (dn < dMejor) { mejor = n; dMejor = dn; } }
  }
  return mejor;
}
export function ordenar(M, ids, modelo) {
  if (ids.length <= 1) return [...ids];
  if (modelo === "auto") modelo = ids.length <= 9 ? "exacto" : "sa";
  if (modelo === "exacto" && ids.length > 9) modelo = "nnopt";
  return modelo === "exacto" ? exacto(M, ids) : modelo === "nn" ? vecino(M, ids) : modelo === "nnopt" ? dosOpt(M, vecino(M, ids))
    : modelo === "sa" ? recocido(M, ids) : [...ids];
}

// enlace de Google Maps: sale y vuelve al punto de salida pasando por las paradas en orden
export const linkMaps = (salida, paradas) => {
  const c = p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${c(salida)}&destination=${c(salida)}` + (paradas.length ? `&waypoints=${paradas.map(c).join("%7C")}` : "");
};

// ---------- OSRM: matriz de distancias y trazo por calles (si no responde, se usa línea recta × 1,3) ----------
const OSRM = "https://router.project-osrm.org";
const cacheM = new Map(), cacheT = new Map();
export async function matriz(pts) {
  const clave = pts.map(p => p.lat.toFixed(5) + "," + p.lon.toFixed(5)).join(";");
  if (cacheM.has(clave)) return cacheM.get(clave);
  const recta = { km: pts.map(a => pts.map(b => kmRecta(a, b) * 1.3)), min: null, fuente: "recta" };
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${OSRM}/table/v1/driving/${pts.map(p => p.lon.toFixed(6) + "," + p.lat.toFixed(6)).join(";")}?annotations=distance,duration`, { signal: ctl.signal });
    clearTimeout(t); const j = await r.json();
    if (j.code !== "Ok") throw new Error(j.code);
    const res = { km: j.distances.map(f => f.map(v => v / 1000)), min: j.durations.map(f => f.map(v => v / 60)), fuente: "calles" };
    cacheM.set(clave, res); return res;
  } catch { return recta; }
}
export async function trazo(pts) {
  const clave = pts.map(p => p.lat.toFixed(5) + "," + p.lon.toFixed(5)).join(";");
  if (cacheT.has(clave)) return cacheT.get(clave);
  try {
    const r = await fetch(`${OSRM}/route/v1/driving/${pts.map(p => p.lon.toFixed(6) + "," + p.lat.toFixed(6)).join(";")}?overview=full&geometries=geojson`);
    const j = await r.json(); if (j.code !== "Ok") throw new Error(j.code);
    const res = j.routes[0].geometry.coordinates.map(([lo, la]) => [la, lo]); cacheT.set(clave, res); return res;
  } catch { return pts.map(p => [p.lat, p.lon]); }
}

// ---------- Leaflet (mapa) se carga la primera vez que se abre el módulo ----------
let cargaL = null;
export function cargarLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return cargaL ||= new Promise((ok, mal) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.appendChild(css);
    const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    s.onload = () => ok(window.L); s.onerror = () => { cargaL = null; mal(new Error("No se pudo cargar el mapa")); }; document.head.appendChild(s);
  });
}
