// Editor de flujogramas (módulo «Editor de flujogramas»): figuras estándar, conectores con flechas, textos y tiempos.
// Modelo: { nodos: [{ id, k, x, y, w, h, t, tm, c }], lineas: [{ id, a, b, t, pa, pb }] }
//   nodo: k = forma, (x, y) = centro, w × h = tamaño, t = texto, tm = tiempo (opcional), c = color de relleno
//   línea: va del nodo a al nodo b; t = etiqueta (Sí / No…); pa / pb = lado de salida y de llegada ("" = automático)
export const FORMAS = [
  ["term", "Inicio / fin"], ["proc", "Proceso"], ["dec", "Decisión"], ["datos", "Datos / registro"], ["doc", "Documento"],
  ["mdoc", "Varios documentos"], ["cil", "Base de datos"], ["demora", "Espera / demora"], ["manual", "Operación manual"],
  ["prep", "Preparación"], ["con", "Conector"], ["texto", "Texto libre"]];
export const COLORES = ["#FFFFFF", "#FFF3B0", "#ECE6F7", "#DCEBFF", "#E3F4EA", "#FFE3D3", "#FDE2E2", "#EEF1F5"];
const TAM = { term: [100, 40], proc: [120, 50], dec: [120, 70], datos: [130, 50], doc: [120, 54], mdoc: [120, 58], cil: [120, 56],
  demora: [120, 50], manual: [120, 50], prep: [120, 50], con: [40, 40], texto: [160, 40] };
const LADOS = { t: [0, -1], r: [1, 0], b: [0, 1], l: [-1, 0] };
const NS = "http://www.w3.org/2000/svg";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nid = () => Math.random().toString(36).slice(2, 9);
const sn = v => Math.round(v / 5) * 5;

