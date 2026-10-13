import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, onSnapshot, query, where,
  serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { firebaseConfig, DOMINIO, FARMACIAS, MOTIVOS_BLOQUEO, MOTIVOS_REACTIVACION } from "./config.js?v=202610132300";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ===================== utilidades ===================== */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hoyISO = () => new Date().toISOString().slice(0, 10);
const aFecha = v => v?.toDate ? v.toDate() : (typeof v === "string" && v ? new Date(v + "T12:00:00") : null);
const fmtF = v => { const d = aFecha(v); return d ? d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "–"; };
const fmtFH = v => { const d = aFecha(v); return d ? d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) + "<br>" + d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) : "ahora"; };
const nombreFarm = f => "Sucursal " + String(f || "").replace(/^ALMACEN /, "").toLowerCase().replace(/(^|[\s.])\p{L}/gu, c => c.toUpperCase());
const corto = f => f === "TODAS" ? "Todas las farmacias" : f.replace(/^ALMACEN /, "");
// Productos fuera del catálogo sin código: se guardan con una clave "SC-NOMBRE".
const SIN_COD = "SC-";
const codVis = c => String(c || "").startsWith(SIN_COD) ? "Sin código" : c;
const claveManual = p => {
  const c = p.c.trim().replace(/[\/\s]+/g, "");
  return c || SIN_COD + norm(p.n).replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
};
const claseMotivo = m => (MOTIVOS_BLOQUEO.find(x => x.texto === m)?.clase) || "m-otro";
const tagMotivo = (m, extra = "") => `<span class="tag ${claseMotivo(m)}">${esc(m)}${extra}</span>`;
const norm = s => String(s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 3000); }
function msg(id, texto, error) { const el = $(id); el.hidden = !texto; el.textContent = texto || ""; el.className = "msg" + (error ? " error" : ""); }
function textoError(e) {
  if (e?.code === "permission-denied") return "Firebase rechazó la acción (sin permiso). Revisa que las reglas de firestore.rules estén publicadas y que tu usuario en la colección «usuarios» tenga el rol y la farmacia correctos.";
  if (e?.code === "unavailable") return "Sin conexión. Revisa tu internet e inténtalo de nuevo.";
  return "No se pudo guardar. " + (e?.message || "");
}

/* ===================== estado ===================== */
const S = {
  perfil: null, catalogo: [], catIdx: new Map(), bloqueos: new Map(), usuarios: [],
  subs: [], vista: null, origen: null, sel: {}, ficha: null,
  af: { farm: "", motivo: "", estado: "bloqueado", q: "" }
};
const esAdmin = () => S.perfil?.rol === "admin";
const miFarm = () => S.perfil?.farmacia;

/* ===================== catálogo ===================== */
async function cargarCatalogo() {
  if (S.catalogo.length) return;
  try {
    const r = await fetch("catalogo.json", { cache: "no-cache" });
    if (!r.ok) throw new Error();
    S.catalogo = (await r.json()).map(p => ({ c: String(p.c), n: String(p.n), l: String(p.l || ""), ln: String(p.ln || ""), k: norm([p.c, p.n, p.l, p.ln].join(" ")) }));
    S.catIdx = new Map(S.catalogo.map(p => [p.c, p]));
  } catch {
    const a = $("avisoGlobal"); a.hidden = false;
    a.textContent = "No se encontró el catálogo de productos (catalogo.json). Súbelo al repositorio junto con la página.";
  }
}
function buscarCat(texto) {
  const q = norm(texto).trim(); if (!q) return [];
  const exacto = S.catIdx.get(texto.trim());
  const palabras = q.split(/\s+/);
  const r = S.catalogo.filter(p => palabras.every(w => p.k.includes(w))).slice(0, 12);
  return exacto ? [exacto, ...r.filter(p => p !== exacto)] : r;
}

/* ===================== ingreso ===================== */
$("fLogin").addEventListener("submit", async e => {
  e.preventDefault();
  const u = $("lUser").value.trim().toLowerCase();
  const email = u.includes("@") ? u : `${u}@${DOMINIO}`;
  $("lBtn").disabled = true; $("lErr").hidden = true;
  try { await signInWithEmailAndPassword(auth, email, $("lPass").value); }
  catch { $("lErr").textContent = "Usuario o contraseña incorrectos."; $("lErr").hidden = false; }
  finally { $("lBtn").disabled = false; }
});
$("salir").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async user => {
  S.subs.forEach(u => u()); S.subs = []; S.bloqueos = new Map(); S.perfil = null; $("avisoGlobal").hidden = true;
  if (!user) { mostrar("vLogin"); $("top").hidden = true; return; }
  try {
    const snap = await getDoc(doc(db, "usuarios", user.uid));
    if (!snap.exists() || [false, "false"].includes(snap.data().activo)) {
      await signOut(auth);
      $("lErr").textContent = "Tu usuario no está habilitado. Consulta con Abastecimiento."; $("lErr").hidden = false;
      return;
    }
    const datos = snap.data();
    S.perfil = { uid: user.uid, ...datos, rol: String(datos.rol || "").trim().toLowerCase() };
  } catch (e) {
    await signOut(auth);
    $("lErr").textContent = textoError(e); $("lErr").hidden = false;
    return;
  }
  await cargarCatalogo();
  iniciar();
  revisarPerfil();
});

