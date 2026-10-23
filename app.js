import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword, updatePassword
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, where,
  serverTimestamp, writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { firebaseConfig, DOMINIO, FARMACIAS, NOMBRES_VISIBLES, MOTIVOS_BLOQUEO, MOTIVOS_REACTIVACION } from "./config.js?v=202610151900";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
// La proyección de compras (proyeccion.html, dentro de un marco) usa esta misma conexión y sesión.
window.FB = { auth, db, onAuthStateChanged, doc, getDoc, setDoc, deleteDoc, collection, getDocs, onSnapshot };

// Cambiar al publicar cambios en proyeccion.html / proyeccion.js, para que el navegador no use la copia vieja.
const VERSION_PROY = "202610231100";
const VERSION_COMP = "202610212000";

/* ===================== utilidades ===================== */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hoyISO = () => new Date().toISOString().slice(0, 10);
const aFecha = v => v?.toDate ? v.toDate() : (typeof v === "string" && v ? new Date(v + "T12:00:00") : null);
const fmtF = v => { const d = aFecha(v); return d ? d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "–"; };
const fmtFH = v => { const d = aFecha(v); return d ? d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) + "<br>" + d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) : "ahora"; };
// "ALMACEN HUANCAS" -> "Sucursal Huancas"; los que no son almacén (DROGUERIA FS) se muestran tal cual.
// Nombre que se ve en pantalla (ALMACEN PRINCIPAL se ve como ALMACEN REAL, etc.).
const visible = f => NOMBRES_VISIBLES[f] || String(f || "");
const nombreFarm = f => /^ALMACEN /.test(visible(f))
  ? "Sucursal " + visible(f).replace(/^ALMACEN /, "").toLowerCase().replace(/(^|[\s.])\p{L}/gu, c => c.toUpperCase())
  : visible(f);
const corto = f => f === "TODAS" ? "Todas las farmacias" : visible(f).replace(/^ALMACEN /, "");
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
  S.claveIngreso = $("lPass").value;
  try { await signInWithEmailAndPassword(auth, email, $("lPass").value); $("lPass").value = ""; }
  catch (err) {
    const c = err?.code || "";
    $("lErr").textContent = c === "auth/too-many-requests" ? "Demasiados intentos fallidos. Espera unos minutos y vuelve a intentarlo."
      : c === "auth/network-request-failed" ? "Sin conexión a internet. Revisa tu red e inténtalo de nuevo."
      : "Usuario o contraseña incorrectos. Revisa mayúsculas (Bloq Mayús) y que no haya espacios.";
    $("lErr").hidden = false;
  }
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
  // Primer ingreso (o contraseña restablecida): debe crear su propia contraseña antes de seguir.
  if (S.perfil.cambiarClave === true) {
    $("top").hidden = true; mostrar("vClave");
    // Siempre en blanco: la química escribe su propio nombre en su primer ingreso.
    $("fClave").reset(); $("cErr").hidden = true; $("cNom").focus();
    return;
  }
  await entrar();
});
async function entrar() {
  await cargarCatalogo();
  iniciar();
  revisarPerfil();
}