// figura de un nodo (sin texto)
function figura(n, sel) {
  const { x, y, w, h } = n, x0 = x - w / 2, y0 = y - h / 2, f = n.c || (n.k === "texto" ? "none" : "#FFFFFF");
  const st = `fill="${f}" stroke="${sel ? "#1E6B5F" : n.k === "texto" ? "none" : "#5f6b7a"}" stroke-width="${sel ? 2.5 : 1.4}"`;
  switch (n.k) {
    case "term": return `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="${h / 2}" ${st}/>`;
    case "dec": return `<polygon points="${x},${y0} ${x0 + w},${y} ${x},${y0 + h} ${x0},${y}" ${st}/>`;
    case "datos": return `<polygon points="${x0 + 14},${y0} ${x0 + w},${y0} ${x0 + w - 14},${y0 + h} ${x0},${y0 + h}" ${st}/>`;
    case "doc": return `<path d="M${x0},${y0} H${x0 + w} V${y0 + h - 8} C${x0 + w * .75},${y0 + h - 20} ${x0 + w * .25},${y0 + h + 6} ${x0},${y0 + h - 8} Z" ${st}/>`;
    case "mdoc": return `<rect x="${x0 + 8}" y="${y0 - 8}" width="${w - 8}" height="${h - 8}" ${st}/><rect x="${x0 + 4}" y="${y0 - 4}" width="${w - 8}" height="${h - 8}" ${st}/>` +
      `<path d="M${x0},${y0} H${x0 + w - 8} V${y0 + h - 8} C${x0 + w * .7},${y0 + h - 20} ${x0 + w * .25},${y0 + h + 6} ${x0},${y0 + h - 8} Z" ${st}/>`;
    case "cil": return `<path d="M${x0},${y0 + 7} V${y0 + h - 7} A${w / 2},7 0 0 0 ${x0 + w},${y0 + h - 7} V${y0 + 7} A${w / 2},7 0 0 0 ${x0},${y0 + 7} Z" ${st}/><path d="M${x0},${y0 + 7} A${w / 2},7 0 0 0 ${x0 + w},${y0 + 7}" fill="none" stroke="${sel ? "#1E6B5F" : "#5f6b7a"}" stroke-width="1.4"/>`;
    case "demora": return `<path d="M${x0},${y0} H${x0 + w - h / 2} A${h / 2},${h / 2} 0 0 1 ${x0 + w - h / 2},${y0 + h} H${x0} Z" ${st}/>`;
    case "manual": return `<polygon points="${x0},${y0} ${x0 + w},${y0} ${x0 + w - 14},${y0 + h} ${x0 + 14},${y0 + h}" ${st}/>`;
    case "prep": return `<polygon points="${x0 + 14},${y0} ${x0 + w - 14},${y0} ${x0 + w},${y} ${x0 + w - 14},${y0 + h} ${x0 + 14},${y0 + h} ${x0},${y}" ${st}/>`;
    case "con": return `<circle cx="${x}" cy="${y}" r="${Math.min(w, h) / 2}" ${st}/>`;
    case "texto": return `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="transparent" stroke="${sel ? "#1E6B5F" : "none"}" stroke-dasharray="4 3"/>`;
    default: return `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="3" ${st}/>`;
  }
}
// texto partido en renglones según el ancho útil de la figura
function renglones(t, ancho) {
  const max = Math.max(4, Math.floor(ancho / 7)), out = [];
  for (const par of String(t || "").split("\n")) {
    let l = "";
    for (const w of par.split(" ")) { if ((l + " " + w).trim().length > max && l) { out.push(l); l = w; } else l = (l + " " + w).trim(); }
    out.push(l);
  }
  return out;
}
const utilDe = n => n.k === "dec" ? n.w * .6 : n.k === "datos" || n.k === "manual" || n.k === "prep" ? n.w - 30 : n.w - 12;
// alto mínimo para que el texto entre en la figura (las figuras crecen solas al escribir)
function ajustarAlto(n) {
  if (n.k === "con" || n.k === "texto") return n;
  // una palabra más larga que el ancho útil: la figura se ensancha
  const larga = Math.max(0, ...String(n.t || "").split(/\s+/).map(w => w.length)) * 7.3, util = utilDe(n);
  if (larga > util) n.w = Math.ceil((n.w + (larga - util) / (n.k === "dec" ? .6 : 1)) / 5) * 5;
  const ls = renglones(n.t, utilDe(n)).length, extra = n.k === "dec" ? 40 : n.k === "doc" || n.k === "mdoc" ? 24 : n.k === "cil" ? 22 : 14;
  n.h = Math.max(n.h, Math.ceil((ls * 14.5 + extra) / 5) * 5);
  return n;
}
function textoNodo(n) {
  const util = utilDe(n);
  const ls = renglones(n.t, util), lh = 14.5, y0 = n.y - (ls.length - 1) * lh / 2 + 4 - (n.k === "doc" || n.k === "mdoc" ? 4 : 0);
  let s = ls.map((l, i) => `<text x="${n.x}" y="${y0 + i * lh}" text-anchor="middle" class="fe-t">${esc(l)}</text>`).join("");
  if (n.tm) s += `<text x="${n.x}" y="${n.y + n.h / 2 + 13}" text-anchor="middle" class="fe-tm">⏱ ${esc(n.tm)}</text>`;
  return s;
}
// punto de un lado del nodo
const puerto = (n, l) => ({ t: [n.x, n.y - n.h / 2], r: [n.x + n.w / 2, n.y], b: [n.x, n.y + n.h / 2], l: [n.x - n.w / 2, n.y] }[l]);
function ladosAuto(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy) * 1.2) return dx >= 0 ? ["r", "l"] : ["l", "r"];
  return dy >= 0 ? ["b", "t"] : ["t", "b"];
}
// recorrido en ángulo recto entre dos nodos
function recorrido(a, b, pa, pb) {
  const [la, lb] = [pa || ladosAuto(a, b)[0], pb || ladosAuto(a, b)[1]];
  const p1 = puerto(a, la), p2 = puerto(b, lb), d1 = LADOS[la], d2 = LADOS[lb], o = 18;
  const s = [p1[0] + d1[0] * o, p1[1] + d1[1] * o], e = [p2[0] + d2[0] * o, p2[1] + d2[1] * o];
  const h1 = d1[0] !== 0, h2 = d2[0] !== 0; let mid;
  if (h1 && h2) { const mx = la === lb ? (la === "r" ? Math.max(s[0], e[0]) : Math.min(s[0], e[0])) : (s[0] + e[0]) / 2; mid = [[mx, s[1]], [mx, e[1]]]; }
  else if (!h1 && !h2) { const my = la === lb ? (la === "b" ? Math.max(s[1], e[1]) : Math.min(s[1], e[1])) : (s[1] + e[1]) / 2; mid = [[s[0], my], [e[0], my]]; }
  else if (h1) mid = [[e[0], s[1]]];
  else mid = [[s[0], e[1]]];
  // si salida y llegada están alineadas no hacen falta los quiebres
  const pts = [p1, s, ...mid, e, p2].filter((p, i, arr) => !i || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]);
  return pts;
}
function etiquetaEn(pts) {
  let best = 0, bi = 0;
  for (let i = 0; i < pts.length - 1; i++) { const d = Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1]); if (d > best) { best = d; bi = i; } }
  return [(pts[bi][0] + pts[bi + 1][0]) / 2, (pts[bi][1] + pts[bi + 1][1]) / 2];
}