// Si el perfil se creó a mano con algún dato mal escrito, Firebase rechazará lo que se guarde: avisarlo claro.
function revisarPerfil() {
  const p = S.perfil, prob = [];
  if (!["admin", "quimico"].includes(p.rol)) prob.push(`el campo «rol» debe ser admin o quimico (ahora dice "${p.rol}")`);
  if (p.activo !== undefined && p.activo !== true && p.activo !== "true") prob.push(`el campo «activo» debe ser boolean true`);
  if (p.rol === "quimico" && !FARMACIAS.includes(p.farmacia)) prob.push(`el campo «farmacia» ("${p.farmacia || ""}") no coincide con ninguna farmacia de config.js`);
  if (prob.length) avisar({ message: "Tu usuario está mal configurado en Firebase (colección usuarios): " + prob.join("; ") + "." });
}

/* ===================== arranque por rol ===================== */
function iniciar() {
  $("top").hidden = false;
  $("uNombre").textContent = S.perfil.nombre || S.perfil.usuario;
  $("uRol").textContent = esAdmin() ? "Abastecimiento" : nombreFarm(S.perfil.farmacia);
  montarMotivos("bqMot", "bqMotivo"); montarMotivos("abMot", "abMotivo");

  if (esAdmin()) {
    $("abFarm").innerHTML = `<option value="TODAS">Todas las farmacias</option>` + FARMACIAS.map(f => `<option>${esc(f)}</option>`).join("");
    $("uFarm").innerHTML = FARMACIAS.map(f => `<option>${esc(f)}</option>`).join("");
    $("aMot").innerHTML = `<option value="">Todos</option>` + MOTIVOS_BLOQUEO.map(m => `<option>${esc(m.texto)}</option>`).join("");
    S.subs.push(onSnapshot(collection(db, "bloqueos"), snap => {
      S.bloqueos = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
      render();
    }, e => avisar(e)));
    S.subs.push(onSnapshot(collection(db, "usuarios"), snap => {
      S.usuarios = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      if (S.vista === "vUsuarios") pintarUsuarios();
    }, e => avisar(e)));
    ir("vAdmin");
  } else {
    $("qFarm").textContent = nombreFarm(miFarm());
    const mapas = { propia: new Map(), todas: new Map() };
    const escuchar = (farm, k) => onSnapshot(query(collection(db, "bloqueos"), where("farmacia", "==", farm)), snap => {
      mapas[k] = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
      S.bloqueos = new Map([...mapas.propia, ...mapas.todas]);
      render();
    }, e => avisar(e));
    S.subs.push(escuchar(miFarm(), "propia"), escuchar("TODAS", "todas"));
    ir("vQuimico");
  }
}
function avisar(e) { const a = $("avisoGlobal"); a.hidden = false; a.textContent = e?.code ? textoError(e) : e.message; }

function pintarNav() {
  const pend = [...S.bloqueos.values()].filter(d => d.estado === "bloqueado" && d.solicitud?.estado === "pendiente").length;
  const items = esAdmin()
    ? [["vAdmin", "Bloqueos" + (pend ? `<span class="badge">${pend}</span>` : "")], ["vUsuarios", "Usuarios"]]
    : [];   // el químico tiene una sola vista: no hace falta menú
  const actual = S.vista === "vFicha" ? S.origen : S.vista;
  $("nav").innerHTML = items.map(([v, t]) => `<button type="button" data-ir="${v}" ${v === actual ? 'aria-current="page"' : ""}>${t}</button>`).join("");
}
$("nav").addEventListener("click", e => { const b = e.target.closest("[data-ir]"); if (b) ir(b.dataset.ir); });

function mostrar(id) { ["vLogin", "vQuimico", "vAdmin", "vUsuarios", "vFicha"].forEach(v => $(v).hidden = v !== id); }
function ir(vista) { S.vista = vista; mostrar(vista); render(); scrollTo({ top: 0 }); }
function render() {
  if (!S.perfil) return;
  pintarNav();
  if (S.vista === "vQuimico") pintarQuimico();
  else if (S.vista === "vAdmin") pintarAdmin();
  else if (S.vista === "vUsuarios") pintarUsuarios();
  else if (S.vista === "vFicha") pintarFicha();
  pintarSel("bq"); pintarSel("ab");
}