$("cSalir").addEventListener("click", () => signOut(auth));
$("fClave").addEventListener("submit", async e => {
  e.preventDefault();
  const nueva = $("cNueva").value, err = t => { $("cErr").textContent = t; $("cErr").hidden = !t; };
  const nombre = $("cNom").value.trim().replace(/\s+/g, " ");
  if (nombre.length < 3) return err("Escribe tu nombre completo.");
  if (nueva.length < 6) return err("La contraseña debe tener al menos 6 caracteres.");
  if (nueva !== $("cRepite").value) return err("Las dos contraseñas no coinciden.");
  if (S.claveIngreso && nueva === S.claveIngreso && nueva !== S.claveNueva) return err("Debe ser distinta a la contraseña con la que ingresaste.");
  $("cBtn").disabled = true; err("");
  try {
    // Si en un intento anterior la contraseña ya se cambió y solo falló guardar el nombre, no se cambia de nuevo.
    if (S.claveNueva !== nueva) { await updatePassword(auth.currentUser, nueva); S.claveNueva = nueva; }
    try {
      await updateDoc(doc(db, "usuarios", S.perfil.uid), { nombre, cambiarClave: false, claveCambiada: serverTimestamp() });
    } catch (x) {
      err("Tu contraseña nueva ya quedó guardada (úsala para ingresar), pero no se pudo guardar tu nombre. " + textoError(x));
      return;
    }
    S.perfil.cambiarClave = false; S.perfil.nombre = nombre; S.claveIngreso = S.claveNueva = ""; e.target.reset();
    toast("Contraseña guardada. Úsala desde ahora para ingresar.");
    await entrar();
  } catch (x) {
    err(x?.code === "auth/requires-recent-login" ? "Por seguridad, sal y vuelve a ingresar con la contraseña inicial para cambiarla."
      : x?.code === "auth/weak-password" ? "La contraseña es muy débil. Usa al menos 6 caracteres."
      : textoError(x));
  } finally { $("cBtn").disabled = false; }
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
    const opciones = FARMACIAS.map(f => `<option value="${esc(f)}">${esc(visible(f))}</option>`).join("");
    $("abFarm").innerHTML = `<option value="TODAS">Todas las farmacias</option>` + opciones;
    $("uFarm").innerHTML = opciones;
    $("aMot").innerHTML = `<option value="">Todos</option>` + MOTIVOS_BLOQUEO.map(m => `<option>${esc(m.texto)}</option>`).join("");
    S.subs.push(onSnapshot(collection(db, "bloqueos"), snap => {
      S.bloqueos = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
      render();
    }, e => avisar(e)));
    S.subs.push(onSnapshot(collection(db, "usuarios"), snap => {
      const antes = solicitudesSucursal().length;
      S.usuarios = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      if (S.usuariosListos && solicitudesSucursal().length > antes) toast("Nueva solicitud de cambio de sucursal");
      S.usuariosListos = true;
      pintarNav(); pintarSolSucursal(); pintarCierreAdmin();
      if (S.vista === "vUsuarios" && !S.editando) pintarUsuarios();   // no borrar lo que se está editando
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
    // Si el administrador le cambia la sucursal, el rol o la deshabilita, se recarga con los datos nuevos.
    pintarPedidoSucursal();
    S.subs.push(onSnapshot(doc(db, "usuarios", S.perfil.uid), snap => {
      const d = snap.data() || {};
      S.perfil.solicitudSucursal = d.solicitudSucursal; pintarPedidoSucursal();
      S.perfil.cierre = d.cierre; render();
      if (d.farmacia !== S.perfil.farmacia || String(d.rol || "").trim().toLowerCase() !== S.perfil.rol || [false, "false"].includes(d.activo) || d.cambiarClave === true) location.reload();
    }));
    ir("vQuimico");
  }
}
function avisar(e) { const a = $("avisoGlobal"); a.hidden = false; a.textContent = e?.code ? textoError(e) : e.message; }

function pintarNav() {
  const pend = [...S.bloqueos.values()].filter(d => d.estado === "bloqueado" && d.solicitud?.estado === "pendiente").length;
  const items = esAdmin()
    ? [["vAdmin", "Bloqueos" + (pend ? `<span class="badge">${pend}</span>` : "")],
       ["vUsuarios", "Usuarios" + (solicitudesSucursal().length ? `<span class="badge">${solicitudesSucursal().length}</span>` : "")],
       ["vProy", "Proyección de compras"],
       ["vComp", "Comparativo", "comp"],
       ["vMapa", "Mapa de calor", "mapa"]]
    : [];   // el químico tiene una sola vista: no hace falta menú
  const actual = S.vista === "vFicha" ? S.origen : S.vista;
  $("nav").innerHTML = items.map(([v, t, c]) => `<button type="button" data-ir="${v}" ${c ? `class="${c}"` : ""} ${v === actual ? 'aria-current="page"' : ""}>${t}</button>`).join("");
}
$("nav").addEventListener("click", e => { const b = e.target.closest("[data-ir]"); if (b) ir(b.dataset.ir); });

function mostrar(id) { ["vLogin", "vClave", "vQuimico", "vAdmin", "vUsuarios", "vProy", "vComp", "vMapa", "vFicha"].forEach(v => $(v).hidden = v !== id); }
function ir(vista) {
  // La proyección se carga la primera vez que se abre (es pesada y solo la usa el administrador).
  if (vista === "vProy" && !$("proyFrame").src) $("proyFrame").src = "proyeccion.html?v=" + VERSION_PROY;
  if (vista === "vMapa" && !$("mapaFrame").src) $("mapaFrame").src = "proyeccion.html?solo=mapa&v=" + VERSION_PROY;
  if (vista === "vComp" && !$("compFrame").src) $("compFrame").src = "comparativo.html?v=" + VERSION_COMP;
  S.vista = vista; mostrar(vista); render(); scrollTo({ top: 0 }); }
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
    btn.disabled = !listo || !!b || (pre === "bq" && cerradoParaMi());
    return;
  }
  const b = estadoEn(p.c, farm);
  box.innerHTML = `<span class="cod">${esc(p.c)}${p.l ? " · Lab. " + esc(p.l) : ""}</span><b>${esc(p.n)}</b>` +
    (b ? `<span class="est mal">Ya está bloqueado${b.farmacia === "TODAS" ? " en todas las farmacias" : ""}: ${esc(b.motivo)}</span>`
       : `<span class="est ok">Se abastece a ${esc(corto(farm))}</span>`);
  btn.disabled = !!b || (pre === "bq" && cerradoParaMi());
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
  // Flechas ↑/↓ recorren los resultados; Enter elige el marcado (o el primero); Esc cierra.
  inp.addEventListener("keydown", e => {
    const ops = [...res.querySelectorAll("button")];
    let i = ops.findIndex(b => b.classList.contains("activo"));
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !res.hidden && ops.length) {
      e.preventDefault();
      i = e.key === "ArrowDown" ? (i + 1) % ops.length : (i <= 0 ? ops.length - 1 : i - 1);
      ops.forEach((b, k) => b.classList.toggle("activo", k === i));
      ops[i].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); if (!res.hidden) (ops[i] || ops[0])?.click(); }
    else if (e.key === "Escape") res.hidden = true;
  });
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
// Botón azul de la lupa: muestra los resultados de lo escrito.
document.querySelectorAll("[data-lupa]").forEach(b => b.addEventListener("click", () => {
  const inp = $(b.dataset.lupa + "Bus"); inp.focus(); inp.dispatchEvent(new Event("input"));
}));
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
  if (pre === "bq" && cerradoParaMi()) return msg(pre + "Msg", "El ingreso de información está cerrado por Abastecimiento.", true);
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