// SVG completo (para mostrar, exportar o imprimir)
export function svgDe(D, sel = {}, marco = null) {
  const byId = new Map(D.nodos.map(n => [n.id, n]));
  let lin = "";
  for (const l of D.lineas) {
    const a = byId.get(l.a), b = byId.get(l.b); if (!a || !b) continue;
    const pts = recorrido(a, b, l.pa, l.pb), s = sel.l === l.id;
    lin += `<g data-fel="${l.id}" class="fe-lin"><polyline points="${pts.map(p => p.join(",")).join(" ")}" fill="none" stroke="transparent" stroke-width="12"/>` +
      `<polyline points="${pts.map(p => p.join(",")).join(" ")}" fill="none" stroke="${s ? "#1E6B5F" : "#3c4654"}" stroke-width="${s ? 2.4 : 1.4}" marker-end="url(#fePunta${s ? "S" : ""})"/>`;
    if (l.t) { const [mx, my] = etiquetaEn(pts); lin += `<rect x="${mx - l.t.length * 3.4 - 4}" y="${my - 9}" width="${l.t.length * 6.8 + 8}" height="16" rx="3" fill="#fff"/><text x="${mx}" y="${my + 3}" text-anchor="middle" class="fe-lt">${esc(l.t)}</text>`; }
    lin += "</g>";
  }
  let nod = "";
  for (const n of D.nodos) {
    const s = sel.n === n.id || sel.a === n.id;
    nod += `<g data-fen="${n.id}" class="fe-nod">${figura(n, s)}${textoNodo(n)}` +
      (sel.n === n.id ? `<rect data-feres="${n.id}" x="${n.x + n.w / 2 - 5}" y="${n.y + n.h / 2 - 5}" width="10" height="10" fill="#1E6B5F" class="fe-res"/>` : "") + "</g>";
  }
  const vb = marco || limites(D);
  return `<svg xmlns="${NS}" viewBox="${vb.join(" ")}" class="fe-svg"><defs>
    <marker id="fePunta" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#3c4654"/></marker>
    <marker id="fePuntaS" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1E6B5F"/></marker>
    <style>.fe-t{font:600 12.5px system-ui,Segoe UI,Arial,sans-serif;fill:#1d2939}.fe-tm{font:600 11px system-ui,Arial,sans-serif;fill:#B7791F}.fe-lt{font:700 12px system-ui,Arial,sans-serif;fill:#3c4654}</style></defs>${lin}${nod}</svg>`;
}
export function limites(D) {
  if (!D.nodos.length) return [0, 0, 1200, 700];
  const xs = D.nodos.flatMap(n => [n.x - n.w / 2, n.x + n.w / 2]), ys = D.nodos.flatMap(n => [n.y - n.h / 2 - 10, n.y + n.h / 2 + 20]);
  const x0 = Math.min(...xs) - 40, y0 = Math.min(...ys) - 40;
  return [x0, y0, Math.max(...xs) - x0 + 40, Math.max(...ys) - y0 + 40];
}