/* ===================== formulario de bloqueo (químico y admin) ===================== */
function montarMotivos(contId, nombre) {
  $(contId).innerHTML = MOTIVOS_BLOQUEO.map(m => `<label class="${esc(m.clase)}"><input type="radio" name="${nombre}" value="${esc(m.texto)}">${esc(m.texto)}</label>`).join("");
}
function farmDeForm(pre) { return pre === "bq" ? miFarm() : $("abFarm").value; }
function estadoEn(cod, farm) {
  const todas = S.bloqueos.get(`TODAS__${cod}`);
  if (todas?.estado === "bloqueado") return todas;
  const propio = farm === "TODAS" ? null : S.bloqueos.get(`${farm}__${cod}`);
  return propio?.estado === "bloqueado" ? propio : null;
}
// Clave y datos finales del producto elegido (del catálogo o escrito a mano).
function prodFinal(p) {
  if (!p.manual) return p;
  const enCat = p.c.trim() && S.catIdx.get(p.c.trim());
  if (enCat) return enCat;
  const n = p.n.trim().replace(/\s+/g, " ");
  return { c: claveManual(p), n: n ? n.toUpperCase() : `PRODUCTO CÓDIGO ${p.c.trim()}`, l: "", manual: true };
}
function pintarSel(pre) {
  const p = S.sel[pre], box = $(pre + "Sel"), btn = $(pre + "Btn");
  if (!box) return;
  if (!p) { box.hidden = true; box.innerHTML = ""; btn.disabled = true; return; }
  box.hidden = false;
  const farm = farmDeForm(pre);
  btn.textContent = pre === "bq" ? "Bloquear en mi farmacia" : (farm === "TODAS" ? "Bloquear en todas las farmacias" : `Bloquear en ${corto(farm)}`);
  if (p.manual) {
    // El formulario se arma una sola vez para no perder lo que se está escribiendo.
    if (!box.querySelector(".manual")) {
      box.innerHTML = `<span class="cod">Producto que no está en la lista</span>
        <div class="manual">
          <input data-m="c" placeholder="Código (si lo tienes)" value="${esc(p.c)}" autocomplete="off">
          <input data-m="n" placeholder="Nombre del producto" value="${esc(p.n)}" autocomplete="off">
        </div>
        <span class="est"></span>
        <button class="enlace" type="button" data-quitar>Quitar</button>`;
      box.querySelector(p.c ? '[data-m="n"]' : '[data-m="c"]').focus();
    }
    const listo = p.c.trim() || p.n.trim().length >= 3;
    const f = listo ? prodFinal(p) : null, b = f && estadoEn(f.c, farm);
    const est = box.querySelector(".est");
    est.className = "est " + (b ? "mal" : listo ? "ok" : "muted");
    est.textContent = !listo ? "Escribe el código o el nombre (al menos uno)."
      : b ? `Ya está bloqueado${b.farmacia === "TODAS" ? " en todas las farmacias" : ""}: ${b.motivo}`
      : !f.manual ? `Ese código sí está en la lista: ${f.n}`
      : `Se registrará como: ${codVis(f.c) === "Sin código" ? "sin código" : f.c} · ${f.n}`;
    btn.disabled = !listo || !!b;
    return;
  }
  const b = estadoEn(p.c, farm);
  box.innerHTML = `<span class="cod">${esc(p.c)}${p.l ? " · Lab. " + esc(p.l) : ""}</span><b>${esc(p.n)}</b>` +
    (b ? `<span class="est mal">Ya está bloqueado${b.farmacia === "TODAS" ? " en todas las farmacias" : ""}: ${esc(b.motivo)}</span>`
       : `<span class="est ok">Se abastece a ${esc(corto(farm))}</span>`);
  btn.disabled = !!b;
}
function cablearBuscador(pre) {
  const inp = $(pre + "Bus"), res = $(pre + "Res");
  inp.addEventListener("input", () => {
    const r = buscarCat(inp.value);
    res.hidden = !inp.value.trim();
    res.innerHTML = (r.length
      ? r.map(p => `<button type="button" data-c="${esc(p.c)}"><code>${esc(p.c)}</code><span>${esc(p.n)}</span><small>${esc(p.l)}</small></button>`).join("")
      : `<div class="vacio">Ningún producto coincide.</div>`) +
      `<button type="button" class="agregar" data-manual>+ Agregar producto que no está en la lista</button>`;
  });
  inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); res.querySelector("button")?.click(); } if (e.key === "Escape") res.hidden = true; });
  res.addEventListener("click", e => {
    if (e.target.closest("[data-manual]")) {
      const t = inp.value.trim(), esCod = /^\d+$/.test(t);
      S.sel[pre] = { manual: true, c: esCod ? t : "", n: esCod ? "" : t };
      inp.value = ""; res.hidden = true; msg(pre + "Msg", ""); $(pre + "Sel").innerHTML = "";
      return pintarSel(pre);
    }
    const b = e.target.closest("[data-c]"); if (!b) return;
    S.sel[pre] = S.catIdx.get(b.dataset.c); inp.value = ""; res.hidden = true; msg(pre + "Msg", "");
    pintarSel(pre);
  });
}
cablearBuscador("bq"); cablearBuscador("ab");
["bq", "ab"].forEach(pre => {
  $(pre + "Sel").addEventListener("input", e => {
    const campo = e.target.dataset?.m, p = S.sel[pre]; if (!campo || !p?.manual) return;
    p[campo] = e.target.value; pintarSel(pre);
  });
  $(pre + "Sel").addEventListener("click", e => { if (e.target.closest("[data-quitar]")) { S.sel[pre] = null; pintarSel(pre); } });
});
$("abFarm").addEventListener("change", () => pintarSel("ab"));

