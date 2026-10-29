import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword, updatePassword,
  EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc as fsSet, updateDoc as fsUpdate, deleteDoc as fsDelete, onSnapshot, query, where,
  serverTimestamp, writeBatch as fsBatch, deleteField
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { firebaseConfig, DOMINIO, FARMACIAS, NOMBRES_VISIBLES, MOTIVOS_BLOQUEO, MOTIVOS_REACTIVACION, FORM_URGENCIA } from "./config.js?v=202610280700";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
// La proyección de compras (proyeccion.html, dentro de un marco) usa esta misma conexión y sesión.
window.FB = { auth, db, onAuthStateChanged, doc, getDoc, setDoc: fsSet, deleteDoc: fsDelete, collection, getDocs, onSnapshot };
// En la vista previa ("ver como la sucursal X") no se guarda nada: todas las escrituras se rechazan.
const PREVIA = { message: "Vista previa: aquí no se guarda nada. Sal de la vista previa para hacer cambios." };
const setDoc = (...a) => S.prev ? Promise.reject(PREVIA) : fsSet(...a);
const updateDoc = (...a) => S.prev ? Promise.reject(PREVIA) : fsUpdate(...a);
const deleteDoc = (...a) => S.prev ? Promise.reject(PREVIA) : fsDelete(...a);
const writeBatch = d => { const b = fsBatch(d); if (S.prev) b.commit = () => Promise.reject(PREVIA); return b; };

// Cambiar al publicar cambios en proyeccion.html / proyeccion.js, para que el navegador no use la copia vieja.
const VERSION_PROY = "202610300300";
const VERSION_COMP = "202610281500";

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
// S.prev: el usuario como el que el administrador está viendo la página (vista previa): su rol, sucursal y módulos
const esAdmin = () => S.perfil?.rol === "admin" && !S.prev;
const esQuimicoV = () => S.prev ? S.prev.rol === "quimico" : S.perfil?.rol === "quimico";
// Vistas que el administrador puede darle a cualquier usuario (se guardan en usuarios/{uid}.vistas). Para agregar otra
// más adelante basta con sumarla aquí y crear su sección en index.html.
// c: color del botón en el menú; ic: ícono; desc: lo que se ve en la pantalla de inicio.
const VISTAS = [
  { id: "kardex", nombre: "Kardex", vista: "vKar", c: "kar", ic: "i-bajar", desc: "Subir el kardex del día y publicar las listas", ayuda: "también publica las listas" },
  { id: "proyeccion", nombre: "Proyección de compras", vista: "vProy", ic: "i-grafico", desc: "Pronóstico, reposición y alertas" },
  { id: "comparativo", nombre: "Comparativo", vista: "vComp", c: "comp", ic: "i-lista", desc: "Comparar precios y proveedores" },
  { id: "mapa", nombre: "Mapa de calor", vista: "vMapa", c: "mapa", ic: "i-grafico", desc: "Ventas por sucursal y mes" },
  { id: "estadistica", nombre: "Estadística Proyx", vista: "vEst", c: "est", ic: "i-grafico", desc: "Pronóstico estadístico por producto" },
  { id: "sucursales", nombre: "Atención a sucursales", vista: "vSuc", c: "suc", ic: "i-tienda", desc: "Qué enviar a cada sucursal", ayuda: "también publica las listas" },
  { id: "faltantes", nombre: "Faltantes de droguería", vista: "vFalt", ic: "i-buscar", desc: "Productos en 0 en droguería que piden las sucursales" },
  { id: "atencion", nombre: "Lo que me van a atender", vista: "vAten", ic: "i-ojo", desc: "Lo que Abastecimiento enviará a tu sucursal", ayuda: "solo químicos: ve su sucursal" },
  { id: "pedidos", nombre: "Productos agotados o de extrema urgencia", vista: "vPed", ic: "i-lista", desc: "Lo que cada sucursal pidió de urgencia (desde el formulario)", ayuda: "químicos: ven los de su sucursal" },
  { id: "compras", nombre: "Compras por laboratorio", vista: "vCompL", c: "comp", ic: "i-grafico", desc: "Qué porcentaje de las compras de cada mes fue de cada laboratorio" },
  { id: "evaluacion", nombre: "Evaluación de sucursales", vista: "vEval", c: "est", ic: "i-grafico", desc: "Stock, orden, limpieza, capacidad y BPA de cada sucursal", ayuda: "químicos: ven la de su sucursal" }];
const misVistas = () => esAdmin() ? VISTAS : VISTAS.filter(v => ((S.prev || S.perfil)?.vistas || []).includes(v.id));
const NOMBRE_ROL = { admin: "Administrador", quimico: "Químico", colaborador: "Colaborador" };
const miFarm = () => S.prev ? S.prev.farmacia : S.perfil?.farmacia;

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
// Productos que están en el kardex pero no en catalogo.json (se publica en red/catalogo junto con las listas)
async function cargarCatVivo() {
  try {
    const d = await getDoc(doc(db, "red", "catalogo")); if (!d.exists()) return;
    let n = 0;
    for (const [c, [nom, lab = ""]] of Object.entries(d.data().p || {})) {
      if (S.catIdx.has(c)) continue;
      const p = { c, n: String(nom), l: "", ln: String(lab), k: norm([c, nom, lab].join(" ")) }; S.catalogo.push(p); S.catIdx.set(c, p); n++;
    }
    if (n && S.vista === "vPed") pintarPedidos();
  } catch {}   // sin permiso (usuario sin estos módulos) o sin internet: se queda con catalogo.json
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
  let email = u.includes("@") ? u : `${u}@${DOMINIO}`;
  $("lBtn").disabled = true; $("lErr").hidden = true;
  // si el administrador le restableció la contraseña, su usuario entra con otra cuenta (alias/{usuario})
  if (!u.includes("@")) try { const a = await getDoc(doc(db, "alias", u)); if (a.exists() && a.data().email) email = a.data().email; } catch {}
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
  if (!user) { mostrar("vLogin"); $("top").hidden = true; $("ayuda").hidden = $("ladoIzq").hidden = $("ladoDer").hidden = true; document.body.classList.remove("lado-i", "lado-d"); return; }
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
  await cargarCatalogo(); cargarCatVivo();
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
  if (!["admin", "quimico", "colaborador"].includes(p.rol)) prob.push(`el campo «rol» debe ser admin, quimico o colaborador (ahora dice "${p.rol}")`);
  if (p.activo !== undefined && p.activo !== true && p.activo !== "true") prob.push(`el campo «activo» debe ser boolean true`);
  if (p.rol === "quimico" && !FARMACIAS.includes(p.farmacia)) prob.push(`el campo «farmacia» ("${p.farmacia || ""}") no coincide con ninguna farmacia de config.js`);
  if (prob.length) avisar({ message: "Tu usuario está mal configurado en Firebase (colección usuarios): " + prob.join("; ") + "." });
}

/* ===================== arranque por rol ===================== */
function iniciar() {
  $("top").hidden = false;
  $("uNombre").textContent = S.perfil.nombre || S.perfil.usuario;
  $("uRol").textContent = esAdmin() ? "Abastecimiento" : S.perfil.rol === "colaborador" ? "Colaborador" : nombreFarm(S.perfil.farmacia);
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
    escucharFalt();
    ir("vInicio");
  } else if (S.perfil.rol === "colaborador") {
    // Colaborador: solo ve las vistas que le dio el administrador.
    vigilarPerfil();
    ir("vInicio");
    if (!misVistas().length) avisar({ message: "Tu usuario aún no tiene módulos asignados. Pide a Abastecimiento que te los habilite." });
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
      if (d.farmacia !== S.perfil.farmacia || String(d.rol || "").trim().toLowerCase() !== S.perfil.rol || [false, "false"].includes(d.activo) || d.cambiarClave === true
        || JSON.stringify(d.vistas || []) !== JSON.stringify(S.perfil.vistas || [])) location.reload();
    }));
    ir("vInicio");
  }
  montarAyuda(); escucharAvisos();
  $("prevBtn").hidden = S.perfil.rol !== "admin";
}
// Si el administrador le cambia el rol, las vistas o lo deshabilita, se recarga con los datos nuevos.
function vigilarPerfil() {
  S.subs.push(onSnapshot(doc(db, "usuarios", S.perfil.uid), snap => {
    const d = snap.data() || {};
    if (String(d.rol || "").trim().toLowerCase() !== S.perfil.rol || [false, "false"].includes(d.activo) || d.cambiarClave === true
      || JSON.stringify(d.vistas || []) !== JSON.stringify(S.perfil.vistas || [])) location.reload();
  }));
}
// Después de subir un kardex, los demás módulos abiertos (proyección, estadística, sucursales, mapa) se recargan con los datos nuevos.
window.recargarModulos = origen => {
  for (const id of ["proyFrame", "estFrame", "sucFrame", "mapaFrame", "karFrame"]) {
    const fr = $(id); if (fr?.src && fr.contentWindow !== origen) try { fr.contentWindow.location.reload(); } catch {}
  }
};
function avisar(e) { const a = $("avisoGlobal"); a.hidden = false; a.textContent = e?.code ? textoError(e) : e.message; }

function pintarNav() {
  const pend = [...S.bloqueos.values()].filter(d => d.estado === "bloqueado" && d.solicitud?.estado === "pendiente").length;
  const items = [["vInicio", "🏠 Menú principal", "ini"],
    ...(esAdmin() ? [["vAdmin", "Bloqueos" + (pend ? `<span class="badge">${pend}</span>` : "")],
       ["vUsuarios", "Usuarios" + (solicitudesSucursal().length ? `<span class="badge">${solicitudesSucursal().length}</span>` : "")]]
      : esQuimicoV() ? [["vQuimico", "Bloqueos"]] : []),
    ...misVistas().map(v => [v.vista, v.nombre + (esAdmin() && v.id === "faltantes" && faltSinResp() ? `<span class="badge">${faltSinResp()}</span>` : ""), v.c])];
  const actual = S.vista === "vFicha" ? S.origen : S.vista;
  $("nav").innerHTML = items.map(([v, t, c]) => `<button type="button" data-ir="${v}" ${c ? `class="${c}"` : ""} ${v === actual ? 'aria-current="page"' : ""}>${t}</button>`).join("");
}
$("nav").addEventListener("click", e => { const b = e.target.closest("[data-ir]"); if (b) ir(b.dataset.ir); });

function mostrar(id) { ["vLogin", "vClave", "vInicio", "vQuimico", "vAdmin", "vUsuarios", "vProy", "vComp", "vMapa", "vEst", "vSuc", "vFalt", "vAten", "vPed", "vEval", "vCompL", "vKar", "vFicha"].forEach(v => $(v).hidden = v !== id); }
function ir(vista) {
  // La proyección se carga la primera vez que se abre (es pesada y solo la usa el administrador).
  if (vista === "vProy" && !$("proyFrame").src) $("proyFrame").src = "proyeccion.html?v=" + VERSION_PROY;
  if (vista === "vKar" && !$("karFrame").src) $("karFrame").src = "proyeccion.html?solo=kar&v=" + VERSION_PROY;
  if (vista === "vSuc" && !$("sucFrame").src) $("sucFrame").src = "proyeccion.html?solo=suc&v=" + VERSION_PROY;
  if (vista === "vEst" && !$("estFrame").src) $("estFrame").src = "proyeccion.html?solo=est&v=" + VERSION_PROY;
  if (vista === "vMapa" && !$("mapaFrame").src) $("mapaFrame").src = "proyeccion.html?solo=mapa&v=" + VERSION_PROY;
  if (vista === "vComp" && !$("compFrame").src) $("compFrame").src = "comparativo.html?v=" + VERSION_COMP;
  S.vista = vista; mostrar(vista); render(); scrollTo({ top: 0 }); }
function render() {
  if (!S.perfil) return;
  pintarNav();
  if (S.vista === "vInicio") pintarInicio();
  else if (S.vista === "vQuimico") pintarQuimico();
  else if (S.vista === "vAdmin") pintarAdmin();
  else if (S.vista === "vUsuarios") pintarUsuarios();
  else if (S.vista === "vFicha") pintarFicha();
  else if (S.vista === "vFalt") { escucharFalt(); pintarFalt(); }
  else if (S.vista === "vAten") { escucharAten(); pintarAten(); }
  else if (S.vista === "vPed") { cargarPedidos(); pintarPedidos(); }
  else if (S.vista === "vEval") { cargarEval(); pintarEval(); }
  else if (S.vista === "vCompL") { cargarCompras(); pintarCompras(); }   // escucharFalt vuelve a conectar si se había cortado
  pintarSel("bq"); pintarSel("ab"); pintarLados();
  $("ayuda").classList.toggle("mini", S.vista !== "vInicio");   // fuera del inicio solo el ícono, para no tapar botones
}

/* ===================== inicio (menú principal) ===================== */
const FRASES = [
  "Hoy es un gran día para crear nuevas oportunidades",
  "Cada producto bien atendido es un paciente que se va contento",
  "Los pequeños detalles hacen la gran diferencia",
  "Trabajar en equipo hace que todo salga mejor",
  "La constancia de hoy es el resultado de mañana",
  "Un buen abastecimiento es el corazón de cada farmacia",
  "Hoy es un buen día para dar lo mejor de ti",
  "Ordenar hoy es ganar tiempo mañana",
  "Tu esfuerzo cuida la salud de muchas familias",
  "Con buena actitud todo problema tiene solución",
  "Cada día es una nueva oportunidad para mejorar",
  "Lo que se mide se puede mejorar",
  "La atención con cariño se nota y se agradece",
  "Juntos llegamos más lejos",
  "Un paso a la vez, pero siempre hacia adelante",
  "La calidad empieza por hacer bien lo sencillo",
  "Hoy siembras, mañana cosechas",
  "Que nunca falte lo que nuestros pacientes necesitan",
  "Las metas grandes se logran con trabajo diario",
  "Tu trabajo importa más de lo que imaginas",
  "Sonríe: el buen ánimo también se contagia",
  "Hacerlo bien a la primera ahorra el doble",
  "La organización es la mejor medicina para el estrés",
  "Cada sucursal cuenta, cada persona suma",
  "Hoy es un gran día para aprender algo nuevo",
  "El compromiso convierte una promesa en realidad",
  "Servir bien es nuestra mejor carta de presentación",
  "Lo importante no es correr, es no detenerse",
  "Con datos claros se toman mejores decisiones",
  "Gracias por ser parte de este gran equipo",
  "La disciplina de hoy es la tranquilidad de mañana"
];
const fechaHoy = () => new Date().toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
function pintarInicio() {
  const p = S.perfil, hoy = new Date(), dia = Math.floor((hoy - new Date(hoy.getFullYear(), 0, 0)) / 864e5);
  $("iniFrase").textContent = `“${FRASES[dia % FRASES.length]}, Farmacia Socorro.”`;
  const larga = hoy.toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  $("iniFirma").textContent = larga[0].toUpperCase() + larga.slice(1) + " · " + fechaHoy();
  pintarAvisosInicio();
  $("iniHola").textContent = `Hola, ${(p.nombre || p.usuario || "").split(" ")[0]} 👋 ¿Qué haremos hoy?`;
  const mods = [
    ...(esAdmin() ? [{ vista: "vAdmin", nombre: "Bloqueos", ic: "i-candado", desc: "Productos bloqueados y reactivaciones" },
      { vista: "vUsuarios", nombre: "Usuarios", ic: "i-usuario", desc: "Crear usuarios y darles módulos" }]
      : esQuimicoV() ? [{ vista: "vQuimico", nombre: "Bloqueos", ic: "i-candado", desc: "Bloquear productos en tu farmacia" }] : []),
    ...misVistas()];
  $("iniMods").innerHTML = mods.length ? mods.map(m => `<button type="button" class="ini-mod ${esc(m.c || "")}" data-ir="${m.vista}">
      <span class="im-ic"><svg width="26" height="26"><use href="#${m.ic || "i-lista"}"/></svg></span><b>${esc(m.nombre)}</b><small>${esc(m.desc || "")}</small></button>`).join("")
    : `<p class="muted">Aún no tienes módulos asignados. Pide a Abastecimiento que te los habilite.</p>`;
}
function pintarUsuarioDlg() {
  const p = S.perfil, fila = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  $("iniDatos").innerHTML = fila("Nombre", esc(p.nombre || "–")) + fila("Usuario", esc(p.usuario || auth.currentUser?.email || "–"))
    + fila("Rol", esc(NOMBRE_ROL[p.rol] || p.rol)) + (p.farmacia ? fila("Sucursal", esc(nombreFarm(p.farmacia))) : "")
    + fila("Módulos", esAdmin() ? "Todos" : (misVistas().map(v => esc(v.nombre)).join("<br>") || "Ninguno"));
}
$("uAbrir").addEventListener("click", () => {
  pintarUsuarioDlg(); $("iniNomF").hidden = $("iniClaveF").hidden = true; $("iniNomF").reset(); $("iniClaveF").reset();
  msg("iniNomMsg", ""); msg("iniClaveMsg", ""); $("uDlg").showModal();
});
$("uDatosBtn").addEventListener("click", () => { const f = $("iniNomF"); f.hidden = !f.hidden; $("iniClaveF").hidden = true; $("iniNom").value = S.perfil.nombre || ""; if (!f.hidden) $("iniNom").focus(); });
$("uClaveBtn").addEventListener("click", () => { const f = $("iniClaveF"); f.hidden = !f.hidden; $("iniNomF").hidden = true; if (!f.hidden) $("iniActual").focus(); });
$("uDlg").addEventListener("click", e => { if (e.target.closest("[data-cerrar-u]") || e.target === $("uDlg")) $("uDlg").close(); });
$("iniMods").addEventListener("click", e => { const b = e.target.closest("[data-ir]"); if (b) ir(b.dataset.ir); });
$("iniNomF").addEventListener("submit", async e => {
  e.preventDefault();
  const nombre = $("iniNom").value.trim().replace(/\s+/g, " ");
  if (nombre.length < 3) return msg("iniNomMsg", "Escribe tu nombre completo.", true);
  try {
    await updateDoc(doc(db, "usuarios", S.perfil.uid), { nombre, cambiarClave: false });
    S.perfil.nombre = nombre; $("uNombre").textContent = nombre; msg("iniNomMsg", "✓ Nombre guardado."); pintarUsuarioDlg(); if (S.vista === "vInicio") pintarInicio();
  } catch (x) { msg("iniNomMsg", textoError(x), true); }
});
$("iniClaveF").addEventListener("submit", async e => {
  e.preventDefault();
  const actual = $("iniActual").value, nueva = $("iniNueva").value;
  if (nueva.length < 6) return msg("iniClaveMsg", "La contraseña nueva debe tener al menos 6 caracteres.", true);
  if (nueva !== $("iniRepite").value) return msg("iniClaveMsg", "Las dos contraseñas nuevas no coinciden.", true);
  if (nueva === actual) return msg("iniClaveMsg", "La contraseña nueva debe ser distinta a la actual.", true);
  const b = e.target.querySelector("button"); b.disabled = true;
  try {
    const u = auth.currentUser;
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, actual));
    await updatePassword(u, nueva);
    e.target.reset(); msg("iniClaveMsg", "✓ Contraseña cambiada. Úsala desde ahora para ingresar.");
  } catch (x) {
    msg("iniClaveMsg", ["auth/wrong-password", "auth/invalid-credential", "auth/invalid-login-credentials"].includes(x?.code) ? "La contraseña actual no es correcta."
      : x?.code === "auth/too-many-requests" ? "Demasiados intentos. Espera unos minutos." : x?.code === "auth/weak-password" ? "La contraseña nueva es muy débil." : textoError(x), true);
  } finally { b.disabled = false; }
});

// Avisos a la izquierda e información a la derecha (en pantallas anchas; en las angostas se ven dentro de la página).
function pintarLados() {
  if (!S.perfil) return;
  // cada aviso en su módulo: generales en el menú principal, el cierre en Bloqueos, "de prueba" en lo que me van a atender
  const av = [], inf = [], e = !esAdmin() && estadoCierre(S.perfil.cierre);
  if (S.vista === "vInicio") av.push(...htmlAvisos());
  if (S.vista === "vQuimico" && e) av.push(`<div class="aviso cierre-aviso${e.vigente ? "" : " prox"}">${esc(avisoCierre(e))}</div>`);
  if (S.vista === "vAten") {
    av.push(`<div class="aviso prueba">🧪 Módulo de prueba · solo informativo. Los datos pueden cambiar; ante cualquier duda consulta con Abastecimiento.</div>`);
    if ($("atFiltro").innerHTML.trim()) inf.push(`<div class="at-filtro">${$("atFiltro").innerHTML}</div>`);
  }
  $("avisosLado").innerHTML = av.join(""); $("infoLado").innerHTML = inf.join("");
  $("ladoIzq").hidden = !av.length; $("ladoDer").hidden = !inf.length;
  document.body.classList.toggle("lado-i", !!av.length); document.body.classList.toggle("lado-d", !!inf.length);
}