// ---------------- editor interactivo ----------------
export function crearEditor(caja, { alCambiar } = {}) {
  let D = { nodos: [], lineas: [] }, sel = {}, modo = "sel", vista = [0, 0, 1400, 800], historia = [], fut = [];
  caja.innerHTML = `<div class="fe-lienzo" tabindex="0"></div>`;
  const lienzo = caja.querySelector(".fe-lienzo");
  const cambio = () => alCambiar?.(D, sel);
  const guardarHist = () => { historia.push(JSON.stringify(D)); if (historia.length > 80) historia.shift(); fut = []; };
  function pintar() { lienzo.innerHTML = svgDe(D, sel, vista); lienzo.classList.toggle("conectando", modo === "con"); }
  const nodo = id => D.nodos.find(n => n.id === id);
  // coordenadas del puntero dentro del dibujo
  const pt = e => { const r = lienzo.getBoundingClientRect(); return [vista[0] + (e.clientX - r.left) / r.width * vista[2], vista[1] + (e.clientY - r.top) / r.height * vista[3]]; };
  let arr = null;
  lienzo.addEventListener("pointerdown", e => {
    const [x, y] = pt(e), res = e.target.closest("[data-feres]"), gN = e.target.closest("[data-fen]"), gL = e.target.closest("[data-fel]");
    lienzo.focus();
    if (res) { const n = nodo(res.dataset.feres); guardarHist(); arr = { tipo: "res", n, x, y, w: n.w, h: n.h }; }
    else if (gN) {
      const n = nodo(gN.dataset.fen);
      if (modo === "con") {
        if (!sel.a) { sel = { a: n.id }; pintar(); cambio(); return; }
        if (sel.a !== n.id) { guardarHist(); const l = { id: nid(), a: sel.a, b: n.id, t: "", pa: "", pb: "" }; D.lineas.push(l); sel = { l: l.id }; modo = "sel"; pintar(); cambio(); }
        return;
      }
      sel = { n: n.id }; guardarHist(); arr = { tipo: "mov", n, dx: x - n.x, dy: y - n.y, movio: false };
    } else if (gL) { sel = { l: gL.dataset.fel }; }
    else { if (modo === "con") { modo = "sel"; } sel = {}; arr = { tipo: "pan", cx: e.clientX, cy: e.clientY, v: [...vista] }; }
    lienzo.setPointerCapture(e.pointerId); pintar(); cambio();
  });
  lienzo.addEventListener("pointermove", e => {
    if (!arr) return;
    if (arr.tipo === "pan") { const r = lienzo.getBoundingClientRect(); vista[0] = arr.v[0] - (e.clientX - arr.cx) / r.width * vista[2]; vista[1] = arr.v[1] - (e.clientY - arr.cy) / r.height * vista[3]; pintar(); return; }
    const [x, y] = pt(e);
    if (arr.tipo === "mov") { arr.n.x = sn(x - arr.dx); arr.n.y = sn(y - arr.dy); arr.movio = true; }
    else if (arr.tipo === "res") { arr.n.w = Math.max(30, sn(arr.w + (x - arr.x) * 2)); arr.n.h = Math.max(24, sn(arr.h + (y - arr.y) * 2)); }
    pintar();
  });
  const soltar = () => { if (arr && arr.tipo === "mov" && !arr.movio) historia.pop(); if (arr && arr.tipo !== "pan") cambio(); arr = null; };
  lienzo.addEventListener("pointerup", soltar); lienzo.addEventListener("pointercancel", soltar);
  lienzo.addEventListener("wheel", e => {
    e.preventDefault(); const [x, y] = pt(e), f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    vista = [x - (x - vista[0]) * f, y - (y - vista[1]) * f, vista[2] * f, vista[3] * f]; pintar();
  }, { passive: false });
  lienzo.addEventListener("dblclick", e => { if (e.target.closest("[data-fen],[data-fel]")) caja.dispatchEvent(new CustomEvent("fe-editar")); });
  lienzo.addEventListener("keydown", e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if ((e.key === "Delete" || e.key === "Backspace") && (sel.n || sel.l)) { e.preventDefault(); api.borrar(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? api.rehacer() : api.deshacer(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && sel.n) { e.preventDefault(); api.duplicar(); }
    else if (sel.n && e.key.startsWith("Arrow")) {
      e.preventDefault(); const n = nodo(sel.n), p = e.shiftKey ? 20 : 5; guardarHist();
      if (e.key === "ArrowLeft") n.x -= p; if (e.key === "ArrowRight") n.x += p; if (e.key === "ArrowUp") n.y -= p; if (e.key === "ArrowDown") n.y += p;
      pintar(); cambio();
    } else if (e.key === "Escape") { modo = "sel"; sel = {}; pintar(); cambio(); }
  });
  const api = {
    cargar(d) { D = { nodos: (d?.nodos || []).map(n => ajustarAlto({ ...n })), lineas: (d?.lineas || []).map(l => ({ ...l })) }; sel = {}; historia = []; fut = []; api.real(); },
    datos: () => JSON.parse(JSON.stringify(D)),
    sel: () => sel,
    nodoSel: () => sel.n ? nodo(sel.n) : null,
    lineaSel: () => sel.l ? D.lineas.find(l => l.id === sel.l) : null,
    agregar(k) {
      guardarHist(); const [w, h] = TAM[k] || [120, 50];
      const n = { id: nid(), k, x: sn(vista[0] + vista[2] / 2), y: sn(vista[1] + vista[3] / 2), w, h, t: k === "term" ? "Inicio" : k === "dec" ? "¿…?" : k === "con" ? "A" : "Texto", tm: "", c: "" };
      // si hay uno elegido, el nuevo se pone a su derecha y se conecta
      const prev = sel.n && nodo(sel.n);
      if (prev) { n.x = sn(prev.x + prev.w / 2 + 50 + w / 2); n.y = prev.y; D.lineas.push({ id: nid(), a: prev.id, b: n.id, t: "", pa: "", pb: "" }); }
      D.nodos.push(n); sel = { n: n.id }; pintar(); cambio(); return n;
    },
    conectar() { modo = modo === "con" ? "sel" : "con"; sel = modo === "con" && sel.n ? { a: sel.n } : {}; pintar(); cambio(); return modo === "con"; },
    modo: () => modo,
    cambiar(campos) {
      guardarHist(); const o = sel.n ? nodo(sel.n) : sel.l ? D.lineas.find(l => l.id === sel.l) : null; if (!o) return;
      Object.assign(o, campos); if (sel.n && ("t" in campos || "w" in campos || "k" in campos)) ajustarAlto(o); pintar(); cambio();
    },
    borrar() {
      if (!sel.n && !sel.l) return; guardarHist();
      if (sel.n) { D.nodos = D.nodos.filter(n => n.id !== sel.n); D.lineas = D.lineas.filter(l => l.a !== sel.n && l.b !== sel.n); }
      else D.lineas = D.lineas.filter(l => l.id !== sel.l);
      sel = {}; pintar(); cambio();
    },
    duplicar() { const n = nodo(sel.n); if (!n) return; guardarHist(); const c = { ...n, id: nid(), x: n.x + 30, y: n.y + 30 }; D.nodos.push(c); sel = { n: c.id }; pintar(); cambio(); },
    invertir() { const l = api.lineaSel(); if (!l) return; guardarHist(); [l.a, l.b] = [l.b, l.a]; [l.pa, l.pb] = [l.pb, l.pa]; pintar(); cambio(); },
    deshacer() { if (!historia.length) return; fut.push(JSON.stringify(D)); D = JSON.parse(historia.pop()); sel = {}; pintar(); cambio(); },
    rehacer() { if (!fut.length) return; historia.push(JSON.stringify(D)); D = JSON.parse(fut.pop()); sel = {}; pintar(); cambio(); },
    zoom(f) { const cx = vista[0] + vista[2] / 2, cy = vista[1] + vista[3] / 2; vista = [cx - vista[2] * f / 2, cy - vista[3] * f / 2, vista[2] * f, vista[3] * f]; pintar(); },
    ajustar() {
      const b = limites(D), r = lienzo.getBoundingClientRect(), asp = (r.width || 1200) / (r.height || 700);
      let [x, y, w, h] = b; if (w / h > asp) { const nh = w / asp; y -= (nh - h) / 2; h = nh; } else { const nw = h * asp; x -= (nw - w) / 2; w = nw; }
      vista = [x, y, w, h]; pintar();
    },
    // tamaño real (100 %): cada punto del dibujo es un píxel; se empieza por la esquina de arriba a la izquierda
    real() {
      const b = limites(D), r = lienzo.getBoundingClientRect();
      vista = [b[0], b[1], r.width || 1200, r.height || 700]; pintar();
    },
    escala: () => { const r = lienzo.getBoundingClientRect(); return r.width ? r.width / vista[2] : 1; },
    svg: () => svgDe(D),
    pintar
  };
  let ancho0 = 0, alto0 = 0;
  new ResizeObserver(() => {
    const r = lienzo.getBoundingClientRect();
    if (ancho0 && r.width && r.height) { vista[2] *= r.width / ancho0; vista[3] *= r.height / alto0; }
    ancho0 = r.width; alto0 = r.height; pintar();
  }).observe(lienzo);
  return api;
}

// ---------------- flujograma inicial (el que se venía armando en SmartDraw) ----------------
export function ejemploAbastecimiento() {
  const N = [], L = [], S = 1.45;
  const n = (id, k, x, y, t, w, h) => N.push({ id, k, x: Math.round(x * S), y: Math.round(y * S), w: w || TAM[k][0], h: h || TAM[k][1], t, tm: "", c: "" });
  const l = (a, b, t = "", pa = "", pb = "") => L.push({ id: nid(), a, b, t, pa, pb });
  // fila 1: compras
  n("ini", "term", 205, 50, "Inicio", 80, 36);
  n("nota", "texto", 290, 20, "Filtrado de movimientos de SKU en un periodo", 170, 30);
  n("filt", "proc", 290, 50, "Filtrado", 90, 40);
  n("sol", "doc", 380, 50, "Envío de Solicitud de Cotización", 110, 50);
  n("prop", "doc", 465, 50, "Recepción de propuesta", 100, 48);
  n("eva", "proc", 545, 50, "Evaluación. Vencimiento, lotes, fechas, precio.", 120, 54);
  n("conf", "dec", 640, 50, "¿Se confirma?", 110, 64);
  n("aprob", "doc", 755, 50, "Aprobación por Correo", 110, 48);
  n("esp", "demora", 870, 50, "Espera de llegada de los pedidos", 120, 50);
  l("ini", "filt"); l("filt", "sol"); l("sol", "prop"); l("prop", "eva"); l("eva", "conf"); l("conf", "aprob", "Sí"); l("aprob", "esp");
  l("conf", "sol", "No", "b", "b");
  // fila 2: recepción y revisión (de derecha a izquierda)
  n("rec", "proc", 880, 145, "Recepción de Mercadería, entrega de cargo", 130, 54);
  n("reg", "datos", 770, 145, "Registro de llegada al sistema", 130, 48);
  n("espr", "proc", 680, 145, "Espera a ser revisado", 100, 44);
  n("ver", "datos", 580, 145, "Verificación pedido vs factura", 130, 48);
  n("obs", "dec", 478, 145, "¿Hay observaciones?", 120, 70);
  n("rego", "datos", 365, 145, "Registro de observados al sistema", 140, 48);
  n("tras", "proc", 252, 145, "Traslado de productos a cuarentena", 120, 50);
  n("cuar", "doc", 160, 145, "Productos en cuarentena", 100, 48);
  l("esp", "rec", "", "b", "t"); l("rec", "reg"); l("reg", "espr"); l("espr", "ver"); l("ver", "obs"); l("obs", "rego", "Sí"); l("rego", "tras"); l("tras", "cuar");
  l("obs", "tras", "No", "b", "b");
  // fila 3: ingreso al sistema
  n("fact", "mdoc", 175, 222, "Envío de facturas a compras", 110, 54);
  n("revoc", "proc", 285, 218, "Revisión OC vs Factura", 100, 44);
  n("coin", "dec", 375, 218, "¿Coincide con lo solicitado?", 120, 70);
  n("rego2", "datos", 490, 218, "Registro de observados al sistema", 140, 48);
  n("gen", "proc", 598, 218, "Generar secuencia de ingreso", 110, 48);
  n("jal", "proc", 690, 218, "Jalar secuencia", 100, 40);
  n("ing", "cil", 783, 218, "Ingreso lotes, FV y Precios", 110, 56);
  n("vfin", "proc", 880, 218, "Verificación Final", 100, 40);
  n("exi", "dec", 993, 218, "¿Existe alguna observación?", 130, 70);
  n("regf", "datos", 1125, 218, "Registro de observados finales al sistema", 150, 50);
  l("cuar", "fact", "", "b", "l"); l("fact", "revoc"); l("revoc", "coin"); l("coin", "rego2", "Sí"); l("rego2", "gen"); l("coin", "gen", "No", "b", "b");
  l("gen", "jal"); l("jal", "ing"); l("ing", "vfin"); l("vfin", "exi"); l("exi", "regf", "Sí");
  // fila 4: almacenaje y observados
  n("alm", "proc", 882, 278, "Almacenar productos", 110, 44);
  n("desab", "doc", 762, 278, "Evaluación de desabastecimiento", 120, 50);
  n("sepa", "manual", 1130, 285, "Separa productos reportados", 130, 48);
  n("reco", "demora", 1130, 348, "Productos en espera de ser recogidos", 140, 52);
  l("exi", "alm", "No", "b", "r"); l("alm", "desab"); l("regf", "sepa"); l("sepa", "reco");
  // figuras sueltas por ubicar (distribución, picking, venta…)
  const sueltas = [["proc", 85, 278, "Carga de mercadería"], ["proc", 172, 278, "Packing"], ["proc", 262, 278, "Picking"], ["proc", 345, 278, "Filtrado"],
    ["datos", 465, 278, "Ingreso de requerimiento al Lolfar"], ["doc", 568, 280, "Preparar la lista de atención según cronograma"],
    ["proc", 85, 325, "Traslado a sucursal"], ["proc", 172, 325, "Entrega a sucursal"], ["manual", 262, 325, "Verificación de enviado vs recibido"],
    ["dec", 365, 330, "¿Es conforme?"], ["proc", 472, 325, "Almacenar productos"], ["proc", 568, 325, "Venta"], ["term", 662, 325, "Fin"],
    ["proc", 363, 385, "Evaluación de faltantes"], ["proc", 265, 445, "Se reporta a compras"], ["dec", 365, 448, "¿Es desabastecimiento?"], ["dec", 470, 448, "¿Es error de picking?"]];
  sueltas.forEach(([k, x, y, t], i) => n("s" + i, k, x, y + 40, t));
  return { nodos: N, lineas: L };
}