/* ===================== químico: pedir cambio de sucursal ===================== */
function pintarPedidoSucursal() {
  const s = S.perfil?.solicitudSucursal;
  $("csPend").hidden = s?.estado !== "pendiente";
  $("csAbrir").hidden = s?.estado === "pendiente";
  if (s?.estado === "pendiente") $("csPendTxt").textContent = `Pediste cambiarte a ${nombreFarm(s.farmacia)}. Abastecimiento lo revisará.`;
  // Avisar solo cuando pasa de pendiente a rechazada mientras está conectada.
  if (S.estadoPedido === "pendiente" && s?.estado === "rechazada") toast(`Tu pedido de cambio a ${nombreFarm(s.farmacia)} fue rechazado.`);
  S.estadoPedido = s?.estado;
}
$("csAbrir").addEventListener("click", () => {
  $("csSel").innerHTML = `<option value="">Elige la sucursal…</option>` + FARMACIAS.filter(f => f !== miFarm())
    .map(f => `<option value="${esc(f)}">${esc(nombreFarm(f))}</option>`).join("");
  $("csForm").hidden = false; $("csAbrir").hidden = true; $("csSel").focus();
});
$("csCancelar").addEventListener("click", () => { $("csForm").hidden = true; msg("csMsg", ""); pintarPedidoSucursal(); });
$("csForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (cerradoParaMi()) return msg("csMsg", "El ingreso de información está cerrado por Abastecimiento.", true);
  const farmacia = $("csSel").value; if (!farmacia) return msg("csMsg", "Elige la sucursal.", true);
  const sol = { farmacia, motivo: $("csMot").value.trim(), estado: "pendiente", fecha: serverTimestamp() };
  try {
    await updateDoc(doc(db, "usuarios", S.perfil.uid), { solicitudSucursal: sol });
    S.perfil.solicitudSucursal = sol; e.target.reset(); $("csForm").hidden = true; msg("csMsg", "");
    toast("Solicitud enviada a Abastecimiento"); pintarPedidoSucursal();
  } catch (err) { msg("csMsg", textoError(err), true); }
});
$("csAnular").addEventListener("click", async () => {
  try { await updateDoc(doc(db, "usuarios", S.perfil.uid), { "solicitudSucursal.estado": "cancelada" }); S.perfil.solicitudSucursal.estado = "cancelada"; pintarPedidoSucursal(); toast("Solicitud anulada"); }
  catch (err) { toast(textoError(err)); }
});

/* ===================== cierre del ingreso de información ===================== */
// El cierre se guarda en el usuario de cada químico: cierre = { desde, hasta (o null), motivo, porNombre }.
// Mientras está vigente, el químico no puede bloquear, pedir reactivación ni pedir cambio de sucursal
// (las reglas de Firestore también lo rechazan). El administrador no tiene cierre.
const aDate = v => v?.toDate ? v.toDate() : v ? new Date(v) : null;
const fmtDH = d => d.toLocaleString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const aInput = d => d ? new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : "";
function estadoCierre(c, ahora = Date.now()) {
  const d = aDate(c?.desde), h = aDate(c?.hasta);
  if (!d || (h && ahora >= h)) return null;   // sin cierre o ya terminó
  return { desde: d, hasta: h, motivo: c.motivo || "", vigente: ahora >= d };
}
const cerradoParaMi = () => !esAdmin() && !!estadoCierre(S.perfil?.cierre)?.vigente;
const textoCierre = e => e.vigente
  ? `Ingreso de información cerrado ${e.hasta ? "hasta el " + fmtDH(e.hasta) : "hasta nuevo aviso"}`
  : `El ingreso de información se cerrará el ${fmtDH(e.desde)}${e.hasta ? " y se abrirá el " + fmtDH(e.hasta) : ""}`;