// Avisos generales: los publica el administrador (colección avisos) y los ven todos en el menú principal
S.avisos = [];
const htmlAvisos = () => S.avisos.map(a => `<div class="aviso general">📢 ${esc(a.texto)}<small>${esc(a.porNombre || "Abastecimiento")} · ${fmtF(a.fecha)}</small></div>`);
function escucharAvisos() {
  S.subs.push(onSnapshot(collection(db, "avisos"), sn => {
    S.avisos = sn.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (aFecha(b.fecha) || 0) - (aFecha(a.fecha) || 0));
    if (S.vista === "vInicio") render();
  }, () => {}));
}
function pintarAvisosInicio() {
  const h = htmlAvisos(); $("iniAvisos").innerHTML = h.join(""); $("iniAvisos").hidden = !h.length;
  $("iniAdmAv").hidden = !esAdmin(); if (!esAdmin()) return;
  $("avLista").innerHTML = S.avisos.length ? S.avisos.map(a => `<div class="av-item"><span>${esc(a.texto)} <small>· ${fmtF(a.fecha)}</small></span><button type="button" class="btn sm peligro" data-quitar-av="${esc(a.id)}">Quitar</button></div>`).join("")
    : '<small class="muted">No hay avisos publicados.</small>';
}
$("avForm").addEventListener("submit", async e => {
  e.preventDefault(); const texto = $("avTxt").value.trim(); if (!texto) return;
  try { await setDoc(doc(collection(db, "avisos")), { texto, porNombre: S.perfil.nombre || S.perfil.usuario, porUid: S.perfil.uid, fecha: serverTimestamp() }); $("avTxt").value = ""; toast("Aviso publicado para todos"); }
  catch (x) { toast(textoError(x)); }
});
$("avLista").addEventListener("click", async e => {
  const b = e.target.closest("[data-quitar-av]"); if (!b || !confirm("¿Quitar este aviso para todos?")) return;
  try { await deleteDoc(doc(db, "avisos", b.dataset.quitarAv)); toast("Aviso quitado"); } catch (x) { toast(textoError(x)); }
});