async function enviarBloqueo(e) {
  e.preventDefault();
  const pre = e.currentTarget.dataset.pre, elegido = S.sel[pre], farm = farmDeForm(pre);
  const motivo = document.querySelector(`input[name="${pre}Motivo"]:checked`)?.value;
  if (!elegido) return msg(pre + "Msg", "Elige un producto.", true);
  if (elegido.manual && !elegido.c.trim() && elegido.n.trim().length < 3) return msg(pre + "Msg", "Escribe el código o el nombre del producto.", true);
  const p = prodFinal(elegido), extra = p.manual ? { fueraCatalogo: true } : {};
  if (!motivo) return msg(pre + "Msg", "Elige el motivo del bloqueo.", true);
  if (estadoEn(p.c, farm)) return msg(pre + "Msg", "Ese producto ya está bloqueado.", true);
  const comentario = $(pre + "Com").value.trim(), revisar = $(pre + "Rev")?.value || null;
  const ahora = serverTimestamp(), quien = { porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario };
  const lote = writeBatch(db);
  lote.set(doc(db, "bloqueos", `${farm}__${p.c}`), {
    farmacia: farm, codpro: p.c, producto: p.n, laboratorio: p.l || "", estado: "bloqueado",
    alcance: farm === "TODAS" ? "todas" : "farmacia",
    motivo, comentario, revisar, desde: ahora, solicitud: null, ...extra, ...quien
  });
  lote.set(doc(collection(db, "historial")), {
    farmacia: farm, codpro: p.c, producto: p.n, laboratorio: p.l || "", tipo: "bloqueo", motivo, comentario, fecha: ahora, ...extra, ...quien
  });
  $(pre + "Btn").disabled = true;
  try {
    await lote.commit();
    toast(`${p.n} bloqueado en ${corto(farm)}`);
    S.sel[pre] = null; $(pre + "Com").value = ""; if ($(pre + "Rev")) $(pre + "Rev").value = "";
    document.querySelectorAll(`input[name="${pre}Motivo"]`).forEach(r => r.checked = false);
    msg(pre + "Msg", ""); pintarSel(pre);
  } catch (err) { msg(pre + "Msg", textoError(err), true); pintarSel(pre); }
}
$("bqForm").addEventListener("submit", enviarBloqueo);
$("abForm").addEventListener("submit", enviarBloqueo);

/* ===================== vista químico ===================== */
$("qFil").addEventListener("input", () => pintarQuimico());
function etiquetaSolicitud(d) {
  const s = d.solicitud; if (!s) return "";
  if (s.estado === "pendiente") return `<span class="tag t-pend">Reactivación pedida</span>`;
  if (s.estado === "rechazada") return `<span class="tag t-rech">Reactivación rechazada</span>`;
  return "";
}
function pintarQuimico() {
  const q = norm($("qFil").value).trim();
  const activos = [...S.bloqueos.values()].filter(d => d.estado === "bloqueado" && d.farmacia === miFarm());
  const lista = activos
    .filter(d => !q || q.split(/\s+/).every(w => norm(d.codpro + " " + d.producto + " " + (d.laboratorio || "")).includes(w)))
    .sort((a, b) => (aFecha(b.desde) || 0) - (aFecha(a.desde) || 0));
  $("qCount").textContent = activos.length;
  $("qK1").textContent = activos.length;
  $("qK2").textContent = activos.filter(d => d.solicitud?.estado === "pendiente").length;
  $("qK3").textContent = activos.filter(d => d.solicitud?.estado === "rechazada").length;
  const estado = d => d.solicitud?.estado === "pendiente" ? `<span class="tag t-pend">Reactivación pedida</span>`
    : d.solicitud?.estado === "rechazada" ? `<span class="tag t-rech">Reactivación rechazada</span>`
    : `<span class="tag t-bloq">Bloqueado</span>`;
  const accion = d => d.farmacia === "TODAS" ? "Ver" : d.solicitud?.estado === "pendiente" ? "Ver solicitud"
    : d.solicitud?.estado === "rechazada" ? "Volver a pedir" : "Pedir reactivación";
  $("qTabla").innerHTML = `<thead><tr><th>Producto</th><th>Motivo</th><th>Desde</th><th>Estado</th><th class="der">Acción</th></tr></thead><tbody>` +
    (lista.length ? lista.map(d => `<tr>
      <td class="p"><b>${esc(codVis(d.codpro))} - ${esc(d.producto)}</b><code>${d.laboratorio ? esc(d.laboratorio) + " · " : ""}por ${esc(d.porNombre)}</code></td>
      <td>${tagMotivo(d.motivo)}</td>
      <td class="f">${fmtF(d.desde)}</td>
      <td>${estado(d)}</td>
      <td class="der"><button class="btn sm" type="button" data-ficha="${esc(d.id)}">${accion(d)}</button></td>
    </tr>`).join("") : `<tr class="vacia"><td colspan="5">${q ? "Ningún bloqueo coincide con la búsqueda." : "No hay productos bloqueados en tu farmacia."}</td></tr>`) + "</tbody>";
}
$("qTabla").addEventListener("click", e => { const b = e.target.closest("[data-ficha]"); if (b) abrirFicha(b.dataset.ficha); });