function pintarCierreQuimico() {
  const e = estadoCierre(S.perfil?.cierre), a = $("qCierre");
  a.hidden = !e;
  if (e) {
    a.className = "aviso cierre-aviso" + (e.vigente ? "" : " prox");
    const t = textoCierre(e), punto = t.endsWith(".") ? " " : ". ";
    a.textContent = t + (e.vigente ? punto + "Mientras tanto no puedes bloquear productos ni enviar solicitudes." : punto.trim()) + (e.motivo ? " Motivo: " + e.motivo : "");
  }
  $("csAbrir").disabled = !!e?.vigente;
}
const quimicos = () => S.usuarios.filter(u => String(u.rol || "").trim().toLowerCase() !== "admin" && ![false, "false"].includes(u.activo));
function pintarCierreAdmin() {
  const el = $("ciEstado"); if (!el) return;
  const qs = quimicos(), con = qs.map(u => [u, estadoCierre(u.cierre)]).filter(([, e]) => e);
  el.hidden = !con.length; if (!con.length) return;
  const e = con.find(([, x]) => x.vigente)?.[1] || con[0][1];
  const varios = new Set(con.map(([, x]) => +x.desde + "|" + +(x.hasta || 0))).size > 1;
  el.className = "cierre-estado" + (e.vigente ? " activo" : "");
  el.textContent = `${e.vigente ? "🔒 Ingreso cerrado" : "⏱ Cierre programado"} para ${con.length === qs.length ? "todos los usuarios" : con.length + " de " + qs.length + " usuarios"}: `
    + (e.vigente ? "desde " : "") + fmtDH(e.desde) + (e.hasta ? " → " + fmtDH(e.hasta) : " · sin fecha de apertura") + (varios ? " (hay horarios distintos)" : "");
}
function pintarUsuariosCierre() {
  const qs = quimicos().sort((a, b) => (a.farmacia + a.usuario).localeCompare(b.farmacia + b.usuario));
  $("ciUsuarios").innerHTML = `<label class="todo"><input type="checkbox" data-todos> Marcar todos</label>` + qs.map(u =>
    `<label><input type="checkbox" value="${esc(u.uid)}" ${estadoCierre(u.cierre) ? "checked" : ""}> ${esc(u.nombre || u.usuario)} <small>${esc(corto(u.farmacia || ""))}</small></label>`).join("");
}
$("ciAbrir").addEventListener("click", () => {
  const f = $("ciForm"); f.hidden = !f.hidden; if (f.hidden) return;
  const qs = quimicos(), con = qs.filter(u => estadoCierre(u.cierre)), e = con.length ? estadoCierre(con[0].cierre) : null;
  const ahora = new Date(); ahora.setSeconds(0, 0);
  $("ciDesde").value = aInput(e?.desde || ahora); $("ciHasta").value = aInput(e?.hasta); $("ciMot").value = e?.motivo || "";
  const algunos = con.length && con.length < qs.length;
  document.querySelector(`input[name="ciQuien"][value="${algunos ? "algunos" : "todos"}"]`).checked = true;
  pintarUsuariosCierre(); $("ciUsuarios").hidden = !algunos; msg("ciMsg", "");
  f.scrollIntoView({ behavior: "smooth", block: "start" });
});
$("ciCancelar").addEventListener("click", () => { $("ciForm").hidden = true; });
document.querySelectorAll('input[name="ciQuien"]').forEach(r => r.addEventListener("change", () => { $("ciUsuarios").hidden = r.value !== "algunos" || !r.checked; }));
$("ciUsuarios").addEventListener("change", e => { if (e.target.matches("[data-todos]")) $("ciUsuarios").querySelectorAll("input[value]").forEach(x => x.checked = e.target.checked); });
// Guarda el cierre en los usuarios elegidos y lo quita de los demás.
async function guardarCierre(elegidos, cierre) {
  const lote = writeBatch(db); let n = 0;
  for (const u of quimicos()) {
    if (elegidos.has(u.uid)) { lote.update(doc(db, "usuarios", u.uid), { cierre }); n++; }
    else if (u.cierre) lote.update(doc(db, "usuarios", u.uid), { cierre: deleteField() });
  }
  await lote.commit(); return n;
}
$("ciForm").addEventListener("submit", async e => {
  e.preventDefault();
  const desde = $("ciDesde").value ? new Date($("ciDesde").value) : null, hasta = $("ciHasta").value ? new Date($("ciHasta").value) : null;
  if (!desde) return msg("ciMsg", "Elige la fecha y hora del cierre.", true);
  if (hasta && hasta <= desde) return msg("ciMsg", "La fecha para volver a abrir debe ser posterior al cierre.", true);
  if (hasta && hasta <= new Date()) return msg("ciMsg", "La fecha para volver a abrir ya pasó.", true);
  const todos = document.querySelector('input[name="ciQuien"]:checked').value === "todos";
  const elegidos = new Set(todos ? quimicos().map(u => u.uid) : [...$("ciUsuarios").querySelectorAll("input[value]:checked")].map(x => x.value));
  if (!elegidos.size) return msg("ciMsg", "Elige al menos un usuario.", true);
  $("ciBtn").disabled = true;
  try {
    const n = await guardarCierre(elegidos, { desde, hasta, motivo: $("ciMot").value.trim(), porNombre: S.perfil.nombre || S.perfil.usuario, fecha: serverTimestamp() });
    $("ciForm").hidden = true; msg("ciMsg", "");
    toast(`${desde <= new Date() ? "Ingreso cerrado" : "Cierre programado para el " + fmtDH(desde)} · ${n} usuario(s)`);
  } catch (err) { msg("ciMsg", textoError(err), true); }
  finally { $("ciBtn").disabled = false; }
});
$("ciQuitar").addEventListener("click", async () => {
  if (!quimicos().some(u => u.cierre)) { $("ciForm").hidden = true; return toast("No hay ningún cierre"); }
  if (!confirm("¿Quitar el cierre? Todos los usuarios podrán volver a ingresar información.")) return;
  try { await guardarCierre(new Set(), null); $("ciForm").hidden = true; toast("Ingreso abierto para todos"); }
  catch (err) { msg("ciMsg", textoError(err), true); }
});
// El cierre empieza y termina solo a la hora elegida: revisar cada 20 segundos.
setInterval(() => {
  if (!S.perfil) return;
  if (esAdmin()) return pintarCierreAdmin();
  const v = cerradoParaMi() + "|" + !!estadoCierre(S.perfil.cierre);
  if (v !== S.cierreVisto) { S.cierreVisto = v; render(); }
}, 20000);