// ¿En qué podemos ayudarte hoy? → WhatsApp de Abastecimiento
const WHATSAPP = "51903203799";
function montarAyuda() {
  const p = S.perfil;
  $("ayudaWa").href = `https://wa.me/${WHATSAPP}?text=` + encodeURIComponent(`Hola, soy ${p.nombre || p.usuario}${p.farmacia ? " de " + nombreFarm(p.farmacia) : ""}. Necesito ayuda con Socorro Abastecimiento.`);
  $("ayuda").hidden = false;
}
const ayudaPanel = abrir => { $("ayudaPanel").hidden = !abrir; $("ayudaBurbuja").hidden = abrir || S.ayudaCerrada; };
$("ayudaBtn").addEventListener("click", () => ayudaPanel($("ayudaPanel").hidden));
$("ayudaAbrir").addEventListener("click", () => ayudaPanel(true));
$("ayudaPX").addEventListener("click", () => ayudaPanel(false));
$("ayudaX").addEventListener("click", () => { S.ayudaCerrada = true; $("ayudaBurbuja").hidden = true; });

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
function avisoCierre(e) {
  const t = textoCierre(e), punto = t.endsWith(".") ? " " : ". ";
  return t + (e.vigente ? punto + "Mientras tanto no puedes bloquear productos ni enviar solicitudes." : punto.trim()) + (e.motivo ? " Motivo: " + e.motivo : "");
}
function pintarCierreQuimico() {
  const e = estadoCierre(S.perfil?.cierre), a = $("qCierre");
  a.hidden = !e;
  if (e) { a.className = "aviso cierre-aviso inline-lado" + (e.vigente ? "" : " prox"); a.textContent = avisoCierre(e); }
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

// línea del producto (Fármacos, Cosméticos, Pañales…), de clasificacion.json por el nombre del producto
const lineaDe = d => GEN?.lin(d.producto) || GEN?.lin(S.catIdx.get(String(d.codpro))?.n) || "";
function pintarAdmin() {
  if (!GEN) cargarGenericos().then(() => S.vista === "vAdmin" && pintarAdmin());
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
  $("aTabla").innerHTML = `<thead><tr><th>Producto</th><th>Línea</th><th>Farmacia</th><th>Motivo</th><th>Por</th><th>Desde</th><th>Revisar</th></tr></thead><tbody>` +
    (lista.length ? lista.map(d => {
      const vencida = d.estado === "bloqueado" && d.revisar && d.revisar <= hoy;
      return `<tr class="clic ${vencida ? "revisar" : ""}" data-ficha="${esc(d.id)}" tabindex="0">
        <td class="p"><b>${esc(d.producto)}</b><code>${esc(codVis(d.codpro))}${d.fueraCatalogo ? " · fuera de la lista" : ""}${d.laboratorio ? " · " + esc(d.laboratorio) : ""}</code></td>
        <td>${lineaDe(d) ? `<span class="tag">${esc(lineaDe(d))}</span>` : '<span class="muted">–</span>'}</td>
        <td>${esc(corto(d.farmacia))}</td>
        <td>${d.estado === "activo" ? `<span class="tag t-ok">Reactivado</span>` : tagMotivo(d.motivo)} ${d.estado === "bloqueado" ? etiquetaSolicitud(d) : ""}</td>
        <td>${esc(d.porNombre)}</td>
        <td class="f">${fmtF(d.desde)}</td>
        <td class="f ${vencida ? "mal" : ""}">${d.revisar ? fmtF(d.revisar) : "–"}</td>
      </tr>`; }).join("") : `<tr class="vacia"><td colspan="7">No hay registros con estos filtros.</td></tr>`) + "</tbody>";
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
$("uRolSel").addEventListener("change", () => { $("uFarm").disabled = $("uRolSel").value !== "quimico"; });
const chkVistas = (sel = []) => VISTAS.map(v => `<label class="check"><input type="checkbox" data-vista="${esc(v.id)}" ${sel.includes(v.id) ? "checked" : ""}> ${esc(v.nombre)}${v.ayuda ? ` <small class="muted">(${esc(v.ayuda)})</small>` : ""}</label>`).join("");
$("uVistas").innerHTML = chkVistas();
const vistasDe = el => [...el.querySelectorAll("[data-vista]:checked")].map(x => x.dataset.vista);
function pintarUsuarios() {
  const lista = S.usuarios.filter(u => !u.reemplazadoPor).sort((a, b) => (a.rol + a.farmacia + a.usuario).localeCompare(b.rol + b.farmacia + b.usuario));
  const opcFarm = sel => FARMACIAS.map(f => `<option value="${esc(f)}" ${f === sel ? "selected" : ""}>${esc(corto(f))}</option>`).join("");
  const fila = u => `<tr class="${u.activo === false ? "inactivo" : ""}">
      <td class="f">${esc(u.usuario)}</td><td>${u.nombre ? esc(u.nombre) : '<span class="muted">Lo escribirá al ingresar</span>'}</td>
      <td>${NOMBRE_ROL[u.rol] || esc(u.rol)}${(u.vistas || []).map(id => `<br><span class="tag">${esc(VISTAS.find(v => v.id === id)?.nombre || id)}</span>`).join("")}</td><td>${esc(u.farmacia ? corto(u.farmacia) : "–")}</td>
      <td>${u.cambiarClave === true ? '<span class="tag t-pend">Aún no cambia su contraseña</span>' : '<span class="tag t-ok">Contraseña propia</span>'}${u.activo === false ? ' <span class="tag t-rech">Deshabilitado</span>' : ""}</td>
      <td class="der"><div class="botones-fila">${u.uid === S.perfil.uid ? '<span class="muted">Tú</span>' :
        `<button class="btn sm" type="button" data-editar="${esc(u.uid)}">Editar</button>
         <button class="btn sm" type="button" data-toggle="${esc(u.uid)}">${u.activo === false ? "Habilitar" : "Deshabilitar"}</button>
         <button class="btn sm" type="button" data-reset="${esc(u.uid)}" title="Si olvidó su contraseña: le das una temporal y al entrar crea la suya">🔑 Restablecer contraseña</button>`}</div></td>
    </tr>`;
  // Fila de edición debajo del usuario elegido.
  const edicion = u => `<tr class="editando"><td colspan="6">
      <div class="edit-grid" data-uid="${esc(u.uid)}">
        <label class="filtro">Nombre<input data-e="nombre" value="${esc(u.nombre || "")}" maxlength="60" placeholder="Nombre completo"></label>
        <label class="filtro">Sucursal<select data-e="farmacia" ${u.rol !== "quimico" ? "disabled" : ""}>${opcFarm(u.farmacia)}</select></label>
        <label class="filtro">Rol<select data-e="rol">${["quimico", "colaborador", "admin"].map(r => `<option value="${r}" ${u.rol === r || (r === "quimico" && !NOMBRE_ROL[u.rol]) ? "selected" : ""}>${NOMBRE_ROL[r]}</option>`).join("")}</select></label>
        <div class="filtro">Vistas<div class="vistas-chk">${chkVistas(u.vistas || [])}</div></div>
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
  if (e.target.dataset.e === "rol") e.target.closest(".edit-grid").querySelector('[data-e="farmacia"]').disabled = e.target.value !== "quimico";
});
$("uTabla").addEventListener("click", async e => {
  const ed = e.target.closest("[data-editar]");
  if (ed) { S.editando = S.editando === ed.dataset.editar ? null : ed.dataset.editar; return pintarUsuarios(); }
  if (e.target.closest("[data-cancelar]")) { S.editando = null; return pintarUsuarios(); }
  if (e.target.closest("[data-guardar]")) {
    const g = e.target.closest(".edit-grid"), v = k => g.querySelector(`[data-e="${k}"]`);
    const rol = v("rol").value, cambio = {
      nombre: v("nombre").value.trim().replace(/\s+/g, " "),
      rol, farmacia: rol === "quimico" ? v("farmacia").value : "",
      cambiarClave: v("cambiarClave").checked, vistas: vistasDe(g)
    };
    try { await setDoc(doc(db, "usuarios", g.dataset.uid), cambio, { merge: true }); S.editando = null; toast("Usuario actualizado"); pintarUsuarios(); }
    catch (err) { toast(textoError(err)); }
    return;
  }
  const rs = e.target.closest("[data-reset]"); if (rs) return restablecerClave(S.usuarios.find(x => x.uid === rs.dataset.reset));
  const b = e.target.closest("[data-toggle]"); if (!b) return;
  const u = S.usuarios.find(x => x.uid === b.dataset.toggle);
  try { await setDoc(doc(db, "usuarios", u.uid), { activo: u.activo === false }, { merge: true }); toast(u.activo === false ? "Usuario habilitado" : "Usuario deshabilitado"); }
  catch (err) { toast(textoError(err)); }
});
// Olvidó su contraseña: Firebase no deja cambiar la de otra persona desde la página, así que se le crea una cuenta
// nueva con una contraseña temporal, se le copia su perfil (rol, sucursal, módulos) y su usuario apunta a la cuenta
// nueva (alias/{usuario}). La cuenta vieja queda deshabilitada. En su próximo ingreso crea su propia contraseña.
async function restablecerClave(u) {
  if (!u || !confirm(`¿Restablecer la contraseña de ${u.nombre || u.usuario}?\n\nSe le dará una contraseña temporal; al ingresar tendrá que crear la suya.`)) return;
  const temp = "Socorro" + String(crypto.getRandomValues(new Uint32Array(1))[0] % 9000 + 1000);
  const email = `${u.usuario}.r${Date.now().toString(36)}@${DOMINIO}`;
  const app2 = initializeApp(firebaseConfig, "reset-" + Date.now()), auth2 = getAuth(app2);
  try {
    const cred = await createUserWithEmailAndPassword(auth2, email, temp);
    const { uid: _uid, ...perfil } = u;
    await setDoc(doc(db, "usuarios", cred.user.uid), { ...perfil, activo: true, cambiarClave: true, emailLogin: email, reemplazadoPor: deleteField(), restablecido: serverTimestamp() }, { merge: true });
    await setDoc(doc(db, "alias", u.usuario), { email, uid: cred.user.uid, fecha: serverTimestamp() });
    await setDoc(doc(db, "usuarios", u.uid), { activo: false, reemplazadoPor: cred.user.uid }, { merge: true });
    await signOut(auth2).catch(() => {});
    $("rsUsr").textContent = u.usuario; $("rsClave").textContent = temp; $("rsDlg").showModal();
  } catch (err) { toast(err?.code === "permission-denied" ? "Falta publicar las reglas nuevas (firestore.rules) en Firebase." : textoError(err)); }
}
$("rsDlg").addEventListener("click", e => { if (e.target.closest("[data-cerrar-dlg]") || e.target === $("rsDlg")) $("rsDlg").close(); });
$("rsCopiar").addEventListener("click", () => { navigator.clipboard?.writeText(`Usuario: ${$("rsUsr").textContent}\nContraseña temporal: ${$("rsClave").textContent}`); toast("Copiado"); });
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
  const farmacia = rol === "quimico" ? $("uFarm").value : "";
  if (S.usuarios.some(u => u.usuario === usuario)) return msg("uMsg", "Ese usuario ya existe.", true);
  $("uBtn").disabled = true; msg("uMsg", "Creando…");
  // Una segunda conexión crea el usuario sin cerrar tu sesión.
  const app2 = initializeApp(firebaseConfig, "crear-" + Date.now()), auth2 = getAuth(app2);
  try {
    const cred = await createUserWithEmailAndPassword(auth2, `${usuario}@${DOMINIO}`, $("uPass").value);
    await setDoc(doc(db, "usuarios", cred.user.uid), { usuario, nombre: $("uNom").value.trim(), rol, farmacia, activo: true, cambiarClave: true, vistas: vistasDe($("uVistas")) });
    await signOut(auth2);
    msg("uMsg", `Usuario "${usuario}" creado con la contraseña inicial "${$("uPass").value}". Entrégasela: al ingresar deberá cambiarla.`);
    e.target.reset(); $("uFarm").disabled = false; $("uVistas").innerHTML = chkVistas();
  } catch (err) {
    const t = err?.code === "auth/email-already-in-use" ? "Ese usuario ya existe en Authentication."
      : err?.code === "auth/weak-password" ? "La contraseña debe tener al menos 6 caracteres." : textoError(err);
    msg("uMsg", t, true);
  } finally { $("uBtn").disabled = false; }
});

/* ===================== faltantes de droguería (vista para colaboradores y el administrador) ===================== */
// La lista la publica el administrador desde Atención a sucursales (faltantes/actual); cada respuesta es un
// documento en faltantes_estado/{código}.
const ESTADOS_F = [
  { id: "descontinuado", letra: "A", txt: "Descontinuado" },
  { id: "agotado", letra: "B", txt: "Agotado en laboratorio" },
  { id: "transito", letra: "C", txt: "En tránsito" },
  { id: "pendiente", letra: "D", txt: "Pendiente de solicitud" },
  { id: "alternativa", letra: "E", txt: "Existe otro medicamento" }];
const PLAZOS = [["1s", "1 semana", 7], ["2s", "2 semanas", 14], ["1m", "1 mes", 30], ["2m", "2 meses", 60], ["3m", "3 meses", 90], ["otra", "Otra fecha", 0]];
S.falt = null; S.fEst = new Map(); S.fFil = { est: "sin", lab: "", suc: "", q: "" }; S.fAbierto = null; S.fAlt = []; S.fMostrar = 100;
// Una respuesta con fecha (agotado hasta / llega el) vence si pasó la fecha y el producto sigue faltando:
// vuelve a "Sin responder" mostrando lo que se había respondido.
const vencida = e => { const h = hoyISO(); return !!e && ((e.estado === "agotado" && e.hasta && e.hasta < h) || (e.estado === "transito" && e.llega && e.llega < h)); };
const estVig = c => { const e = S.fEst.get(c); return e && !vencida(e) ? e : null; };
const faltSinResp = () => (S.falt?.items || []).filter(i => !estVig(i.c)).length;
function escucharFalt() {
  if (S.faltSubs) return; S.faltSubs = true;
  S.subs.push(onSnapshot(doc(db, "faltantes", "actual"), sn => { S.falt = sn.exists() ? sn.data() : { items: [] }; pintarNav(); if (S.vista === "vFalt") pintarFalt(); },
    e => { S.faltSubs = false; avisar(e); }));
  S.subs.push(onSnapshot(collection(db, "faltantes_estado"), sn => { S.fEst = new Map(sn.docs.map(d => [d.id, d.data()])); pintarNav(); if (S.vista === "vFalt" && !S.fAbierto) pintarFalt(); },
    () => { S.faltSubs = false; }));
}
const sumarDias = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const fDia = v => v ? new Date(v + "T12:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
function textoEstado(e) {
  if (!e) return "";
  const t = ESTADOS_F.find(x => x.id === e.estado)?.txt || e.estado;
  return e.estado === "agotado" && e.hasta ? `${t} hasta el ${fDia(e.hasta)}`
    : e.estado === "transito" && e.llega ? `${t} · llega el ${fDia(e.llega)}`
    : e.estado === "alternativa" ? `${t}: ${(e.alternativas || []).map(a => `${a.c} ${a.n}`).join(" / ")}`
    : e.estado === "descontinuado" && e.alternativas?.length ? `${t} · lo reemplaza: ${e.alternativas.map(a => `${a.c} ${a.n}`).join(" / ")}` : t;
}
// Solo el administrador: genera y publica la lista con los datos de la proyección (abre en segundo plano el
// módulo Atención a sucursales, que es el que la calcula).
async function generarFalt() {
  if (!esAdmin() || S.fGenerando) return; S.fGenerando = true;
  $("fsGenBtn").disabled = true; $("fsGenMsg").textContent = "Calculando con los datos de la proyección… (puede tardar un minuto)";
  try {
    if (!$("sucFrame").src) $("sucFrame").src = "proyeccion.html?solo=suc&v=" + VERSION_PROY;
    let w = null;
    for (let i = 0; i < 120 && !(w = $("sucFrame").contentWindow)?.publicarFaltantes; i++) await new Promise(r => setTimeout(r, 500));
    const r = w?.publicarFaltantes ? await w.publicarFaltantes() : { ok: false, error: "no se pudo abrir Atención a sucursales" };
    $("fsGenMsg").textContent = r.ok ? `Lista publicada: ${nf(r.n)} productos.` : "No se pudo: " + r.error;
    // se lee de nuevo y se vuelve a escuchar, por si la conexión en vivo se había cortado
    if (r.ok) { const sn = await getDoc(doc(db, "faltantes", "actual")); S.falt = sn.exists() ? sn.data() : { items: [] }; S.faltSubs = false; escucharFalt(); pintarNav(); pintarFalt(); }
  } catch (e) { $("fsGenMsg").textContent = "No se pudo: " + (e.message || e); }
  finally { S.fGenerando = false; $("fsGenBtn").disabled = false; }
}
$("fsGenBtn").addEventListener("click", generarFalt);
function pintarFalt() {
  const F = S.falt, items = F?.items || [], f = S.fFil;
  $("fsGen").hidden = !esAdmin();
  // si aún no hay lista, el administrador la genera al abrir esta vista
  if (esAdmin() && S.falt && !F?.publicado && !S.fAutoGen) { S.fAutoGen = true; generarFalt(); }
  $("fsSub").textContent = F?.publicado
    ? `Productos en 0 en droguería que piden las sucursales para ${F.C} días + ${F.Sg} de seguridad (datos al ${fmtF(F.corte)}, lista del ${new Date(F.publicado).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}). Primero los que faltan en más sucursales y en más cantidad.`
    : "Aún no hay lista publicada. Abastecimiento la publica desde Atención a sucursales.";
  // conteos por estado
  const cuenta = { sin: 0, todos: items.length }; for (const x of ESTADOS_F) cuenta[x.id] = 0;
  for (const i of items) { const e = estVig(i.c); cuenta[e ? e.estado : "sin"]++; }
  const opc = [["sin", "Sin responder"], ...ESTADOS_F.map(x => [x.id, `${x.letra}. ${x.txt}`]), ["todos", "Todos"]];
  $("fsChips").innerHTML = opc.map(([id, t]) => `<button type="button" class="fs-chip ${id}" data-est="${id}" aria-pressed="${f.est === id}"><b>${nf(cuenta[id] || 0)}</b><span>${esc(t)}</span></button>`).join("");
  $("fsEst").innerHTML = opc.map(([id, t]) => `<option value="${id}" ${f.est === id ? "selected" : ""}>${esc(t)} (${nf(cuenta[id] || 0)})</option>`).join("");
  const labs = [...new Set(items.map(i => i.l).filter(Boolean))].sort();
  $("fsLab").innerHTML = `<option value="">Todos</option>` + labs.map(l => `<option ${l === f.lab ? "selected" : ""}>${esc(l)}</option>`).join("");
  const sucs = [...new Set(items.flatMap(i => i.s.map(x => x.f)))].sort();
  $("fsSuc").innerHTML = `<option value="">Todas</option>` + sucs.map(x => `<option value="${esc(x)}" ${x === f.suc ? "selected" : ""}>${esc(corto(x))}</option>`).join("");
  const q = norm(f.q).trim();
  const lista = items.filter(i => {
    const e = estVig(i.c);
    if (f.est === "sin" ? e : f.est !== "todos" && e?.estado !== f.est) return false;
    if (f.lab && i.l !== f.lab) return false;
    if (f.suc && !i.s.some(x => x.f === f.suc)) return false;
    return !q || q.split(/\s+/).every(w => norm(i.c + " " + i.n + " " + i.l).includes(w));
  });
  S.fLista = lista;
  const vis = lista.slice(0, S.fMostrar);
  $("fsTit").textContent = `${opc.find(x => x[0] === f.est)?.[1] || ""}: ${nf(lista.length)} productos`;
  $("fsTabla").innerHTML = `<thead><tr><th>Producto</th><th class="at-ojo">Información</th><th>Le falta a</th><th class="der">Total</th><th>Estado</th><th class="der">Acción</th></tr></thead><tbody>` +
    (vis.length ? vis.map(i => {
      const e = estVig(i.c), ev = !e ? S.fEst.get(i.c) : null, ab = S.fAbierto === i.c;
      return `<tr class="${ab ? "abierta" : ""}"><td class="p"><b>${esc(i.c)} - ${esc(i.n)}</b><code>${esc(i.l || "")}</code></td>
        <td class="at-ojo">${i.hv ? `<button type="button" class="at-ibtn" data-finfo="${esc(i.c)}" title="Ver la información de este producto" aria-label="Información de ${esc(i.n)}">${OJO}</button>` : ""}</td>
        <td><div class="fs-sucs"><span class="fs-n">${i.s.length} suc.</span>${i.s.map(x => `<span class="fs-suc">${esc(corto(x.f))} <b>${nf(x.q)}</b></span>`).join("")}</div></td>
        <td class="der"><b>${nf(i.t)}</b></td>
        <td>${e ? `<span class="tag fs-tag ${esc(e.estado)}">${esc(textoEstado(e))}</span><small class="fs-quien">${esc(e.porNombre || "")} · ${fmtF(e.fecha)}${e.comentario ? " · " + esc(e.comentario) : ""}</small>`
          : ev ? `<span class="muted">Sin responder</span><span class="tag fs-tag vencida">Venció: ${esc(textoEstado(ev))}</span><small class="fs-quien">Respondió ${esc(ev.porNombre || "")} · ${fmtF(ev.fecha)}${ev.comentario ? " · " + esc(ev.comentario) : ""} · sigue faltando: vuelve a responder</small>` : '<span class="muted">Sin responder</span>'}</td>
        <td class="der"><button class="btn sm${e ? "" : " primario"}" type="button" data-resp="${esc(i.c)}">${e ? "Cambiar" : "Responder"}</button></td></tr>`;
    }).join("") : `<tr class="vacia"><td colspan="6">${items.length ? "Nada con estos filtros." : "Sin productos."}</td></tr>`) + "</tbody>";
  ventanaResp("fsDlg", S.fAbierto && (() => { const i = (S.falt?.items || []).find(x => x.c === S.fAbierto); if (!i) return "";
    const e = estVig(i.c) || S.fEst.get(i.c); return `<h2>${esc(i.c)} - ${esc(i.n)}</h2><p class="muted">${esc(i.l || "")} · le falta a ${i.s.length} sucursales (${nf(i.t)} cajas)</p>` + formResp(i, e); })());
  $("fsMas").innerHTML = lista.length > vis.length ? `<button class="btn" type="button" id="fsMasBtn">Ver ${Math.min(100, lista.length - vis.length)} más (de ${nf(lista.length)})</button>` : "";
}
const nf = v => Number(v || 0).toLocaleString("es-PE");
// Genérico de cada producto del catálogo (clasificacion.json, por nombre): para ofrecer primero los del mismo genérico.
const MAX_ALT = 4;
let GEN = null;
function cargarGenericos() {
  cargarGenericos.p ??= fetch("clasificacion.json").then(r => r.json()).then(c => {
    const nomN = x => String(x || "").trim().toUpperCase().replace(/\s+/g, " "), g = { de: new Map(), por: new Map() };
    for (const p of S.catalogo) {
      const a = c.p[nomN(p.n)], ge = a && c.g[a[1]]; if (!ge) continue;
      g.de.set(p.c, ge); if (!g.por.has(ge)) g.por.set(ge, []); g.por.get(ge).push(p);
    }
    g.nom = n => { const x = c.p[nomN(n)]; return (x && c.g[x[1]]) || ""; };
    g.lin = n => { const x = n && c.p[nomN(n)]; return (x && c.t[x[0]]) || ""; };   // por el nombre, si el código no está en el catálogo
    GEN = g;
  }).catch(() => { GEN = { de: new Map(), por: new Map(), nom: () => "", lin: () => "" }; }).then(() => { if (S.fAbierto) pintarFalt(); });
  return cargarGenericos.p;
}
const genDe = i => i?.ge || GEN?.de.get(i?.c) || GEN?.nom(i?.n) || "";
// buscador del listado general (todos los medicamentos): primero los del mismo genérico
function resBusqueda(i, texto, fuera, attr) {
  if (!texto.trim()) return "";
  const ge = genDe(i), q = norm(texto).trim().split(/\s+/);
  const deGen = ge && GEN ? (GEN.por.get(ge) || []).filter(p => q.every(w => p.k.includes(w))) : [];
  const r = [...new Set([...buscarCat(texto), ...deGen])].filter(p => p.c !== i.c && !fuera(p)).slice(0, 15);
  return r.length ? r.map(p => `<button type="button" ${attr}="${esc(p.c)}"><b>${esc(p.c)}</b> ${esc(p.n)}${p.ln ? ` <small>${esc(p.ln)}</small>` : ""}${ge && GEN?.de.get(p.c) === ge ? ' <span class="tag t-ok">mismo genérico</span>' : ""}</button>`).join("")
    : '<small class="muted" style="padding:8px;display:block">No se encontró ningún medicamento con ese código o nombre.</small>';
}
// sin genérico conocido: los de nombre parecido (las dos primeras palabras del nombre)
const parecidos = i => { const w = norm(i?.n).replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter(x => x.length > 2).slice(0, 2); return w.length ? S.catalogo.filter(p => p.c !== i.c && w.every(x => p.k.includes(x))).slice(0, 30) : []; };
function formResp(i, e) {
  const st = S.fForm || {};
  const est = st.estado ?? e?.estado ?? "";
  const plazo = st.plazo ?? (e?.plazo || "1m");
  const alts = S.fAlt;
  return `<div class="fs-form" data-c="${esc(i.c)}">
    <fieldset><legend>¿Qué pasa con este producto?</legend><div class="pills fs-pills">${ESTADOS_F.map(x => `<label class="${x.id}"><input type="radio" name="fsEstado" value="${x.id}" ${est === x.id ? "checked" : ""}>${x.letra}. ${esc(x.txt)}</label>`).join("")}</div></fieldset>
    ${est === "agotado" ? `<div class="campo"><span class="lbl">¿Hasta cuándo?</span><div class="pills verde fs-plazos">${PLAZOS.map(([id, t]) => `<label><input type="radio" name="fsPlazo" value="${id}" ${plazo === id ? "checked" : ""}>${t}</label>`).join("")}</div>
      ${plazo === "otra" ? `<input type="date" id="fsHasta" value="${esc(st.hasta ?? e?.hasta ?? "")}" min="${hoyISO()}">` : `<small class="ayuda">Hasta el ${fDia(sumarDias(PLAZOS.find(p => p[0] === plazo)?.[2] || 30))}</small>`}</div>` : ""}
    ${est === "transito" ? `<div class="campo"><label for="fsLlega">Fecha estimada de llegada (opcional)</label><input type="date" id="fsLlega" value="${esc(st.llega ?? e?.llega ?? "")}"></div>` : ""}
    ${est === "alternativa" ? formAlt(i, alts) : est === "descontinuado" ? formAlt(i, alts, true) : ""}
    <div class="campo"><label for="fsCom">Comentario (opcional)</label><input id="fsCom" maxlength="200" value="${esc(st.comentario ?? e?.comentario ?? "")}" placeholder="Ej. proveedor confirma reposición"></div>
    <div class="msg" id="fsMsg" hidden></div>
    <div class="botones-fila"><button class="btn sm primario" type="button" data-guardar-f>Guardar</button>${e ? '<button class="btn sm" type="button" data-borrar-f>Quitar respuesta</button>' : ""}<button class="btn sm" type="button" data-cerrar-f>Cancelar</button></div>
  </div>`;
}
function formAlt(i, alts, opcional) {
  const ge = genDe(i), mismos = (ge && GEN ? (GEN.por.get(ge) || []) : GEN ? parecidos(i) : []).filter(p => p.c !== i.c && !alts.some(a => a.c === p.c));
  return `<div class="campo buscador"><span class="lbl">${opcional ? "¿Lo reemplaza otro medicamento? (opcional; si no hay, déjalo vacío)" : "Medicamentos que lo reemplazan"} (hasta ${MAX_ALT}) · elegidos ${alts.length} de ${MAX_ALT}</span>
    <div class="fs-alts">${alts.map((a, k) => `<span class="fs-alt">${esc(a.c)} - ${esc(a.n)} <button type="button" class="enlace" data-quitar-alt="${k}">Quitar</button></span>`).join("")}</div>
    ${alts.length < MAX_ALT ? `<div class="fs-mismo"><b>${ge ? `Del mismo genérico: ${esc(ge)}` : "De nombre parecido (no se conoce su genérico)"}</b>
        ${!GEN ? '<small class="muted">Cargando…</small>'
          : mismos.length ? `<div class="fs-mismo-lista">${mismos.map(p => `<button type="button" data-alt="${esc(p.c)}"><b>${esc(p.c)}</b> ${esc(p.n)}${p.ln || p.l ? ` <small>${esc(p.ln || p.l)}</small>` : ""}</button>`).join("")}</div>`
          : '<small class="muted">No hay otros parecidos en el listado: búscalo abajo.</small>'}</div>
      <label for="fsBus">¿No está? Búscalo en el listado general</label>
      <input id="fsBus" type="search" autocomplete="off" placeholder="Código o nombre del otro medicamento" value="${esc(S.fBus || "")}"><div class="resultados" id="fsRes" ${S.fBus ? "" : "hidden"}>${resBusqueda(i, S.fBus || "", p => alts.some(a => a.c === p.c), "data-alt")}</div>` : ""}</div>`;
}
function leerForm() {
  const g = n => document.querySelector(`input[name="${n}"]:checked`)?.value;
  S.fForm = { ...S.fForm, estado: g("fsEstado") ?? S.fForm?.estado, plazo: g("fsPlazo") ?? S.fForm?.plazo,
    hasta: $("fsHasta")?.value ?? S.fForm?.hasta, llega: $("fsLlega")?.value ?? S.fForm?.llega, comentario: $("fsCom")?.value ?? S.fForm?.comentario };
}
function abrirResp(c) {
  if (S.fAbierto === c) { S.fAbierto = null; S.fForm = null; return pintarFalt(); }
  const e = S.fEst.get(c); S.fAbierto = c; S.fForm = null; S.fBus = ""; S.fAlt = (e?.alternativas || []).slice(0, MAX_ALT);
  cargarGenericos(); pintarFalt();
}
$("fsChips").addEventListener("click", ev => { const b = ev.target.closest("[data-est]"); if (b) { S.fFil.est = b.dataset.est; S.fMostrar = 100; pintarFalt(); } });
$("fsEst").addEventListener("change", ev => { S.fFil.est = ev.target.value; S.fMostrar = 100; pintarFalt(); });
$("fsLab").addEventListener("change", ev => { S.fFil.lab = ev.target.value; pintarFalt(); });
$("fsSuc").addEventListener("change", ev => { S.fFil.suc = ev.target.value; pintarFalt(); });
$("fsQ").addEventListener("input", ev => { S.fFil.q = ev.target.value; pintarFalt(); });
$("fsMas").addEventListener("click", ev => { if (ev.target.closest("#fsMasBtn")) { S.fMostrar += 100; pintarFalt(); } });
["fsTabla", "fsDlg"].forEach(t => $(t).addEventListener("change", ev => {
  if (ev.target.name === "fsEstado" || ev.target.name === "fsPlazo") { leerForm(); pintarFalt(); }
}));
["fsTabla", "fsDlg"].forEach(t => $(t).addEventListener("input", ev => {
  if (ev.target.id !== "fsBus") return;
  S.fBus = ev.target.value;
  const i = (S.falt?.items || []).find(x => x.c === S.fAbierto) || { c: S.fAbierto }, box = $("fsRes");
  box.innerHTML = resBusqueda(i, S.fBus, p => S.fAlt.some(a => a.c === p.c), "data-alt"); box.hidden = !S.fBus.trim();
}));
["fsTabla", "fsDlg"].forEach(t => $(t).addEventListener("click", async ev => {
  const r = ev.target.closest("[data-resp]"); if (r) return abrirResp(r.dataset.resp);
  const a = ev.target.closest("[data-alt]");
  if (a) { const p = S.catIdx.get(a.dataset.alt); if (p && S.fAlt.length < MAX_ALT) S.fAlt.push({ c: p.c, n: p.n }); S.fBus = ""; leerForm(); pintarFalt(); $("fsBus")?.focus(); return; }
  const q = ev.target.closest("[data-quitar-alt]"); if (q) { S.fAlt.splice(+q.dataset.quitarAlt, 1); leerForm(); return pintarFalt(); }
  if (ev.target.closest("[data-cerrar-f]")) { S.fAbierto = null; S.fForm = null; return pintarFalt(); }
  const c = S.fAbierto; if (!c) return;
  if (ev.target.closest("[data-borrar-f]")) {
    try { await deleteDoc(doc(db, "faltantes_estado", c)); S.fAbierto = null; S.fForm = null; toast("Respuesta quitada"); pintarFalt(); }
    catch (err) { msg("fsMsg", textoError(err), true); }
    return;
  }
  if (!ev.target.closest("[data-guardar-f]")) return;
  leerForm(); const f = S.fForm || {}, prev = S.fEst.get(c) || {};
  const estado = f.estado ?? prev.estado;
  if (!estado) return msg("fsMsg", "Elige una opción (A a E).", true);
  const item = (S.falt?.items || []).find(i => i.c === c) || {};
  const d = { codpro: c, producto: item.n || "", laboratorio: item.l || "", estado, comentario: (f.comentario ?? prev.comentario ?? "").trim(),
    porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario, fecha: serverTimestamp() };
  if (estado === "agotado") {
    const plazo = f.plazo ?? prev.plazo ?? "1m";
    d.plazo = plazo; d.hasta = plazo === "otra" ? (f.hasta ?? prev.hasta ?? "") : sumarDias(PLAZOS.find(p => p[0] === plazo)?.[2] || 30);
    if (!d.hasta) return msg("fsMsg", "Elige la fecha hasta la que estará agotado.", true);
  }
  if (estado === "transito") d.llega = f.llega ?? prev.llega ?? "";
  if (estado === "descontinuado" && S.fAlt.length) d.alternativas = S.fAlt.slice(0, MAX_ALT);
  if (estado === "alternativa") { if (!S.fAlt.length) return msg("fsMsg", `Elige el medicamento que lo reemplaza (hasta ${MAX_ALT}).`, true); d.alternativas = S.fAlt.slice(0, MAX_ALT); }
  try { await setDoc(doc(db, "faltantes_estado", c), d); S.fAbierto = null; S.fForm = null; toast("Respuesta guardada"); pintarFalt(); }
  catch (err) { msg("fsMsg", textoError(err), true); }
}));
$("fsXls").addEventListener("click", () => {
  const filas = [["Código", "Producto", "Laboratorio", "N° sucursales", "Total cajas", "Le falta a", "Estado", "Detalle", "Comentario", "Respondió", "Fecha"],
    ...(S.fLista || []).map(i => { const e = estVig(i.c);
      return [i.c, i.n, i.l, i.s.length, i.t, i.s.map(x => `${corto(x.f)} ${x.q}`).join(" / "), e ? ESTADOS_F.find(x => x.id === e.estado)?.txt : "Sin responder",
        e ? textoEstado(e) : "", e?.comentario || "", e?.porNombre || "", e ? fmtF(e.fecha) : ""]; })];
  const t = filas.map(f => f.map(v => { const x = String(v ?? ""); return /[;"\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; }).join(";")).join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["\ufeff" + t], { type: "text/csv;charset=utf-8" }));
  a.download = `faltantes_drogueria_${hoyISO()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

/* ===================== lo que me van a atender (por sucursal; módulo de prueba) ===================== */
// Lo publica el administrador desde Atención a sucursales en atencion/{SUCURSAL}. El químico ve la de su sucursal;
// el administrador elige cuál ver.
S.aten = null; S.atSuc = null; S.atVer = ""; S.atQ = "";
function escucharAten() {
  const suc = esAdmin() ? (S.atSuc || FARMACIAS[0]) : miFarm();
  if (S.atSubSuc === suc) return;
  S.atUnsub?.(); S.atSubSuc = suc; S.aten = null;
  S.atUnsub = onSnapshot(doc(db, "atencion", suc), sn => { S.aten = sn.exists() ? sn.data() : { items: [] }; cargarStkSuc(suc, S.aten.publicado); if (S.vista === "vAten") pintarAten(); },
    e => { S.atSubSuc = null; avisar(e); });
  // respuestas del químico por producto (atencion_resp/{SUCURSAL}__{codpro})
  S.atResp = new Map(); S.atRespUnsub?.();
  S.atRespUnsub = onSnapshot(query(collection(db, "atencion_resp"), where("suc", "==", suc)), sn => {
    S.atResp = new Map(sn.docs.map(d => [d.data().codpro, d.data()])); if (S.vista === "vAten") pintarAten();
  }, e => avisar(e));
  S.subs.push(() => S.atUnsub?.(), () => S.atRespUnsub?.());
  // lo que respondió droguería en Faltantes (descontinuado, agotado, en tránsito…), para verlo en cada producto
  if (!S.faltSubs && !S.fEstAten) { S.fEstAten = true;
    S.subs.push(onSnapshot(collection(db, "faltantes_estado"), sn => { S.fEst = new Map(sn.docs.map(d => [d.id, d.data()])); if (S.vista === "vAten" && !S.atEdit) pintarAten(); },
      () => { S.fEstAten = false; })); }
}
const tagDrog = i => { const e = estVig(i.c); if (!e) return "";
  // el stock que tiene la sucursal del medicamento que indicó droguería
  const alts = (e.alternativas || []).map(a => tagStock(i, a.c, `${a.c} ${a.n}: `)).join("");
  return `<span class="tag fs-tag ${esc(e.estado)} at-drog" title="${esc((e.porNombre || "") + (e.comentario ? ": " + e.comentario : ""))}">Droguería: ${esc(textoEstado(e))}${e.comentario ? " · " + esc(e.comentario) : ""}</span>${alts}`; };
// Lo que el químico puede responder sobre cada producto que le van a enviar
const RESP_AT = [
  { id: "si_requiere", txt: "Sí se requiere en esta sucursal", clase: "t-ok" },
  { id: "no_requiere", txt: "No se requiere en esta sucursal", clase: "t-rech" },
  { id: "no_se_mueve", txt: "No se mueve", clase: "t-pend", campo: "motivo", ph: "¿Por qué motivo? (obligatorio)" },
  { id: "otro_medicamento", txt: "Se tiene otro medicamento en su cambio", clase: "t-ok", campo: "alt", ph: "Busca el medicamento por código o nombre" },
  { id: "otros", txt: "Otros", clase: "m-otro", campo: "motivo", ph: "Escribe tu comentario (obligatorio)" }];
const puedeResponderAt = () => !esAdmin() && ((S.prev || S.perfil)?.vistas || []).includes("atencion") && !!miFarm();
const textoResp = r => { const o = RESP_AT.find(x => x.id === r.estado); return (o?.txt || r.estado) + (r.alternativa ? ": " + r.alternativa : "") + (r.comentario ? (r.alternativa ? " · " : ": ") + r.comentario : ""); };
// stock y venta diaria de la sucursal (red/stk_SUCURSAL, se publica con la lista) para el medicamento de cambio
async function cargarStkSuc(suc, ver) {
  const k = suc + "|" + (ver || ""); if (S.atStkK === k) return; S.atStkK = k;
  try { const d = await getDoc(doc(db, "red", "stk_" + suc)); S.atStkOk = d.exists(); S.atStk = d.exists() ? d.data().p || {} : {}; } catch { S.atStkOk = false; S.atStk = {}; }
  if (S.vista === "vAten") pintarAten();
}
// cuánto tiene la sucursal del medicamento c (que usa en lugar de i) y, si no le alcanza, cuánto se le enviaría
function stockCambio(i, c, n = 1) {
  const A = S.aten || {}, dias = (A.C || 0) + (A.Sg || 0);
  if (!S.atStk) return { cls: "", txt: "Revisando tu stock…" };
  // si aún no se publicó el stock de la sucursal, se usa el de la red (solo trae los productos de las listas)
  const rx = !S.atStkOk && S.red?.get(c)?.r?.find(x => x.f === A.nombre);
  if (!S.atStkOk && !rx) { if (!S.red && !S.redCargando) cargarRed().then(() => S.vista === "vAten" && pintarAten());
    return { cls: "", txt: S.red ? "Aún no está publicado tu stock de este medicamento: se verá cuando Abastecimiento actualice la lista (al subir el kardex)" : "Revisando tu stock…" }; }
  // el de cambio pasa a cubrir también la venta del original: su venta diaria es la mayor de las dos
  const [st = 0, dA = 0] = rx ? [rx.s || 0, rx.d || 0] : S.atStk[c] || [], d = Math.max(dA, (i?.d || 0) / n), cob = d > 0 ? Math.floor(st / d) : null;
  if (st > 0 && (d <= 0 || st >= d * dias)) return { cls: "t-ok", txt: `✓ Tienes ${fCaja(st)}${cob != null ? ` · te cubre ${nf(cob)} días` : ""} · no necesitas que te envíen` };
  const env = d > 0 ? Math.max(1, Math.ceil(d * dias - st - 1e-9)) : 0;
  return { cls: "t-pend", txt: `${st > 0 ? `Tienes ${fCaja(st)} (te cubre ${nf(cob)} días)` : "✗ No tienes"}${env ? ` · se te enviarán ${nf(env)} para ${A.C} + ${A.Sg} días` : ""}` };
}
const tagStock = (i, c, pre = "", n = 1) => { const x = stockCambio(i, c, n); return `<span class="tag ${x.cls} at-drog">${pre}${esc(x.txt)}</span>`; };
// el producto ya no se le envía: la sucursal usa otro en su cambio, o droguería lo dio por descontinuado o reemplazado
function noEnvia(i) {
  const r = S.atResp?.get(i.c), e = estVig(i.c);
  if (r?.estado === "otro_medicamento" && r.altCod) return `usas en su cambio ${r.alternativa || r.altCod}`;
  if (i.rmp) return `droguería lo reemplaza por ${i.rmp}`;
  if (e?.estado === "descontinuado") return e.alternativas?.length ? `descontinuado; lo reemplaza ${e.alternativas[0].c} ${e.alternativas[0].n}` : "descontinuado (droguería)";
  return "";
}
function celdaResp(i) {
  // el cierre del ingreso de información es para los bloqueos: responder aquí siempre se puede
  const r = S.atResp?.get(i.c), puede = puedeResponderAt();
  const ver = r ? `<span class="tag ${RESP_AT.find(x => x.id === r.estado)?.clase || ""} at-rtag">${esc(textoResp(r))}</span>${r.estado === "otro_medicamento" ? altsResp(r).map((a, k, l) => tagStock(i, a.c, l.length > 1 ? a.c + ": " : "", l.length)).join("") : ""}<small class="muted at-rpor">${esc(r.porNombre || "")} · ${fmtF(r.fecha)}</small>` : "";
  return ver + (puede ? `<button type="button" class="btn sm at-rbtn${r ? "" : " primario"}" data-resp="${esc(i.c)}">${r ? "Cambiar" : "Responder"}</button>` : r ? "" : '<span class="muted">–</span>');
}
// Ventana al centro para responder (faltantes y lo que me van a atender): se arma de nuevo en cada cambio
function ventanaResp(id, html) {
  const d = $(id);
  if (!html) { if (d.open) { d.dataset.cerrando = "1"; d.close(); } return; }
  const foco = document.activeElement?.closest?.("#" + id) ? document.activeElement : null, sel = foco && (foco.id || foco.getAttribute("data-rbus") !== null && "[data-rbus]" || foco.getAttribute("data-rmot") !== null && "[data-rmot]");
  const val = foco?.value, pos = foco?.selectionStart;
  d.querySelector(".resp-c").innerHTML = html;
  if (!d.open) d.showModal();
  if (sel) { const x = d.querySelector(foco.id ? "#" + foco.id : sel); if (x) { x.focus(); if (val != null && x.value === val && pos != null) try { x.setSelectionRange(pos, pos); } catch {} } }
}
["atDlg", "fsDlg"].forEach(id => {
  $(id).addEventListener("close", () => {
    if ($(id).dataset.cerrando) { delete $(id).dataset.cerrando; return; }
    if (id === "atDlg") { S.atEdit = null; S.atForm = null; pintarAten(); } else { S.fAbierto = null; S.fForm = null; pintarFalt(); }
  });
  $(id).addEventListener("click", e => { if (e.target.closest("[data-cerrar-dlg]") || e.target === $(id)) $(id).close(); });
});
function formRespAt(i) {
  const r = S.atResp?.get(i.c) || {}, e = S.atForm?.estado ?? r.estado ?? "", o = RESP_AT.find(x => x.id === e);
  return `<div class="at-rf" data-rf="${esc(i.c)}">
    <b>¿Qué pasa con este producto en tu sucursal?</b>
    <div class="pills at-ropts">${RESP_AT.map(x => `<label class="${x.id}"><input type="radio" name="atR" value="${x.id}" ${x.id === e ? "checked" : ""}>${esc(x.txt)}</label>`).join("")}</div>
    ${o?.campo === "alt" ? altAt(i, r) : ""}
    ${o?.campo === "motivo" ? `<input class="at-rin" data-rmot placeholder="${esc(o.ph)}" value="${esc(S.atForm?.mot ?? r.comentario ?? "")}">` : ""}
    <div class="at-racc"><button type="button" class="btn primario sm" data-rguardar>Guardar</button><button type="button" class="btn sm" data-rcancelar>Cancelar</button>
      ${r.estado ? `<button type="button" class="btn sm peligro" data-rquitar>Quitar mi respuesta</button>` : ""}<span class="msg error" id="atRMsg" hidden></span></div>
  </div>`;
}
// el medicamento que usa en su cambio: primero los del mismo genérico; si no está, del listado general
// medicamentos que la sucursal usa en su cambio (antes era uno solo: altCod)
const altsResp = r => r?.alts?.length ? r.alts : r?.altCod ? [{ c: r.altCod, n: (r.alternativa || "").replace(/^[^-]*- /, "") }] : [];
const altsForm = r => S.atForm?.alts ?? altsResp(r);
// orden: buscador arriba, lo elegido (con su stock), el comentario y abajo los sugeridos del mismo genérico
function altAt(i, r) {
  const sel = altsForm(r), lleno = sel.length >= MAX_ALT;
  const ge = genDe(i), mismos = (ge && GEN ? (GEN.por.get(ge) || []) : GEN ? parecidos(i) : []).filter(p => p.c !== i.c && !sel.some(a => a.c === p.c));
  return `<div class="campo"><b>¿Qué medicamento(s) usas en su cambio? <small class="muted">(puedes elegir hasta ${MAX_ALT})</small></b></div>
    ${lleno ? "" : `<div class="buscador"><input class="at-rin" data-rbus type="search" autocomplete="off" placeholder="Busca por código o nombre (todos los medicamentos)" value="${esc(S.atBus || "")}"><div class="resultados" id="atRes" ${S.atBus ? "" : "hidden"}>${resBusqueda(i, S.atBus || "", p => sel.some(a => a.c === p.c), "data-ralt-c")}</div></div>`}
    ${sel.length ? `<div class="at-sel">${sel.map((a, k) => `<div class="at-sel-f"><span class="fs-alt"><b>${esc(a.c)} - ${esc(a.n)}</b> <button type="button" class="enlace" data-ralt-quitar="${k}">Quitar</button></span>${tagStock(i, a.c, "", sel.length)}</div>`).join("")}</div>` : ""}
    <input class="at-rin" data-rmot placeholder="Comentario (opcional)" value="${esc(S.atForm?.mot ?? r.comentario ?? "")}">
    ${lleno ? "" : `<div class="fs-mismo"><small class="muted">Sugeridos${ge ? "" : " (de nombre parecido)"}:</small>
      ${!GEN ? '<small class="muted">Cargando…</small>'
        : mismos.length ? `<div class="fs-mismo-lista">${mismos.map(p => `<button type="button" data-ralt-c="${esc(p.c)}"><b>${esc(p.c)}</b> ${esc(p.n)}${p.ln || p.l ? ` <small>${esc(p.ln || p.l)}</small>` : ""}</button>`).join("")}</div>`
        : '<small class="muted">No hay sugeridos: búscalo arriba.</small>'}</div>`}`;
}
const leerAtForm = box => { S.atForm = { ...S.atForm, estado: box.querySelector("[name=atR]:checked")?.value, mot: box.querySelector("[data-rmot]")?.value ?? S.atForm?.mot }; };
async function guardarResp(cod) {
  const i = (S.aten?.items || []).find(x => x.c === cod), box = document.querySelector(`[data-rf="${CSS.escape(cod)}"]`); if (!i || !box) return;
  const estado = box.querySelector("[name=atR]:checked")?.value, o = RESP_AT.find(x => x.id === estado);
  const sel = altsForm(S.atResp?.get(cod));
  const alt = sel.map(a => `${a.c} - ${a.n}`).join(" / "), mot = box.querySelector("[data-rmot]")?.value.trim() || "";
  const err = t => { const m = $("atRMsg"); m.hidden = !t; m.textContent = t; };
  if (!o) return err("Elige una opción.");
  if (o.campo === "alt" && !alt) return err("Elige el medicamento que usas en su cambio.");
  if (o.campo === "motivo" && !mot) return err(o.id === "otros" ? "Escribe tu comentario." : "Escribe el motivo.");
  const suc = miFarm();
  try {
    await setDoc(doc(db, "atencion_resp", `${suc}__${cod}`), { suc, codpro: cod, producto: i.n, laboratorio: i.l || "", estado,
      comentario: mot.slice(0, 300), alternativa: o.campo === "alt" ? alt.slice(0, 400) : "", altCod: o.campo === "alt" ? sel[0].c : "", alts: o.campo === "alt" ? sel.slice(0, MAX_ALT) : [], porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario, fecha: serverTimestamp() });
    S.atEdit = null; S.atForm = null; toast("Respuesta guardada"); pintarAten();
  } catch (x) { err(textoError(x)); }
}
const fCaja = (v, fr) => { if (!(fr > 1)) return Number(v || 0).toLocaleString("es-PE", { maximumFractionDigits: 1 }); const u = Math.round((v || 0) * fr), e = Math.trunc(u / fr), f = Math.abs(u % fr); return f ? `${nf(e)} / ${f} f` : nf(e); };
const fFecha = iso => iso ? new Date(iso).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
function pintarAten() {
  const A = S.aten, suc = esAdmin() ? (S.atSuc || FARMACIAS[0]) : miFarm();
  $("atSucF").hidden = !esAdmin();
  if (esAdmin() && !$("atSuc").options.length) $("atSuc").innerHTML = FARMACIAS.map(f => `<option value="${esc(f)}">${esc(corto(f))}</option>`).join("");
  if (esAdmin()) $("atSuc").value = suc;
  $("atSub").textContent = `Productos que Abastecimiento tiene previsto enviar a ${nombreFarm(suc)}.`;
  if (!A) { $("atFiltro").innerHTML = ""; $("atTabla").innerHTML = `<tbody><tr class="vacia"><td>Cargando…</td></tr></tbody>`; return; }
  if (!A.publicado) { $("atFiltro").innerHTML = '<span class="muted">Aún no hay información publicada para tu sucursal.</span>'; $("atTabla").innerHTML = ""; $("atTit").textContent = "Productos"; return; }
  const hasta = new Date(A.publicado); hasta.setDate(hasta.getDate() + (A.C || 0));
  const fte = A.fte === "motor" ? "pronóstico estadístico de tu sucursal" : `ventas de los últimos ${A.fte} días`;
  $("atFiltro").innerHTML = `<b>Criterio usado por Abastecimiento${A.propio ? " para tu sucursal" : ""}:</b> atender para <b>${A.C} días</b> de venta + <b>${A.Sg} días</b> de seguridad
    · cubre hasta el <b>${hasta.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" })}</b>
    · venta diaria según ${esc(fte)} · ${A.tipos === "todos" ? "todo lo que se vende en la sucursal" : "productos de venta frecuente (tipo A lo necesario; tipo B 1 unidad si no le alcanza)"}
    ${(A.items || []).some(i => i.aj) ? "<br>Algunos productos tienen un criterio propio (se indica en la columna Nota)." : ""}
    <br><small class="muted">Datos al ${fmtF(A.corte)} · publicado el ${fFecha(A.publicado)}</small>`;
  const q = norm(S.atQ).trim();
  const lista = (A.items || []).filter(i => (S.atVer !== "urg" || i.urg) && (S.atVer !== "env" || i.pide > 0)
    && (S.atVer !== "sinr" || !S.atResp?.has(i.c)) && (S.atVer !== "resp" || S.atResp?.has(i.c))
    && (!q || q.split(/\s+/).every(w => norm(i.c + " " + i.n + " " + i.l).includes(w))));
  $("atTit").textContent = `${nf(lista.length)} productos · ${nf(lista.filter(i => i.urg).length)} urgentes`;
  const colCob = i => i.d <= 0 ? "#9e9e9e" : i.cob == null ? "#1e6bb8" : i.cob < A.Sg ? "#d9302c" : i.cob < A.C + A.Sg ? "#e0a030" : "#43a047";
  $("atTabla").innerHTML = `<thead><tr><th>Producto</th><th class="at-ojo">Información</th><th>Tipo</th><th class="der">Cobertura</th><th class="der">Venta diaria</th><th class="der">Tu stock</th><th class="der">Se te enviará</th><th>Nota</th><th>Respuesta de la sucursal</th></tr></thead><tbody>` +
    (lista.length ? lista.map(i => `<tr><td class="p"><b>${esc(i.c)} - ${esc(i.n)}</b><code>${esc(i.l)}</code></td>
      <td class="at-ojo">${i.hv ? `<button type="button" class="at-ibtn" data-info="${esc(i.c)}" title="Ver la información de este producto en tu local" aria-label="Información de ${esc(i.n)}">${OJO}</button>` : ""}</td>
      <td><span class="at-cat ${esc(i.cat)}">${esc(i.cat)}</span></td>
      <td class="der"><span class="at-cob" style="background:${colCob(i)}">${i.d <= 0 ? "sin venta" : i.cob == null ? "–" : nf(i.cob) + " días"}</span></td>
      <td class="der">${fCaja(i.d, i.fr)}</td><td class="der">${fCaja(i.st, i.fr)}</td>
      <td class="der">${noEnvia(i) ? '<span class="muted">No</span>' : `<b>${i.pide ? nf(i.pide) : "–"}</b>`}</td>
      <td class="at-nota">${noEnvia(i) ? `<span class="tag t-rech at-drog">No se te envía: ${esc(noEnvia(i))}</span>`
        : `${i.urg ? '<span class="tag t-rech">Urgente</span> ' : ""}${i.pide && i.falta ? `<span class="tag t-pend">${nf(i.falta)} sin stock en droguería</span>` : ""}${(i.de || []).map(x => `<span class="tag t-ok">${nf(x.q)} de ${esc(x.f)}</span>`).join(" ")}${i.cmp ? `<span class="tag t-rech">${nf(i.cmp)} por comprar</span>` : ""}`}${i.cmb ? `<span class="tag t-ok">En cambio de ${esc(i.cmb)}</span>` : ""}${tagDrog(i)}${i.enl ? `<span class="tag t-ok at-drog">Se te envía en lugar de ${esc(i.enl)} (droguería)</span>` : ""}${i.aj ? `<small class="at-aj">Criterio propio: ${esc(i.aj)}</small>` : ""}</td>
      <td class="at-resp">${celdaResp(i)}</td></tr>`).join("")
      : `<tr class="vacia"><td colspan="9">Nada que mostrar.</td></tr>`) + "</tbody>";
  const iEd = S.atEdit && (A.items || []).find(x => x.c === S.atEdit);
  ventanaResp("atDlg", iEd ? `<h2>${esc(iEd.c)} - ${esc(iEd.n)}</h2><p class="muted">${esc(iEd.l || "")} · se te enviará ${nf(iEd.pide || 0)}</p>` + formRespAt(iEd) : "");
  pintarLados();
}
$("atVer").addEventListener("change", e => { S.atVer = e.target.value; pintarAten(); });
// 👁 Información del producto en el local: Atributos, Pronóstico y Plan (como Estadística Proyx, pero de su sucursal)
const MESES_C = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const etM = m => { const [y, mo] = String(m).split("-"); return MESES_C[+mo - 1] + " " + y.slice(2); };
const PATRON_T = { smooth: "Suave (vende parejo)", erratic: "Errático (cantidades muy variables)", intermittent: "Intermitente (meses sin venta)", lumpy: "Irregular" };
const NOM_TIPO = { A: "Venta mensual", B: "Venta cada 2 meses", C: "Venta cada 4 meses", D: "Ventas al año", E: "Sin venta" };
const OJO = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/></svg>`;
const diasDelMes = m => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo, 0).getDate(); };
// gráfico SVG: barras y líneas sobre los mismos meses
function svgGraf(labels, series, fr) {
  const W = 760, H = 250, L = 34, B = 34, T = 14, n = labels.length, w = (W - L - 8) / n;
  const max = Math.max(1, ...series.flatMap(s => s.data.filter(v => v != null))) * 1.1, y = v => T + (H - T - B) * (1 - v / max);
  let g = "";
  for (let k = 0; k <= 4; k++) { const v = max * k / 4, yy = y(v); g += `<line x1="${L}" x2="${W - 4}" y1="${yy}" y2="${yy}" stroke="#eceff3"/><text x="${L - 4}" y="${yy + 3}" text-anchor="end" font-size="10" fill="#889">${v.toLocaleString("es-PE", { maximumFractionDigits: max < 10 ? 1 : 0 })}</text>`; }
  const barras = series.filter(s => s.tipo === "barra"), nb = barras.length || 1;
  barras.forEach((s, j) => s.data.forEach((v, i) => { if (!v) return; const bw = (w - 6) / nb, x = L + i * w + 3 + j * bw;
    g += `<rect x="${x}" y="${y(v)}" width="${bw - 1}" height="${y(0) - y(v)}" rx="2" fill="${s.color}"><title>${etM(labels[i])} · ${s.nombre}: ${fCaja(v, fr)}</title></rect>`; }));
  series.filter(s => s.tipo === "linea").forEach(s => {
    let d = "", pts = ""; s.data.forEach((v, i) => { if (v == null) return; const x = L + i * w + w / 2; d += (d && s.data[i - 1] != null ? "L" : "M") + x + " " + y(v) + " ";
      pts += `<circle cx="${x}" cy="${y(v)}" r="2.6" fill="${s.color}"><title>${etM(labels[i])} · ${s.nombre}: ${fCaja(v, fr)}</title></circle>`; });
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.4"/>${s.puntos === false ? "" : pts}`; });
  labels.forEach((m, i) => { if (n > 14 && i % 2) return; g += `<text x="${L + i * w + w / 2}" y="${H - 14}" text-anchor="middle" font-size="10" fill="#667">${etM(m)}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" class="at-graf" role="img">${g}</svg><div class="at-ley">${series.map(s => `<span><i style="background:${s.color}"></i>${s.nombre}</span>`).join("")}</div>`;
}
// plan de 12 meses del local: cuando el stock baja de la seguridad, se le envía hasta cubrir días + seguridad
function planLocal(i, A) {
  const fm = A.fm || [], filas = []; let ini = i.st;
  fm.forEach((m, k) => {
    const dm = diasDelMes(m), dia = k === 0 && A.avDia ? A.avDia : 0, pron = i.pr?.[k] || 0;
    const dem = k === 0 ? Math.max(0, pron - (i.av || 0)) : pron, diaria = pron / dm;
    const seg = diaria * A.Sg, obj = diaria * (A.C + A.Sg);
    let env = 0; if (diaria > 0 && ini - dem < seg) env = Math.ceil(obj - (ini - dem) - 1e-9);
    const fin = Math.max(0, ini - dem + env);
    filas.push({ m, obj, seg, ini, dem, env, fin }); ini = fin;
  });
  return filas;
}
S.atTab = "atr";
// src: "aten" (lo de una sucursal) o "falt" (faltantes de droguería, toda la empresa)
function abrirInfo(c, src = "aten") { S.atInfoC = c; S.infoSrc = src; S.atTab = "atr"; pintarInfo(); $("atInfo").showModal(); }
// el producto en toda la red (red/meta y red/p0, p1…), se lee una vez
async function cargarRed() {
  if (S.red || S.redCargando) return; S.redCargando = true;
  try {
    const m = await getDoc(doc(db, "red", "meta")), n = m.exists() ? m.data().n || 0 : 0, red = new Map();
    for (let k = 0; k < n; k++) { const d = await getDoc(doc(db, "red", "p" + k)); if (d.exists()) for (const [c, v] of Object.entries(d.data().p || {})) red.set(c, v); }
    S.red = red; S.redErr = n ? "" : "Aún no hay información de la red publicada.";
  } catch (e) { S.redErr = textoError(e); S.red = new Map(); }
  S.redCargando = false; if ($("atInfo").open) pintarInfo();
}
function pintarInfo() {
  const falt = S.infoSrc === "falt", A = falt ? S.falt : S.aten, i = (A?.items || []).find(x => x.c === S.atInfoC); if (!i) return;
  const donde = falt ? "toda la empresa" : "tu local";
  const fila = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`, hv = i.hv || [], meses = A.meses || [], fm = A.fm || [];
  const conV = hv.slice(-12).filter(v => v > 0).length, nec = i.nec, seg = i.d * A.Sg, enC = Math.max(0, i.st - i.d * A.C);
  const estado = nec > 0 ? Math.max(0, Math.min(1, Math.min(i.st, enC) / nec)) : 1, colE = estado >= 1 ? "#1a7f37" : estado >= .5 ? "#e0a030" : "#d9302c";
  const tope = Math.max(nec, i.st, 1) * 1.15, yy = v => 100 - Math.max(0, Math.min(v, tope)) / tope * 100;
  const tabs = falt ? [["atr", "Atributos"], ["pron", "Pronóstico"], ["red", "En la red"]] : [["atr", "Atributos"], ["pron", "Pronóstico"], ["plan", "Plan"], ["red", "En la red"]];
  let cuerpo = "";
  if (S.atTab === "atr" && falt) {
    const e = S.fEst.get(i.c);
    cuerpo = `<div class="at-info-3">
      <section class="at-box"><h3>Producto</h3><table class="at-kv">
        ${fila("Nombre", esc(i.n))}${fila("Código", esc(i.c))}${fila("Laboratorio", esc(i.l) || "–")}${fila("Línea", esc(i.li) || "–")}${fila("Genérico", esc(i.ge) || "–")}${fila("Familia", esc(i.fa) || "–")}
        ${fila("Tipo en la empresa", `<span class="at-cat ${esc(i.cat)}">${esc(i.cat)}</span> ${NOM_TIPO[i.cat] || ""}`)}${fila("Patrón de venta", esc(PATRON_T[i.pat] || "–"))}
        ${fila("ADI (cada cuántos meses vende)", i.adi ?? "–")}${fila("CV² (variación de la cantidad)", i.cv2 ?? "–")}${fila("Meses con venta (últimos 12)", conV)}</table></section>
      <section class="at-box"><h3>Situación</h3><table class="at-kv">
        ${fila("Stock en droguería", "<b>0</b>")}${fila("Stock en las sucursales", fCaja(i.sts || 0, i.fr))}${fila(`Le falta a`, `${i.s.length} sucursales · ${nf(i.t)} cajas`)}
        ${fila("Sucursales", i.s.map(x => `${esc(corto(x.f))} ${nf(x.q)}`).join(" · "))}
        ${fila("Respuesta", e ? `${esc(textoEstado(e))}${vencida(e) ? " <b class='neg'>(venció)</b>" : ""}<br><small class="muted">${esc(e.porNombre || "")} · ${fmtF(e.fecha)}${e.comentario ? " · " + esc(e.comentario) : ""}</small>` : "Sin responder")}</table></section>
      <section class="at-box"><h3>Abastecimiento</h3><table class="at-kv">
        ${fila("Tipo", "Compra")}${fila("Proveedor", esc(i.l) || "–")}${fila("Costo por caja", i.k ? "S/ " + i.k.toLocaleString("es-PE", { maximumFractionDigits: 2 }) : "–")}
        ${fila("Valor de lo que falta", i.k ? "S/ " + nf(Math.round(i.t * i.k)) : "–")}${fila("Unidad", i.fr > 1 ? `caja de ${i.fr} fracciones` : "caja")}</table></section></div>`;
  } else if (S.atTab === "red") {
    if (!S.red) { cargarRed(); cuerpo = '<p class="at-nota">Cargando la información de la red…</p>'; }
    else {
      const x = S.red.get(i.c), mia = falt ? "" : (A.nombre || "");
      const crit = falt ? `Para ${A.C} días + ${A.Sg} de seguridad (criterio general de Abastecimiento).`
        : `Tu sucursal: ${A.C} días + ${A.Sg} de seguridad · venta diaria según ${A.fte === "motor" ? "pronóstico estadístico" : `ventas de los últimos ${A.fte} días`} · ${A.tipos === "todos" ? "todo lo que se vende" : "tipo A lo necesario, tipo B 1 unidad si no le alcanza"}${i.aj ? `<br><b>Este producto tiene criterio propio:</b> ${esc(i.aj)}` : ""}`;
      const cob = r => r.d <= 0 ? '<span class="at-cob" style="background:#9e9e9e">sin venta</span>' : `<span class="at-cob" style="background:${r.s / r.d < (falt ? A.Sg : A.Sg) ? "#d9302c" : r.s / r.d < A.C + A.Sg ? "#e0a030" : r.s / r.d <= (A.C + A.Sg) * 2 ? "#43a047" : "#1e6bb8"}">${r.s / r.d > 999 ? "> 999" : nf(Math.floor(r.s / r.d))} días</span>`;
      cuerpo = `<section class="at-box"><h3>Criterio que se aplica</h3><p class="at-nota" style="color:inherit">${crit}</p></section>` + (!x ? `<p class="at-nota">${esc(S.redErr || "Este producto no tiene información de la red.")}</p>` :
        `<section class="at-box"><h3>El producto en toda la red</h3><div class="at-scroll" style="border:0;border-radius:0"><table class="at-mes"><thead><tr><th>Sucursal</th><th>Tipo</th><th>Venta diaria</th><th>Stock</th><th>Cobertura</th><th>Necesita</th><th>Enviar</th><th>De droguería</th><th>Sobra</th></tr></thead><tbody>
          <tr class="b"><th>Droguería FS</th><td></td><td></td><td class="n">${fCaja(x.dg, i.fr)}</td><td></td><td></td><td></td><td></td><td></td></tr>
          ${[...x.r].sort((a, b) => (a.f === mia ? -1 : b.f === mia ? 1 : (a.d > 0 ? a.s / a.d : 1e9) - (b.d > 0 ? b.s / b.d : 1e9))).map(r => `<tr${r.f === mia ? ' class="mia"' : ""}><th>${esc(r.f)}</th><td><span class="at-cat ${esc(r.t)}">${esc(r.t)}</span></td>
            <td class="n">${fCaja(r.d, i.fr)}</td><td class="n">${fCaja(r.s, i.fr)}</td><td class="n">${cob(r)}</td><td class="n">${fCaja(r.n, i.fr)}</td><td class="n"><b>${r.e ? nf(r.e) : "·"}</b></td><td class="n">${r.e ? nf(r.g) : ""}</td><td class="n">${r.x ? nf(r.x) : ""}</td></tr>`).join("")}
          </tbody></table></div></section>`);
    }
  } else if (S.atTab === "atr") {
    cuerpo = `<div class="at-info-3">
      <section class="at-box"><h3>Producto</h3><table class="at-kv">
        ${fila("Nombre", esc(i.n))}${fila("Código", esc(i.c))}${fila("Laboratorio", esc(i.l) || "–")}${fila("Línea", esc(i.li) || "–")}${fila("Genérico", esc(i.ge) || "–")}${fila("Familia", esc(i.fa) || "–")}
        ${fila("Tipo en tu local", `<span class="at-cat ${esc(i.cat)}">${esc(i.cat)}</span> ${NOM_TIPO[i.cat] || ""}`)}${fila("Patrón de venta", esc(PATRON_T[i.pat] || "–"))}
        ${fila("ADI (cada cuántos meses vende)", i.adi ?? "–")}${fila("CV² (variación de la cantidad)", i.cv2 ?? "–")}${fila("Meses con venta (últimos 12)", conV)}</table></section>
      <section class="at-box"><h3>Estado del inventario</h3>
        <div class="at-barra"><div class="ab-col"><div class="ab-v" style="top:${yy(nec)}%;bottom:${100 - yy(seg)}%"><span>${fCaja(nec, i.fr)}</span></div><div class="ab-r" style="top:${yy(seg)}%"><span>${fCaja(seg, i.fr)}</span></div></div>
          <div class="ab-f der" style="top:${yy(i.st)}%">← ${fCaja(i.st, i.fr)} <small>stock hoy</small></div>
          <div class="ab-f izq" style="top:${yy(enC)}%"><small>en ${A.C} días</small> ${fCaja(enC, i.fr)} →</div></div>
        <p class="at-nota">Estado: <b style="color:${colE}">${Math.round(estado * 100)} %</b> · rojo = stock de seguridad (${A.Sg} días) · verde = lo que necesita (${A.C} + ${A.Sg} días)</p></section>
      <section class="at-box"><h3>Abastecimiento</h3><table class="at-kv">
        ${fila("Tipo", "Envío desde droguería")}${fila("Tu stock", fCaja(i.st, i.fr))}${fila("Venta diaria", `${fCaja(i.d, i.fr)} <small class="muted">(${esc(i.vd || "")})</small>`)}
        ${fila("Cobertura", i.d <= 0 ? "sin venta" : i.cob == null ? "–" : nf(i.cob) + " días")}${fila(`Necesita (${A.C} + ${A.Sg} días)`, fCaja(nec, i.fr))}
        ${fila("Se te enviará", `<b>${i.pide ? nf(i.pide) : "–"}</b>`)}
        ${i.pide ? fila("Sale de", [i.drog ? `${nf(i.drog)} de droguería` : "", ...(i.de || []).map(x => `${nf(x.q)} de ${esc(x.f)}`), i.cmp ? `${nf(i.cmp)} por comprar` : ""].filter(Boolean).join(" · ") || "–") : ""}
        ${fila("Unidad", i.fr > 1 ? `caja de ${i.fr} fracciones` : "caja")}${i.aj ? fila("Criterio propio", esc(i.aj)) : ""}</table></section></div>`;
  } else if (S.atTab === "pron") {
    const lab = [...meses, ...fm], real = [...hv, ...fm.map((m, k) => k === 0 && i.av != null ? i.av : null)];
    const hace = k => fm.map(m => { const [y, mo] = m.split("-"); const j = meses.indexOf(`${+y - k}-${mo}`); return j >= 0 ? hv[j] : null; });
    const celdas = a => a.map(v => `<td class="n">${v == null ? '<span class="muted">·</span>' : fCaja(v, i.fr)}</td>`).join("");
    cuerpo = `<section class="at-box"><h3>Venta en ${donde} y pronóstico</h3>${svgGraf(lab, [
        { nombre: "Venta real", tipo: "linea", color: "#7cb342", data: real },
        { nombre: "Pronóstico", tipo: "linea", color: "#e53935", data: [...meses.map(() => null), ...(i.pr || [])] }], i.fr)}</section>
      <div class="at-scroll"><table class="at-mes"><thead><tr><th></th>${fm.map(m => `<th>${etM(m)}</th>`).join("")}</tr></thead><tbody>
        <tr><th>Venta hace 2 años</th>${celdas(hace(2))}</tr><tr><th>Venta hace 1 año</th>${celdas(hace(1))}</tr>
        <tr><th>Venta real${A.avDia ? ` <small class="muted">(al ${A.avDia})</small>` : ""}</th>${celdas(fm.map((m, k) => k === 0 && i.av != null ? i.av : null))}</tr>
        <tr class="b"><th>Pronóstico</th>${celdas(i.pr || [])}</tr></tbody></table></div>
      <p class="at-nota">Método estadístico usado: <b>${esc(i.met || "–")}</b>. El pronóstico es de ${donde}, con su venta de cada mes.</p>`;
  } else {
    const f = planLocal(i, A), rw = (t, k, b) => `<tr${b ? ' class="b"' : ""}><th>${t}</th>${f.map(x => `<td class="n">${fCaja(x[k], i.fr)}</td>`).join("")}</tr>`;
    cuerpo = `<section class="at-box"><h3>Plan de tu local (12 meses)</h3>${svgGraf(f.map(x => x.m), [
        { nombre: "Envío propuesto", tipo: "barra", color: "#1e88e5", data: f.map(x => x.env) },
        { nombre: "Demanda", tipo: "barra", color: "#fbc02d", data: f.map(x => x.dem) },
        { nombre: "Stock inicial", tipo: "linea", color: "#7cb342", data: f.map(x => x.ini) },
        { nombre: `Necesita (${A.C} + ${A.Sg} d)`, tipo: "linea", color: "#fb8c00", data: f.map(x => x.obj), puntos: false },
        { nombre: "Stock de seguridad", tipo: "linea", color: "#e53935", data: f.map(x => x.seg), puntos: false }], i.fr)}</section>
      <div class="at-scroll"><table class="at-mes"><thead><tr><th></th>${f.map(x => `<th>${etM(x.m)}</th>`).join("")}</tr></thead><tbody>
        ${rw(`Necesita (${A.C} + ${A.Sg} días)`, "obj")}${rw("Stock de seguridad", "seg")}${rw("Stock inicial", "ini")}${rw("Demanda", "dem", 1)}${rw("Envío propuesto", "env", 1)}${rw("Stock final", "fin")}</tbody></table></div>
      <p class="at-nota">Con el pronóstico de cada mes: cuando tu stock baja de la seguridad (${A.Sg} días) se propone un envío para cubrir ${A.C} días + ${A.Sg} de seguridad. Es una estimación; lo que se envía de verdad lo decide Abastecimiento.</p>`;
  }
  $("atInfoC").innerHTML = `<div class="at-info-cab"><div><h2>${esc(i.n)}</h2><div class="muted">Código ${esc(i.c)} · ${esc(i.l)} · ${falt ? "toda la empresa" : esc(nombreFarm(A.suc))}</div></div>
      <button type="button" class="btn sm" data-cerrar-info aria-label="Cerrar">✕</button></div>
    <div class="at-tabs" role="tablist">${tabs.map(([k, t]) => `<button type="button" role="tab" data-at-tab="${k}" aria-selected="${S.atTab === k}">${t}</button>`).join("")}</div>${cuerpo}`;
}
$("atInfo").addEventListener("click", e => { const t = e.target.closest("[data-at-tab]"); if (t) { S.atTab = t.dataset.atTab; pintarInfo(); } });
["atTabla", "atDlg"].forEach(t => $(t).addEventListener("click", e => {
  const b = e.target.closest("[data-info]"); if (b) return abrirInfo(b.dataset.info);
  const r = e.target.closest("[data-resp]"); if (r) { S.atEdit = r.dataset.resp; S.atForm = null; S.atBus = ""; cargarGenericos().then(() => S.atEdit && pintarAten()); pintarAten(); return; }
  const box = e.target.closest("[data-rf]"); if (!box) return;
  const ac = e.target.closest("[data-ralt-c]");
  if (ac) { const p = S.catIdx.get(ac.dataset.raltC); leerAtForm(box); const sel = [...altsForm(S.atResp?.get(S.atEdit))];
    if (p && sel.length < MAX_ALT && !sel.some(a => a.c === p.c)) sel.push({ c: p.c, n: p.n }); S.atForm.alts = sel; S.atBus = ""; return pintarAten(); }
  const qa = e.target.closest("[data-ralt-quitar]");
  if (qa) { leerAtForm(box); const sel = [...altsForm(S.atResp?.get(S.atEdit))]; sel.splice(+qa.dataset.raltQuitar, 1); S.atForm.alts = sel; return pintarAten(); }
  if (e.target.closest("[data-rcancelar]")) { S.atEdit = null; S.atForm = null; pintarAten(); }
  else if (e.target.closest("[data-rguardar]")) guardarResp(box.dataset.rf);
  else if (e.target.closest("[data-rquitar]")) deleteDoc(doc(db, "atencion_resp", `${miFarm()}__${box.dataset.rf}`))
    .then(() => { S.atEdit = null; S.atForm = null; toast("Respuesta quitada"); pintarAten(); }).catch(x => { $("atRMsg").hidden = false; $("atRMsg").textContent = textoError(x); });
}));
["atTabla", "atDlg"].forEach(t => $(t).addEventListener("change", e => {
  if (e.target.name !== "atR") return;
  const box = e.target.closest("[data-rf]");
  leerAtForm(box); if (S.atForm.estado === "otro_medicamento") cargarGenericos().then(() => S.atEdit && pintarAten());
  pintarAten();
}));
["atTabla", "atDlg"].forEach(t => $(t).addEventListener("input", e => {
  if (!e.target.matches("[data-rbus]")) return;
  S.atBus = e.target.value;
  const i = (S.aten?.items || []).find(x => x.c === S.atEdit) || { c: S.atEdit }, box = $("atRes");
  box.innerHTML = resBusqueda(i, S.atBus, () => false, "data-ralt-c"); box.hidden = !S.atBus.trim();
}));
$("atXls").addEventListener("click", () => {
  const A = S.aten, suc = esAdmin() ? (S.atSuc || FARMACIAS[0]) : miFarm();
  if (!A?.items?.length) return toast("Aún no hay lista publicada para descargar.");
  const datos = A.items.map(i => { const r = S.atResp?.get(i.c);
    return { "Código": i.c, Producto: i.n, Laboratorio: i.l || "", Tipo: i.cat || "", "Cobertura (días)": i.d <= 0 ? "sin venta" : i.cob ?? "",
      "Venta diaria": +Number(i.d || 0).toFixed(2), "Tu stock": i.st, "Se te enviará": i.pide || 0,
      Urgente: i.urg ? "Sí" : "", Nota: [i.pide && i.falta ? `${i.falta} sin stock en droguería` : "", ...(i.de || []).map(x => `${x.q} de ${x.f}`), i.cmp ? `${i.cmp} por comprar` : "", i.aj ? "Criterio propio: " + i.aj : "", i.cmb ? "En cambio de " + i.cmb : "", i.rmp ? "Droguería lo reemplaza por " + i.rmp : "", i.enl ? "En lugar de " + i.enl : "",
        ...(i.alt || []).map(a => `${a.c} ${a.n}: tienes ${a.st}${a.cob != null ? ` (${a.cob} días)` : ""}`)].filter(Boolean).join(" · "),
      "Respuesta de droguería": estVig(i.c) ? textoEstado(estVig(i.c)) + (estVig(i.c).comentario ? " · " + estVig(i.c).comentario : "") : "",
      Respuesta: r ? RESP_AT.find(x => x.id === r.estado)?.txt || r.estado : "", "Medicamento en su cambio": r?.alternativa || "", Comentario: r?.comentario || "",
      "Respondió": r?.porNombre || "", Fecha: r ? aFecha(r.fecha) || "" : "" }; });
  excelDe(datos, "Atención", "atencion_" + corto(suc).replace(/\W+/g, "_").toLowerCase());
});
$("fsTabla").addEventListener("click", e => { const b = e.target.closest("[data-finfo]"); if (b) abrirInfo(b.dataset.finfo, "falt"); });
$("atInfo").addEventListener("click", e => { if (e.target.closest("[data-cerrar-info]") || e.target === $("atInfo")) $("atInfo").close(); });
$("atQ").addEventListener("input", e => { S.atQ = e.target.value; pintarAten(); });
$("atSuc").addEventListener("change", e => { S.atSuc = e.target.value; escucharAten(); pintarAten(); });

/* ===================== exportar a Excel ===================== */
let XLSX = null;
async function descargarExcel(filas, nombre, conFarmacia) {
  await cargarGenericos();   // para la columna Línea
  try { XLSX ??= await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm"); }
  catch { return toast("No se pudo preparar el Excel. Revisa tu internet e inténtalo de nuevo."); }
  const estado = d => d.solicitud?.estado === "pendiente" ? "Reactivación pedida" : d.solicitud?.estado === "rechazada" ? "Reactivación rechazada" : "Bloqueado";
  const datos = filas.sort((a, b) => (a.farmacia + a.producto).localeCompare(b.farmacia + b.producto)).map(d => ({
    ...(conFarmacia ? { Farmacia: corto(d.farmacia), "Almacén (kardex)": d.farmacia } : {}),
    "Código": String(d.codpro).startsWith(SIN_COD) ? "" : d.codpro,
    Producto: d.producto,
    "Línea": lineaDe(d),
    Laboratorio: d.laboratorio || "",
    Motivo: d.motivo,
    Comentario: d.comentario || "",
    Desde: aFecha(d.desde) || "",
    "Bloqueado por": d.porNombre || "",
    Estado: estado(d),
    "En la lista": d.fueraCatalogo ? "No" : "Sí",
    ...(conFarmacia ? { Revisar: d.revisar || "" } : {})
  }));
  excelDe(datos, "Bloqueados", nombre);
}
async function excelDe(datos, hojaNom, nombre) {
  try { XLSX ??= await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm"); }
  catch { return toast("No se pudo preparar el Excel. Revisa tu internet e inténtalo de nuevo."); }
  const hoja = XLSX.utils.json_to_sheet(datos, { cellDates: true, dateNF: "dd/mm/yyyy" });
  const cols = Object.keys(datos[0] || { Producto: "" });
  hoja["!cols"] = cols.map(c => ({ wch: Math.min(48, Math.max(c.length, ...datos.map(d => String(d[c] instanceof Date ? "00/00/0000" : d[c]).length)) + 2) }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, hojaNom);
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

/* ===================== productos agotados o de extrema urgencia (hoja del formulario en Google Drive) ===================== */
// La hoja (compartida con "cualquiera con el enlace") se lee directo desde el navegador y se vuelve a leer cada 2 minutos.
// El administrador ve un tablero (cifras, gráficos, top 5) y marca cada pedido; las sucursales ven tarjetas por estado.
const HOJA_PEDIDOS = "18-biRg4ySB4By1Q0mYLJT2On3XrYZV7BhdwUyiWlfvI";
S.ped = null; S.pdSuc = ""; S.pdQ = ""; S.pdDesde = ""; S.pdMostrar = 200; S.pdHasta = ""; S.urgEst = new Map();
function leerCSV(t) {
  const filas = []; let f = [], c = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { f.push(c); c = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; f.push(c); filas.push(f); f = []; c = ""; }
    else c += ch;
  }
  if (c || f.length) { f.push(c); filas.push(f); }
  return filas.filter(r => r.some(x => x.trim()));
}
// qué sucursal es el texto que escribieron ("Huancas", "Sucursal Real", "Mcdo. Tambo"…)
const CLAVES_SUC = () => FARMACIAS.filter(f => /^ALMACEN /.test(f)).flatMap(f => {
  const ks = new Set([f, visible(f)].map(x => norm(x).replace(/^ALMACEN /, "").replace(/[^A-Z0-9]+/g, " ").trim()));
  if (/TAMBO/.test(f)) ks.add("TAMBO");
  ks.delete("SUCURSAL");   // "ALMACEN SUCURSAL" es Puno: la palabra "sucursal" sola no dice cuál es
  return [...ks].map(k => [k, f]);
}).sort((a, b) => (b[0].includes("TAMBO") - a[0].includes("TAMBO")) || b[0].length - a[0].length);
function sucDe(texto) {
  // "Almacén Sucursal" (o solo "Sucursal") es Puno; "Sucursal Real" es Real y "Sucursal Puno" es Puno
  if (/^(ALMACEN )?SUCURSAL$/.test(norm(texto).replace(/[^A-Z0-9]+/g, " ").trim())) return "ALMACEN SUCURSAL";
  const t = " " + norm(texto).replace(/[^A-Z0-9]+/g, " ").replace(/\b(SUCURSAL|ALMACEN|FARMACIA|BOTICA|SOCORRO)\b/g, " ").replace(/\s+/g, " ").trim() + " ";
  return (CLAVES_SUC().find(([k]) => t.includes(" " + k + " ")) || [])[1] || "";
}
const fechaDe = v => { // "27/10/2026 14:05:10" o "2026-10-27"
  const m = String(v || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  const d = new Date(v); return isNaN(d) ? null : d;
};
// id estable de cada fila (para guardar lo que marca droguería): se calcula con el contenido de la fila
const idFila = x => { let h = 5381; for (const ch of x.join("\u0001")) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return "u" + h.toString(36) + "_" + x.length; };
// el código que escribieron, en el catálogo (también si le faltan los ceros de adelante)
const prodCat = c => { c = String(c || "").trim(); return c ? S.catIdx.get(c) || (/^\d+$/.test(c) ? S.catIdx.get(c.padStart(5, "0")) : null) : null; };
async function cargarPedidos(forzar) {
  escucharUrg(); cargarDrogStk();
  if (S.pdCargando || (!forzar && S.ped && Date.now() - S.ped.t < 120000)) return;
  S.pdCargando = true;
  try {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${HOJA_PEDIDOS}/gviz/tq?tqx=out:csv&_=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const filas = leerCSV(await r.text());
    const cab = (filas.shift() || []).map(x => x.trim());
    const col = (re, sin = []) => cab.findIndex((h, i) => re.test(norm(h)) && !sin.includes(i));
    const cS = col(/SUCURSAL|ALMACEN|FARMACIA|LOCAL|BOTICA/), cF = col(/MARCA TEMPORAL|FECHA|TIMESTAMP/);
    const cC = col(/COD/), cP = col(/PRODUCTO|MEDICAMENTO|DESCRIPCION|INSUMO/, [cC, cS, cF]), cQ = col(/CANTIDAD|CANT\b|UNIDADES/);
    const cM = col(/MOTIVO|OBSERV|COMENTARIO|DETALLE|URGENCIA/), cU = col(/RESPONSABLE|SOLICITA|QUIMICO|APELLIDO|CORREO|USUARIO|NOMBRE/, [cP, cC, cS]);
    // el producto: la columna de código/producto; si en esa fila está vacía, cualquier otra columna con texto
    // (la hoja junta respuestas de versiones anteriores del formulario). Varios códigos en una respuesta = varios productos.
    const fuera = [cS, cF, cU, cQ, cM], otras = cab.map((h, i) => i).filter(i => !fuera.includes(i) && !/CORREO|EMAIL/.test(norm(cab[i])));
    const orden = [cC, cP, ...otras].filter((i, j, a) => i >= 0 && a.indexOf(i) === j);
    const datos = filas.flatMap((x, k) => {
      const crudo = String(x[orden.find(i => String(x[i] || "").trim())] ?? "").trim();
      const cods = crudo.match(/\b\d{3,6}\b/g), partes = cods && cods.length && crudo.replace(/[\d\s,;\/.\-y]+/gi, "") === "" ? cods : [crudo];
      return partes.map(p => p.trim()).filter(p => p && !/^[-–.\s]*$/.test(p)).map((pz, j) => {
        const pc = prodCat(pz) || (cods?.length === 1 ? prodCat(cods[0]) : null);
        return { k: k + j / 100, x, id: idFila(x) + (partes.length > 1 ? "_" + j : ""), suc: cS >= 0 ? sucDe(x[cS]) : "", f: cF >= 0 ? fechaDe(x[cF]) : null,
          cod: pc?.c || (/^\d+$/.test(pz) ? pz : ""), nom: pc?.n || (/^\d+$/.test(pz) ? "" : pz), lab: pc?.ln || "",
          q: cQ >= 0 ? parseFloat(String(x[cQ]).replace(",", ".")) || 0 : 0, mot: cM >= 0 ? x[cM].trim() : "", quien: cU >= 0 ? x[cU].trim() : "" };
      });
    });
    S.ped = { t: Date.now(), cab, cS, cF, datos: datos.filter(d => d.cod || d.nom) }; S.pdErr = "";
  } catch (e) {
    S.pdErr = "No se pudo leer la hoja de pedidos. Revisa tu internet, y que la hoja esté compartida como «Cualquier persona con el enlace puede ver». (" + (e.message || e) + ")";
  }
  S.pdCargando = false; if (S.vista === "vPed") pintarPedidos();
}
setInterval(() => { if (S.vista === "vPed" && !document.hidden) cargarPedidos(true); }, 120000);
// lo que marca droguería en cada pedido (urgencia_estado/{id}): viendo | atendido, con una nota
function escucharUrg() {
  if (S.urgSub) return; S.urgSub = true;
  const un = onSnapshot(collection(db, "urgencia_estado"), sn => { S.urgEst = new Map(sn.docs.map(d => [d.id, d.data()])); if (S.vista === "vPed") pintarPedidos(); },
    () => { S.urgSub = false; });
  S.subs.push(() => { un(); S.urgSub = false; });
}
// stock de droguería (red/stk_DROGUERIA FS, se publica con las listas) para el top 5 del administrador
async function cargarDrogStk() {
  if (S.drogStk || S.drogStkCargando) return; S.drogStkCargando = true;
  try { const d = await getDoc(doc(db, "red", "stk_DROGUERIA FS")); S.drogStk = d.exists() ? d.data().p || {} : {}; } catch { S.drogStk = {}; }
  S.drogStkCargando = false; if (S.vista === "vPed") pintarPedidos();
}
const puedeMarcarUrg = () => esAdmin() || ["sucursales", "kardex"].some(v => (S.perfil?.vistas || []).includes(v));
const ESTADO_U = { "": ["🔴 Pedido recién", "rojo"], viendo: ["🟠 Droguería lo está viendo", "amb"], atendido: ["🟢 Atendido", "verde"] };
const estU = d => S.urgEst.get(d.id) || {};
const inicioDia = (n = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
const hace = f => { if (!f) return ""; const m = Math.round((Date.now() - f) / 60000); return m < 1 ? "recién" : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : f.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" }); };
const nomProd = d => d.nom || (d.cod ? "Código " + d.cod : "(sin producto)");
function pedidosVisibles() {
  const P = S.ped; if (!P) return [];
  const admin = esAdmin() || !miFarm(), suc = admin ? S.pdSuc : miFarm(), q = norm(S.pdQ).trim().split(/\s+/).filter(Boolean);
  const desde = S.pdDesde ? new Date(S.pdDesde + "T00:00:00") : null, hasta = S.pdHasta ? new Date(S.pdHasta + "T23:59:59") : null;
  return P.datos.filter(d => (!suc || d.suc === suc) && (!desde || !d.f || d.f >= desde) && (!hasta || !d.f || d.f <= hasta) && (!q.length || q.every(w => norm(d.x.join(" ") + " " + d.nom).includes(w))))
    .sort((a, b) => (b.f || 0) - (a.f || 0) || b.k - a.k);
}
function pintarPedidos() {
  const P = S.ped, admin = esAdmin() || !miFarm();
  $("pdNuevoA").hidden = !esAdmin(); $("pdDrive").hidden = !esAdmin(); $("pdDrive").href = `https://docs.google.com/spreadsheets/d/${HOJA_PEDIDOS}/edit`;
  $("pdSucF").hidden = !admin; $("pdA").hidden = !admin || !P; $("pdLista").hidden = !admin; $("pdB").hidden = admin || !P;
  $("pdSub").textContent = admin ? "Lo que cada sucursal pidió de urgencia. Se actualiza desde el formulario."
    : `Lo que ${nombreFarm(miFarm())} pidió de urgencia. Se actualiza desde el formulario.`;
  msg("pdMsg", S.pdErr || "", true);
  if (!P) { $("pdTabla").innerHTML = `<tbody><tr class="vacia"><td>${S.pdErr ? "" : "Leyendo la hoja de pedidos…"}</td></tr></tbody>`; if (!admin) $("pdLista").hidden = false; return; }
  $("pdHora").textContent = "Actualizado " + new Date(P.t).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  if (!admin && P.cS < 0) { msg("pdMsg", "La hoja no tiene una columna de sucursal; consulta con Abastecimiento.", true); $("pdB").hidden = true; return; }
  if (admin) pintarTableroUrg(P); else pintarTarjetasUrg();
}
// ---------- usuarios: tabla simple (medicamento, fecha y hora, si hay en droguería) ----------
const hayDrog = c => { if (S.drogStk == null) return '<span class="muted">…</span>'; const v = S.drogStk[c]?.[0];
  return v > 0 ? `<span class="chip verde">✓ Sí hay (${nf(v)})</span>` : c ? '<span class="chip rojo">✗ No hay</span>' : '<span class="muted">–</span>'; };
function pintarTarjetasUrg() {
  const lista = pedidosVisibles();
  $("pdTablaU").innerHTML = `<thead><tr><th>Medicamento</th><th>Fecha y hora del pedido</th><th>¿Hay en droguería?</th></tr></thead><tbody>` +
    (lista.length ? lista.map(d => `<tr><td class="p"><b>${esc(nomProd(d))}</b>${d.cod && d.nom ? `<code>${esc(d.cod)}</code>` : ""}</td>
      <td class="f">${d.f ? d.f.toLocaleString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : esc(d.x[S.ped.cF] || "")}</td><td>${hayDrog(d.cod)}</td></tr>`).join("")
      : '<tr class="vacia"><td colspan="3">No hay pedidos en esas fechas.</td></tr>') + "</tbody>";
}
// ---------- administrador: tablero ----------
function pintarTableroUrg(P) {
  const base = P.datos.filter(d => !S.pdSuc || d.suc === S.pdSuc), hoy = inicioDia(0), ayer = inicioDia(1), sem = inicioDia(6);
  const deHoy = base.filter(d => d.f && d.f >= hoy), deAyer = base.filter(d => d.f && d.f >= ayer && d.f < hoy), deSem = base.filter(d => d.f && d.f >= sem);
  const cuenta = (arr, key) => { const m = new Map(); arr.forEach(d => { const k = key(d); if (k) m.set(k, (m.get(k) || 0) + 1); }); return [...m].sort((a, b) => b[1] - a[1]); };
  const sucTop = cuenta(deHoy.length ? deHoy : deSem, d => d.suc)[0];
  const porProd = new Map(); deSem.forEach(d => { const k = d.cod || d.nom; if (!k) return; const x = porProd.get(k) || { d, q: 0, n: 0, s: new Set() }; x.q += d.q || 1; x.n++; if (d.suc) x.s.add(d.suc); porProd.set(k, x); });
  const top = [...porProd.values()].sort((a, b) => b.s.size - a.s.size || b.q - a.q).slice(0, 5);
  const dif = deHoy.length - deAyer.length;
  $("pdKpi").innerHTML = `
    <div class="card pd-kpi"><small>Pedidos hoy</small><b class="n rojo-t">${nf(deHoy.length)}</b><small>${dif > 0 ? `▲ ${dif} más que ayer` : dif < 0 ? `▼ ${-dif} menos que ayer` : "igual que ayer"}</small></div>
    <div class="card pd-kpi"><small>Productos distintos hoy</small><b class="n">${nf(new Set(deHoy.map(d => d.cod || d.nom)).size)}</b><small>esta semana: ${nf(porProd.size)}</small></div>
    <div class="card pd-kpi"><small>Sucursal que más pide${deHoy.length ? " hoy" : " (semana)"}</small><b class="n m">${sucTop ? esc(corto(sucTop[0])) : "–"}</b><small>${sucTop ? nf(sucTop[1]) + " pedidos" : ""}</small></div>
    <div class="card pd-kpi"><small>Producto más pedido (semana)</small><b class="n s">${top[0] ? esc(nomProd(top[0].d)) : "–"}</b><small class="cod">${top[0] ? esc(top[0].d.cod) + " · " + top[0].s.size + " sucursales" : ""}</small></div>`;
  // barras por sucursal (todas, últimos 7 días)
  const barras = cuenta(P.datos.filter(d => d.f && d.f >= sem), d => d.suc), mx = Math.max(1, ...barras.map(b => b[1]));
  $("pdBarras").innerHTML = barras.length ? `<svg viewBox="0 0 520 ${barras.length * 30 + 6}" class="pd-svg">${barras.map(([f, n], i) => {
    const w = Math.max(4, 370 * n / mx), y = 6 + i * 30, c = ["#14306B", "#14306B", "#3d5a99", "#3d5a99", "#6b84bf", "#6b84bf"][i] || "#9fb1d9";
    return `<g class="pd-bar" data-pdsuc="${esc(f)}"><text x="0" y="${y + 13}">${esc(corto(f))}</text><rect x="100" y="${y}" width="${w}" height="18" rx="4" fill="${S.pdSuc === f ? "#F28C1E" : c}"/><text x="${106 + w}" y="${y + 14}">${n}</text></g>`; }).join("")}</svg>`
    : '<p class="muted">Sin pedidos en los últimos 7 días.</p>';
  // línea por día (últimos 7 días)
  const dias = Array.from({ length: 7 }, (_, i) => inicioDia(6 - i)), vals = dias.map((d0, i) => base.filter(d => d.f && d.f >= d0 && (i === 6 || d.f < dias[i + 1])).length);
  const mv = Math.max(1, ...vals), X = i => 40 + i * 65, Y = v => 170 - v / mv * 140;
  $("pdLinH").textContent = "Pedidos por día" + (S.pdSuc ? " · " + corto(S.pdSuc) : "");
  $("pdLinea").innerHTML = `<svg viewBox="0 0 460 200" class="pd-svg"><g stroke="#eceff3"><line x1="30" x2="450" y1="30" y2="30"/><line x1="30" x2="450" y1="100" y2="100"/><line x1="30" x2="450" y1="170" y2="170"/></g>
    <polyline points="${vals.map((v, i) => X(i) + "," + Y(v)).join(" ")}" fill="none" stroke="#F28C1E" stroke-width="3"/>
    ${vals.map((v, i) => `<circle cx="${X(i)}" cy="${Y(v)}" r="${i === 6 ? 5 : 4}" fill="#F28C1E"><title>${v} pedidos</title></circle><text x="${X(i)}" y="${Y(v) - 10}" text-anchor="middle" class="${i === 6 ? "hoy" : ""}">${v}</text>
      <text x="${X(i)}" y="192" text-anchor="middle" class="dia">${i === 6 ? "hoy" : dias[i].toLocaleDateString("es-PE", { weekday: "short" })}</text>`).join("")}</svg>`;
  // top 5 con el stock de droguería
  const stDrog = c => { const v = S.drogStk?.[c]?.[0]; return S.drogStk == null ? "" : v > 0 ? `<span class="chip ${v >= 0 ? "verde" : ""}">Hay ${nf(v)}</span>` : '<span class="chip rojo">Sin stock</span>'; };
  $("pdTop").innerHTML = `<thead><tr><th>Producto</th><th>Sucursales que lo pidieron</th><th class="der">Cant.</th><th>En droguería</th></tr></thead><tbody>` +
    (top.length ? top.map(x => `<tr><td class="p"><b>${esc(nomProd(x.d))}</b><code>${esc(x.d.cod)}</code></td><td>${[...x.s].map(f => `<span class="tag">${esc(corto(f))}</span>`).join(" ")} <b>${x.s.size}</b></td><td class="der"><b>${nf(x.q)}</b></td><td>${stDrog(x.d.cod)}</td></tr>`).join("")
      : '<tr class="vacia"><td colspan="4">Sin pedidos esta semana.</td></tr>') + "</tbody>";
  // resumen por sucursal (filtro) y lista de pedidos para marcarlos
  const res = $("pdRes"); res.hidden = P.cS < 0;
  if (P.cS >= 0) res.innerHTML = cuenta(P.datos, d => d.suc || "?").map(([f, c]) => `<button type="button" class="pd-chip${S.pdSuc === f ? " act" : ""}" data-pdsuc="${esc(f)}">${esc(f === "?" ? "Sin reconocer" : corto(f))} <b>${nf(c)}</b></button>`).join("");
  if (!$("pdSuc").options.length) $("pdSuc").innerHTML = `<option value="">Todas</option>` + FARMACIAS.filter(f => /^ALMACEN /.test(f)).map(f => `<option value="${esc(f)}">${esc(corto(f))}</option>`).join("");
  $("pdSuc").value = S.pdSuc;
  const lista = pedidosVisibles(), vis = lista.slice(0, S.pdMostrar), marca = puedeMarcarUrg();
  $("pdTit").textContent = `Pedidos recientes · ${nf(lista.length)}`;
  $("pdTabla").innerHTML = `<thead><tr><th>Fecha</th>${P.cS >= 0 ? "<th>Sucursal</th>" : ""}<th>Producto</th><th class="der">Cant.</th><th>Motivo</th><th>Pidió</th><th>Estado</th><th>Nota de droguería</th></tr></thead><tbody>` +
    (vis.length ? vis.map(d => { const e = estU(d), k = e.estado || "";
      return `<tr data-uid="${esc(d.id)}"><td class="f">${d.f ? d.f.toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}</td>${P.cS >= 0 ? `<td><b>${esc(d.suc ? corto(d.suc) : "¿" + (d.x[P.cS] || "") + "?")}</b></td>` : ""}
        <td class="p"><b>${esc(nomProd(d))}</b><code>${esc(d.cod)}</code></td><td class="der">${d.q ? nf(d.q) : ""}</td><td>${esc(d.mot)}</td><td>${esc(d.quien)}</td>
        <td>${marca ? `<select class="pd-est ${ESTADO_U[k][1]}" data-uest>${Object.entries(ESTADO_U).map(([v, [t]]) => `<option value="${v}" ${v === k ? "selected" : ""}>${t}</option>`).join("")}</select>` : `<span class="chip ${ESTADO_U[k][1]}">${ESTADO_U[k][0]}</span>`}</td>
        <td>${marca ? `<input class="pd-nota" data-unota maxlength="120" placeholder="Ej. en tránsito, guía GR…" value="${esc(e.nota || "")}">` : esc(e.nota || "")}</td></tr>`; }).join("")
      : `<tr class="vacia"><td colspan="8">No hay pedidos con estos filtros.</td></tr>`) + "</tbody>";
  $("pdMas").innerHTML = lista.length > vis.length ? `<button class="btn" type="button" id="pdMasBtn">Ver más (de ${nf(lista.length)})</button>` : "";
}
async function marcarUrg(tr) {
  const d = S.ped?.datos.find(x => x.id === tr.dataset.uid); if (!d) return;
  const estado = tr.querySelector("[data-uest]").value, nota = tr.querySelector("[data-unota]").value.trim().slice(0, 120);
  try {
    if (!estado && !nota) await deleteDoc(doc(db, "urgencia_estado", d.id));
    else await setDoc(doc(db, "urgencia_estado", d.id), { estado, nota, suc: d.suc || "", cod: d.cod || "", porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario, fecha: serverTimestamp() });
    toast("Pedido actualizado");
  } catch (x) { toast(textoError(x)); }
}
$("pdTabla").addEventListener("change", e => { const tr = e.target.closest("tr[data-uid]"); if (tr && e.target.matches("[data-uest],[data-unota]")) marcarUrg(tr); });
$("pdAct").addEventListener("click", () => cargarPedidos(true));
$("pdSuc").addEventListener("change", e => { S.pdSuc = e.target.value; pintarPedidos(); });
["pdQ", "pdQ2"].forEach(id => $(id).addEventListener("input", e => { S.pdQ = e.target.value; pintarPedidos(); }));
["pdDesde", "pdDesde2"].forEach(id => $(id).addEventListener("change", e => { S.pdDesde = e.target.value; pintarPedidos(); }));
["pdHasta", "pdHasta2"].forEach(id => $(id).addEventListener("change", e => { S.pdHasta = e.target.value; pintarPedidos(); }));
["pdRes", "pdBarras"].forEach(id => $(id).addEventListener("click", e => { const b = e.target.closest("[data-pdsuc]"); if (!b) return; S.pdSuc = S.pdSuc === b.dataset.pdsuc ? "" : b.dataset.pdsuc; pintarPedidos(); }));
$("pdMas").addEventListener("click", e => { if (e.target.closest("#pdMasBtn")) { S.pdMostrar += 200; pintarPedidos(); } });
["pdXls", "pdXls2"].forEach(id => $(id).addEventListener("click", () => {
  const P = S.ped; if (!P) return;
  const cols = P.cab.map((h, i) => i).filter(i => P.cab[i]);
  if (!(esAdmin() || !miFarm())) { const ds = pedidosVisibles().map(d => ({ "Código": d.cod, Medicamento: nomProd(d), "Fecha y hora": d.f || "", "¿Hay en droguería?": S.drogStk?.[d.cod]?.[0] > 0 ? "Sí (" + S.drogStk[d.cod][0] + ")" : "No" }));
    if (!ds.length) return toast("No hay pedidos para descargar."); return excelDe(ds, "Urgencias", "agotados_urgencia_" + corto(miFarm()).replace(/\W+/g, "_").toLowerCase()); }
  const datos = pedidosVisibles().map(d => { const e = estU(d);
    return Object.fromEntries([["Sucursal (reconocida)", d.suc ? corto(d.suc) : ""], ["Código", d.cod], ["Producto (catálogo)", d.nom], ["Estado", ESTADO_U[e.estado || ""][0].slice(3)], ["Nota de droguería", e.nota || ""],
      ...cols.map(i => [P.cab[i], d.x[i] || ""])]); });
  if (!datos.length) return toast("No hay pedidos para descargar.");
  const suc = esAdmin() || !miFarm() ? S.pdSuc : miFarm();
  excelDe(datos, "Urgencias", "agotados_urgencia_" + (suc ? corto(suc) : "todas").replace(/\W+/g, "_").toLowerCase());
}));

// ---------- pedir desde la página: se envía al mismo formulario de Google (cae en la misma hoja de Drive) ----------
S.urgNuevo = []; S.urgBus = "";
const sucFormDe = f => FORM_URGENCIA.sucursales[f] || corto(f);
function abrirNuevoUrg() { S.urgNuevo = []; S.urgBus = ""; S.urgSucSel = miFarm() || ""; pintarNuevoUrg(); $("urgDlg").showModal(); $("urgBus").focus(); }
function pintarNuevoUrg() {
  const fija = !!miFarm() && !esAdmin();
  $("urgSucBox").innerHTML = fija ? `<b>${esc(nombreFarm(miFarm()))}</b> <small class="muted">(tu sucursal)</small>`
    : `<select id="urgSuc"><option value="">Elige la sucursal…</option>${Object.keys(FORM_URGENCIA.sucursales).map(f => `<option value="${esc(f)}" ${S.urgSucSel === f ? "selected" : ""}>${esc(corto(f))}</option>`).join("")}</select>`;
  $("urgSel").innerHTML = S.urgNuevo.length ? S.urgNuevo.map((p, k) => `<span class="fs-alt"><b>${esc(p.c)}</b> ${esc(p.n)} <button type="button" class="enlace" data-urg-quitar="${k}">Quitar</button></span>`).join("")
    : '<small class="muted">Busca y agrega los productos que necesitas (puedes agregar varios).</small>';
  $("urgEnviar").textContent = S.urgNuevo.length > 1 ? `Enviar pedido (${S.urgNuevo.length} productos)` : "Enviar pedido";
}
$("pdNuevo").addEventListener("click", abrirNuevoUrg);
$("pdNuevoA").addEventListener("click", abrirNuevoUrg);
$("urgBus").addEventListener("input", e => {
  S.urgBus = e.target.value; const box = $("urgRes");
  const t = S.urgBus.trim(), libre = /^\d{3,6}$/.test(t) && !prodCat(t) && !S.urgNuevo.some(a => a.c === t);
  box.innerHTML = resBusqueda({ c: "" }, S.urgBus, p => S.urgNuevo.some(a => a.c === p.c), "data-urg-add")
    + (libre ? `<button type="button" data-urg-cod="${esc(t)}"><b>${esc(t)}</b> Agregar este código tal cual (no está en el catálogo)</button>` : ""); box.hidden = !t;
});
$("urgDlg").addEventListener("change", e => { if (e.target.id === "urgSuc") S.urgSucSel = e.target.value; });
$("urgDlg").addEventListener("click", async e => {
  if (e.target.closest("[data-cerrar-dlg]") || e.target === $("urgDlg")) return $("urgDlg").close();
  const a = e.target.closest("[data-urg-add]");
  if (a) { const p = S.catIdx.get(a.dataset.urgAdd); if (p) S.urgNuevo.push({ c: p.c, n: p.n }); $("urgBus").value = S.urgBus = ""; $("urgRes").hidden = true; pintarNuevoUrg(); $("urgBus").focus(); return; }
  const lc = e.target.closest("[data-urg-cod]");
  if (lc) { S.urgNuevo.push({ c: lc.dataset.urgCod, n: "(código sin nombre en el catálogo)" }); $("urgBus").value = S.urgBus = ""; $("urgRes").hidden = true; pintarNuevoUrg(); $("urgBus").focus(); return; }
  const q = e.target.closest("[data-urg-quitar]"); if (q) { S.urgNuevo.splice(+q.dataset.urgQuitar, 1); return pintarNuevoUrg(); }
  if (!e.target.closest("#urgEnviar")) return;
  if (S.prev) return msg("urgMsg", PREVIA.message, true);
  const suc = !esAdmin() && miFarm() ? miFarm() : S.urgSucSel;
  if (!suc) return msg("urgMsg", "Elige la sucursal.", true);
  if (!S.urgNuevo.length) return msg("urgMsg", "Agrega al menos un producto.", true);
  const b = $("urgEnviar"); b.disabled = true; msg("urgMsg", "Enviando…");
  try {
    // Google no deja leer la respuesta desde otra página (no-cors): se envía y luego se confirma al releer la hoja
    // como en el formulario: todos los códigos en una sola respuesta, separados por coma ("21648, 00052, 52147")
    const datos = new URLSearchParams({ [FORM_URGENCIA.campoSucursal]: sucFormDe(suc), [FORM_URGENCIA.campoProducto]: S.urgNuevo.map(p => p.c).join(", ") });
    await fetch(FORM_URGENCIA.url, { method: "POST", mode: "no-cors", body: datos });
    const n = S.urgNuevo.length; $("urgDlg").close(); toast(`Pedido enviado al formulario (${n} producto${n === 1 ? "" : "s"}). Aparecerá en unos segundos.`);
    S.urgNuevo = []; setTimeout(() => cargarPedidos(true), 4000); setTimeout(() => cargarPedidos(true), 15000);
  } catch (x) { msg("urgMsg", "No se pudo enviar. Revisa tu internet e inténtalo de nuevo.", true); }
  finally { b.disabled = false; }
});

/* ===================== vista previa: el administrador ve la página como la ve un usuario ===================== */
const nomUsr = u => `${u.nombre || u.usuario}${u.farmacia ? " · " + corto(u.farmacia) : ""} (${NOMBRE_ROL[u.rol] || u.rol})`;
function ponerPrevia(u) {
  S.prev = u ? { ...u, rol: String(u.rol || "").trim().toLowerCase() } : null;
  document.body.classList.toggle("en-previa", !!S.prev);
  $("prevBar").hidden = !S.prev; $("prevBtn").hidden = !!S.prev || S.perfil?.rol !== "admin";
  if (S.prev) $("prevTxt").textContent = `Vista previa: así ve la página ${nomUsr(S.prev)}, con sus módulos habilitados. No se guarda ningún cambio.`;
  $("uNombre").textContent = S.prev ? (S.prev.nombre || S.prev.usuario) + " (vista previa)" : (S.perfil.nombre || S.perfil.usuario);
  $("uRol").textContent = S.prev ? (S.prev.farmacia ? nombreFarm(S.prev.farmacia) : NOMBRE_ROL[S.prev.rol] || "") : "Abastecimiento";
  S.atSubSuc = null; S.atStkK = null;   // vuelve a leer lo de la sucursal elegida
  ir(S.vista && S.vista !== "vAdmin" && S.vista !== "vUsuarios" && misVistas().some(v => v.vista === S.vista) || S.vista === "vInicio" || S.vista === "vQuimico" ? S.vista : "vInicio");
}
$("prevBtn").addEventListener("click", () => {
  const us = S.usuarios.filter(u => !u.reemplazadoPor && u.activo !== false && String(u.rol || "").trim().toLowerCase() !== "admin")
    .sort((a, b) => (a.farmacia || "~").localeCompare(b.farmacia || "~") || (a.nombre || a.usuario).localeCompare(b.nombre || b.usuario));
  $("prevSuc").innerHTML = us.map(u => `<option value="${esc(u.uid)}">${esc(nomUsr(u))}</option>`).join("") || '<option value="">No hay usuarios</option>';
  $("prevDlg").showModal();
});
$("prevDlg").addEventListener("click", e => {
  if (e.target.closest("[data-cerrar-dlg]") || e.target === $("prevDlg")) return $("prevDlg").close();
  if (e.target.closest("#prevOk")) { const u = S.usuarios.find(x => x.uid === $("prevSuc").value); if (!u) return; $("prevDlg").close(); ponerPrevia(u); }
});
$("prevSalir").addEventListener("click", () => ponerPrevia(null));

// los avisos de los costados empiezan debajo de la cabecera (que puede ocupar 2 o 3 líneas con muchos módulos)
new ResizeObserver(() => document.documentElement.style.setProperty("--alto-top", ($("top").hidden ? 0 : $("top").getBoundingClientRect().bottom) + "px")).observe($("top"));
addEventListener("scroll", () => document.documentElement.style.setProperty("--alto-top", ($("top").hidden ? 0 : Math.max(0, $("top").getBoundingClientRect().bottom)) + "px"), { passive: true });

/* ===================== evaluación de sucursales ===================== */
// Indicadores de stock (automáticos, del kardex publicado en red/eval) + lo que se califica en cada visita
// (rotulación, orden, limpieza, termómetro), la capacidad de almacén (calculadora de anaqueles) y la lista de BPA.
// Cada evaluación se guarda por fecha en evaluacion/{AAAA-MM-DD}: { s: { "ALMACEN X": {...} } }.
const EV_ITEMS = [["rotulacion", "Rotulación"], ["orden", "Orden"], ["limpieza", "Limpieza"], ["termometro", "Termómetro"]];
const EV_NOTA = { "": ["–", ""], c: ["Cumple", "verde"], p: ["Parcial", "amb"], n: ["No cumple", "rojo"] };
const EV_PUNTOS = { c: 100, p: 50, n: 0 };
const BPA = [
  ["Áreas obligatorias", ["Recepción", "Cuarentena", "Aprobados o almacenamiento", "Muestras de retención", "Baja o rechazados", "Devoluciones", "Embalaje y despacho", "Productos controlados", "Área administrativa"]],
  ["Infraestructura", ["Parihuelas, racks o estantes (nada en contacto directo con el piso)", "Temperatura de 20 a 25 °C (máx. 30 °C)", "Cadena de frío", "Termómetro con registro de temperatura", "Protegido de la luz y la humedad"]],
  ["Funcionamiento", ["Flujo sin interferencia de actividades operativas o administrativas", "Instalaciones limpias, con registros de limpieza", "Productos farmacéuticos, dispositivos médicos y sanitarios separados"]]];
const BPA_TOTAL = BPA.reduce((a, [, xs]) => a + xs.length, 0);
S.evFecha = hoyISO(); S.evMin = 15; S.evMax = 90;
try { const g = JSON.parse(localStorage.getItem("ev_umbral") || "{}"); if (g.min) S.evMin = g.min; if (g.max) S.evMax = g.max; } catch {}
const sucsEval = () => FARMACIAS.filter(f => /^ALMACEN /.test(f) && (esAdmin() || !miFarm() || f === miFarm()));
async function cargarEval(forzar) {
  if (S.evCargando) return; S.evCargando = true;
  try {
    if (!S.evStock || forzar) { const d = await getDoc(doc(db, "red", "eval")); S.evStock = d.exists() ? d.data() : { s: {} }; }
    if (!S.evFechas || forzar) { const q = await getDocs(collection(db, "evaluacion")); S.evDocs = new Map(q.docs.map(d => [d.id, d.data()])); S.evFechas = [...S.evDocs.keys()].sort().reverse(); }
  } catch (e) { S.evErr = textoError(e); S.evStock ??= { s: {} }; }
  S.evDocs ??= new Map(); S.evFechas ??= [];
  S.evCargando = false; if (S.vista === "vEval") pintarEval();
}
// los 5 indicadores de stock de una sucursal (% de productos), con los días mínimo y máximo elegidos
function stockEval(f) {
  const e = S.evStock?.s?.[f]; if (!e) return null;
  const n = { normo: 0, sobre: 0, sub: 0, sr: e.sr || 0, de: e.de || 0 }, v = { normo: 0, sobre: 0, sub: 0, sr: e.sv || 0 };
  for (const x of String(e.c || "").split(",").filter(Boolean)) {
    const [d, val] = x.split(":").map(Number), k = d < S.evMin ? "sub" : d > S.evMax ? "sobre" : "normo";
    n[k]++; v[k] += val || 0;
  }
  const tot = n.normo + n.sobre + n.sub + n.sr + n.de, pc = k => tot ? n[k] / tot * 100 : 0;
  const disp = e.dem ? (1 - n.de / e.dem) * 100 : null;
  return { n, v, tot, p: { normo: pc("normo"), sobre: pc("sobre"), sub: pc("sub"), sr: pc("sr"), de: pc("de") }, disp };
}
const nivelStock = p => p == null ? ["–", ""] : p >= 60 ? ["Adecuado", "verde"] : p >= 40 ? ["Regular", "amb"] : ["Deficiente", "rojo"];
const capacidad = c => c && c.largo && c.ancho && c.altura && c.anaqueles ? c.largo * c.ancho * c.altura * c.anaqueles : null;
const bpaPct = b => b ? Object.values(b).filter(Boolean).length / BPA_TOTAL * 100 : null;
const evDe = f => S.evDocs?.get(S.evFecha)?.s?.[f] || {};
const p1 = v => v == null ? "–" : (Math.round(v * 100) / 100).toLocaleString("es-PE", { maximumFractionDigits: 2 }) + " %";
function pintarEval() {
  const admin = esAdmin();
  $("evMin").value = S.evMin; $("evMax").value = S.evMax;
  const fechas = [...new Set([S.evFecha, ...(S.evFechas || [])])].sort().reverse();
  $("evFecha").innerHTML = fechas.map(f => `<option value="${f}" ${f === S.evFecha ? "selected" : ""}>${fDia(f)}${S.evDocs?.has(f) ? "" : " (nueva)"}</option>`).join("");
  $("evNueva").hidden = !admin;
  $("evInfo").innerHTML = S.evStock?.publicado ? `Indicadores de stock con el kardex al <b>${fmtF(S.evStock.corte)}</b> (publicado el ${fFecha(S.evStock.publicado)}) · por cantidad de productos.`
    : "Los indicadores de stock aparecerán después de subir el kardex o abrir Atención a sucursales.";
  msg("evMsg", S.evErr || "", true);
  const filas = sucsEval().map(f => ({ f, st: stockEval(f), e: evDe(f) }));
  const celNota = (f, k, val) => admin ? `<select class="ev-sel ${EV_NOTA[val || ""][1]}" data-evf="${esc(f)}" data-evk="${k}">${Object.entries(EV_NOTA).map(([v, [t]]) => `<option value="${v}" ${v === (val || "") ? "selected" : ""}>${t}</option>`).join("")}</select>`
    : `<span class="chip ${EV_NOTA[val || ""][1]}">${EV_NOTA[val || ""][0]}</span>`;
  $("evTabla").innerHTML = `<thead><tr><th>Sucursal</th><th>Nivel de stockeo</th><th class="der">Capacidad de almacén</th>${EV_ITEMS.map(([, t]) => `<th>${t}</th>`).join("")}
      <th class="der">Disponibilidad</th><th class="der ev-n">Normostock</th><th class="der ev-s">Sobrestock</th><th class="der ev-b">Substock</th><th class="der ev-r">Sin rotación</th><th class="der ev-d">Desabastecido</th><th class="der">Cumplimiento de BPA</th><th></th></tr></thead><tbody>` +
    filas.map(({ f, st, e }) => { const nv = nivelStock(st?.p.normo), cap = capacidad(e.cap), bpa = bpaPct(e.bpa);
      return `<tr><td><b>${esc(corto(f))}</b></td><td><span class="chip ${nv[1]}">${nv[0]}</span></td><td class="der">${cap != null ? cap.toLocaleString("es-PE", { maximumFractionDigits: 2 }) + " m³" : "–"}</td>
        ${EV_ITEMS.map(([k]) => `<td>${celNota(f, k, e[k])}</td>`).join("")}
        <td class="der">${p1(st?.disp)}</td><td class="der ev-n">${p1(st?.p.normo)}</td><td class="der ev-s">${p1(st?.p.sobre)}</td><td class="der ev-b">${p1(st?.p.sub)}</td><td class="der ev-r">${p1(st?.p.sr)}</td><td class="der ev-d">${p1(st?.p.de)}</td>
        <td class="der"><b>${p1(bpa)}</b></td><td><button class="btn sm" type="button" data-evdet="${esc(f)}">${admin ? "Capacidad y BPA" : "Ver detalle"}</button></td></tr>`; }).join("") + "</tbody>";
  // barras apiladas: cómo está el stock de cada sucursal
  const cols = [["normo", "Normostock", "#1E6B5F"], ["sobre", "Sobrestock", "#3d5a99"], ["sub", "Substock", "#B7791F"], ["sr", "Sin rotación", "#8a4f9e"], ["de", "Desabastecido", "#B4321C"]];
  $("evGraf").innerHTML = filas.some(x => x.st) ? `<div class="ev-ley">${cols.map(([, t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join("")}</div>` +
    filas.filter(x => x.st).sort((a, b) => b.st.p.normo - a.st.p.normo).map(({ f, st }) => `<div class="ev-barra"><span>${esc(corto(f))}</span><div>${cols.map(([k, t, c]) => st.p[k] ? `<i style="width:${st.p[k]}%;background:${c}" title="${t}: ${p1(st.p[k])} (${st.n[k]} productos)"></i>` : "").join("")}</div><b>${p1(st.p.normo)}</b></div>`).join("")
    : '<p class="muted">Aún no hay indicadores de stock publicados.</p>';
}
async function guardarEval(f, cambio) {
  const fecha = S.evFecha, actual = S.evDocs?.get(fecha) || { s: {} };
  const s = { ...actual.s, [f]: { ...(actual.s?.[f] || {}), ...cambio } };
  try {
    await setDoc(doc(db, "evaluacion", fecha), { s, fecha, porNombre: S.perfil.nombre || S.perfil.usuario, actualizado: serverTimestamp() }, { merge: true });
    S.evDocs.set(fecha, { ...actual, s }); if (!S.evFechas.includes(fecha)) S.evFechas = [fecha, ...S.evFechas].sort().reverse();
    toast("Evaluación guardada"); pintarEval();
  } catch (x) { toast(textoError(x)); }
}
$("evTabla").addEventListener("change", e => { const t = e.target.closest("[data-evk]"); if (t) guardarEval(t.dataset.evf, { [t.dataset.evk]: t.value }); });
$("evTabla").addEventListener("click", e => { const b = e.target.closest("[data-evdet]"); if (b) abrirDetEval(b.dataset.evdet); });
$("evFecha").addEventListener("change", e => { S.evFecha = e.target.value; pintarEval(); });
$("evNueva").addEventListener("click", () => { const f = prompt("Fecha de la nueva evaluación (AAAA-MM-DD):", hoyISO()); if (f && /^\d{4}-\d{2}-\d{2}$/.test(f)) { S.evFecha = f; pintarEval(); } });
["evMin", "evMax"].forEach(id => $(id).addEventListener("change", () => {
  S.evMin = Math.max(1, +$("evMin").value || 15); S.evMax = Math.max(S.evMin + 1, +$("evMax").value || 90);
  try { localStorage.setItem("ev_umbral", JSON.stringify({ min: S.evMin, max: S.evMax })); } catch {}
  pintarEval();
}));
$("evAct").addEventListener("click", () => cargarEval(true));
// detalle de una sucursal: calculadora de capacidad y lista de BPA
function abrirDetEval(f) {
  const e = evDe(f), c = e.cap || { largo: 1.2, ancho: 0.5, altura: 1.5, anaqueles: 10 }, admin = esAdmin(), st = stockEval(f);
  let k = 0;
  $("evDetC").innerHTML = `<h2>${esc(nombreFarm(f))} · evaluación del ${fDia(S.evFecha)}</h2>
    ${st ? `<p class="muted">Productos con stock o con venta: ${nf(st.tot)} · Normostock ${st.n.normo} · Sobrestock ${st.n.sobre} (S/ ${nf(Math.round(st.v.sobre))}) · Substock ${st.n.sub} · Sin rotación ${st.n.sr} (S/ ${nf(Math.round(st.v.sr))}) · Desabastecido ${st.n.de}</p>` : ""}
    <h3>Capacidad de almacenamiento</h3>
    <div class="ev-cap">${[["largo", "Largo del anaquel (m)"], ["ancho", "Ancho del anaquel (m)"], ["altura", "Altura máx. de apilamiento (m)"], ["anaqueles", "N° de anaqueles o parihuelas"]].map(([kk, t]) =>
      `<label class="campo"><span class="lbl">${t}</span><input type="number" step="0.01" min="0" data-cap="${kk}" value="${c[kk] ?? ""}" ${admin ? "" : "disabled"}></label>`).join("")}</div>
    <p>Área por anaquel: <b id="evArea"></b> · Volumen útil por anaquel: <b id="evVol"></b> · <b>Total: <span id="evTot"></span></b></p>
    <h3>Cumplimiento de BPA <span class="muted" id="evBpaPct"></span></h3>
    ${BPA.map(([g, xs]) => `<div class="ev-bpa"><b>${g}</b>${xs.map(t => { const i = "b" + (k++); return `<label class="check"><input type="checkbox" data-bpa="${i}" ${e.bpa?.[i] ? "checked" : ""} ${admin ? "" : "disabled"}> ${esc(t)}</label>`; }).join("")}</div>`).join("")}
    <label class="campo"><span class="lbl">Observaciones</span><textarea id="evObs" rows="2" ${admin ? "" : "disabled"}>${esc(e.obs || "")}</textarea></label>
    ${admin ? `<div class="botones-fila"><button class="btn primario" type="button" id="evGuardar" data-f="${esc(f)}">Guardar</button><button class="btn" type="button" data-cerrar-dlg>Cancelar</button></div>` : ""}`;
  calcCap(); $("evDet").showModal();
}
function calcCap() {
  const v = k => +($("evDetC").querySelector(`[data-cap="${k}"]`)?.value || 0);
  const area = v("largo") * v("ancho"), vol = area * v("altura"), n2 = x => x.toLocaleString("es-PE", { maximumFractionDigits: 2 });
  $("evArea").textContent = n2(area) + " m²"; $("evVol").textContent = n2(vol) + " m³"; $("evTot").textContent = n2(vol * v("anaqueles")) + " m³";
  const ch = [...$("evDetC").querySelectorAll("[data-bpa]")]; $("evBpaPct").textContent = "· " + p1(ch.filter(x => x.checked).length / BPA_TOTAL * 100);
}
$("evDet").addEventListener("input", calcCap);
$("evDet").addEventListener("change", calcCap);
$("evDet").addEventListener("click", e => {
  if (e.target.closest("[data-cerrar-dlg]") || e.target === $("evDet")) return $("evDet").close();
  const g = e.target.closest("#evGuardar"); if (!g) return;
  const C = $("evDetC"), cap = Object.fromEntries(["largo", "ancho", "altura", "anaqueles"].map(k => [k, +C.querySelector(`[data-cap="${k}"]`).value || 0]));
  const bpa = Object.fromEntries([...C.querySelectorAll("[data-bpa]")].map(x => [x.dataset.bpa, x.checked]));
  guardarEval(g.dataset.f, { cap, bpa, obs: $("evObs").value.trim().slice(0, 500) }); $("evDet").close();
});
$("evXls").addEventListener("click", () => {
  const datos = sucsEval().map(f => { const st = stockEval(f), e = evDe(f), r2 = v => v == null ? "" : Math.round(v * 100) / 100;
    return { Sucursal: corto(f), "Nivel de stockeo": nivelStock(st?.p.normo)[0], "Capacidad de almacén (m³)": r2(capacidad(e.cap)),
      ...Object.fromEntries(EV_ITEMS.map(([k, t]) => [t, EV_NOTA[e[k] || ""][0]])), "Disponibilidad %": r2(st?.disp),
      "Normostock %": r2(st?.p.normo), "Sobrestock %": r2(st?.p.sobre), "Substock %": r2(st?.p.sub), "Sin rotación %": r2(st?.p.sr), "Desabastecido %": r2(st?.p.de),
      "Total %": st ? 100 : "", "Cumplimiento de BPA %": r2(bpaPct(e.bpa)), Observaciones: e.obs || "" }; });
  excelDe(datos, "Evaluación", "evaluacion_" + S.evFecha);
});

/* ===================== compras por laboratorio ===================== */
// red/compras (se publica con las listas): { m: ["2024-11", …], lab: { "AC FARMA": "soles,soles,…" } }
// La participación de cada laboratorio es su compra del mes / la compra total del mes.
S.cpLab = ""; S.cpVer = "pct"; S.cpDesde = ""; S.cpHasta = "";
async function cargarCompras(forzar) {
  if (S.cpCargando || (S.cp && !forzar)) return; S.cpCargando = true;
  try { const d = await getDoc(doc(db, "red", "compras")); S.cp = d.exists() ? d.data() : { m: [], lab: {} }; S.cpErr = ""; }
  catch (e) { S.cpErr = textoError(e); S.cp = { m: [], lab: {} }; }
  S.cpCargando = false; if (S.vista === "vCompL") pintarCompras();
}
const MES_L = m => { const [y, mo] = m.split("-"); return ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Set", "Oct", "Nov", "Dic"][+mo - 1] + "-" + y.slice(2); };
const solesR = v => "S/ " + Math.round(v).toLocaleString("es-PE");
function datosCompras() {
  const C = S.cp, todos = C.m || [];
  // toda la historia: desde el primer mes con compras hasta el último
  const tot0 = todos.map((_, i) => Object.values(C.lab || {}).reduce((a, t) => a + Math.max(0, +String(t).split(",")[i] || 0), 0));
  const i0 = Math.max(0, tot0.findIndex(v => v > 0)), i1 = todos.length - 1, meses = todos.slice(i0, i1 + 1);
  S.cpDesde = meses[0] || ""; S.cpHasta = meses[meses.length - 1] || "";
  const labs = Object.entries(C.lab || {}).map(([l, t]) => { const v = String(t).split(",").map(Number).slice(i0, i1 + 1); return { l, v, tot: v.reduce((a, x) => a + Math.max(0, x), 0) }; })
    .filter(x => x.tot > 0).sort((a, b) => b.tot - a.tot);
  const totMes = meses.map((_, j) => labs.reduce((a, x) => a + Math.max(0, x.v[j]), 0)), tot = totMes.reduce((a, x) => a + x, 0);
  return { meses, labs, totMes, tot };
}
function pintarCompras() {
  const C = S.cp; msg("cpMsg", S.cpErr || "", true);
  if (!C) { $("cpTabla").innerHTML = '<tbody><tr class="vacia"><td>Cargando…</td></tr></tbody>'; return; }
  $("cpCalc").hidden = !esAdmin();
  if (!C.m?.length) { $("cpInfo").textContent = esAdmin() ? "Aún no hay compras calculadas: pulsa «Calcular compras ahora» (usa el kardex que ya está guardado)." : "Las compras aparecerán cuando Abastecimiento las calcule."; $("cpTabla").innerHTML = ""; $("cpGraf").innerHTML = ""; return; }
  $("cpCalc").hidden = $("cpDiag").hidden = !esAdmin();
  $("cpInfo").innerHTML = `Compras en soles (costo) según el kardex al <b>${fmtF(C.corte)}</b>: «Cargo compra» menos devoluciones al proveedor.`;
  const D = datosCompras();
  if (!S.cpLab || !D.labs.some(x => x.l === S.cpLab)) S.cpLab = D.labs[0]?.l || "";
  if (document.activeElement !== $("cpQ")) $("cpQ").value = S.cpLab;
  document.querySelectorAll("[data-cpver]").forEach(b => b.setAttribute("aria-pressed", b.dataset.cpver === S.cpVer));
  const pct = (v, t) => t ? v / t * 100 : 0, fP = v => (Math.round(v * 10) / 10).toLocaleString("es-PE") + "%";
  // gráfico del laboratorio elegido: barras por mes con su % de las compras (eje desde 0)
  const x = D.labs.find(a => a.l === S.cpLab);
  if (x) {
    const vals = D.meses.map((_, j) => S.cpVer === "pct" ? pct(Math.max(0, x.v[j]), D.totMes[j]) : Math.max(0, x.v[j]));
    // barras agrupadas: un grupo por mes (Ene…Dic) y dentro una barra por año, cada año de un color
    const anios = [...new Set(D.meses.map(m => m.slice(0, 4)))].sort(), nums = [...new Set(D.meses.map(m => +m.slice(5)))].sort((a, b) => a - b);
    const COL_ANIO = ["#1F77B4", "#FF7F0E", "#2CA02C", "#8a4f9e", "#B4321C"], colA = a => COL_ANIO[anios.indexOf(a) % COL_ANIO.length];
    const valDe = (a, mo) => { const j = D.meses.indexOf(`${a}-${String(mo).padStart(2, "0")}`); return j < 0 ? null : vals[j]; };
    const MES_N = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Set", "Oct", "Nov", "Dic"];
    const mx = Math.max(...vals, 0.0001) * 1.18, W = Math.max(760, nums.length * (anios.length * 24 + 18)), H = 320, L = 60, B = 40, T = 30;
    const gw = (W - L - 10) / nums.length, bw = Math.min(46, (gw * 0.8) / anios.length), y = v => T + (H - T - B) * (1 - v / mx);
    let g = "";
    for (let k = 0; k <= 4; k++) { const v = mx * k / 4, yy = y(v); g += `<line x1="${L}" x2="${W - 6}" y1="${yy}" y2="${yy}" stroke="#eceff3"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end" class="ax">${S.cpVer === "pct" ? fP(v) : solesR(v)}</text>`; }
    nums.forEach((mo, gi) => {
      const x0 = L + gi * gw + (gw - bw * anios.length) / 2;
      anios.forEach((a, ai) => { const v = valDe(a, mo); if (v == null) return; const bx = x0 + ai * bw, j = D.meses.indexOf(`${a}-${String(mo).padStart(2, "0")}`);
        g += `<rect x="${bx + 1}" y="${y(v)}" width="${bw - 2}" height="${Math.max(0, y(0) - y(v))}" fill="${colA(a)}"><title>${MES_L(D.meses[j])}: ${fP(pct(Math.max(0, x.v[j]), D.totMes[j]))} · ${solesR(x.v[j])} de ${solesR(D.totMes[j])}</title></rect>`
          + (v > 0 ? `<text x="${bx + bw / 2}" y="${y(v) - 5}" text-anchor="middle" class="val" style="font-size:${bw < 26 ? 9.5 : 11}px">${S.cpVer === "pct" ? fP(v) : solesR(v)}</text>` : ""); });
      g += `<text x="${L + gi * gw + gw / 2}" y="${H - B + 20}" text-anchor="middle" class="ax mes">${MES_N[mo - 1]}</text>`;
    });
    g += `<line x1="${L}" x2="${W - 6}" y1="${y(0)}" y2="${y(0)}" stroke="#334"/>`;
    const ley = anios.map(a => `<span><i style="background:${colA(a)}"></i>${a}</span>`).join("");
    $("cpGraf").innerHTML = `<h3>${esc(x.l)} <small class="muted">· ${fP(pct(x.tot, D.tot))} de las compras de ${MES_L(D.meses[0])} a ${MES_L(D.meses[D.meses.length - 1])} (${solesR(x.tot)})</small></h3><div class="ev-ley">${ley}</div><div class="cp-scroll"><svg viewBox="0 0 ${W} ${H}" class="cp-svg" style="min-width:${Math.min(W, 1400)}px">${g}</svg></div>`;
  } else $("cpGraf").innerHTML = '<p class="muted">Sin compras en ese periodo.</p>';
  // tabla: cada laboratorio con su % de cada mes; al final el total (100 %)
  const q = norm(S.cpQ2 || "").trim();
  const filas = D.labs.filter(a => !q || norm(a.l).includes(q));
  const celda = (v, t) => S.cpVer === "pct" ? (v > 0 ? fP(pct(v, t)) : "–") : (v ? solesR(v) : "–");
  $("cpTabla").innerHTML = `<thead><tr><th>Laboratorio</th>${D.meses.map(m => `<th class="der">${MES_L(m)}</th>`).join("")}<th class="der">Periodo</th></tr></thead><tbody>` +
    filas.slice(0, S.cpMostrar || 100).map(a => `<tr class="clic${a.l === S.cpLab ? " cp-sel" : ""}" data-cplab="${esc(a.l)}"><td><b>${esc(a.l)}</b></td>${a.v.map((v, j) => `<td class="der">${celda(Math.max(0, v), D.totMes[j])}</td>`).join("")}<td class="der"><b>${celda(a.tot, D.tot)}</b></td></tr>`).join("") +
    `</tbody><tfoot><tr><td><b>Compras</b></td>${D.totMes.map(t => `<td class="der"><b>${S.cpVer === "pct" ? (t ? "100%" : "–") : solesR(t)}</b></td>`).join("")}<td class="der"><b>${S.cpVer === "pct" ? "100%" : solesR(D.tot)}</b></td></tr></tfoot>`;
  $("cpMas").innerHTML = filas.length > (S.cpMostrar || 100) ? `<button class="btn" type="button" id="cpMasBtn">Ver más (de ${filas.length})</button>` : "";
}
// buscador de laboratorio: se escribe y aparecen los que coinciden (con su % del periodo)
function resLabs() {
  const q = norm($("cpQ").value).trim(), box = $("cpRes"), D = datosCompras();
  const r = D.labs.filter(a => !q || q.split(/\s+/).every(w => norm(a.l).includes(w))).slice(0, 15);
  box.innerHTML = r.length ? r.map(a => `<button type="button" data-cpsel="${esc(a.l)}"><b>${esc(a.l)}</b> <small>${D.tot ? (Math.round(a.tot / D.tot * 1000) / 10).toLocaleString("es-PE") + "% · " : ""}${solesR(a.tot)}</small></button>`).join("")
    : '<small class="muted" style="padding:8px;display:block">Ningún laboratorio con ese nombre.</small>';
  box.hidden = false;
}
$("cpQ").addEventListener("input", resLabs);
$("cpQ").addEventListener("focus", () => { $("cpQ").select(); resLabs(); });
const elegirLab = l => { S.cpLab = l; $("cpRes").hidden = true; $("cpQ").value = l; $("cpQ").blur(); pintarCompras(); };
$("cpQ").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); const b = $("cpRes").querySelector("[data-cpsel]"); if (b) elegirLab(b.dataset.cpsel); } else if (e.key === "Escape") $("cpRes").hidden = true; });
$("cpRes").addEventListener("mousedown", e => { const b = e.target.closest("[data-cpsel]"); if (!b) return; e.preventDefault(); elegirLab(b.dataset.cpsel); });
$("cpQ").addEventListener("blur", () => setTimeout(() => { $("cpRes").hidden = true; $("cpQ").value = S.cpLab; }, 150));
$("cpQ2").addEventListener("input", e => { S.cpQ2 = e.target.value; pintarCompras(); });
$("cpVerBox").addEventListener("click", e => { const b = e.target.closest("[data-cpver]"); if (b) { S.cpVer = b.dataset.cpver; pintarCompras(); } });
$("cpTabla").addEventListener("click", e => { const r = e.target.closest("[data-cplab]"); if (r) { S.cpLab = r.dataset.cplab; pintarCompras(); scrollTo({ top: 0, behavior: "smooth" }); } });
$("cpMas").addEventListener("click", e => { if (e.target.closest("#cpMasBtn")) { S.cpMostrar = (S.cpMostrar || 100) + 100; pintarCompras(); } });
$("cpAct").addEventListener("click", () => cargarCompras(true));
// Recalcula con el kardex ya guardado (sin subir archivo) y publica: abre en segundo plano el módulo Kardex
async function calcularCompras() {
  const b = $("cpCalc"); b.disabled = true; msg("cpMsg", "Calculando las compras con el kardex guardado… puede tardar unos minutos la primera vez. No cierres la página.");
  try {
    if (!$("karFrame").src) $("karFrame").src = "proyeccion.html?solo=kar&v=" + VERSION_PROY;
    let w = null;
    for (let i = 0; i < 240 && !w; i++) { await new Promise(r => setTimeout(r, 500)); const x = $("karFrame").contentWindow; if (x?.recalcularPron && x?.publicarExtras) w = x; }
    if (!w) throw new Error("no terminó de cargar el módulo Kardex");
    const aviso = await w.recalcularPron();
    if (aviso && /no se pudo|error/i.test(aviso)) throw new Error(aviso);
    const r = await w.publicarExtras();
    S.cp = null; await cargarCompras(true);
    if (!S.cp?.m?.length) throw new Error((r?.errores || []).join(" · ") || `no se encontraron compras (productos con compras: ${r?.conCompras ?? "?"})`);
    msg("cpMsg", r.errores.length ? "Compras calculadas. Otros avisos: " + r.errores.join(" · ") : ""); toast(`Compras calculadas (${r.labs} laboratorios)`);
  } catch (e) { msg("cpMsg", "No se pudo calcular: " + (e.message || e), true); }
  finally { b.disabled = false; }
}
$("cpCalc").addEventListener("click", calcularCompras);
// Revisar meses: qué meses del kardex están guardados (proy_config/meses) y cuánto se compró en cada uno
$("cpDiag").addEventListener("click", async () => {
  const box = $("cpDiagBox"); box.hidden = !box.hidden; if (box.hidden) return;
  box.innerHTML = '<p class="muted">Revisando…</p>';
  try {
    const d = await getDoc(doc(db, "proy_config", "meses")), m = d.exists() ? d.data().m || {} : {};
    const C = S.cp || { m: [], lab: {} }, tot = C.m.map((_, i) => Object.values(C.lab || {}).reduce((a, t) => a + Math.max(0, +String(t).split(",")[i] || 0), 0));
    const meses = [...new Set([...Object.keys(m), ...C.m])].sort();
    box.innerHTML = `<p class="muted">Cada mes debe tener kardex guardado <b>con todos los almacenes, incluida Droguería FS</b> (ahí se registran las compras). Un mes sin compras normalmente es un mes que no se subió o que se subió solo con las sucursales.</p>
      <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Mes</th><th class="der">Movimientos del kardex guardados</th><th class="der">Compras (S/)</th><th>Última carga</th></tr></thead><tbody>` +
      meses.map(x => { const i = C.m.indexOf(x), t = i >= 0 ? tot[i] : null, me = m[x];
        return `<tr${!t ? ' class="revisar"' : ""}><td><b>${MES_L(x)}</b></td><td class="der">${me ? nf(me.movimientos || 0) : '<span class="mal">no hay kardex de este mes</span>'}</td><td class="der">${t ? solesR(t) : '<span class="mal">sin compras</span>'}</td><td>${me?.actualizado ? fFecha(me.actualizado) : "–"}</td></tr>`; }).join("") + "</tbody></table></div>";
  } catch (e) { box.innerHTML = `<p class="mal">${esc(textoError(e))}</p>`; }
});
$("cpXls").addEventListener("click", () => {
  const D = datosCompras(); if (!D.labs.length) return toast("No hay compras para descargar.");
  const fila = (l, v, t) => ({ Laboratorio: l, ...Object.fromEntries(D.meses.flatMap((m, j) => [[MES_L(m) + " %", D.totMes[j] ? Math.round(Math.max(0, v[j]) / D.totMes[j] * 10000) / 100 : 0], [MES_L(m) + " S/", Math.round(v[j])]])), "Periodo %": D.tot ? Math.round(t / D.tot * 10000) / 100 : 0, "Periodo S/": Math.round(t) });
  excelDe([...D.labs.map(a => fila(a.l, a.v, a.tot)), fila("COMPRAS (total)", D.totMes, D.tot)], "Compras", `compras_por_laboratorio_${S.cpDesde}_${S.cpHasta}`);
});