/* ===================== vista admin ===================== */
["aMot", "aEst", "aQ", "aLab"].forEach(id => $(id).addEventListener("input", () => { S.af.motivo = $("aMot").value; S.af.estado = $("aEst").value; S.af.q = $("aQ").value; S.af.lab = $("aLab").value; pintarAdmin(); }));
$("aChips").addEventListener("click", e => { const b = e.target.closest("[data-farm]"); if (b) { S.af.farm = b.dataset.farm; pintarAdmin(); } });

function pintarAdmin() {
  const todos = [...S.bloqueos.values()], act = todos.filter(d => d.estado === "bloqueado");
  const pend = act.filter(d => d.solicitud?.estado === "pendiente");
  const hoy = hoyISO(), hace30 = Date.now() - 30 * 864e5;
  $("k1").textContent = act.length; $("k1s").textContent = `en ${new Set(act.map(d => d.farmacia)).size} farmacias o todas`;
  $("k2").textContent = pend.length;
  $("k3").textContent = act.filter(d => d.revisar && d.revisar <= hoy).length;
  $("k4").textContent = todos.filter(d => d.estado === "activo" && (aFecha(d.reactivado?.fecha) || 0) >= hace30).length;

  // solicitudes
  $("aSol").innerHTML = pend.length ? pend.sort((a, b) => (aFecha(a.solicitud.fecha) || 0) - (aFecha(b.solicitud.fecha) || 0)).map(d => `
    <div class="sol" data-id="${esc(d.id)}">
      <div class="p"><b>${esc(d.producto)}</b><code>${esc(codVis(d.codpro))} · ${esc(corto(d.farmacia))}</code><div>${tagMotivo(d.motivo)} <span class="muted">desde ${fmtF(d.desde)}</span></div></div>
      <div><b>${esc(d.solicitud.motivo)}</b><div class="muted">${esc(d.solicitud.comentario || "Sin comentario")}</div><small class="muted">${esc(d.solicitud.porNombre)} · ${fmtF(d.solicitud.fecha)}</small></div>
      <div class="acc">
        <label class="filtro">Respuesta (opcional)<input type="text" data-resp placeholder="Comentario para el químico"></label>
        <div class="botones"><button class="btn sm verde" type="button" data-aprobar>Aprobar y reactivar</button><button class="btn sm" type="button" data-rechazar>Rechazar</button></div>
      </div>
    </div>`).join("") : `<div class="vacio-sol">No hay solicitudes pendientes.</div>`;

  // chips por farmacia
  const cuenta = f => act.filter(d => d.farmacia === f).length;
  $("aChips").innerHTML = [["", "Todas", act.length], ["TODAS", "Bloqueo general", cuenta("TODAS")], ...FARMACIAS.map(f => [f, corto(f), cuenta(f)])]
    .map(([v, t, n]) => `<button type="button" data-farm="${esc(v)}" aria-pressed="${S.af.farm === v}">${esc(t)}<span>${n}</span></button>`).join("");

  // laboratorios presentes en los bloqueos
  const labs = [...new Set(todos.map(d => d.laboratorio).filter(Boolean))].sort();
  $("aLab").innerHTML = `<option value="">Todos</option>` + labs.map(l => `<option ${l === S.af.lab ? "selected" : ""}>${esc(l)}</option>`).join("");

  // tabla
  const q = norm(S.af.q).trim();
  const lista = todos
    .filter(d => !S.af.farm || d.farmacia === S.af.farm)
    .filter(d => !S.af.lab || d.laboratorio === S.af.lab)
    .filter(d => !S.af.estado || d.estado === S.af.estado)
    .filter(d => !S.af.motivo || d.motivo === S.af.motivo)
    .filter(d => !q || q.split(/\s+/).every(w => norm(d.codpro + " " + d.producto + " " + (d.laboratorio || "")).includes(w)))
    .sort((a, b) => (aFecha(b.desde) || 0) - (aFecha(a.desde) || 0));
  $("aTit").textContent = (S.af.farm ? corto(S.af.farm) : "Todas las farmacias") + ` · ${lista.length}`;
  $("aTabla").innerHTML = `<thead><tr><th>Producto</th><th>Farmacia</th><th>Motivo</th><th>Por</th><th>Desde</th><th>Revisar</th></tr></thead><tbody>` +
    (lista.length ? lista.map(d => {
      const vencida = d.estado === "bloqueado" && d.revisar && d.revisar <= hoy;
      return `<tr class="clic ${vencida ? "revisar" : ""}" data-ficha="${esc(d.id)}" tabindex="0">
        <td class="p"><b>${esc(d.producto)}</b><code>${esc(codVis(d.codpro))}${d.fueraCatalogo ? " · fuera de la lista" : ""}${d.laboratorio ? " · " + esc(d.laboratorio) : ""}</code></td>
        <td>${esc(corto(d.farmacia))}</td>
        <td>${d.estado === "activo" ? `<span class="tag t-ok">Reactivado</span>` : tagMotivo(d.motivo)} ${d.estado === "bloqueado" ? etiquetaSolicitud(d) : ""}</td>
        <td>${esc(d.porNombre)}</td>
        <td class="f">${fmtF(d.desde)}</td>
        <td class="f ${vencida ? "mal" : ""}">${d.revisar ? fmtF(d.revisar) : "–"}</td>
      </tr>`; }).join("") : `<tr class="vacia"><td colspan="6">No hay registros con estos filtros.</td></tr>`) + "</tbody>";
}
$("aTabla").addEventListener("click", e => { const tr = e.target.closest("[data-ficha]"); if (tr) abrirFicha(tr.dataset.ficha); });
$("aTabla").addEventListener("keydown", e => { const tr = e.target.closest("[data-ficha]"); if (tr && e.key === "Enter") abrirFicha(tr.dataset.ficha); });
$("aSol").addEventListener("click", e => {
  const caja = e.target.closest(".sol"); if (!caja) return;
  const resp = caja.querySelector("[data-resp]").value.trim();
  const d = S.bloqueos.get(caja.dataset.id);
  if (e.target.closest("[data-aprobar]")) reactivar(d, d.solicitud.motivo, resp || d.solicitud.comentario || "");
  if (e.target.closest("[data-rechazar]")) rechazar(d, resp);
});