/* ===================== vista químico ===================== */
$("qFil").addEventListener("input", () => pintarQuimico());
function etiquetaSolicitud(d) {
  const s = d.solicitud; if (!s) return "";
  if (s.estado === "pendiente") return `<span class="tag t-pend">Reactivación pedida</span>`;
  if (s.estado === "rechazada") return `<span class="tag t-rech">Reactivación rechazada</span>`;
  return "";
}
function pintarQuimico() {
  pintarCierreQuimico();
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
  const accion = d => d.farmacia === "TODAS" ? ["Ver", "i-ojo"] : d.solicitud?.estado === "pendiente" ? ["Ver solicitud", "i-ojo"]
    : d.solicitud?.estado === "rechazada" ? ["Volver a pedir reactivación", "i-reactivar"] : ["Pedir reactivación", "i-reactivar"];
  const boton = d => { const [t, i] = accion(d); return `<button class="btn icono" type="button" data-ficha="${esc(d.id)}" title="${t}" aria-label="${t}"><svg width="18" height="18"><use href="#${i}"/></svg></button>`; };
  $("qTabla").innerHTML = `<thead><tr><th>Producto</th><th>Motivo</th><th>Desde</th><th>Estado</th><th class="der">Acción</th></tr></thead><tbody>` +
    (lista.length ? lista.map(d => `<tr>
      <td class="p"><b>${esc(codVis(d.codpro))} - ${esc(d.producto)}</b><code>${d.laboratorio ? esc(d.laboratorio) + " · " : ""}por ${esc(d.porNombre)}</code></td>
      <td>${tagMotivo(d.motivo)}</td>
      <td class="f">${fmtF(d.desde)}</td>
      <td>${estado(d)}</td>
      <td class="der">${boton(d)}</td>
    </tr>`).join("") : `<tr class="vacia"><td colspan="5">${q ? "Ningún bloqueo coincide con la búsqueda." : "No hay productos bloqueados en tu farmacia."}</td></tr>`) + "</tbody>";
}
$("qTabla").addEventListener("click", e => { const b = e.target.closest("[data-ficha]"); if (b) abrirFicha(b.dataset.ficha); });

/* ===================== vista admin ===================== */
["aMot", "aEst", "aQ", "aLab"].forEach(id => $(id).addEventListener("input", () => { S.af.motivo = $("aMot").value; S.af.estado = $("aEst").value; S.af.q = $("aQ").value; S.af.lab = $("aLab").value; pintarAdmin(); }));
$("aChips").addEventListener("click", e => { const b = e.target.closest("[data-farm]"); if (b) { S.af.farm = b.dataset.farm; pintarAdmin(); } });

function pintarAdmin() {
  pintarCierreAdmin();
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

  pintarTorta(todos);

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
// torta: reparto de los registros por sucursal (respeta laboratorio, motivo, estado y búsqueda; no la farmacia elegida)
const COL_TORTA = ["#14306B", "#2F6FB3", "#1E6B5F", "#B7791F", "#6B4C9A", "#3E8E9E", "#A0522D", "#5C7A2E", "#8A5A83", "#4A5B7A"];
function pintarTorta(todos) {
  const q = norm(S.af.q).trim();
  const base = todos
    .filter(d => !S.af.lab || d.laboratorio === S.af.lab)
    .filter(d => !S.af.estado || d.estado === S.af.estado)
    .filter(d => !S.af.motivo || d.motivo === S.af.motivo)
    .filter(d => !q || q.split(/\s+/).every(w => norm(d.codpro + " " + d.producto + " " + (d.laboratorio || "")).includes(w)));
  const filas = [["TODAS", "Bloqueo general"], ...FARMACIAS.map(f => [f, corto(f)])].map(([f, t]) => [f, t, base.filter(d => d.farmacia === f).length]);
  const con = filas.filter(x => x[2] > 0).sort((a, b) => b[2] - a[2]), cero = filas.filter(x => !x[2]), total = base.length;
  const R = 64, C = 2 * Math.PI * R;
  let acum = 0, arcos = "";
  con.forEach(([f, t, n], i) => {
    const largo = n / total * C, sel = S.af.farm === f;
    arcos += `<circle r="${R}" cx="90" cy="90" fill="none" stroke="${COL_TORTA[i % COL_TORTA.length]}" stroke-width="${sel ? 44 : 36}"
      stroke-dasharray="${Math.max(0, largo - (con.length > 1 ? 1.5 : 0))} ${C}" stroke-dashoffset="${-acum}" data-farm="${esc(f)}" class="${S.af.farm && !sel ? "tenue" : ""}"><title>${esc(t)}: ${n} (${Math.round(n / total * 100)}%)</title></circle>`;
    acum += largo;
  });
  $("aTorta").innerHTML = `<h3>Por sucursal</h3>
    <svg viewBox="0 0 180 180" class="dona" role="img" aria-label="Registros por sucursal"><g transform="rotate(-90 90 90)">${total ? arcos : `<circle r="${R}" cx="90" cy="90" fill="none" stroke="var(--line)" stroke-width="36"/>`}</g>
      <text x="90" y="88" text-anchor="middle" class="n">${total}</text><text x="90" y="108" text-anchor="middle" class="l">registros</text></svg>
    <ul class="ley">${con.map(([f, t, n], i) => `<li><button type="button" data-farm="${esc(f)}" aria-pressed="${S.af.farm === f}"><i style="background:${COL_TORTA[i % COL_TORTA.length]}"></i>${esc(t)}<b>${n}</b><span>${Math.round(n / total * 100)}%</span></button></li>`).join("")}</ul>
    ${cero.length ? `<div class="cero"><b>Sin registros · ${cero.length}</b><ul>${cero.map(([f, t]) => `<li><button type="button" data-farm="${esc(f)}">${esc(t)}<b>0</b></button></li>`).join("")}</ul></div>` : ""}`;
}
$("aTorta").addEventListener("click", e => {
  const x = e.target.closest("[data-farm]"); if (!x) return;
  S.af.farm = S.af.farm === x.dataset.farm ? "" : x.dataset.farm; pintarAdmin();
});
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
        <button class="btn verde" type="button" data-pedir ${cerradoParaMi() ? "disabled" : ""}>Enviar solicitud a Abastecimiento</button>`;
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
    if (cerradoParaMi()) return msg("fMsg", "El ingreso de información está cerrado por Abastecimiento.", true);
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
  const opcFarm = sel => FARMACIAS.map(f => `<option value="${esc(f)}" ${f === sel ? "selected" : ""}>${esc(corto(f))}</option>`).join("");
  const fila = u => `<tr class="${u.activo === false ? "inactivo" : ""}">
      <td class="f">${esc(u.usuario)}</td><td>${u.nombre ? esc(u.nombre) : '<span class="muted">Lo escribirá al ingresar</span>'}</td>
      <td>${u.rol === "admin" ? "Administrador" : "Químico"}</td><td>${esc(u.farmacia ? corto(u.farmacia) : "–")}</td>
      <td>${u.cambiarClave === true ? '<span class="tag t-pend">Aún no cambia su contraseña</span>' : '<span class="tag t-ok">Contraseña propia</span>'}${u.activo === false ? ' <span class="tag t-rech">Deshabilitado</span>' : ""}</td>
      <td class="der"><div class="botones-fila">${u.uid === S.perfil.uid ? '<span class="muted">Tú</span>' :
        `<button class="btn sm" type="button" data-editar="${esc(u.uid)}">Editar</button>
         <button class="btn sm" type="button" data-toggle="${esc(u.uid)}">${u.activo === false ? "Habilitar" : "Deshabilitar"}</button>`}</div></td>
    </tr>`;
  // Fila de edición debajo del usuario elegido.
  const edicion = u => `<tr class="editando"><td colspan="6">
      <div class="edit-grid" data-uid="${esc(u.uid)}">
        <label class="filtro">Nombre<input data-e="nombre" value="${esc(u.nombre || "")}" maxlength="60" placeholder="Nombre completo"></label>
        <label class="filtro">Sucursal<select data-e="farmacia" ${u.rol === "admin" ? "disabled" : ""}>${opcFarm(u.farmacia)}</select></label>
        <label class="filtro">Rol<select data-e="rol"><option value="quimico" ${u.rol !== "admin" ? "selected" : ""}>Químico</option><option value="admin" ${u.rol === "admin" ? "selected" : ""}>Administrador</option></select></label>
        <label class="check"><input type="checkbox" data-e="cambiarClave" ${u.cambiarClave === true ? "checked" : ""}> Pedirle nombre y contraseña nueva en su próximo ingreso</label>
        <div class="botones-fila"><button class="btn sm primario" type="button" data-guardar>Guardar cambios</button><button class="btn sm" type="button" data-cancelar>Cancelar</button></div>
      </div>
      <small class="ayuda">Los bloqueos ya registrados se quedan en la sucursal donde se hicieron. Si está conectada, el cambio se le aplica al instante.</small>
    </td></tr>`;
  $("uTabla").innerHTML = `<thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Farmacia</th><th>Contraseña</th><th class="der">Acciones</th></tr></thead><tbody>` +
    (lista.length ? lista.map(u => fila(u) + (S.editando === u.uid ? edicion(u) : "")).join("") : `<tr class="vacia"><td colspan="6">Sin usuarios.</td></tr>`) + "</tbody>";
}
$("uTabla").addEventListener("change", e => {
  // Un administrador no tiene sucursal.
  if (e.target.dataset.e === "rol") e.target.closest(".edit-grid").querySelector('[data-e="farmacia"]').disabled = e.target.value === "admin";
});
$("uTabla").addEventListener("click", async e => {
  const ed = e.target.closest("[data-editar]");
  if (ed) { S.editando = S.editando === ed.dataset.editar ? null : ed.dataset.editar; return pintarUsuarios(); }
  if (e.target.closest("[data-cancelar]")) { S.editando = null; return pintarUsuarios(); }
  if (e.target.closest("[data-guardar]")) {
    const g = e.target.closest(".edit-grid"), v = k => g.querySelector(`[data-e="${k}"]`);
    const rol = v("rol").value, cambio = {
      nombre: v("nombre").value.trim().replace(/\s+/g, " "),
      rol, farmacia: rol === "admin" ? "" : v("farmacia").value,
      cambiarClave: v("cambiarClave").checked
    };
    try { await setDoc(doc(db, "usuarios", g.dataset.uid), cambio, { merge: true }); S.editando = null; toast("Usuario actualizado"); pintarUsuarios(); }
    catch (err) { toast(textoError(err)); }
    return;
  }
  const b = e.target.closest("[data-toggle]"); if (!b) return;
  const u = S.usuarios.find(x => x.uid === b.dataset.toggle);
  try { await setDoc(doc(db, "usuarios", u.uid), { activo: u.activo === false }, { merge: true }); toast(u.activo === false ? "Usuario habilitado" : "Usuario deshabilitado"); }
  catch (err) { toast(textoError(err)); }
});
// Contraseña inicial fácil de dictar: Socorro + 4 números (la cambian en su primer ingreso).
$("uGen").addEventListener("click", () => { $("uPass").value = "Socorro" + String(crypto.getRandomValues(new Uint32Array(1))[0] % 9000 + 1000); });
/* ----- solicitudes de cambio de sucursal (las pide la química, las resuelve el administrador) ----- */
function solicitudesSucursal() { return S.usuarios.filter(u => u.solicitudSucursal?.estado === "pendiente"); }
function pintarSolSucursal() {
  const sol = solicitudesSucursal();
  $("sCard").hidden = !sol.length;
  $("sLista").innerHTML = sol.map(u => `<div class="sol" data-uid="${esc(u.uid)}">
      <div class="p"><b>${esc(u.nombre || u.usuario)}</b><code>${esc(u.usuario)}</code></div>
      <div><span class="muted">De</span> <b>${esc(corto(u.farmacia))}</b> <span class="muted">→ a</span> <b>${esc(corto(u.solicitudSucursal.farmacia))}</b>
        <div class="muted">${esc(u.solicitudSucursal.motivo || "Sin motivo")}</div><small class="muted">${fmtF(u.solicitudSucursal.fecha)}</small></div>
      <div class="acc"><div class="botones"><button class="btn sm verde" type="button" data-s-ok>Aprobar cambio</button><button class="btn sm" type="button" data-s-no>Rechazar</button></div></div>
    </div>`).join("");
}
$("sLista").addEventListener("click", async e => {
  const caja = e.target.closest("[data-uid]"); if (!caja) return;
  const u = S.usuarios.find(x => x.uid === caja.dataset.uid), ok = !!e.target.closest("[data-s-ok]");
  if (!ok && !e.target.closest("[data-s-no]")) return;
  const resuelta = { ...u.solicitudSucursal, estado: ok ? "aprobada" : "rechazada", respondio: S.perfil.nombre || S.perfil.usuario, fechaRespuesta: serverTimestamp() };
  try {
    await setDoc(doc(db, "usuarios", u.uid), ok ? { farmacia: u.solicitudSucursal.farmacia, solicitudSucursal: resuelta } : { solicitudSucursal: resuelta }, { merge: true });
    toast(ok ? `${u.nombre || u.usuario} ahora está en ${corto(u.solicitudSucursal.farmacia)}` : "Solicitud rechazada");
  } catch (err) { toast(textoError(err)); }
});

/* ----- crear varios usuarios: una línea por usuario "usuario - ALMACEN - contraseña" ----- */
function leerLote() {
  const existentes = new Set(S.usuarios.map(u => u.usuario)), vistos = new Set();
  return $("lTxt").value.split(/\n/).map(l => l.trim()).filter(Boolean).map(linea => {
    const [u = "", f = "", c = ""] = linea.split(/\s*[,;\t|]\s*|\s+-\s+/);
    const usuario = u.toLowerCase(), F = f.trim().toUpperCase().replace(/\s+/g, " ");
    const farmacia = FARMACIAS.find(x => [x, visible(x)].some(n => n === F || n === "ALMACEN " + F)) || "";
    const problema = !/^[a-z0-9._-]{3,30}$/.test(usuario) ? "Usuario inválido (3 a 30 letras o números, sin espacios)"
      : !farmacia ? `Sucursal no reconocida: "${f}"`
      : c.length < 6 ? "La contraseña debe tener al menos 6 caracteres"
      : existentes.has(usuario) ? "Ya existe"
      : vistos.has(usuario) ? "Repetido en la lista" : "";
    vistos.add(usuario);
    return { usuario, farmacia, clave: c, estado: problema || "Listo para crear", ok: !problema };
  });
}
function pintarLote(filas) {
  $("lTabla").innerHTML = `<thead><tr><th>Usuario</th><th>Sucursal</th><th>Contraseña inicial</th><th>Estado</th></tr></thead><tbody>` +
    filas.map(f => `<tr><td class="f">${esc(f.usuario)}</td><td>${esc(f.farmacia ? corto(f.farmacia) : "–")}</td><td class="f">${esc(f.clave)}</td>
      <td><span class="tag ${f.creado ? "t-ok" : f.ok ? "t-pend" : "t-rech"}">${esc(f.estado)}</span></td></tr>`).join("") + "</tbody>";
  const n = filas.filter(f => f.ok && !f.creado).length;
  $("lCrear").hidden = !n; $("lCrear").textContent = `Crear ${n} usuario${n === 1 ? "" : "s"}`;
}
$("lRevisar").addEventListener("click", () => { S.lote = leerLote(); pintarLote(S.lote); msg("lMsg", S.lote.length ? "" : "Pega la lista primero.", !S.lote.length); });
$("lCrear").addEventListener("click", async () => {
  const filas = (S.lote || []).filter(f => f.ok && !f.creado); if (!filas.length) return;
  $("lCrear").disabled = $("lRevisar").disabled = true;
  // Una segunda conexión crea los usuarios sin cerrar tu sesión.
  const app2 = initializeApp(firebaseConfig, "lote-" + Date.now()), auth2 = getAuth(app2);
  let hechos = 0;
  for (const f of filas) {
    f.estado = "Creando…"; pintarLote(S.lote);
    try {
      const cred = await createUserWithEmailAndPassword(auth2, `${f.usuario}@${DOMINIO}`, f.clave);
      await setDoc(doc(db, "usuarios", cred.user.uid), { usuario: f.usuario, nombre: "", rol: "quimico", farmacia: f.farmacia, activo: true, cambiarClave: true });
      f.creado = true; f.estado = "Creado"; hechos++;
    } catch (err) {
      f.ok = false;
      f.estado = err?.code === "auth/email-already-in-use" ? "Ya existe en Authentication" : textoError(err);
    }
  }
  await signOut(auth2).catch(() => {});
  pintarLote(S.lote);
  msg("lMsg", `Se crearon ${hechos} de ${filas.length} usuarios.` + (hechos < filas.length ? " Revisa los que quedaron en rojo." : " Entrega a cada una su usuario y contraseña inicial."), hechos < filas.length);
  $("lCrear").disabled = $("lRevisar").disabled = false;
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
    await setDoc(doc(db, "usuarios", cred.user.uid), { usuario, nombre: $("uNom").value.trim(), rol, farmacia, activo: true, cambiarClave: true });
    await signOut(auth2);
    msg("uMsg", `Usuario "${usuario}" creado con la contraseña inicial "${$("uPass").value}". Entrégasela: al ingresar deberá cambiarla.`);
    e.target.reset(); $("uFarm").disabled = false;
  } catch (err) {
    const t = err?.code === "auth/email-already-in-use" ? "Ese usuario ya existe en Authentication."
      : err?.code === "auth/weak-password" ? "La contraseña debe tener al menos 6 caracteres." : textoError(err);
    msg("uMsg", t, true);
  } finally { $("uBtn").disabled = false; }
});

/* ===================== exportar a Excel ===================== */
let XLSX = null;
async function descargarExcel(filas, nombre, conFarmacia) {
  try { XLSX ??= await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm"); }
  catch { return toast("No se pudo preparar el Excel. Revisa tu internet e inténtalo de nuevo."); }
  const estado = d => d.solicitud?.estado === "pendiente" ? "Reactivación pedida" : d.solicitud?.estado === "rechazada" ? "Reactivación rechazada" : "Bloqueado";
  const datos = filas.sort((a, b) => (a.farmacia + a.producto).localeCompare(b.farmacia + b.producto)).map(d => ({
    ...(conFarmacia ? { Farmacia: corto(d.farmacia), "Almacén (kardex)": d.farmacia } : {}),
    "Código": String(d.codpro).startsWith(SIN_COD) ? "" : d.codpro,
    Producto: d.producto,
    Laboratorio: d.laboratorio || "",
    Motivo: d.motivo,
    Comentario: d.comentario || "",
    Desde: aFecha(d.desde) || "",
    "Bloqueado por": d.porNombre || "",
    Estado: estado(d),
    "En la lista": d.fueraCatalogo ? "No" : "Sí",
    ...(conFarmacia ? { Revisar: d.revisar || "" } : {})
  }));
  const hoja = XLSX.utils.json_to_sheet(datos, { cellDates: true, dateNF: "dd/mm/yyyy" });
  const cols = Object.keys(datos[0] || { Producto: "" });
  hoja["!cols"] = cols.map(c => ({ wch: Math.min(48, Math.max(c.length, ...datos.map(d => String(d[c] instanceof Date ? "00/00/0000" : d[c]).length)) + 2) }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Bloqueados");
  XLSX.writeFile(libro, `${nombre}_${hoyISO()}.xlsx`);
}
const bloqueadosAhora = () => [...S.bloqueos.values()].filter(d => d.estado === "bloqueado");
$("aCsv").addEventListener("click", () => {
  const filas = bloqueadosAhora().filter(d => !S.af.farm || d.farmacia === S.af.farm);
  descargarExcel(filas, "bloqueos_" + (S.af.farm ? corto(S.af.farm) : "todas").replace(/\W+/g, "_").toLowerCase(), true);
});
// La sucursal solo exporta los productos bloqueados en su propia farmacia.
$("qXls").addEventListener("click", () => descargarExcel(bloqueadosAhora().filter(d => d.farmacia === miFarm()),
  "bloqueos_" + corto(miFarm()).replace(/\W+/g, "_").toLowerCase(), false));