/* ===================== acciones del administrador ===================== */
async function reactivar(d, motivo, comentario) {
  const ahora = serverTimestamp(), quien = { porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario };
  const cambio = { estado: "activo", reactivado: { fecha: ahora, motivo, comentario, ...quien } };
  if (d.solicitud?.estado === "pendiente") cambio.solicitud = { ...d.solicitud, estado: "aprobada", respuesta: comentario, respondio: quien.porNombre, fechaRespuesta: ahora };
  const lote = writeBatch(db);
  lote.update(doc(db, "bloqueos", d.id), cambio);
  lote.set(doc(collection(db, "historial")), { farmacia: d.farmacia, codpro: d.codpro, producto: d.producto, tipo: "reactivacion", motivo, comentario, fecha: ahora, ...quien });
  try { await lote.commit(); toast(`${d.producto} reactivado en ${corto(d.farmacia)}`); if (S.vista === "vFicha") cargarHistorial(); }
  catch (e) { toast(textoError(e)); }
}
async function rechazar(d, comentario) {
  const ahora = serverTimestamp(), quien = { porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario };
  const lote = writeBatch(db);
  lote.update(doc(db, "bloqueos", d.id), { solicitud: { ...d.solicitud, estado: "rechazada", respuesta: comentario, respondio: quien.porNombre, fechaRespuesta: ahora } });
  lote.set(doc(collection(db, "historial")), { farmacia: d.farmacia, codpro: d.codpro, producto: d.producto, tipo: "rechazo", motivo: d.solicitud.motivo, comentario, fecha: ahora, ...quien });
  try { await lote.commit(); toast("Solicitud rechazada"); if (S.vista === "vFicha") cargarHistorial(); }
  catch (e) { toast(textoError(e)); }
}

/* ===================== ficha de producto ===================== */
function abrirFicha(id) { S.ficha = id; S.origen = S.vista === "vFicha" ? S.origen : S.vista; ir("vFicha"); cargarHistorial(); }
$("fVolver").addEventListener("click", () => ir(S.origen || (esAdmin() ? "vAdmin" : "vQuimico")));

async function cargarHistorial() {
  const d = S.bloqueos.get(S.ficha); if (!d) return;
  $("fHist").innerHTML = `<p class="muted">Cargando…</p>`;
  try {
    const snap = await getDocs(query(collection(db, "historial"), where("farmacia", "==", d.farmacia), where("codpro", "==", d.codpro)));
    const ev = snap.docs.map(x => x.data()).sort((a, b) => (aFecha(b.fecha) || Date.now()) - (aFecha(a.fecha) || Date.now()));
    const nombre = { bloqueo: "Bloqueado", solicitud: "Reactivación pedida", reactivacion: "Reactivado", rechazo: "Solicitud rechazada" };
    const clase = { bloqueo: "", solicitud: "t-pend", reactivacion: "t-ok", rechazo: "t-rech" };
    $("fHist").innerHTML = ev.length ? ev.map(e => `
      <div class="ev"><div class="f">${fmtFH(e.fecha)}</div><div>
        <div class="t">${nombre[e.tipo] || e.tipo} ${e.tipo === "bloqueo" ? tagMotivo(e.motivo) : `<span class="tag ${clase[e.tipo]}">${esc(e.motivo)}</span>`}</div>
        <p>${e.comentario ? `"${esc(e.comentario)}"` : "Sin comentario"} — ${esc(e.porNombre)}</p>
      </div></div>`).join("") : `<p class="muted">Sin movimientos registrados.</p>`;
  } catch (e) { $("fHist").innerHTML = `<p class="mal">${esc(textoError(e))}</p>`; }
}

function pintarFicha() {
  const d = S.bloqueos.get(S.ficha); if (!d) return;
  $("fVolver").textContent = "← Volver";
  $("fEyebrow").innerHTML = `<code>${esc(codVis(d.codpro))}</code>${d.fueraCatalogo ? " · fuera de la lista" : ""}${d.laboratorio ? " · Lab. " + esc(d.laboratorio) : ""} · ${esc(corto(d.farmacia))}`;
  $("fTitulo").textContent = d.producto;
  $("fEstado").innerHTML = d.estado === "bloqueado"
    ? `<span class="estado ${claseMotivo(d.motivo)}">Bloqueado desde el ${fmtF(d.desde)}</span>`
    : `<span class="estado t-ok">Se abastece · reactivado el ${fmtF(d.reactivado?.fecha)}</span>`;

  const A = $("fAccion"), s = d.solicitud;
  const radios = (nombre) => `<div class="pills verde">${MOTIVOS_REACTIVACION.map(m => `<label><input type="radio" name="${nombre}" value="${esc(m)}">${esc(m)}</label>`).join("")}</div>`;
  const ultimaRespuesta = s?.estado === "rechazada"
    ? `<div class="msg error">Tu solicitud anterior fue rechazada el ${fmtF(s.fechaRespuesta)}${s.respuesta ? `: "${esc(s.respuesta)}"` : "."}</div>` : "";

  if (d.estado !== "bloqueado") {
    A.innerHTML = `<h2>Se abastece</h2><p class="muted">Reactivado por ${esc(d.reactivado?.porNombre || "–")}: ${esc(d.reactivado?.motivo || "")}. Si hay que volver a bloquearlo, usa el formulario de bloqueo.</p>`;
  } else if (!esAdmin()) {
    if (d.farmacia === "TODAS") {
      A.innerHTML = `<h2>Bloqueo general</h2><p class="muted">Abastecimiento bloqueó este producto en todas las farmacias. Si lo necesitas, consúltalo directamente con Abastecimiento.</p>`;
    } else if (s?.estado === "pendiente") {
      A.innerHTML = `<h2>Reactivación pedida</h2><div class="msg">Enviada el ${fmtF(s.fecha)}: ${esc(s.motivo)}. Abastecimiento la revisará.</div><p class="muted">El producto sigue bloqueado hasta que se apruebe.</p>`;
    } else {
      A.innerHTML = `<h2>Pedir reactivación</h2>${ultimaRespuesta}
        <p class="muted">La reactivación la aprueba Abastecimiento. El producto sigue bloqueado hasta entonces.</p>
        <fieldset><legend>Motivo</legend>${radios("fMot")}</fieldset>
        <div class="campo"><label for="fCom">Comentario</label><textarea id="fCom" rows="3"></textarea></div>
        <div class="msg" id="fMsg" hidden></div>
        <button class="btn verde" type="button" data-pedir>Enviar solicitud a Abastecimiento</button>`;
    }
  } else {
    A.innerHTML = (s?.estado === "pendiente"
      ? `<div class="msg">Solicitud de ${esc(s.porNombre)} (${fmtF(s.fecha)}): <b>${esc(s.motivo)}</b>${s.comentario ? ` — "${esc(s.comentario)}"` : ""}</div>` : "") + `
      <h2>Reactivar abastecimiento</h2>
      <fieldset><legend>Motivo</legend>${radios("fMot")}</fieldset>
      <div class="campo"><label for="fCom">Comentario</label><textarea id="fCom" rows="3"></textarea></div>
      <div class="msg" id="fMsg" hidden></div>
      <button class="btn verde" type="button" data-reactivar>Reactivar en ${esc(corto(d.farmacia))}</button>
      ${s?.estado === "pendiente" ? `<button class="btn" type="button" data-rechazar-f>Rechazar la solicitud</button>` : ""}`;
    if (s?.estado === "pendiente") { const r = A.querySelector(`input[value="${CSS.escape(s.motivo)}"]`); if (r) r.checked = true; }
  }
}
$("fAccion").addEventListener("click", async e => {
  const d = S.bloqueos.get(S.ficha); if (!d) return;
  const motivo = document.querySelector('input[name="fMot"]:checked')?.value;
  const comentario = $("fCom")?.value.trim() || "";
  if (e.target.closest("[data-rechazar-f]")) return rechazar(d, comentario);
  if (e.target.closest("[data-reactivar]")) {
    if (!motivo) return msg("fMsg", "Elige el motivo de la reactivación.", true);
    return reactivar(d, motivo, comentario);
  }
  if (e.target.closest("[data-pedir]")) {
    if (!motivo) return msg("fMsg", "Elige el motivo.", true);
    const ahora = serverTimestamp(), quien = { porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario };
    const lote = writeBatch(db);
    lote.update(doc(db, "bloqueos", d.id), { solicitud: { estado: "pendiente", motivo, comentario, fecha: ahora, ...quien } });
    lote.set(doc(collection(db, "historial")), { farmacia: d.farmacia, codpro: d.codpro, producto: d.producto, tipo: "solicitud", motivo, comentario, fecha: ahora, ...quien });
    try { await lote.commit(); toast("Solicitud enviada a Abastecimiento"); cargarHistorial(); }
    catch (err) { msg("fMsg", textoError(err), true); }
  }
});

/* ===================== usuarios (solo admin) ===================== */
$("uRolSel").addEventListener("change", () => { $("uFarm").disabled = $("uRolSel").value === "admin"; });
function pintarUsuarios() {
  const lista = [...S.usuarios].sort((a, b) => (a.rol + a.farmacia + a.usuario).localeCompare(b.rol + b.farmacia + b.usuario));
  $("uTabla").innerHTML = `<thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Farmacia</th><th class="der">Estado</th></tr></thead><tbody>` +
    (lista.length ? lista.map(u => `<tr>
      <td class="f">${esc(u.usuario)}</td><td>${esc(u.nombre)}</td>
      <td>${u.rol === "admin" ? "Administrador" : "Químico"}</td><td>${esc(u.farmacia ? corto(u.farmacia) : "–")}</td>
      <td class="der">${u.uid === S.perfil.uid ? '<span class="muted">Tú</span>' :
        `<button class="btn sm" type="button" data-toggle="${esc(u.uid)}">${u.activo === false ? "Habilitar" : "Deshabilitar"}</button>`}</td>
    </tr>`).join("") : `<tr class="vacia"><td colspan="5">Sin usuarios.</td></tr>`) + "</tbody>";
}
$("uTabla").addEventListener("click", async e => {
  const b = e.target.closest("[data-toggle]"); if (!b) return;
  const u = S.usuarios.find(x => x.uid === b.dataset.toggle);
  try { await setDoc(doc(db, "usuarios", u.uid), { activo: u.activo === false }, { merge: true }); toast(u.activo === false ? "Usuario habilitado" : "Usuario deshabilitado"); }
  catch (err) { toast(textoError(err)); }
});
$("fUsr").addEventListener("submit", async e => {
  e.preventDefault();
  const usuario = $("uUsr").value.trim().toLowerCase(), rol = $("uRolSel").value;
  const farmacia = rol === "admin" ? "" : $("uFarm").value;
  if (S.usuarios.some(u => u.usuario === usuario)) return msg("uMsg", "Ese usuario ya existe.", true);
  $("uBtn").disabled = true; msg("uMsg", "Creando…");
  // Una segunda conexión crea el usuario sin cerrar tu sesión.
  const app2 = initializeApp(firebaseConfig, "crear-" + Date.now()), auth2 = getAuth(app2);
  try {
    const cred = await createUserWithEmailAndPassword(auth2, `${usuario}@${DOMINIO}`, $("uPass").value);
    await setDoc(doc(db, "usuarios", cred.user.uid), { usuario, nombre: $("uNom").value.trim(), rol, farmacia, activo: true });
    await signOut(auth2);
    msg("uMsg", `Usuario "${usuario}" creado. Entrégale su usuario y contraseña.`);
    e.target.reset(); $("uFarm").disabled = false;
  } catch (err) {
    const t = err?.code === "auth/email-already-in-use" ? "Ese usuario ya existe en Authentication."
      : err?.code === "auth/weak-password" ? "La contraseña debe tener al menos 6 caracteres." : textoError(err);
    msg("uMsg", t, true);
  } finally { $("uBtn").disabled = false; }
});

/* ===================== exportar CSV ===================== */
function descargarCsv(filas, nombre) {
  const c = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = ["farmacia,codpro,producto,en_lista,laboratorio,motivo,alcance,desde,por,revisar,solicitud",
    ...filas.map(d => [d.farmacia, String(d.codpro).startsWith(SIN_COD) ? "" : d.codpro, d.producto, d.fueraCatalogo ? "no" : "si", d.laboratorio || "", d.motivo, d.alcance, fmtF(d.desde), d.porNombre, d.revisar || "", d.solicitud?.estado || ""].map(c).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `${nombre}_${hoyISO()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const bloqueadosAhora = () => [...S.bloqueos.values()].filter(d => d.estado === "bloqueado");
$("aCsv").addEventListener("click", () => descargarCsv(bloqueadosAhora(), "bloqueos"));
