import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword, updatePassword,
  EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc as fsSet, updateDoc as fsUpdate, deleteDoc as fsDelete, onSnapshot, query, where,
  serverTimestamp, writeBatch as fsBatch, deleteField
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { firebaseConfig, DOMINIO, FARMACIAS, NOMBRES_VISIBLES, MOTIVOS_BLOQUEO, MOTIVOS_REACTIVACION, FORM_URGENCIA } from "./config.js?v=202611210300";
import { MODELOS, COLORES_G, PUNTOS_INICIALES, leerUbicacion, fmtDMS, ordenar, linkMaps, matriz, trazo, cargarLeaflet } from "./rutas.js?v=202611091900";
import { crearEditor, ejemploAbastecimiento, FORMAS, COLORES, svgDe, limites, fmtMin, totalMin, UNIDADES } from "./flued.js?v=202611032300";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
// La proyección de compras (proyeccion.html, dentro de un marco) usa esta misma conexión y sesión.
window.FB = { auth, db, onAuthStateChanged, doc, getDoc, setDoc: fsSet, deleteDoc: fsDelete, collection, getDocs, onSnapshot, query, where };
// sucursal del usuario que entró (o de la vista previa): el módulo de su sucursal solo muestra la suya
window.miFarmUsuario = () => miFarm(); window.enPrevia = () => !!S.prev;
// En la vista previa ("ver como la sucursal X") no se guarda nada: todas las escrituras se rechazan.
const PREVIA = { message: "Vista previa: aquí no se guarda nada. Sal de la vista previa para hacer cambios." };
const setDoc = (...a) => S.prev ? Promise.reject(PREVIA) : fsSet(...a);
const updateDoc = (...a) => S.prev ? Promise.reject(PREVIA) : fsUpdate(...a);
const deleteDoc = (...a) => S.prev ? Promise.reject(PREVIA) : fsDelete(...a);
const writeBatch = d => { const b = fsBatch(d); if (S.prev) b.commit = () => Promise.reject(PREVIA); return b; };

// Cambiar al publicar cambios en proyeccion.html / proyeccion.js, para que el navegador no use la copia vieja.
const VERSION_PROY = "202611261100";
const VERSION_COMP = "202611031900";

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
  { id: "drogueria", nombre: "Droguería", vista: "vDrog", c: "kar", ic: "i-tienda", desc: "Stock de droguería, modelo, lo que se necesita y lo que hay que comprar" },
  { id: "porsucursal", nombre: "Módulos por sucursal", vista: "vSucx", c: "suc", ic: "i-tienda", desc: "Un módulo por cada sucursal: stock, lo que necesita y lo que hay que pedir", porSuc: true },
  { id: "kardex", nombre: "Kardex", vista: "vKar", c: "kar", ic: "i-bajar", desc: "Subir el kardex del día y publicar las listas", ayuda: "también publica las listas" },
  { id: "kmov", nombre: "Kardex por producto", vista: "vKmov", c: "kar", ic: "i-buscar", desc: "Los movimientos de un producto uno por uno, por almacén y fechas (como en el sistema)" },
  { id: "rebates", nombre: "Rebates por factura", vista: "vReb", c: "comp", ic: "i-lista", desc: "Lo comprado por factura y laboratorio (del kardex) y el rebate de cada uno" },
  { id: "indicadores", nombre: "Indicadores", vista: "vInd", c: "est", ic: "i-grafico", desc: "Participación de las sucursales por línea y por familia" },
  { id: "proyeccion", nombre: "Proyección de compras", vista: "vProy", ic: "i-grafico", desc: "Pronóstico, reposición y alertas" },
  { id: "comparativo", nombre: "Comparativo", vista: "vComp", c: "comp", ic: "i-lista", desc: "Comparar precios y proveedores" },
  { id: "mapa", nombre: "Mapa de calor", vista: "vMapa", c: "mapa", ic: "i-grafico", desc: "Ventas por sucursal y mes" },
  { id: "estadistica", nombre: "Estadística Proyx", vista: "vEst", c: "est", ic: "i-grafico", desc: "Pronóstico estadístico por producto" },
  { id: "sucursales", nombre: "Atención a sucursales", vista: "vSuc", c: "suc", ic: "i-tienda", desc: "Qué enviar a cada sucursal", ayuda: "también publica las listas" },
  { id: "faltantes", nombre: "Faltantes de droguería", vista: "vFalt", ic: "i-buscar", desc: "Productos en 0 en droguería que piden las sucursales" },
  // «Lo que me van a atender» ya no se usa: cada sucursal tiene su propio módulo (ver modPropio)
  { id: "pedidos", nombre: "Productos agotados o de extrema urgencia", vista: "vPed", ic: "i-lista", desc: "Lo que cada sucursal pidió de urgencia (desde el formulario)", ayuda: "químicos: ven los de su sucursal" },
  { id: "compras", nombre: "Compras por laboratorio", vista: "vCompL", c: "comp", ic: "i-grafico", desc: "Qué porcentaje de las compras de cada mes fue de cada laboratorio" },
  { id: "evaluacion", nombre: "Evaluación de sucursales", vista: "vEval", c: "est", ic: "i-grafico", desc: "Stock, orden, limpieza, capacidad y BPA de cada sucursal", ayuda: "químicos: ven la de su sucursal" },
  { id: "entregas", nombre: "Recepción de pedidos", vista: "vEnt", c: "suc", ic: "i-lista", desc: "Lo que se le entrega a cada sucursal: revisar y marcar cada producto al recibirlo", todos: true },
  { id: "nuevos", nombre: "Productos que buscan los clientes", vista: "vNue", c: "suc", ic: "i-mas", desc: "Registrar con foto lo que piden y no tenemos; lo ven todas las sucursales", ayuda: "ve lo que reportan todas las sucursales" },
  { id: "flujo", nombre: "Flujograma de abastecimiento", vista: "vFlujo", c: "mapa", ic: "i-lista", desc: "Cómo se trabaja: de la compra al proveedor hasta la atención a sucursales", todos: true },
  { id: "rutas", nombre: "Rutas de reparto", vista: "vRutas", c: "mapa", ic: "i-grafico", desc: "La ruta más corta para repartir a un grupo de sucursales, en el mapa y en Google Maps" },
  { id: "reporep", nombre: "Reposición por reportes", vista: "vRep", c: "suc", ic: "i-lista", desc: "Subir el reporte de ventas de droguería y de cada sucursal y sacar lo que se debe atender (en pantalla y en Excel)" },
  { id: "flued", nombre: "Editor de flujogramas", vista: "vFlued", c: "est", ic: "i-grafico", desc: "Crear y editar flujogramas con figuras, flechas, textos y tiempos" }];
// v.todos: módulo abierto a todos los usuarios (no hace falta activarlo en Usuarios)
// «Módulos por sucursal» se abre en un módulo por cada sucursal (ordenadas por prioridad de ventas, la que más vende primero)
const ordenSucs = () => { let pr = []; try { pr = JSON.parse(localStorage.getItem("prio_sucs") || "[]"); } catch {}
  const suc = FARMACIAS.filter(f => /^ALMACEN /.test(f)); return [...pr.filter(f => suc.includes(f)), ...suc.filter(f => !pr.includes(f))]; };
const expandirSucs = l => l.flatMap(v => !v.porSuc ? [v] : ordenSucs().map((f, i, a) => ({ ...v, nombre: nombreFarm(f), vista: "vSucx:" + f, farm: f,
  desc: `Prioridad ${i + 1} de ${a.length}: stock, lo que necesita y lo que hay que pedir` })));
// cada usuario de una sucursal tiene su propio módulo sin activarlo: los de REAL «Real», los de PARRA «Parra»…, y los de droguería «Droguería»
const modPropio = () => { const f = miFarm(); if (esAdmin() || !f) return [];
  if (f === "DROGUERIA FS") return VISTAS.filter(v => v.id === "drogueria");
  const v = VISTAS.find(x => x.porSuc); return /^ALMACEN /.test(f) && v ? [{ ...v, nombre: nombreFarm(f), vista: "vSucx:" + f, farm: f, desc: "Tu sucursal: stock, venta diaria, lo que necesita y lo que se te va a enviar" }] : []; };
const misVistas = () => { const l = esAdmin() ? expandirSucs(VISTAS) : [...modPropio(), ...expandirSucs(VISTAS.filter(v => v.todos || ((S.prev || S.perfil)?.vistas || []).includes(v.id)))];
  return l.filter((v, i) => l.findIndex(x => x.vista === v.vista) === i); };
const NOMBRE_ROL = { admin: "Administrador", quimico: "Químico", colaborador: "Colaborador" };
const miFarm = () => S.prev ? S.prev.farmacia : S.perfil?.farmacia;
// modo celular: el enlace ?m=<módulo> abre directo ese módulo; en el celular queda recordado (hasta pulsar «Menú completo»)
const MODO_M = (() => {
  const q = new URLSearchParams(location.search).get("m"), cel = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  try { if (q && cel) localStorage.setItem("modo_m", q); return q || (cel ? localStorage.getItem("modo_m") : null); } catch { return q; }
})();
if (MODO_M) document.body.classList.add("modo-cel");

/* ===================== catálogo ===================== */
async function cargarCatalogo() {
  if (S.catalogo.length) return;
  try {
    const r = await fetch("catalogo.json", { cache: "no-cache" });
    if (!r.ok) throw new Error();
    // laboratorios que pasaron a otro: se leen con el nombre y el código nuevos (HERSIL → MEDIFARMA HUMANOVA, VHH PHARMA → MH PHARMA)
    const alias = l => /^HERS(IL)?\b/i.test(l) ? "MEDIFARMA HUMANOVA S.A." : /^VHH\b/i.test(l) ? "MH PHARMA" : l;
    const aliasCod = l => /^HERS$/i.test(l) ? "MEDI" : /^VHH$/i.test(l) ? "MHPH" : l;
    S.catalogo = (await r.json()).map(p => { const ln = alias(String(p.ln || "")), l = aliasCod(String(p.l || "")); return { c: String(p.c), n: String(p.n), l, ln, k: norm([p.c, p.n, l, ln].join(" ")) }; });
    S.catIdx = new Map(S.catalogo.map(p => [p.c, p]));
  } catch {
    const a = $("avisoGlobal"); a.hidden = false;
    a.textContent = "No se encontró el catálogo de productos (catalogo.json). Súbelo al repositorio junto con la página.";
  }
}
// Productos que están en el kardex pero no en catalogo.json (se publica en red/catalogo junto con las listas)
// Se vuelve a leer si pasaron más de 5 minutos (las listas se publican durante el día y la página puede estar abierta desde antes).
async function cargarCatVivo(forzar) {
  if (!forzar && Date.now() - (S.catVivoT || 0) < 5 * 60000) return 0;
  S.catVivoT = Date.now();
  try {
    const d = await getDoc(doc(db, "red", "catalogo")); if (!d.exists()) return 0;
    return usarCatVivo(d.data());
  } catch { return 0; }   // sin permiso (usuario sin estos módulos) o sin internet: se queda con catalogo.json
}
// En vivo: cuando se publica un kardex nuevo (cambia red/catalogo) la página abierta se actualiza sola:
// catálogo de los buscadores, compras, evaluación y lo que esté a la vista.
function escucharCatVivo() {
  if (S.catSub) return; S.catSub = true;
  S.subs.push(onSnapshot(doc(db, "red", "catalogo"), sn => {
    if (!sn.exists()) return;
    const x = sn.data(), nuevo = S.catPub && x.publicado && x.publicado !== S.catPub;
    S.catPub = x.publicado; S.catVivoT = Date.now(); usarCatVivo(x);
    if (nuevo) {
      S.cp = null; S.evStock = null; S.evR = null; armarPed();
      if (["vCompL", "vEval", "vPed", "vAten", "vNue"].includes(S.vista)) render();
      toast("Datos actualizados con el kardex nuevo");
    }
  }, () => { S.catSub = false; }));
}
// La base de los buscadores es el KARDEX GENERAL (proy_config/maestro): todos los productos que existen y existieron.
// Se escucha en vivo: apenas se sube un kardex, los buscadores de todas las páginas abiertas tienen sus productos.
function escucharKardex() {
  if (S.karSub) return; S.karSub = true;
  S.subs.push(onSnapshot(doc(db, "proy_config", "maestro"), async sn => {
    const a = sn.exists() ? sn.data().asset : ""; if (!a || a === S.karAsset) return;
    const nuevo = !!S.karAsset; S.karAsset = a;
    try {
      // el kardex está comprimido (gzip) y partido en trozos (proy_blobs/{id}/partes)
      const q = await getDocs(collection(db, "proy_blobs", a, "partes"));
      const b64 = q.docs.sort((x, y) => x.id - y.id).map(d => d.data().d).join(""), bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const m = JSON.parse(await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
      S.ultAbast = m.ua || {}; S.ultCompra = m.uc || {}; S.karStock = m.stock || {}; if (S.vista === "vPed") pintarPedidos(); else if (S.vista === "vRep") pintarRpCmp();
      let n = 0;
      for (const [c, pr] of Object.entries(m.prod || {})) {
        const nom = String(pr?.[0] || "").trim(); if (!c || !nom) continue;
        const ya = S.catIdx.get(c);
        if (ya) { if (ya.n !== nom && ya.vivo) { ya.n = nom; ya.k = norm([c, nom, ya.ln].join(" ")); } continue; }
        const p = { c, n: nom, l: "", ln: "", k: norm(c + " " + nom), vivo: true }; S.catalogo.push(p); S.catIdx.set(c, p); n++;
      }
      for (const x of S.ped?.datos || []) if (!x.nom && x.cod) { const pc = prodCat(x.cod); if (pc) { x.cod = pc.c; x.nom = pc.n; x.lab = pc.ln; } }
      if (n && S.vista === "vPed") pintarPedidos();
      if (nuevo) { S.cp = null; S.evStock = null; S.evR = null; armarPed(); if (["vCompL", "vEval", "vPed", "vNue"].includes(S.vista)) render(); toast("Datos actualizados con el kardex nuevo"); }
    } catch (e) { S.karAsset = ""; console.warn("No se pudo leer el kardex general", e); }
  }, () => { S.karSub = false; }));
}
function usarCatVivo(x) {
  {
    let n = 0;
    // formato nuevo: un texto «código<TAB>nombre<TAB>laboratorio» por renglón; el anterior era un mapa {código: [nombre, lab]}
    const filas = x.t ? String(x.t).split("\n").map(l => { const [c, nom = "", lab = ""] = l.split("\t"); return [c, [nom, lab]]; }) : Object.entries(x.p || {});
    for (const [c, [nom, lab = ""]] of filas) {
      if (!c) continue;
      const ya = S.catIdx.get(c); if (ya) { if (!ya.ln && lab) { ya.ln = String(lab); ya.k = norm([c, ya.n, lab].join(" ")); } continue; }
      const p = { c, n: String(nom), l: "", ln: String(lab), k: norm([c, nom, lab].join(" ")) }; S.catalogo.push(p); S.catIdx.set(c, p); n++;
    }
    // pedidos de urgencia leídos antes de que llegara este catálogo: completa sus nombres
    for (const x of S.ped?.datos || []) if (!x.nom && x.cod) { const pc = prodCat(x.cod); if (pc) { x.cod = pc.c; x.nom = pc.n; x.lab = pc.ln; } }
    if (n && S.vista === "vPed") pintarPedidos();
    return n;
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
  S.subs.forEach(u => u()); S.subs = []; S.nueSub = false; S.catSub = false; S.karSub = false; S.gestSub = false; S.karAsset = ""; S.bloqueos = new Map(); S.perfil = null; $("avisoGlobal").hidden = true;
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
  await cargarCatalogo(); escucharKardex(); escucharCatVivo();
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
    // lo bloqueado en droguería también vale para su sucursal (se guarda aparte: no es un bloqueo que pueda gestionar)
    S.subs.push(onSnapshot(query(collection(db, "bloqueos"), where("farmacia", "==", "DROGUERIA FS")), snap => {
      S.bloqDrog = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }])); if (S.vista === "vAten") pintarAten();
    }, () => {}));
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
  montarAyuda(); escucharAvisos(); escucharVersion(); vigilarVersionPublicada();
  // enlace directo a un módulo (p. ej. ?m=nuevos, el que abre la app instalada en el celular); en el celular se recuerda
  if (misVistas().some(v => v.id === "nuevos")) escucharNue();   // para avisar de lo que registran otros
  const vDir = MODO_M && misVistas().find(v => v.id === MODO_M);
  if (vDir) ir(vDir.vista);
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
// el módulo de una sucursal avisa el orden por prioridad de ventas: el menú se reordena
window.pintarNavExt = () => { if (!S.perfil) return; pintarNav(); if (S.vista === "vInicio") pintarInicio(); };
// Después de subir un kardex, los demás módulos abiertos (proyección, estadística, sucursales, mapa) se recargan con los datos nuevos.
window.recargarModulos = origen => {
  for (const id of ["proyFrame", "estFrame", "sucFrame", "mapaFrame", "karFrame", "drogFrame", "sucxFrame", "indFrame", "kmovFrame", "rebFrame"]) {
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
    ...misVistas().map(v => [v.vista, v.nombre + (esAdmin() && v.id === "faltantes" && faltSinResp() ? `<span class="badge">${faltSinResp()}</span>` : "") + (v.id === "nuevos" && nueSinVer() ? `<span class="badge">${nueSinVer()}</span>` : ""), v.c])];
  const actual = S.vista === "vFicha" ? S.origen : S.vista;
  pintarMenuBtn?.();
  $("nav").innerHTML = items.map(([v, t, c]) => `<button type="button" data-ir="${v}" ${c ? `class="${c}"` : ""} ${v === actual ? 'aria-current="page"' : ""}>${t}</button>`).join("");
}
$("nav").addEventListener("click", e => { const b = e.target.closest("[data-ir]"); if (b) ir(b.dataset.ir); });

function mostrar(id) { ["vLogin", "vClave", "vInicio", "vQuimico", "vAdmin", "vUsuarios", "vProy", "vComp", "vMapa", "vEst", "vSuc", "vFalt", "vAten", "vPed", "vEval", "vCompL", "vNue", "vEnt", "vFlujo", "vFlued", "vRutas", "vDrog", "vSucx", "vInd", "vKar", "vFicha", "vRep", "vKmov", "vReb"].forEach(v => $(v).hidden = v !== id); }
function ir(vista) {
  // La proyección se carga la primera vez que se abre (es pesada y solo la usa el administrador).
  if (vista === "vProy" && !$("proyFrame").src) $("proyFrame").src = "proyeccion.html?v=" + VERSION_PROY;
  if (vista === "vKar" && !$("karFrame").src) $("karFrame").src = "proyeccion.html?solo=kar&v=" + VERSION_PROY;
  if (vista === "vReb" && !$("rebFrame").src) $("rebFrame").src = "proyeccion.html?solo=reb&v=" + VERSION_PROY;
  if (vista === "vKmov" && !$("kmovFrame").src) $("kmovFrame").src = "proyeccion.html?solo=kmov&v=" + VERSION_PROY;
  if (vista === "vSuc" && !$("sucFrame").src) $("sucFrame").src = "proyeccion.html?solo=suc&v=" + VERSION_PROY;
  if (vista === "vEst" && !$("estFrame").src) $("estFrame").src = "proyeccion.html?solo=est&v=" + VERSION_PROY;
  if (vista === "vInd" && !$("indFrame").src) $("indFrame").src = "proyeccion.html?solo=ind&v=" + VERSION_PROY;
  if (vista === "vDrog" && !$("drogFrame").src) $("drogFrame").src = "proyeccion.html?solo=drog&v=" + VERSION_PROY;
  // módulo de una sucursal: el mismo marco, que pasa a mostrar esa sucursal
  if (vista.startsWith("vSucx:")) {
    const f = vista.slice(6), fr = $("sucxFrame");
    window.sucxFarm = f;   // el módulo lee de aquí qué sucursal mostrar (aunque todavía esté cargando)
    if (!fr.src) fr.src = "proyeccion.html?solo=sucx&f=" + encodeURIComponent(f) + "&v=" + VERSION_PROY;
    else try { const w = fr.contentWindow; if (w?.ponerSucursal) w.ponerSucursal(f); else if (w?.document?.readyState === "complete") fr.src = "proyeccion.html?solo=sucx&f=" + encodeURIComponent(f) + "&v=" + VERSION_PROY; } catch {}
  }
  if (vista === "vMapa" && !$("mapaFrame").src) $("mapaFrame").src = "proyeccion.html?solo=mapa&v=" + VERSION_PROY;
  if (vista === "vComp" && !$("compFrame").src) $("compFrame").src = "comparativo.html?v=" + VERSION_COMP;
  S.vista = vista; mostrar(vista.split(":")[0]); render(); scrollTo({ top: 0 }); }
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
  else if (S.vista === "vNue") { escucharNue(); marcarNueVisto(); pintarNue(); }
  else if (S.vista === "vEnt") { escucharEnt(); pintarEnt(); }
  else if (S.vista === "vRep") { escucharRp(); pintarRep(); }
 
  else if (S.vista === "vFlujo") pintarFlujo();
  else if (S.vista === "vFlued") abrirFlued();
  else if (S.vista === "vRutas") abrirRutas();
  if (S.vista !== "vFlued" && document.body.classList.contains("fe-full")) fePantalla(false);
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
  // cada aviso en su módulo: generales en el menú principal, el cierre en Bloqueos
  const av = [], inf = [], e = !esAdmin() && estadoCierre(S.perfil.cierre);
  if (S.vista === "vInicio") av.push(...htmlAvisos());
  if (S.vista === "vQuimico" && e) av.push(`<div class="aviso cierre-aviso${e.vigente ? "" : " prox"}">${esc(avisoCierre(e))}</div>`);
  if (S.vista === "vAten") {
    if ($("atFiltro").innerHTML.trim()) inf.push(`<div class="at-filtro">${$("atFiltro").innerHTML}</div>`);
  }
  $("avisosLado").innerHTML = av.join(""); $("infoLado").innerHTML = inf.join("");
  $("ladoIzq").hidden = !av.length; $("ladoDer").hidden = !inf.length;
  document.body.classList.toggle("lado-i", !!av.length); document.body.classList.toggle("lado-d", !!inf.length);
}

// Avisos generales: los publica el administrador (colección avisos) y los ven todos en el menú principal
S.avisos = [];
const htmlAvisos = () => S.avisos.map(a => `<div class="aviso general">📢 ${esc(a.texto)}<small>${esc(a.porNombre || "Abastecimiento")} · ${fmtF(a.fecha)}</small></div>`);
// versión de la página: si Abastecimiento pide «recargar a todos», las páginas con esta versión (o posteriores) se recargan solas
function escucharVersion() {
  let primera = true;
  S.subs.push(onSnapshot(doc(db, "app", "version"), sn => { const d = sn.data(); if (primera) { primera = false; S.recargaVista = d?.recarga; return; }
    if (d?.recarga && d.recarga !== S.recargaVista && !esAdmin()) location.reload(); }, () => {}));
}
// VERSIÓN NUEVA PUBLICADA: cada 3 minutos se mira qué versión tiene la página publicada (index.html → app.js?v=…).
// Si es más nueva que la que está abierta, se recarga sola apenas el usuario no esté escribiendo ni con una ventana abierta,
// para que nadie trabaje con una versión vieja (p. ej. la que todavía enviaba los pedidos al formulario de Google).
function vigilarVersionPublicada() {
  if (vigilarVersionPublicada.ok) return; vigilarVersionPublicada.ok = true;
  const revisar = async () => {
    try {
      const t = await (await fetch("index.html?_=" + Date.now(), { cache: "no-store" })).text(), v = t.match(/app\.js\?v=(\d+)/)?.[1];
      if (!v || v <= VERSION_PROY) return;
      const ocupado = () => document.querySelector("dialog[open]") || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) && document.activeElement.value;
      if (!ocupado()) return location.reload();
      const av = $("avisoGlobal"); av.hidden = false; av.innerHTML = 'Hay una versión nueva de la página. <button type="button" class="btn sm" onclick="location.reload()">Actualizar ahora</button>';
    } catch {}
  };
  setInterval(revisar, 3 * 60e3); document.addEventListener("visibilitychange", () => { if (!document.hidden) revisar(); });
}
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
const chkVistas = (sel = []) => VISTAS.filter(v => !v.todos).map(v => `<label class="check"><input type="checkbox" data-vista="${esc(v.id)}" ${sel.includes(v.id) ? "checked" : ""}> ${esc(v.nombre)}${v.ayuda ? ` <small class="muted">(${esc(v.ayuda)})</small>` : ""}</label>`).join("");
$("uVistas").innerHTML = chkVistas();
const vistasDe = el => [...el.querySelectorAll("[data-vista]:checked")].map(x => x.dataset.vista);
// RECARGAR A TODOS: la página abierta vigila el usuario de cada uno y se recarga sola si cambia la lista de módulos («vistas»).
// Se agrega a esa lista una marca «_recarga…» (no es un módulo: no cambia nada de lo que ven) y la página de cada uno se recarga.
$("recargarTodos").addEventListener("click", async () => {
  if (!esAdmin()) return;
  const us = (S.usuarios || []).filter(u => u.uid !== S.perfil.uid && !u.reemplazadoPor);
  if (!confirm(`Se recargará la página a ${us.length} usuarios que la tengan abierta (computadoras y celulares), para que tomen la versión nueva.\n\nNo cambia sus módulos ni cierra su sesión. ¿Continuar?`)) return;
  try {
    const marca = "_recarga" + Date.now();
    for (let i = 0; i < us.length; i += 400) {
      const lote = writeBatch(db);
      for (const u of us.slice(i, i + 400)) lote.update(doc(db, "usuarios", u.uid), { vistas: [...(u.vistas || []).filter(v => !String(v).startsWith("_recarga")), marca] });
      await lote.commit();
    }
    // y para las páginas con la versión nueva: aviso de versión
    try { await setDoc(doc(db, "app", "version"), { v: VERSION_PROY, recarga: marca, fecha: new Date().toISOString() }); } catch {}
    toast(`✔ Listo: las páginas abiertas de ${us.length} usuarios se recargan ahora mismo; quien la tenga cerrada, la abrirá ya actualizada.`);
  } catch (x) { avisar(x); }
});
function pintarUsuarios() {
  const lista = S.usuarios.filter(u => !u.reemplazadoPor).sort((a, b) => (a.rol + a.farmacia + a.usuario).localeCompare(b.rol + b.farmacia + b.usuario));
  const opcFarm = sel => FARMACIAS.map(f => `<option value="${esc(f)}" ${f === sel ? "selected" : ""}>${esc(corto(f))}</option>`).join("");
  const fila = u => `<tr class="${u.activo === false ? "inactivo" : ""}">
      <td class="f">${esc(u.usuario)}</td><td>${u.nombre ? esc(u.nombre) : '<span class="muted">Lo escribirá al ingresar</span>'}</td>
      <td>${NOMBRE_ROL[u.rol] || esc(u.rol)}${(u.vistas || []).filter(id => !String(id).startsWith("_recarga")).map(id => `<br><span class="tag">${esc(VISTAS.find(v => v.id === id)?.nombre || id)}</span>`).join("")}</td><td>${esc(u.farmacia ? corto(u.farmacia) : "–")}</td>
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
// quién respondió en Faltantes (nombre del usuario) en lugar de decir solo «droguería»
const quienDrog = e => (e?.porNombre || "").trim() || "Droguería";
const quienEnl = enl => quienDrog(estVig(String(enl || "").split(/\s*-\s*|,/)[0].trim()));
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
// Redondeo de lo que se pide, se atiende y se compra (igual en todos los módulos): hasta ,45 hacia abajo; desde ,46 hacia arriba (3,45 → 3 · 3,46 → 4)
const redPed = x => { if (!(x > 0)) return 0; const e = Math.floor(x + 1e-9); return x - e > 0.45 + 1e-9 ? e + 1 : e; };
const nf = v => Number(v || 0).toLocaleString("es-PE");
// Clasificación de productos (línea, genérico y familia por nombre): la última que se subió desde los reportes «producto por genérico / familia / línea»
// (proy_config/clasificacion → archivo comprimido en proy_blobs); si no hay, la de clasificacion.json de la página.
window.cargarClasificacion = () => window.cargarClasificacion.p || (async () => {
  try {
    const m = await getDoc(doc(db, "proy_config", "clasificacion")), id = m.exists() && m.data().asset;
    if (id) {
      const s = await getDocs(collection(db, "proy_blobs", id, "partes")), t = s.docs.sort((a, b) => a.id - b.id).map(d => d.data().d).join("");
      const bin = Uint8Array.from(atob(t), ch => ch.charCodeAt(0));
      const c = JSON.parse(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
      return (window.cargarClasificacion.p = Promise.resolve(c), c);
    }
    if (auth.currentUser) window.cargarClasificacion.p = fetch("clasificacion.json").then(r => r.json());
  } catch {}
  return fetch("clasificacion.json").then(r => r.json());   // sin sesión o sin permiso: no se guarda, se reintenta después
})();
// al subir una clasificación nueva: todos los módulos la usan sin recargar
window.ponerClasificacion = c => { window.cargarClasificacion.p = Promise.resolve(c); cargarGenericos.p = null; GEN = null; };
// Genérico de cada producto del catálogo (por nombre): para ofrecer primero los del mismo genérico.
const MAX_ALT = 4;
let GEN = null;
function cargarGenericos() {
  cargarGenericos.p ??= window.cargarClasificacion().then(c => {
    const nomN = x => String(x || "").trim().toUpperCase().replace(/\s+/g, " "), g = { de: new Map(), por: new Map() };
    for (const p of S.catalogo) {
      // laboratorio de los productos que no lo traen en el catálogo: la sigla de la clasificación y su nombre
      if (!p.ln) { const x = c.p[nomN(p.n)], sg = (c.pc || {})[p.c] || (x && (c.l || [])[x[3]]); if (sg) { p.l = sg; p.ln = (c.labs || {})[sg] || sg; p.k = norm([p.c, p.n, p.l, p.ln].join(" ")); } }
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
      ${plazo === "otra" ? `<input type="date" id="fsHasta" value="${esc(st.hasta ?? e?.hasta ?? "")}" min="${hoyISO()}" max="2100-12-31">` : `<small class="ayuda">Hasta el ${fDia(sumarDias(PLAZOS.find(p => p[0] === plazo)?.[2] || 30))}</small>`}</div>` : ""}
    ${est === "transito" ? `<div class="campo"><label for="fsLlega">Fecha estimada de llegada (opcional)</label><input type="date" id="fsLlega" value="${esc(st.llega ?? e?.llega ?? "")}" min="2020-01-01" max="2100-12-31"></div>` : ""}
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
  S.atUnsub = onSnapshot(doc(db, "atencion", suc), sn => { S.aten = sn.exists() ? sn.data() : { items: [] }; normAten(S.aten); cargarStkSuc(suc, S.aten.publicado); if (S.vista === "vAten") pintarAten(); },
    e => { S.atSubSuc = null; avisar(e); });
  // respuestas del químico por producto (atencion_resp/{SUCURSAL}__{codpro})
  S.atResp = new Map(); S.atRespUnsub?.();
  S.atRespUnsub = onSnapshot(query(collection(db, "atencion_resp"), where("suc", "==", suc)), sn => {
    S.atResp = new Map(sn.docs.map(d => [d.data().codpro, d.data()])); if (S.vista === "vAten") pintarAten();
  }, e => avisar(e));
  // lo que el administrador decide que vea la sucursal (aten_vis/{SUCURSAL}): tipos visibles y productos ocultos o mostrados aparte
  // comunicados «gestionado por droguería» (gestion/{código}), en vivo
  if (!S.gestSub) { S.gestSub = true; S.subs.push(onSnapshot(collection(db, "gestion"), sn => { S.gest = new Map(sn.docs.map(d => [d.id, d.data()])); if (S.vista === "vAten") pintarAten(); }, () => { S.gestSub = false; })); }
  S.atVis = null; S.atVisUnsub?.();
  S.atVisUnsub = onSnapshot(doc(db, "aten_vis", suc), sn => { S.atVis = sn.exists() ? sn.data() : null; if (S.vista === "vAten") pintarAten(); }, () => { S.atVis = null; });
  S.subs.push(() => S.atUnsub?.(), () => S.atRespUnsub?.(), () => S.atVisUnsub?.());
  // lo que respondió droguería en Faltantes (descontinuado, agotado, en tránsito…), para verlo en cada producto
  if (!S.faltSubs && !S.fEstAten) { S.fEstAten = true;
    S.subs.push(onSnapshot(collection(db, "faltantes_estado"), sn => { S.fEst = new Map(sn.docs.map(d => [d.id, d.data()])); if (S.vista === "vAten" && !S.atEdit) pintarAten(); },
      () => { S.fEstAten = false; })); }
}
// la venta por mes (hv) y el pronóstico (pr) llegan como texto «1.5,2,0,…» (pesan menos); si hay menos meses que la
// cabecera (se guardó solo un año), se completan adelante con vacíos para que coincidan con sus meses
function normAten(A) {
  const arr = v => typeof v === "string" ? (v ? v.split(",").map(x => x === "" ? null : +x) : []) : v || [];
  for (const i of A.items || []) {
    i.hv = arr(i.hv); i.pr = arr(i.pr);
    const n = (A.meses || []).length; if (i.hv.length && i.hv.length < n) i.hv = [...Array(n - i.hv.length).fill(null), ...i.hv];
    if (!i.hv.length) i.hv = null;
  }
}
const tagDrog = i => { const e = estVig(i.c); if (!e) return "";
  // el stock que tiene la sucursal del medicamento que indicó droguería
  const alts = (e.alternativas || []).map(a => tagStock(i, a.c, `${a.c} ${a.n}: `)).join("");
  return `<span class="tag fs-tag ${esc(e.estado)} at-drog" title="${esc((e.porNombre || "") + (e.comentario ? ": " + e.comentario : ""))}">${esc(quienDrog(e))}: ${esc(textoEstado(e))}${e.comentario ? " · " + esc(e.comentario) : ""}</span>${alts}`; };
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
  const env = d > 0 ? Math.max(1, redPed(d * dias - st)) : 0;
  return { cls: "t-pend", txt: `${st > 0 ? `Tienes ${fCaja(st)} (te cubre ${nf(cob)} días)` : "✗ No tienes"}${env ? ` · se te enviarán ${nf(env)} para ${A.C} + ${A.Sg} días` : ""}` };
}
const tagStock = (i, c, pre = "", n = 1) => { const x = stockCambio(i, c, n); return `<span class="tag ${x.cls} at-drog">${pre}${esc(x.txt)}</span>`; };
// el producto ya no se le envía: la sucursal usa otro en su cambio, o droguería lo dio por descontinuado o reemplazado
// bloqueo vigente del producto en la sucursal que se mira (o en todas): se aplica en vivo, aunque la lista se haya
// publicado antes de bloquearlo
function bloqAten(i) {
  const suc = esAdmin() ? (S.atSuc || FARMACIAS[0]) : miFarm();
  // niveles: general (kardex) y droguería bloquean en todas las sucursales; el de la sucursal, solo ahí
  const b = S.bloqueos?.get(suc + "__" + i.c) || S.bloqueos?.get("TODAS__" + i.c) || S.bloqueos?.get("DROGUERIA FS__" + i.c) || S.bloqDrog?.get("DROGUERIA FS__" + i.c);
  return b && b.estado === "bloqueado" ? b : null;
}
function noEnvia(i) {
  const r = S.atResp?.get(i.c), e = estVig(i.c), bq = bloqAten(i);
  if (bq) return `bloqueado${bq.farmacia === "TODAS" ? " en todas las farmacias" : ""}${bq.motivo ? " (" + bq.motivo + ")" : ""}`;
  if (r?.estado === "otro_medicamento" && r.altCod) return `usas en su cambio ${r.alternativa || r.altCod}`;
  if (i.rmp) return `${quienDrog(e)} lo reemplaza por ${i.rmp}`;
  if (e?.estado === "descontinuado") return e.alternativas?.length ? `descontinuado; lo reemplaza ${e.alternativas[0].c} ${e.alternativas[0].n} (${quienDrog(e)})` : `descontinuado (${quienDrog(e)})`;
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
    · venta diaria según ${esc(fte)} · ${A.tipos === "todos" ? "todo lo que se vende en la sucursal" : "productos de venta frecuente (tipo A y B lo necesario)"}
    ${(A.items || []).some(i => i.aj) ? "<br>Algunos productos tienen un criterio propio (se indica en la columna Nota)." : ""}
    <br><small class="muted">Datos al ${fmtF(A.corte)} · publicado el ${fFecha(A.publicado)}</small>`;
  const q = norm(S.atQ).trim(), admin = esAdmin(), todos = A.items || [];
  // la sucursal solo ve lo que el administrador dejó visible; el administrador ve todo (lo oculto, en gris)
  const base = admin ? todos : todos.filter(visAten);
  pintarVisAten(todos);
  const lista = base.filter(i => (S.atVer !== "urg" || i.urg) && (S.atVer !== "env" || i.pide > 0)
    && (S.atVer !== "sinr" || !S.atResp?.has(i.c)) && (S.atVer !== "resp" || S.atResp?.has(i.c))
    && (!q || q.split(/\s+/).every(w => norm(i.c + " " + i.n + " " + i.l).includes(w))));
  $("atTit").textContent = `${nf(lista.length)} productos · ${nf(lista.filter(i => i.urg).length)} urgentes`;
  const colCob = i => i.d <= 0 ? "#9e9e9e" : i.cob == null ? "#1e6bb8" : i.cob < A.Sg ? "#d9302c" : i.cob < A.C + A.Sg ? "#e0a030" : "#43a047";
  $("atTabla").innerHTML = `<thead><tr><th>Producto</th><th class="at-ojo">Información</th><th>Tipo</th><th class="der">Cobertura</th><th class="der">Venta diaria</th><th class="der">Tu stock</th><th class="der">Se te enviará</th><th>Nota</th><th>Respuesta de la sucursal</th>${admin ? '<th>¿Lo ve la sucursal?</th>' : ""}</tr></thead><tbody>` +
    (lista.length ? lista.map(i => `<tr${admin && !visAten(i) ? ' class="at-oculto"' : ""}><td class="p"><b>${esc(i.c)} - ${esc(i.n)}</b><code>${esc(i.l)}</code></td>
      <td class="at-ojo">${i.hv ? `<button type="button" class="at-ibtn" data-info="${esc(i.c)}" title="Ver la información de este producto en tu local" aria-label="Información de ${esc(i.n)}">${OJO}</button>` : ""}</td>
      <td><span class="at-cat ${esc(i.cat)}">${esc(i.cat)}</span></td>
      <td class="der"><span class="at-cob" style="background:${colCob(i)}">${i.d <= 0 ? "sin venta" : i.cob == null ? "–" : nf(i.cob) + " días"}</span></td>
      <td class="der">${fCaja(i.d, i.fr)}</td><td class="der">${fCaja(i.st, i.fr)}</td>
      <td class="der">${noEnvia(i) ? '<span class="muted">No</span>' : `<b>${i.pide ? nf(i.pide) : "–"}</b>`}</td>
      <td class="at-nota">${noEnvia(i) ? `<span class="tag t-rech at-drog">No se te envía: ${esc(noEnvia(i))}</span>`
        : `${i.urg ? '<span class="tag t-rech">Urgente</span> ' : ""}${i.pide && i.falta ? `<span class="tag t-pend">${nf(i.falta)} sin stock en droguería</span>` : ""}${(i.de || []).map(x => `<span class="tag t-ok">${nf(x.q)} de ${esc(x.f)}</span>`).join(" ")}${i.cmp ? `<span class="tag t-rech">${nf(i.cmp)} por comprar</span>` : ""}`}${i.cmb ? `<span class="tag t-ok">En cambio de ${esc(i.cmb)}</span>` : ""}${tagDrog(i)}${i.enl ? `<span class="tag t-ok at-drog">Se te envía en lugar de ${esc(i.enl)} (${esc(quienEnl(i.enl))})</span>` : ""}${S.gest?.has(i.c) ? `<span class="tag t-pend at-drog">📢 ${esc(S.gest.get(i.c).nota || "Comunicado de droguería")}</span>` : ""}${i.krv ? `<span class="tag t-pend at-drog">🔁 Se termina lo que queda: ahora se trabaja con ${esc(i.krv)}</span>` : ""}${i.krn ? `<span class="tag t-ok at-drog">🔁 Reemplaza a ${esc(i.krn)}</span>` : ""}${i.aj ? `<small class="at-aj">Criterio propio: ${esc(i.aj)}</small>` : ""}</td>
      <td class="at-resp">${celdaResp(i)}</td>${admin ? `<td>${visAten(i) ? `<button type="button" class="btn sm at-vis" data-atvis="${esc(i.c)}" title="Ocultar este producto a la sucursal">👁 Visible</button>` : `<button type="button" class="btn sm at-vis no" data-atvis="${esc(i.c)}" title="Mostrar este producto a la sucursal">🚫 Oculto</button>`}</td>` : ""}</tr>`).join("")
      : `<tr class="vacia"><td colspan="10">Nada que mostrar.</td></tr>`) + "</tbody>";
  const iEd = S.atEdit && (A.items || []).find(x => x.c === S.atEdit);
  fxAplicar($("atTabla"), "aten", [1], (v, t) => { $("atTit").textContent = `${nf(v)}${v < t ? ` de ${nf(t)}` : ""} productos · ${nf(lista.filter(i => i.urg).length)} urgentes`; });
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
    let env = 0; if (diaria > 0 && ini - dem < seg) env = redPed(obj - (ini - dem));
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
        : `Tu sucursal: ${A.C} días + ${A.Sg} de seguridad · venta diaria según ${A.fte === "motor" ? "pronóstico estadístico" : `ventas de los últimos ${A.fte} días`} · ${A.tipos === "todos" ? "todo lo que se vende" : "tipo A y B lo necesario"}${i.aj ? `<br><b>Este producto tiene criterio propio:</b> ${esc(i.aj)}` : ""}`;
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
  const datos = (esAdmin() ? A.items : A.items.filter(visAten)).map(i => { const r = S.atResp?.get(i.c);
    return { "Código": i.c, Producto: i.n, Laboratorio: i.l || "", Tipo: i.cat || "", "Cobertura (días)": i.d <= 0 ? "sin venta" : i.cob ?? "",
      "Venta diaria": +Number(i.d || 0).toFixed(2), "Tu stock": i.st, "Se te enviará": i.pide || 0,
      Urgente: i.urg ? "Sí" : "", Nota: [i.pide && i.falta ? `${i.falta} sin stock en droguería` : "", ...(i.de || []).map(x => `${x.q} de ${x.f}`), i.cmp ? `${i.cmp} por comprar` : "", i.aj ? "Criterio propio: " + i.aj : "", i.cmb ? "En cambio de " + i.cmb : "", i.rmp ? quienDrog(estVig(i.c)) + " lo reemplaza por " + i.rmp : "", i.enl ? "En lugar de " + i.enl + " (" + quienEnl(i.enl) + ")" : "",
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
async function excelDe(datos, hojaNom, nombre, conFecha = true) {
  try { XLSX ??= await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm"); }
  catch { return toast("No se pudo preparar el Excel. Revisa tu internet e inténtalo de nuevo."); }
  const hoja = XLSX.utils.json_to_sheet(datos, { cellDates: true, dateNF: "dd/mm/yyyy" });
  const cols = Object.keys(datos[0] || { Producto: "" });
  hoja["!cols"] = cols.map(c => ({ wch: Math.min(48, Math.max(c.length, ...datos.map(d => String(d[c] instanceof Date ? "00/00/0000" : d[c]).length)) + 2) }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, hojaNom);
  XLSX.writeFile(libro, conFecha ? `${nombre}_${hoyISO()}.xlsx` : `${nombre}.xlsx`);
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
S.ped = null; S.pdSuc = ""; S.pdQ = ""; S.pdDesde = ""; S.pdMostrar = 200; S.pdHasta = ""; S.pdTopN = 5; S.pdStk = ""; S.urgEst = new Map();
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
// pedidos de urgencia de los últimos N días (para que Atención y el módulo de cada sucursal los consideren)
window.urgenciasRecientes = async (dias = 14) => {
  // los pedidos están en la plataforma y llegan en vivo: basta con esperar la primera lectura
  try { await cargarPedidos(); } catch {}
  const desde = Date.now() - dias * 864e5;
  return (S.ped?.datos || []).filter(d => d.cod && d.suc && d.f && +d.f >= desde).map(d => ({ suc: d.suc, cod: String(d.cod), q: +d.q || 1, f: d.f.toISOString().slice(0, 10) }));
};
// ---------- HISTÓRICO: la hoja de Drive del formulario de Google. Solo se lee para importarla a la plataforma (botón del administrador) ----------
async function leerHojaPedidos() {
  {
    // dos lecturas de la misma hoja: gviz (al instante, pero deja VACÍAS las celdas con varios códigos «25843, 26456» porque toma
    // la columna como numérica) y la «publicada en la web» como CSV (trae todo tal cual, pero Google la actualiza cada ~5 minutos).
    // Se usa gviz y sus celdas vacías se completan con la publicada (misma marca temporal y sucursal).
    const pub = FORM_URGENCIA.csvPublicado ? fetch(FORM_URGENCIA.csvPublicado + (FORM_URGENCIA.csvPublicado.includes("?") ? "&" : "?") + "_=" + Date.now(), { cache: "no-store" }).then(x => x.ok ? x.text() : null).catch(() => null) : null;
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${HOJA_PEDIDOS}/gviz/tq?tqx=out:csv&_=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const filas = leerCSV(await r.text());
    const tp = await pub;
    if (tp) { const pf = leerCSV(tp), clave = x => String(x[0] || "").trim() + "|" + String(x[1] || "").trim().toUpperCase(), m = new Map(pf.slice(1).map(x => [clave(x), x]));
      let n = 0; for (const x of filas.slice(1)) { const y = m.get(clave(x)); if (y) for (let i = 2; i < x.length; i++) if (!String(x[i] ?? "").trim() && String(y[i] ?? "").trim()) { x[i] = y[i]; n++; } }
      S.pedCompletadas = n; }
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
      // pedidos desde la página: «21648 x3, 00052 x2» = código y cantidad
      const itRe = /^(\d{3,6})\s*[x×*]\s*(\d+(?:[.,]\d+)?)$/i, items = crudo.split(/[,;]/).map(t => t.trim()).filter(Boolean);
      const conQ = items.length && items.every(t => itRe.test(t) || /^\d{3,6}$/.test(t)) && items.some(t => itRe.test(t)) ? items.map(t => { const m = t.match(itRe); return m ? [m[1], parseFloat(m[2].replace(",", "."))] : [t, 0]; }) : null;
      const cods = conQ ? conQ.map(z => z[0]) : crudo.match(/\b\d{3,6}\b/g), partes = conQ ? cods : cods && cods.length && crudo.replace(/[\d\s,;\/.\-y]+/gi, "") === "" ? cods : [crudo];
      return partes.map(p => p.trim()).filter(p => p && !/^[-–.\s]*$/.test(p)).map((pz, j) => {
        const pc = prodCat(pz) || (cods?.length === 1 ? prodCat(cods[0]) : null);
        return { k: k + j / 100, x, id: idFila(x) + (partes.length > 1 ? "_" + j : ""), suc: cS >= 0 ? sucDe(x[cS]) : "", f: cF >= 0 ? fechaDe(x[cF]) : null,
          cod: pc?.c || (/^\d+$/.test(pz) ? pz : ""), nom: pc?.n || (/^\d+$/.test(pz) ? "" : pz), lab: pc?.ln || "",
          q: conQ?.[j]?.[1] || (cQ >= 0 ? parseFloat(String(x[cQ]).replace(",", ".")) || 0 : 0), mot: cM >= 0 ? x[cM].trim() : "", quien: cU >= 0 ? x[cU].trim() : "" };
      });
    });
    // cantidades guardadas desde la página (urgencia_cant/{sucursal__código__día})
    // y quién lo pidió (el formulario de Google no guarda el usuario): { q, por }
    if (!S.urgCant) { S.urgCant = new Map(); try { (await getDocs(collection(db, "urgencia_cant"))).docs.forEach(d => { const x = d.data(); S.urgCant.set(d.id, { q: +x.q || 0, por: x.porNombre || "" }); }); } catch {} }
    const iso = f => f ? new Date(f.getTime() - f.getTimezoneOffset() * 6e4).toISOString().slice(0, 10) : "";
    for (const d of datos) if (d.cod && d.suc && (!d.q || !d.quien)) { const u = S.urgCant.get(`${d.suc}__${d.cod}__${iso(d.f)}`) || S.urgCant.get(`${d.suc}__${d.cod}__${d.f?.toISOString().slice(0, 10)}`);
      if (u) { if (!d.q && u.q) d.q = u.q; if (!d.quien && u.por) d.quien = u.por; } }
    return { cab, cS, datos };
  }
}
// ---------- pedidos de urgencia: se guardan SOLO en la plataforma (urgencias/{id}), en vivo. Nada se borra ni se cambia. ----------
const URG_CAB = ["Fecha", "Sucursal", "Código", "Producto", "Cantidad", "Motivo", "Pidió", "Origen"];
function armarPed() {
  if (!S.pedDocs) { S.ped = null; return; }
  const datos = S.pedDocs.map(r => {
    const f0 = r.f ? new Date(r.f) : null, f = f0 && !isNaN(f0) ? f0 : null, pc = prodCat(r.cod);
    const d = { id: r.id, k: f ? +f : 0, suc: r.suc || "", f, cod: pc?.c || String(r.cod || "").trim(), nom: pc?.n || r.nom || "", lab: pc?.ln || "",
      q: +r.q || 0, mot: r.mot || "", quien: r.porNombre || "", origen: r.origen || "pagina" };
    d.x = [f ? f.toLocaleString("es-PE") : "", r.sucTexto || (d.suc ? corto(d.suc) : ""), d.cod, d.nom, d.q || "", d.mot, d.quien, d.origen === "hoja" ? "Hoja de Drive (importado)" : "Plataforma"];
    return d; }).filter(d => d.cod || d.nom);
  S.ped = { t: Date.now(), cab: URG_CAB, cS: 1, cF: 0, datos };
}
function cargarPedidos() {
  escucharUrg(); cargarDrogStk(); reintentarPend();
  if (S.pedSub) return S.pedListo;
  S.pedSub = true; S.pdCargando = true;
  S.pedListo = new Promise(listo => {
    const un = onSnapshot(collection(db, "urgencias"), sn => {
      S.pedDocs = sn.docs.map(d => ({ id: d.id, ...d.data() })); armarPed(); S.pdErr = ""; S.pdCargando = false; listo();
      if (S.vista === "vPed") pintarPedidos(); else if (S.vista === "vRep") pintarRpCmp();   // urgencias en «Notas y comentarios», en vivo
    }, e => {
      S.pdErr = "No se pudieron leer los pedidos de la plataforma. " + textoError(e); S.pdCargando = false; S.pedSub = false; listo();
      if (S.vista === "vPed") pintarPedidos();
    });
    S.subs.push(() => { un(); S.pedSub = false; S.pedDocs = null; S.ped = null; });
  });
  return S.pedListo;
}
// copia en ESTE equipo de lo que todavía no confirmó el servidor: no se pierde aunque se cierre la página o falle internet
const PEND_K = () => "urgPend_" + (S.perfil?.uid || "");
const leerPend = () => { try { return JSON.parse(localStorage.getItem(PEND_K()) || "[]"); } catch { return []; } };
const guardarPend = l => { try { l.length ? localStorage.setItem(PEND_K(), JSON.stringify(l)) : localStorage.removeItem(PEND_K()); } catch {} };
// escribe los pedidos y ESPERA la confirmación del servidor (máx. 25 s); si no la hay, lanza error
async function guardarUrg(regs, reintento) {
  let falta = regs;
  if (reintento) { falta = []; for (const r of regs) { const s = await getDoc(doc(db, "urgencias", r.id)); if (!s.exists()) falta.push(r); } }
  if (!falta.length) return;
  const bt = writeBatch(db);
  for (const r of falta) bt.set(doc(db, "urgencias", r.id), { ...r.data, creado: serverTimestamp() });
  let tope; const plazo = new Promise((_, no) => { tope = setTimeout(() => no({ code: "timeout" }), 25000); });
  try { await Promise.race([bt.commit(), plazo]); } finally { clearTimeout(tope); }
}
const errUrg = x => x?.code === "timeout" ? "El servidor no confirmó en 25 segundos (internet lento o sin conexión)." : textoError(x);
function pintarPend() {
  const el = $("pdPend"); if (!el) return; const l = leerPend();
  el.hidden = !l.length; if (!l.length) return;
  el.innerHTML = `⚠ <b>${l.length} producto${l.length === 1 ? "" : "s"} pedido${l.length === 1 ? "" : "s"} desde este equipo todavía NO se guardaron en la plataforma</b>
    (${l.slice(0, 8).map(r => esc(r.data.cod || r.data.nom)).join(", ")}${l.length > 8 ? "…" : ""}). Están a salvo en este equipo y se reintenta solo cada 30 segundos.
    ${S.pendErr ? `<br><small>Último error: ${esc(S.pendErr)}</small>` : ""} <button class="btn sm" type="button" id="pdPendBtn">Reintentar ahora</button>`;
}
async function reintentarPend(aviso) {
  // los que se están guardando ahora mismo desde la ventana de pedido no se tocan (evita escribirlos dos veces)
  if (S.pendCorre || !S.perfil || S.prev) return; const l = leerPend().filter(r => !S.urgVuelo?.has(r.id)); if (!l.length) return pintarPend();
  S.pendCorre = true;
  try { await guardarUrg(l, true); guardarPend(leerPend().filter(x => !l.some(r => r.id === x.id))); S.pendErr = "";
    toast(`✔ Se guardaron en la plataforma ${l.length} producto${l.length === 1 ? "" : "s"} que habían quedado pendientes.`); }
  catch (x) { S.pendErr = errUrg(x); if (aviso) alert("⚠ Todavía NO se pudo guardar.\n\n" + S.pendErr); }
  finally { S.pendCorre = false; pintarPend(); }
}
setInterval(() => { if (!document.hidden && navigator.onLine !== false) reintentarPend(); }, 30000);
window.addEventListener("online", () => reintentarPend());
document.addEventListener("click", e => { if (e.target.closest("#pdPendBtn")) reintentarPend(true); });
// importa la hoja de Drive (histórico del formulario de Google): lo que ya está en la plataforma no se repite.
// Conserva el mismo id de cada fila, así siguen valiendo los estados y notas que droguería ya marcó.
async function importarHoja() {
  if (!esAdmin() || S.prev) return;
  if (!confirm("Se copiarán a la plataforma TODOS los pedidos de la hoja de Drive del formulario de Google que todavía no estén aquí. ¿Continuar?")) return;
  const b = $("pdImp"); b.disabled = true; msg("pdImpMsg", "Leyendo la hoja de Drive…");
  try {
    await cargarPedidos(); if (!S.pedDocs) throw new Error("no se pudieron leer los pedidos de la plataforma");
    const hoja = await leerHojaPedidos();
    const clave = (suc, cod, nom, f) => [suc || "", cod || nom || "", f ? Math.floor(+new Date(f) / 60000) : ""].join("|");
    const ids = new Set(S.pedDocs.map(r => r.id)), claves = new Set(S.pedDocs.filter(r => r.origen === "hoja").map(r => clave(r.suc, r.cod, r.nom, r.f)));
    const nuevos = hoja.datos.filter(d => !ids.has(d.id) && !claves.has(clave(d.suc, d.cod, d.nom, d.f)));
    const llaves = hoja.cab.map((h, j, a) => { const k = (h || "").replace(/^_+|_+$/g, "") || "Columna " + (j + 1); return a.indexOf(h) === j ? k : k + " (" + (j + 1) + ")"; });
    let n = 0;
    for (let i = 0; i < nuevos.length; i += 100) {
      const bt = writeBatch(db);
      for (const d of nuevos.slice(i, i + 100)) bt.set(doc(db, "urgencias", d.id), { suc: d.suc || "", sucTexto: hoja.cS >= 0 ? String(d.x[hoja.cS] ?? "").trim() : "",
        cod: d.cod || "", nom: d.nom || "", q: +d.q || 0, mot: d.mot || "", porNombre: d.quien || "", porUid: S.perfil.uid, f: d.f ? d.f.toISOString() : "",
        origen: "hoja", fila: Object.fromEntries(llaves.map((k, j) => [k, String(d.x[j] ?? "")])), creado: serverTimestamp() });
      await bt.commit(); n += Math.min(100, nuevos.length - i);
      msg("pdImpMsg", `Importando… ${n} de ${nuevos.length}`);
    }
    msg("pdImpMsg", `✔ Importación terminada: ${n} pedido${n === 1 ? "" : "s"} nuevo${n === 1 ? "" : "s"} de la hoja (${hoja.datos.length - nuevos.length} ya estaban en la plataforma).`);
  } catch (x) { msg("pdImpMsg", "⚠ La importación NO terminó: " + (x?.code ? textoError(x) : x?.message || x) + " Lo ya importado quedó guardado; puede volver a pulsar «Importar» y seguirá donde se quedó.", true); }
  finally { b.disabled = false; }
}
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
  // stock y venta diaria de cada sucursal (red/stk_SUCURSAL): para ofrecer de dónde sacarlo cuando droguería no tiene
  S.sucStk = new Map();
  await Promise.all(FARMACIAS.filter(f => /^ALMACEN /.test(f)).map(async f => { try { const d = await getDoc(doc(db, "red", "stk_" + f)); if (d.exists()) S.sucStk.set(f, d.data().p || {}); } catch {} }));
  S.drogStkCargando = false; if (S.vista === "vPed") pintarPedidos(); else if (S.vista === "vRep") pintarRpCmp();
}
const puedeMarcarUrg = () => esAdmin() || ["sucursales", "kardex"].some(v => (S.perfil?.vistas || []).includes(v));
const ESTADO_U = { "": ["🔴 Pedido recién", "rojo"], viendo: ["🟠 Droguería lo está viendo", "amb"], gestionado: ["🔵 Listo para entrega en droguería", "azul"], parcial: ["🟡 Atendido parcial", "amb"], atendido: ["🟢 Atendido", "verde"], rechazado: ["⛔ Rechazado", "gris"] };
// texto del estado sin el ícono; en «Atendido parcial», con la cantidad que se atendió (de lo que pidió)
const estUTxt = (e, d) => { const b = (ESTADO_U[e?.estado || ""]?.[0] || e?.estado || "").replace(/^\S+ /, "");
  return e?.estado === "parcial" && e.qAt != null ? `${b}: ${nf(e.qAt)}${d?.q ? " de " + nf(d.q) : ""}` : b; };
// grupo del estado para los filtros: atendido (también parcial), rechazado, o no atendido
const estUGrupo = e => e === "atendido" || e === "parcial" ? "si" : e === "rechazado" ? "rech" : "no";
const estU = d => S.urgEst.get(d.id) || {};
// filtros de la lista de urgencias: con / sin stock en droguería, y atendido / no atendido
const pdPasaFiltros = d => (!S.pdStkL || !S.drogStk || ((S.drogStk[d.cod]?.[0] || 0) > 0) === (S.pdStkL === "con"))
  && (!S.pdAtL || estUGrupo(estU(d).estado || "") === S.pdAtL);
// pedidos REPETIDOS (misma sucursal y mismo producto): con «Quitar repetidos» queda solo el más reciente (no se borra nada)
const pdClaveRep = d => (d.suc || "") + "|" + (d.cod || d.nom);
const pdSinRep = l => { if (!S.pdSinRep) return l; const ya = new Set(); return l.filter(d => { const k = pdClaveRep(d); if (ya.has(k)) return false; ya.add(k); return true; }); };
const inicioDia = (n = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
const inicioDiaDe = x => { const d = new Date(x); d.setHours(0, 0, 0, 0); return d; };
const hace = f => { if (!f) return ""; const m = Math.round((Date.now() - f) / 60000); return m < 1 ? "recién" : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : f.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" }); };
const nomProd = d => d.nom || (d.cod ? "Código " + d.cod + " (no está en el catálogo ni en el kardex)" : "(sin producto)");
function pedidosVisibles() {
  const P = S.ped; if (!P) return [];
  const admin = esAdmin() || !miFarm(), suc = admin ? S.pdSuc : miFarm(), q = norm(S.pdQ).trim().split(/\s+/).filter(Boolean);
  const desde = S.pdDesde ? new Date(S.pdDesde + "T00:00:00") : null, hasta = S.pdHasta ? new Date(S.pdHasta + "T23:59:59") : null;
  return P.datos.filter(d => (!suc || d.suc === suc) && (!desde || !d.f || d.f >= desde) && (!hasta || !d.f || d.f <= hasta) && (!q.length || q.every(w => norm(d.x.join(" ") + " " + d.nom).includes(w))))
    .sort((a, b) => (b.f || 0) - (a.f || 0) || b.k - a.k);
}
function pintarPedidos() {
  const P = S.ped, admin = esAdmin() || !miFarm();
  $("pdNuevoA").hidden = !esAdmin(); $("pdDrive").hidden = !esAdmin(); $("pdImp").hidden = !esAdmin(); pintarPend(); $("pdDrive").href = `https://docs.google.com/spreadsheets/d/${HOJA_PEDIDOS}/edit`;
  $("pdSucF").hidden = !admin; $("pdA").hidden = !admin || !P; $("pdLista").hidden = !admin; $("pdB").hidden = admin || !P;
  $("pdSub").textContent = admin ? "Lo que cada sucursal pidió de urgencia. Se guarda en la plataforma y se actualiza al instante."
    : `Lo que ${nombreFarm(miFarm())} pidió de urgencia. Se guarda en la plataforma y se actualiza al instante.`;
  msg("pdMsg", S.pdErr || "", true);
  if (!P) { $("pdTabla").innerHTML = `<tbody><tr class="vacia"><td>${S.pdErr ? "" : "Leyendo los pedidos…"}</td></tr></tbody>`; if (!admin) $("pdLista").hidden = false; return; }
  $("pdHora").textContent = "Actualizado " + new Date(P.t).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  if (!admin && P.cS < 0) { msg("pdMsg", "La hoja no tiene una columna de sucursal; consulta con Abastecimiento.", true); $("pdB").hidden = true; return; }
  if (admin) { pintarTableroUrg(P); if (esAdmin()) escucharSugAdm(); } else pintarTarjetasUrg();
}
// ---------- usuarios: tabla simple (medicamento, fecha y hora, si hay en droguería) ----------
const hayDrog = c => { if (S.drogStk == null) return '<span class="muted">…</span>'; const v = S.drogStk[c]?.[0];
  return v > 0 ? `<span class="chip verde">✓ Sí hay (${nf(v)})</span>` : c ? '<span class="chip rojo">✗ No hay</span>' : '<span class="muted">–</span>'; };
function pintarTarjetasUrg() {
  const lista = pedidosVisibles();
  $("pdTablaU").innerHTML = `<thead><tr><th>Medicamento</th><th class="der">Cant.</th><th class="der" title="Lo que tiene hoy su sucursal (último kardex)">Stock en tu sucursal</th><th>Fecha y hora del pedido</th><th>¿Hay en droguería?</th><th>Respuesta de Abastecimiento</th></tr></thead><tbody>` +
    (lista.length ? lista.map(d => `<tr><td class="p"><b>${esc(nomProd(d))}</b>${d.cod && d.nom ? `<code>${esc(d.cod)}</code>` : ""}${d.mot ? `<small class="pd-com">💬 ${esc(d.mot)}</small>` : ""}</td>
      <td class="der">${d.q ? nf(d.q) : ""}</td><td class="der">${stockMio(d.cod)}</td>
      <td class="f">${d.f ? d.f.toLocaleString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : esc(d.x[S.ped.cF] || "")}</td><td>${hayDrog(d.cod)}</td><td>${respUrg(d)}</td></tr>`).join("")
      : '<tr class="vacia"><td colspan="8">No hay pedidos en esas fechas.</td></tr>') + "</tbody>";
  pintarIndUrg(); escucharSug();
}
// lo que respondió Abastecimiento (estado y nota): solo si respondió; si no, en blanco
const respUrg = d => { const e = S.urgEst?.get(d.id); if (!e || (!e.estado && !e.nota)) return "";
  return `${e.estado ? `<span class="chip ${ESTADO_U[e.estado]?.[1] || ""}">${esc(estUTxt(e, d))}</span>` : ""}${e.nota ? `<small class="pd-com">📝 ${esc(e.nota)}</small>` : ""}`; };
// stock de la sucursal del usuario (último kardex subido; el mismo que en su módulo)
const stockMioV = c => { const f = miFarm(); if (!f || !c || !S.karStock) return null; return +(S.karStock[c]?.[f]?.[0] || 0); };
const stockMio = c => { const v = stockMioV(c); return v == null ? '<span class="muted">–</span>' : v > 0 ? `<b>${nf(Math.round(v * 100) / 100)}</b>` : '<span class="rojo-t">0</span>'; };
// indicador: cuánto está pidiendo la sucursal (hoy, 7 días, el mes) y los últimos 14 días en barras
function pintarIndUrg() {
  const f = miFarm(), l = (S.ped?.datos || []).filter(d => d.suc === f && d.f), box = $("pdInd"); if (!box) return;
  const desde = n => +inicioDia(n), mes = new Date(); mes.setDate(1); mes.setHours(0, 0, 0, 0);
  const cuenta = t => { const x = l.filter(d => +d.f >= t); return { n: x.length, u: x.reduce((a, d) => a + (+d.q || 1), 0), p: new Set(x.map(d => d.cod || d.nom)).size }; };
  const hoy = cuenta(desde(0)), sem = cuenta(desde(6)), m = cuenta(+mes), red = (S.ped?.datos || []).filter(d => d.f && +d.f >= desde(6));
  const sucs = new Set(red.map(d => d.suc).filter(Boolean)).size || 1, prom = red.length / sucs;
  const dias = Array.from({ length: 14 }, (_, i) => { const a = desde(13 - i), b = a + 864e5; return { d: new Date(a), n: l.filter(d => +d.f >= a && +d.f < b).length }; });
  const max = Math.max(1, ...dias.map(x => x.n));
  box.innerHTML = `<h3>📊 Tus pedidos de urgencia</h3>
    <div class="pd-ind-g"><div><b>${nf(hoy.n)}</b><small>hoy</small></div><div><b>${nf(sem.n)}</b><small>últimos 7 días</small></div><div><b>${nf(m.n)}</b><small>este mes</small></div></div>
    <p class="muted pd-ind-t">Este mes: <b>${nf(m.p)}</b> productos distintos · <b>${nf(m.u)}</b> unidades.<br>Últimos 7 días: tu sucursal <b>${nf(sem.n)}</b> · promedio de las sucursales <b>${nf(Math.round(prom))}</b>.</p>
    <div class="pd-barras">${dias.map(x => `<span title="${x.d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" })}: ${x.n} pedidos"><i style="height:${Math.round(x.n / max * 100)}%"></i><small>${x.d.getDate()}</small></span>`).join("")}</div>
    <small class="muted">Pedidos por día (últimos 14 días)</small>`;
}
// Abastecimiento: todos los comentarios de mejora, en vivo
function escucharSugAdm() {
  if (S.sugAdmSub) return pintarSugAdm(); S.sugAdmSub = true;
  S.subs.push(onSnapshot(collection(db, "sugerencias"), sn => { S.sugAdm = sn.docs.map(d => d.data()).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))); pintarSugAdm(); },
    e => { S.sugAdmSub = false; $("pdSugAdmL").innerHTML = `<p class="muted">${esc(textoError(e))}</p>`; }));
  S.subs.push(() => { S.sugAdmSub = false; });
}
function pintarSugAdm() { const l = S.sugAdm; if (!l) return;
  $("pdSugAdmL").innerHTML = l.length ? l.slice(0, 100).map(x => `<div class="sug-it"><b>${esc(x.suc ? corto(x.suc) : "")}</b> · ${esc(x.txt)}<small>${esc(x.porNombre || "")} · ${new Date(x.fecha).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</small></div>`).join("") : '<p class="muted">Todavía no hay comentarios.</p>'; }
// comentarios de mejora (sugerencias/{id}): los escribe cada sucursal; los lee Abastecimiento
function escucharSug() {
  if (S.sugSub || !miFarm()) return; S.sugSub = true;
  S.subs.push(onSnapshot(query(collection(db, "sugerencias"), where("suc", "==", miFarm())), sn => {
    S.sugMias = sn.docs.map(d => d.data()).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))); pintarSugMias(); }, () => { S.sugSub = false; }));
  S.subs.push(() => { S.sugSub = false; });
}
function pintarSugMias() { const l = S.sugMias || [];
  $("sugMias").innerHTML = l.length ? `<small class="muted">Tus comentarios enviados:</small>${l.slice(0, 5).map(x => `<div class="sug-it">${esc(x.txt)}<small>${esc(x.porNombre || "")} · ${new Date(x.fecha).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</small></div>`).join("")}` : ""; }
$("sugEnviar").addEventListener("click", async () => {
  if (S.prev) return msg("sugMsg", PREVIA.message, true);
  const t = $("sugTxt").value.trim(); if (t.length < 3) return msg("sugMsg", "Escribe tu comentario.", true);
  try { await setDoc(doc(collection(db, "sugerencias")), { suc: miFarm() || "", txt: t.slice(0, 1000), porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario || "", fecha: new Date().toISOString() });
    $("sugTxt").value = ""; msg("sugMsg", "✔ Gracias, tu comentario llegó a Abastecimiento."); }
  catch (x) { msg("sugMsg", textoError(x), true); }
});
// ---------- administrador: tablero ----------
function pintarTableroUrg(P) {
  // periodo: el de los filtros de arriba (Desde / Hasta); sin fechas, los últimos 7 días
  const hoy = inicioDia(0), ayer = inicioDia(1), d0 = S.pdDesde ? new Date(S.pdDesde + "T00:00:00") : inicioDia(6), d1 = S.pdHasta ? new Date(S.pdHasta + "T23:59:59") : new Date();
  const conRango = !!(S.pdDesde || S.pdHasta), fD = x => x.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const per = conRango ? `${fD(d0)} – ${fD(d1)}` : "últimos 7 días";
  $("pdRango").textContent = "Tablero: " + per + (S.pdSuc ? " · " + corto(S.pdSuc) : " · todas las sucursales");
  const enRango = d => d.f && d.f >= d0 && d.f <= d1;
  const base = P.datos.filter(d => !S.pdSuc || d.suc === S.pdSuc);
  const deHoy = base.filter(d => d.f && d.f >= hoy), deAyer = base.filter(d => d.f && d.f >= ayer && d.f < hoy), deSem = base.filter(enRango);
  const cuenta = (arr, key) => { const m = new Map(); arr.forEach(d => { const k = key(d); if (k) m.set(k, (m.get(k) || 0) + 1); }); return [...m].sort((a, b) => b[1] - a[1]); };
  const sucTop = cuenta(conRango || !deHoy.length ? deSem : deHoy, d => d.suc)[0];
  const porProd = new Map(); deSem.forEach(d => { const k = d.cod || d.nom; if (!k) return; const x = porProd.get(k) || { d, q: 0, n: 0, s: new Set(), f0: null, f1: null }; x.q += d.q || 1; x.n++; if (d.suc) x.s.add(d.suc); if (d.f) { if (!x.f0 || d.f < x.f0) x.f0 = d.f; if (!x.f1 || d.f > x.f1) x.f1 = d.f; } porProd.set(k, x); });
  const hayStk = x => S.drogStk?.[x.d.cod]?.[0] > 0;
  const todosTop = [...porProd.values()].sort((a, b) => b.s.size - a.s.size || b.q - a.q);
  const filtTop = S.drogStk == null || !S.pdStk ? todosTop : todosTop.filter(x => S.pdStk === "con" ? hayStk(x) : !hayStk(x));
  const top = S.pdTopN ? filtTop.slice(0, S.pdTopN) : filtTop;
  const dif = deHoy.length - deAyer.length, pc = conRango ? "periodo" : "semana";
  $("pdKpi").innerHTML = conRango ? `
    <div class="card pd-kpi"><small>Pedidos en el periodo</small><b class="n rojo-t">${nf(deSem.length)}</b><small>${per}</small></div>
    <div class="card pd-kpi"><small>Productos distintos</small><b class="n">${nf(porProd.size)}</b><small>en el periodo</small></div>`
    : `
    <div class="card pd-kpi"><small>Pedidos hoy</small><b class="n rojo-t">${nf(deHoy.length)}</b><small>${dif > 0 ? `▲ ${dif} más que ayer` : dif < 0 ? `▼ ${-dif} menos que ayer` : "igual que ayer"}</small></div>
    <div class="card pd-kpi"><small>Productos distintos hoy</small><b class="n">${nf(new Set(deHoy.map(d => d.cod || d.nom)).size)}</b><small>esta semana: ${nf(porProd.size)}</small></div>`;
  $("pdKpi").innerHTML += `
    <div class="card pd-kpi"><small>Sucursal que más pide${conRango ? " (periodo)" : deHoy.length ? " hoy" : " (semana)"}</small><b class="n m">${sucTop ? esc(corto(sucTop[0])) : "–"}</b><small>${sucTop ? nf(sucTop[1]) + " pedidos" : ""}</small></div>
    <div class="card pd-kpi"><small>Producto más pedido (${pc})</small><b class="n s">${top[0] ? esc(nomProd(top[0].d)) : "–"}</b><small class="cod">${top[0] ? esc(top[0].d.cod) + " · " + top[0].s.size + " sucursales" : ""}</small></div>`;
  // barras por sucursal (todas, en el periodo)
  $("pdBarH").textContent = `Pedidos por sucursal (${per})`;
  $("pdTopH").innerHTML = `<span>${S.pdTopN ? "Top " + S.pdTopN + " productos" : "Todos los productos"} más pedidos (${per})</span><span class="pd-topn">${[5, 10, 20, 50, 0].map(n => `<button type="button" class="btn sm${(S.pdTopN ?? 5) === n ? " act" : ""}" data-pdtopn="${n}">${n ? n : "Todos"}</button>`).join("")}</span>${S.drogStk != null ? `<span class="pd-topn pd-stk">${[["", "Todos"], ["con", "Con stock"], ["sin", "Sin stock"]].map(([v, t]) => `<button type="button" class="btn sm${S.pdStk === v ? " act" : ""}" data-pdstk="${v}">${t}</button>`).join("")}</span>` : ""}`;
  const barras = cuenta(P.datos.filter(enRango), d => d.suc), mx = Math.max(1, ...barras.map(b => b[1]));
  $("pdBarras").innerHTML = barras.length ? `<svg viewBox="0 0 520 ${barras.length * 30 + 6}" class="pd-svg">${barras.map(([f, n], i) => {
    const w = Math.max(4, 370 * n / mx), y = 6 + i * 30, c = ["#14306B", "#14306B", "#3d5a99", "#3d5a99", "#6b84bf", "#6b84bf"][i] || "#9fb1d9";
    return `<g class="pd-bar" data-pdsuc="${esc(f)}"><text x="0" y="${y + 13}">${esc(corto(f))}</text><rect x="100" y="${y}" width="${w}" height="18" rx="4" fill="${S.pdSuc === f ? "#F28C1E" : c}"/><text x="${106 + w}" y="${y + 14}">${n}</text></g>`; }).join("")}</svg>`
    : `<p class="muted">Sin pedidos en ${conRango ? "ese periodo" : "los últimos 7 días"}.</p>`;
  // línea: por día (hasta 2 meses) o por mes
  const nDias = Math.round((inicioDiaDe(d1) - inicioDiaDe(d0)) / 864e5) + 1, porMes = nDias > 62;
  let pts;
  if (!porMes) pts = Array.from({ length: nDias }, (_, i) => { const a = new Date(inicioDiaDe(d0).getTime() + i * 864e5), b = new Date(a.getTime() + 864e5);
    return { a, b, et: nDias <= 7 ? (+a === +hoy ? "hoy" : a.toLocaleDateString("es-PE", { weekday: "short" })) : a.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" }) }; });
  else { pts = []; const ini = new Date(Math.max(+d0, +new Date(d1.getFullYear() - 3, d1.getMonth(), 1)));   // como máximo 36 meses
    for (let a = new Date(ini.getFullYear(), ini.getMonth(), 1); a <= d1; a = new Date(a.getFullYear(), a.getMonth() + 1, 1)) pts.push({ a: a < d0 ? d0 : a, b: new Date(a.getFullYear(), a.getMonth() + 1, 1), et: a.toLocaleDateString("es-PE", { month: "short", year: "2-digit" }) }); }
  const vals = pts.map(p => base.filter(d => d.f && d.f >= p.a && d.f < p.b && d.f <= d1).length);
  const mv = Math.max(1, ...vals), paso = pts.length > 1 ? 410 / (pts.length - 1) : 0, X = i => 40 + i * paso, Y = v => 170 - v / mv * 140, cada = Math.ceil(pts.length / 12);
  $("pdLinH").textContent = "Pedidos por " + (porMes ? "mes" : "día") + (S.pdSuc ? " · " + corto(S.pdSuc) : "");
  $("pdLinea").innerHTML = `<svg viewBox="0 0 460 200" class="pd-svg"><g stroke="#eceff3"><line x1="30" x2="450" y1="30" y2="30"/><line x1="30" x2="450" y1="100" y2="100"/><line x1="30" x2="450" y1="170" y2="170"/></g>
    <polyline points="${vals.map((v, i) => X(i) + "," + Y(v)).join(" ")}" fill="none" stroke="#F28C1E" stroke-width="3"/>
    ${vals.map((v, i) => { const ult = i === vals.length - 1, ver = i % cada === 0 || ult; return `<circle cx="${X(i)}" cy="${Y(v)}" r="${ult ? 5 : 4}" fill="#F28C1E"><title>${pts[i].et}: ${v} pedidos</title></circle>${ver ? `<text x="${X(i)}" y="${Y(v) - 10}" text-anchor="middle" class="${ult ? "hoy" : ""}">${v}</text>
      <text x="${X(i)}" y="192" text-anchor="middle" class="dia">${pts[i].et}</text>` : ""}`; }).join("")}</svg>`;
  // top 5 con el stock de droguería
  // sin stock en droguería: sucursales que lo tienen y no lo mueven (sin venta) o lo mueven lento (su stock le dura más de 60 días)
  const fx1 = v => Number(v || 0).toLocaleString("es-PE", { maximumFractionDigits: 1 });
  const otras = otrasSucs;
  const stDrog = (c, pidieron) => { const v = S.drogStk?.[c]?.[0]; if (S.drogStk == null) return "";
    if (v > 0) return `<span class="chip verde">Con stock: ${nf(v)}</span>`;
    const o = otras(c, pidieron || new Set());
    return '<span class="chip rojo">Sin stock</span>' + (o.length ? `<div class="pd-otras"><small class="muted">Pedir a otra sucursal:</small>${o.slice(0, 5).map(x => `<span class="pd-otra" title="Stock ${fx1(x.st)} · venta diaria ${fx1(x.d)}${x.d > 0 ? " · le dura " + Math.round(x.cob) + " días" : ""}"><b>${esc(corto(x.f))}</b> ${fx1(x.st)} <i>${x.d > 0 ? "lento · " + Math.round(x.cob) + " d" : "sin movimiento"}</i></span>`).join("")}${o.length > 5 ? `<small class="muted">+${o.length - 5} más</small>` : ""}</div>`
      : S.sucStk?.size ? '<div class="pd-otras"><small class="muted">Ninguna sucursal lo tiene sin mover</small></div>' : ""); };
  const fDia = f => f.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }), fHora = f => f.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  const fSol = x => !x.f1 ? "" : x.n === 1 || +inicioDiaDe(x.f0) === +inicioDiaDe(x.f1) ? `${fDia(x.f1)}<br><small class="muted">${x.n === 1 ? fHora(x.f1) : fHora(x.f0) + " – " + fHora(x.f1)}</small>`
    : `${fDia(x.f0)} – ${fDia(x.f1)}<br><small class="muted">${nf(x.n)} solicitudes</small>`;
  // último «CARGO ENVIO» del producto en cada sucursal que lo pidió (kardex general)
  const ultAbSucs = (c, sucs) => { const l = [...sucs].map(f => [f, S.ultAbast?.[c]?.[f]]);
    return `<div class="pd-ultab">${l.map(([f, u]) => { if (!u) return `<span><b>${esc(corto(f))}</b> <span class="muted">sin registro</span></span>`;
      const [a, m, di] = u[0].slice(0, 10).split("-"), dias = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(+a, m - 1, +di)) / 864e5);
      return `<span><b>${esc(corto(f))}</b> ${di}/${m}/${a.slice(2)} · ${nf(Math.round(u[1] * 100) / 100)} <small class="muted">(hace ${nf(dias)} d)</small></span>`; }).join("")}</div>`; };
  $("pdTop").innerHTML = `<thead><tr><th>Producto</th><th>Sucursales que lo pidieron</th><th class="der">Cant.</th><th>Fecha de solicitud</th><th>En droguería</th>${esAdmin() ? "<th>Último abastecimiento</th>" : ""}</tr></thead><tbody>` +
    (top.length ? top.map(x => `<tr><td class="p"><b>${esc(nomProd(x.d))}</b><code>${esc(x.d.cod)}</code></td><td>${[...x.s].map(f => `<span class="tag">${esc(corto(f))}</span>`).join(" ")} <b>${x.s.size}</b></td><td class="der"><b>${nf(x.q)}</b></td><td class="f">${fSol(x)}</td><td>${stDrog(x.d.cod, x.s)}</td>${esAdmin() ? `<td>${ultAbSucs(x.d.cod, x.s)}</td>` : ""}</tr>`).join("")
      : `<tr class="vacia"><td colspan="6">${S.pdStk && todosTop.length ? `Ningún producto ${S.pdStk === "con" ? "con" : "sin"} stock en droguería en ${conRango ? "ese periodo" : "esta semana"}.` : `Sin pedidos en ${conRango ? "ese periodo" : "esta semana"}.`}</td></tr>`) + "</tbody>";
  // movimiento de cada sucursal: venta diaria publicada (red/stk_SUCURSAL) y pedidos urgentes del periodo, con su % del total
  const movBox = $("pdMov") && $("pdMovBox"); if (movBox) {
    const pedS = new Map(cuenta(P.datos.filter(enRango), d => d.suc)), filas = FARMACIAS.filter(f => /^ALMACEN /.test(f)).map(f => {
      const p = S.sucStk?.get(f) || {}; let v = 0, n = 0; for (const c in p) { const d = +p[c][1] || 0; if (d > 0) { v += d; n++; } }
      return { f, v, n, ped: pedS.get(f) || 0 }; }).filter(x => x.v > 0 || x.ped > 0);
    const tv = filas.reduce((a, x) => a + x.v, 0), tp = filas.reduce((a, x) => a + x.ped, 0), pc = (a, t) => t ? (a / t * 100).toLocaleString("es-PE", { maximumFractionDigits: 1 }) + " %" : "–";
    filas.sort((a, b) => b.v - a.v || b.ped - a.ped);
    movBox.hidden = !filas.length;
    if (!movBox.hidden) {
      const mx = Math.max(...filas.map(x => tv ? x.v / tv : 0), 1e-9);
      $("pdMov").innerHTML = `<thead><tr><th class="der">#</th><th>Sucursal</th><th class="der">Venta por día</th><th class="der">Productos que se venden</th><th>% del movimiento total</th><th class="der">Pedidos urgentes (${per})</th><th class="der">% de pedidos</th></tr></thead><tbody>` +
        filas.map((x, i) => `<tr><td class="der">${i + 1}</td><td><b>${esc(corto(x.f))}</b></td><td class="der">${fx1(x.v)}</td><td class="der">${nf(x.n)}</td>
          <td><span class="pd-pct"><span style="width:${tv ? Math.round(x.v / tv / mx * 100) : 0}%"></span></span> <b>${pc(x.v, tv)}</b></td><td class="der">${nf(x.ped)}</td><td class="der">${pc(x.ped, tp)}</td></tr>`).join("") +
        `<tr class="tot"><td></td><td><b>Total</b></td><td class="der"><b>${fx1(tv)}</b></td><td></td><td><b>${tv ? "100 %" : "–"}</b></td><td class="der"><b>${nf(tp)}</b></td><td class="der"><b>${tp ? "100 %" : "–"}</b></td></tr></tbody>`;
      $("pdMovNota").textContent = "Movimiento = suma de la venta diaria promedio de todos los productos de la sucursal (la que se publica con las listas a sucursales). Ordenado de mayor a menor.";
    }
  }
  // resumen por sucursal (filtro) y lista de pedidos para marcarlos
  const res = $("pdRes"); res.hidden = P.cS < 0;
  if (P.cS >= 0) res.innerHTML = cuenta(P.datos, d => d.suc || "?").map(([f, c]) => `<button type="button" class="pd-chip${S.pdSuc === f ? " act" : ""}" data-pdsuc="${esc(f)}">${esc(f === "?" ? "Sin reconocer" : corto(f))} <b>${nf(c)}</b></button>`).join("");
  if (!$("pdSuc").options.length) $("pdSuc").innerHTML = `<option value="">Todas</option>` + FARMACIAS.filter(f => /^ALMACEN /.test(f)).map(f => `<option value="${esc(f)}">${esc(corto(f))}</option>`).join("");
  $("pdSuc").value = S.pdSuc;
  // filtro de la lista: con stock / sin stock en droguería (o todos)
  const lista0 = pedidosVisibles().filter(pdPasaFiltros), lista = pdSinRep(lista0), vis = lista.slice(0, S.pdMostrar), marca = puedeMarcarUrg();
  // fechas de cada pedido repetido (de la más reciente a la más antigua)
  const repDe = new Map(); for (const d of lista0) { const k = pdClaveRep(d); (repDe.get(k) || repDe.set(k, []).get(k)).push(d); }
  const fCorta = f => f ? f.toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  const repTxt = d => { const g = repDe.get(pdClaveRep(d)); if (!g || g.length < 2) return ""; const i = g.indexOf(d);
    return i === 0 ? `<small class="pd-rep" title="${esc(g.slice(1).map(x => fCorta(x.f) + (x.q ? " · " + nf(x.q) : "")).join("\n"))}">🔁 pedido ${g.length} veces · antes: ${esc(g.slice(1, 4).map(x => fCorta(x.f)).join(", "))}${g.length > 4 ? "…" : ""}</small>`
      : `<small class="pd-rep viejo">🔁 repetido · el último es del ${esc(fCorta(g[0].f))}</small>`; };
  document.querySelectorAll("#pdRepL [data-pdrep]").forEach(b => b.classList.toggle("act", (b.dataset.pdrep === "1") === !!S.pdSinRep));
  document.querySelectorAll("#pdStkL [data-pdstkl]").forEach(b => b.classList.toggle("act", b.dataset.pdstkl === (S.pdStkL || "")));
  document.querySelectorAll("#pdAtL [data-pdatl]").forEach(b => b.classList.toggle("act", b.dataset.pdatl === (S.pdAtL || "")));
  // stock de la sucursal que pidió (solo el administrador): red/stk_SUCURSAL, se publica con las listas de atención
  const verStkSuc = esAdmin() && !!S.sucStk?.size;
  const stkSucTxt = d => { const m = d.suc && S.sucStk.get(d.suc); if (!m) return '<span class="muted">–</span>'; const v = +(m[d.cod]?.[0] || 0);
    return v > 0 ? `<b>${nf(Math.round(v * 100) / 100)}</b>` : '<span class="rojo-t">0</span>'; };
  // cuánto le dura el stock con el que cuenta la sucursal: stock ÷ venta diaria (red/stk_SUCURSAL: [stock, venta diaria])
  const leDuraSucV = d => { const x = d.suc && S.sucStk?.get(d.suc)?.[d.cod]; if (!x) return null; const [st, vd] = x; return vd > 0 ? Math.round((+st || 0) / vd) : (+st > 0 ? Infinity : 0); };
  const leDuraSuc = d => { const v = leDuraSucV(d); return v == null ? '<span class="muted">–</span>' : v === Infinity ? '<span class="muted">sin venta</span>' : `<span class="${v < 7 ? "rojo-t" : ""}">${nf(v)} d</span>`; };
  const ultCompTxt = c => { const u = c && S.ultCompra?.[c]; if (!u) return '<span class="muted">–</span>';
    const [a, m, di] = u[0].slice(0, 10).split("-"), dias = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(+a, m - 1, +di)) / 864e5);
    return `${di}/${m}/${a.slice(2)} · <b>${nf(Math.round(u[1] * 100) / 100)}</b><br><small class="muted">hace ${nf(dias)} día${dias === 1 ? "" : "s"}</small>`; };
  const ultAbTxt = d => { const u = d.suc && S.ultAbast?.[d.cod]?.[d.suc]; if (!u) return '<span class="muted">–</span>';
    const [a, m, di] = u[0].slice(0, 10).split("-"), dias = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(+a, m - 1, +di)) / 864e5);
    return `${di}/${m}/${a.slice(2)} · <b>${nf(Math.round(u[1] * 100) / 100)}</b><br><small class="muted">hace ${nf(dias)} día${dias === 1 ? "" : "s"}</small>`; };
  $("pdTit").textContent = `Pedidos recientes · ${nf(lista.length)}`;
  $("pdTabla").innerHTML = `<thead><tr><th>Fecha</th>${P.cS >= 0 ? "<th>Sucursal</th>" : ""}<th>Producto</th><th class="der">Cant.</th>${verStkSuc ? '<th class="der" title="Stock de esa sucursal según el último kardex publicado">Stock suc.</th><th class="der" title="Para cuántos días le alcanza su stock: stock ÷ su venta diaria">Le dura</th><th title="Último «CARGO ENVIO» de ese producto en esa sucursal (kardex general)">Último abastecimiento</th><th title="Última compra que ingresó a droguería («CARGO COMPRA» del kardex general)">Último ingreso (compra)</th><th>En droguería</th>' : ""}<th>Motivo</th><th>Pidió</th><th>Estado</th><th>Nota</th></tr></thead><tbody>` +
    (vis.length ? vis.map(d => { const e = estU(d), k = e.estado || "";
      return `<tr data-uid="${esc(d.id)}"><td class="f">${d.f ? d.f.toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}</td>${P.cS >= 0 ? `<td><b>${esc(d.suc ? corto(d.suc) : "¿" + (d.x[P.cS] || "") + "?")}</b></td>` : ""}
        <td class="p"><b>${esc(nomProd(d))}</b><code>${esc(d.cod)}</code>${repTxt(d)}</td><td class="der">${d.q ? nf(d.q) : ""}</td>${verStkSuc ? `<td class="der">${stkSucTxt(d)}</td><td class="der">${leDuraSuc(d)}</td><td>${ultAbTxt(d)}</td><td>${ultCompTxt(d.cod)}</td><td class="pd-endrog">${stDrog(d.cod, new Set([d.suc]))}</td>` : ""}<td>${esc(d.mot)}</td><td>${d.quien ? esc(d.quien) : '<span class="muted">–</span>'}</td>
        <td>${marca ? `<select class="pd-est ${ESTADO_U[k][1]}" data-uest>${Object.entries(ESTADO_U).map(([v, [t]]) => `<option value="${v}" ${v === k ? "selected" : ""}>${t}</option>`).join("")}</select>${k === "parcial" ? `<label class="pd-qat">Se atendió <input type="number" min="0" step="1" data-uqat value="${e.qAt ?? ""}" placeholder="cant."> ${d.q ? "de " + nf(d.q) : ""}</label>` : ""}` : `<span class="chip ${ESTADO_U[k][1]}">${esc(estUTxt(e, d))}</span>`}</td>
        <td>${marca ? `<input class="pd-nota" data-unota maxlength="120" placeholder="Ej. en tránsito, guía GR…" value="${esc(e.nota || "")}">` : esc(e.nota || "")}</td></tr>`; }).join("")
      : `<tr class="vacia"><td colspan="11">No hay pedidos con estos filtros.</td></tr>`) + "</tbody>";
  $("pdMas").innerHTML = lista.length > vis.length ? `<button class="btn" type="button" id="pdMasBtn">Ver más (de ${nf(lista.length)})</button>` : "";
}
// sucursales que tienen el producto sin moverlo (sin venta) o lento (su stock le dura más de 60 días), sin las que lo pidieron
function otrasSucs(c, pidieron) { const l = [];
  for (const [f, p] of S.sucStk || []) { if (pidieron.has(f)) continue; const x = p[c]; if (!x) continue; const [st, d] = x; if (!(st >= 1)) continue;
    const cob = d > 0 ? st / d : Infinity; if (cob <= 60) continue; l.push({ f, st, d, cob }); }
  return l.sort((a, b) => b.cob - a.cob || b.st - a.st); }
async function marcarUrg(tr) {
  const d = S.ped?.datos.find(x => x.id === tr.dataset.uid); if (!d) return;
  const estado = tr.querySelector("[data-uest]").value, nota = tr.querySelector("[data-unota]").value.trim().slice(0, 120), iq = tr.querySelector("[data-uqat]");
  // cantidad atendida (solo en «Atendido parcial»): la del cuadro, o la que ya tenía guardada
  const qAt = estado !== "parcial" ? null : iq && iq.value !== "" ? Math.max(0, Math.round(+iq.value || 0)) : estU(d).qAt ?? null;
  try {
    if (!estado && !nota) await deleteDoc(doc(db, "urgencia_estado", d.id));
    else await setDoc(doc(db, "urgencia_estado", d.id), { estado, nota, ...(qAt != null ? { qAt } : {}), suc: d.suc || "", cod: d.cod || "", porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario, fecha: serverTimestamp() });
    toast(estado === "parcial" && qAt == null ? "Escriba la cantidad que se atendió" : "Pedido actualizado");
    if (estado === "parcial" && qAt == null) setTimeout(() => document.querySelector(`tr[data-uid="${CSS.escape(d.id)}"] [data-uqat]`)?.focus(), 400);
  } catch (x) { toast(textoError(x)); }
}
$("pdTabla").addEventListener("change", e => { const tr = e.target.closest("tr[data-uid]"); if (tr && e.target.matches("[data-uest],[data-unota],[data-uqat]")) marcarUrg(tr); });
$("pdAct").addEventListener("click", () => { cargarPedidos(); reintentarPend(true); pintarPedidos(); });
$("pdImp").addEventListener("click", importarHoja);
$("pdSuc").addEventListener("change", e => { S.pdSuc = e.target.value; pintarPedidos(); });
$("pdTopH").addEventListener("click", e => { const b = e.target.closest("[data-pdtopn]"); if (b) { S.pdTopN = +b.dataset.pdtopn; pintarPedidos(); return; } const k = e.target.closest("[data-pdstk]"); if (k) { S.pdStk = k.dataset.pdstk; pintarPedidos(); } });
$("pdLimpiar").addEventListener("click", () => { S.pdSuc = S.pdDesde = S.pdHasta = ""; $("pdDesde").value = $("pdHasta").value = $("pdDesde2").value = $("pdHasta2").value = ""; pintarPedidos(); });
["pdQ", "pdQ2"].forEach(id => $(id).addEventListener("input", e => { S.pdQ = e.target.value; pintarPedidos(); }));
// fechas: mientras se escribe el año, el navegador da valores incompletos (año 0002, 0020…): se ignoran hasta que el año sea válido
const fechaOk = v => !v || (/^\d{4}-\d{2}-\d{2}$/.test(v) && +v.slice(0, 4) >= 2020 && +v.slice(0, 4) <= 2100);
["pdDesde", "pdDesde2"].forEach(id => $(id).addEventListener("change", e => { if (!fechaOk(e.target.value)) return; S.pdDesde = e.target.value; pintarPedidos(); }));
["pdHasta", "pdHasta2"].forEach(id => $(id).addEventListener("change", e => { if (!fechaOk(e.target.value)) return; S.pdHasta = e.target.value; pintarPedidos(); }));
["pdRes", "pdBarras"].forEach(id => $(id).addEventListener("click", e => { const b = e.target.closest("[data-pdsuc]"); if (!b) return; S.pdSuc = S.pdSuc === b.dataset.pdsuc ? "" : b.dataset.pdsuc; pintarPedidos(); }));
$("pdRepL").addEventListener("click", e => { const b = e.target.closest("[data-pdrep]"); if (!b) return; S.pdSinRep = b.dataset.pdrep === "1"; S.pdMostrar = 200; pintarPedidos(); });
$("pdAtL").addEventListener("click", e => { const b = e.target.closest("[data-pdatl]"); if (!b) return; S.pdAtL = b.dataset.pdatl; S.pdMostrar = 200; pintarPedidos(); });
$("pdStkL").addEventListener("click", e => { const b = e.target.closest("[data-pdstkl]"); if (!b) return; S.pdStkL = b.dataset.pdstkl; S.pdMostrar = 200; pintarPedidos(); });
$("pdMas").addEventListener("click", e => { if (e.target.closest("#pdMasBtn")) { S.pdMostrar += 200; pintarPedidos(); } });
["pdXls", "pdXls2"].forEach(id => $(id).addEventListener("click", () => {
  const P = S.ped; if (!P) return;
  const cols = P.cab.map((h, i) => i).filter(i => P.cab[i]);
  if (!(esAdmin() || !miFarm())) { const ds = pedidosVisibles().map(d => ({ "Código": d.cod, Medicamento: nomProd(d), "Fecha y hora": d.f || "", "¿Hay en droguería?": S.drogStk?.[d.cod]?.[0] > 0 ? "Sí (" + S.drogStk[d.cod][0] + ")" : "No", "Estado (Abastecimiento)": (() => { const e = S.urgEst?.get(d.id); return e?.estado ? estUTxt(e, d) : ""; })(), Nota: S.urgEst?.get(d.id)?.nota || "" }));
    if (!ds.length) return toast("No hay pedidos para descargar."); return excelDe(ds, "Urgencias", "agotados_urgencia_" + corto(miFarm()).replace(/\W+/g, "_").toLowerCase()); }
  const datos = pdSinRep(pedidosVisibles().filter(pdPasaFiltros)).map(d => { const e = estU(d);
    // lo mismo que se ve en la tabla: stock de la sucursal, último abastecimiento, droguería y otras sucursales
    const r2 = v => Math.round((+v || 0) * 100) / 100, stS = d.suc && S.sucStk?.get(d.suc), u = d.suc && S.ultAbast?.[d.cod]?.[d.suc];
    const dias = u ? Math.round((new Date().setHours(0, 0, 0, 0) - new Date(+u[0].slice(0, 4), +u[0].slice(5, 7) - 1, +u[0].slice(8, 10))) / 864e5) : "";
    const sd = S.drogStk?.[d.cod]?.[0], ot = sd > 0 ? [] : otrasSucs(d.cod, new Set([d.suc]));
    return Object.fromEntries([["Sucursal (reconocida)", d.suc ? corto(d.suc) : ""], ["Código", d.cod], ["Producto (catálogo)", d.nom], ["Cantidad pedida", d.q || ""], ["Pidió", d.quien || ""],
      ["Stock de la sucursal", stS ? r2(stS[d.cod]?.[0]) : ""], ["Le dura (días)", stS && stS[d.cod] ? (stS[d.cod][1] > 0 ? Math.round((+stS[d.cod][0] || 0) / stS[d.cod][1]) : (+stS[d.cod][0] > 0 ? "sin venta" : 0)) : ""], ["Último abastecimiento", u ? u[0].slice(0, 10).split("-").reverse().join("/") : ""], ["Cantidad abastecida", u ? r2(u[1]) : ""], ["Días desde el abastecimiento", dias],
      ["Último ingreso (compra)", S.ultCompra?.[d.cod] ? S.ultCompra[d.cod][0].slice(0, 10).split("-").reverse().join("/") : ""], ["Cantidad que ingresó", S.ultCompra?.[d.cod] ? r2(S.ultCompra[d.cod][1]) : ""],
      ["Stock droguería", S.drogStk ? r2(sd) : ""], ["Pedir a otra sucursal", ot.map(x => `${corto(x.f)} ${r2(x.st)} (${x.d > 0 ? "lento, " + Math.round(x.cob) + " d" : "sin movimiento"})`).join(" · ")],
      ["Estado", estUTxt(e, d)], ["Cantidad atendida", e.estado === "atendido" ? d.q || "" : e.estado === "parcial" ? e.qAt ?? "" : e.estado === "rechazado" ? 0 : ""], ["Nota", e.nota || ""],
      ...cols.map(i => [P.cab[i], d.x[i] || ""])]); });
  if (!datos.length) return toast("No hay pedidos para descargar.");
  const suc = esAdmin() || !miFarm() ? S.pdSuc : miFarm();
  excelDe(datos, "Urgencias", "agotados_urgencia_" + (suc ? corto(suc) : "todas").replace(/\W+/g, "_").toLowerCase());
}));

// ---------- pedir desde la página: se guarda en la plataforma (urgencias). Se guarda TODO, aunque el código no esté en el catálogo. ----------
S.urgNuevo = []; S.urgBus = "";
function abrirNuevoUrg() { cargarCatVivo(); $("urgCom").value = ""; S.urgNuevo = []; S.urgBus = ""; S.urgSucSel = miFarm() || ""; msg("urgMsg", ""); pintarNuevoUrg(); $("urgDlg").showModal(); $("urgBus").focus(); }
function pintarNuevoUrg() {
  const fija = !!miFarm() && !esAdmin();
  $("urgSucBox").innerHTML = fija ? `<b>${esc(nombreFarm(miFarm()))}</b> <small class="muted">(tu sucursal)</small>`
    : `<select id="urgSuc"><option value="">Elige la sucursal…</option>${FARMACIAS.filter(f => /^ALMACEN /.test(f)).map(f => `<option value="${esc(f)}" ${S.urgSucSel === f ? "selected" : ""}>${esc(corto(f))}</option>`).join("")}</select>`;
  $("urgSel").innerHTML = S.urgNuevo.length ? S.urgNuevo.map((p, k) => `<span class="fs-alt urg-it"><b>${esc(p.c)}</b> ${p.n ? esc(p.n) : '<i class="muted">(no está en el catálogo)</i>'} ${(() => { const v = stockMioV(p.c); return v == null ? "" : `<small class="urg-stk">Tu stock: <b class="${v > 0 ? "" : "rojo-t"}">${nf(Math.round(v * 100) / 100)}</b></small>`; })()} <label class="urg-q">Cantidad <input type="number" min="1" step="1" value="${p.q || 1}" data-urg-q="${k}" inputmode="numeric"></label> <button type="button" class="enlace" data-urg-quitar="${k}">Quitar</button></span>`).join("")
    : '<small class="muted">Busca y agrega los productos que necesitas (puedes agregar varios).</small>';
  $("urgEnviar").textContent = S.urgNuevo.length > 1 ? `Enviar pedido (${S.urgNuevo.length} productos)` : "Enviar pedido";
}
$("pdNuevo").addEventListener("click", abrirNuevoUrg);
$("pdNuevoA").addEventListener("click", abrirNuevoUrg);
$("urgBus").addEventListener("input", e => {
  S.urgBus = e.target.value; const box = $("urgRes");
  const t = S.urgBus.trim(), num = /^\d{3,6}$/.test(t), libre = t.length >= 2 && !prodCat(t) && !S.urgNuevo.some(a => (a.c || a.n) === t);
  if (libre && num && Date.now() - (S.catVivoT || 0) > 60000) cargarCatVivo(true).then(n => { if (n && $("urgBus").value === e.target.value) $("urgBus").dispatchEvent(new Event("input")); });
  box.innerHTML = resBusqueda({ c: "" }, S.urgBus, p => S.urgNuevo.some(a => a.c === p.c), "data-urg-add")
    + (libre ? `<button type="button" data-urg-cod="${esc(t)}"><b>${esc(t)}</b> Agregar ${num ? "este código" : "este texto"} tal cual (no está en el catálogo)</button>` : ""); box.hidden = !t;
});
$("urgDlg").addEventListener("change", e => { if (e.target.id === "urgSuc") S.urgSucSel = e.target.value; });
$("urgDlg").addEventListener("input", e => { const q = e.target.closest("[data-urg-q]"); if (q) { const p = S.urgNuevo[+q.dataset.urgQ]; if (p) p.q = Math.max(1, Math.round(+q.value || 1)); } });
$("urgDlg").addEventListener("click", async e => {
  if (e.target.closest("[data-cerrar-dlg]") || e.target === $("urgDlg")) return $("urgDlg").close();
  const a = e.target.closest("[data-urg-add]");
  if (a) { const p = S.catIdx.get(a.dataset.urgAdd); if (p) S.urgNuevo.push({ c: p.c, n: p.n, q: 1 }); $("urgBus").value = S.urgBus = ""; $("urgRes").hidden = true; pintarNuevoUrg(); $("urgBus").focus(); return; }
  const lc = e.target.closest("[data-urg-cod]");
  if (lc) { const t = lc.dataset.urgCod; S.urgNuevo.push(/^\d+$/.test(t) ? { c: t, n: "", q: 1 } : { c: "", n: t, q: 1 }); $("urgBus").value = S.urgBus = ""; $("urgRes").hidden = true; pintarNuevoUrg(); $("urgBus").focus(); return; }
  const q = e.target.closest("[data-urg-quitar]"); if (q) { S.urgNuevo.splice(+q.dataset.urgQuitar, 1); return pintarNuevoUrg(); }
  if (!e.target.closest("#urgEnviar")) return;
  if (S.prev) return msg("urgMsg", PREVIA.message, true);
  const suc = !esAdmin() && miFarm() ? miFarm() : S.urgSucSel;
  if (!suc) return msg("urgMsg", "Elige la sucursal.", true);
  if (!S.urgNuevo.length) return msg("urgMsg", "Agrega al menos un producto.", true);
  const b = $("urgEnviar"); b.disabled = true; msg("urgMsg", "Guardando en la plataforma…");
  const ahora = new Date().toISOString(), por = S.perfil.nombre || S.perfil.usuario || "";
  const regs = S.urgNuevo.map(p => ({ id: doc(collection(db, "urgencias")).id, data: { suc, cod: String(p.c || "").trim(), nom: p.n || "", q: Math.max(1, Math.round(+p.q || 1)), mot: ($("urgCom").value || "").trim().slice(0, 300),
    porUid: S.perfil.uid, porNombre: por, f: ahora, origen: "pagina" } }));
  guardarPend([...leerPend(), ...regs]);   // primero, una copia en este equipo: si algo falla, no se pierde
  S.urgVuelo = new Set(regs.map(r => r.id));
  S.urgNuevo = [];
  try {
    await guardarUrg(regs);
    guardarPend(leerPend().filter(x => !regs.some(r => r.id === x.id)));
    $("urgDlg").close(); const n = regs.length; toast(`✔ Pedido guardado en la plataforma (${n} producto${n === 1 ? "" : "s"}).`);
  } catch (x) {
    S.pendErr = errUrg(x); pintarNuevoUrg();
    const t = `⚠ EL PEDIDO NO SE GUARDÓ EN LA PLATAFORMA.\n\n${S.pendErr}\n\nNo se perdió: quedó guardado en este equipo y se reintenta solo cada 30 segundos (también con «Reintentar ahora» en Pedidos). No lo vuelva a registrar.`;
    msg("urgMsg", t.replace(/\n+/g, " "), true); alert(t);
  }
  finally { b.disabled = false; S.urgVuelo = null; pintarPend(); }
});

/* ===================== RECEPCIÓN DE PEDIDOS =====================
   Abastecimiento sube la lista de lo que droguería entrega a cada sucursal (el Excel «Sucursal_dd-mm-aa»):
   entregas/{id} = { suc, fecha, items: [{ c, n, l, q }], archivo, porNombre, creado }.
   La sucursal revisa cada producto al recibirlo: entrega_resp/{idEntrega}__{código} = { ent, suc, dia, cod, estado, q, nota, porUid, porNombre, fecha }. */
const ENT_EST = [["ok", "✔ Correcto", "verde"], ["cruzado", "Cruzado (llegó otro producto)", "rojo"], ["danado", "Dañado", "rojo"], ["cantidad", "Cantidad incorrecta", "amb"],
  ["lote", "Lote no coincide", "amb"], ["fecha_corta", "Fecha corta", "amb"], ["no_llego", "No llegó", "rojo"], ["otro", "Otro", "amb"]];
const entEst = id => ENT_EST.find(e => e[0] === id);
S.ent = null; S.entResp = new Map(); S.entSel = ""; S.entSuc = "";
function escucharEnt() {
  // la escucha es de un usuario: si cambia (cerró sesión y entró otro, o vista previa) se vuelve a escuchar solo lo suyo
  const clave = (S.perfil?.uid || "") + "|" + (esAdmin() ? "*" : miFarm() || "");
  if (S.entSub && S.entClave === clave) return;
  S.entUnsub?.(); S.entUnsub = null;
  S.entSub = true; S.entClave = clave; S.ent = null; S.entResp = new Map(); S.entSel = ""; S.entSuc = "";
  const suc = esAdmin() ? null : miFarm();
  if (!esAdmin() && !suc) { S.ent = []; return; }
  const qE = suc ? query(collection(db, "entregas"), where("suc", "==", suc)) : collection(db, "entregas");
  const subs = [];
  S.entUnsub = () => { subs.forEach(u => u()); subs.length = 0; };
  S.subs.push(() => { S.entUnsub?.(); S.entUnsub = null; S.entSub = false; S.ent = null; S.entResp = new Map(); S.entSel = ""; });
  subs.push(onSnapshot(qE, sn => { S.ent = sn.docs.map(d => { const x = d.data(); return { id: d.id, ...x, items: unirItems(x.items) }; }).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.creado || "").localeCompare(a.creado || "")); S.entErr = ""; if (S.vista === "vEnt") pintarEnt(); },
    e => { S.entErr = textoError(e); S.entSub = false; if (S.vista === "vEnt") pintarEnt(); }));
  // respuestas: la sucursal las suyas; Abastecimiento, las de los últimos 120 días
  const qR = suc ? query(collection(db, "entrega_resp"), where("suc", "==", suc)) : query(collection(db, "entrega_resp"), where("dia", ">=", new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10)));
  subs.push(onSnapshot(qR, sn => { S.entResp = new Map(sn.docs.map(d => [d.id, d.data()])); if (S.vista === "vEnt") pintarEnt(); }, () => {}));
}
// el mismo producto repetido en la lista (varias filas del Excel): una sola fila con la cantidad sumada
function unirItems(l) { const m = new Map();
  for (const it of l || []) { const x = m.get(it.c); if (x) x.q = Math.round(((+x.q || 0) + (+it.q || 0)) * 1000) / 1000; else m.set(it.c, { ...it }); }
  return [...m.values()]; }
const respEnt = (e, c) => S.entResp.get(e.id + "__" + c);
function resumenEnt(e) { let rev = 0, prob = 0; for (const it of e.items || []) { const r = respEnt(e, it.c); if (r) { rev++; if (r.estado !== "ok") prob++; } } return { rev, prob, n: (e.items || []).length }; }
function pintarEnt() {
  const admin = esAdmin();
  $("entAcc").hidden = !admin; $("entFil").hidden = !admin; $("entCabeza").hidden = !admin;
  $("entSub").textContent = admin ? "Suba la lista de cada sucursal; ellas revisan cada producto al recibirlo y usted ve lo que llegó bien y lo que no."
    : `Lo que droguería le entrega a ${nombreFarm(miFarm())}. Revise cada producto al recibirlo y márquelo: ✔ si está correcto o el problema que encontró.`;
  msg("entMsg", S.entErr || "", true);
  if (admin && !$("entSuc").options.length) $("entSuc").innerHTML = `<option value="">Todas</option>` + FARMACIAS.filter(f => /^ALMACEN /.test(f)).map(f => `<option value="${esc(f)}">${esc(corto(f))}</option>`).join("");
  if (admin) $("entSuc").value = S.entSuc;
  if (!S.ent) { $("entLista").innerHTML = '<p class="muted">Cargando…</p>'; return; }
  const lista = S.ent.filter(e => admin ? (!S.entSuc || e.suc === S.entSuc) : e.suc === miFarm());
  $("entLista").innerHTML = lista.length ? lista.slice(0, 60).map(e => { const r = resumenEnt(e), pct = r.n ? Math.round(r.rev / r.n * 100) : 0;
    return `<button type="button" class="card ent-card${S.entSel === e.id ? " act" : ""}" data-ent="${esc(e.id)}"><b>${esc(admin ? corto(e.suc) : "Entrega")} · ${fDia(e.fecha)}</b>
      <small>${nf(r.n)} productos · revisados ${nf(r.rev)} (${pct} %)${r.prob ? ` · <span class="rojo-t">${nf(r.prob)} con observación</span>` : ""}</small>
      <span class="ent-barra"><i style="width:${pct}%"></i></span></button>`; }).join("")
    : `<p class="muted">${admin ? "Todavía no hay listas. Súbalas con «⬆ Subir listas (Excel)»." : "Todavía no hay entregas para su sucursal."}</p>`;
  const e = lista.find(x => x.id === S.entSel) || (!admin ? lista[0] : null);
  if (e && !S.entSel) S.entSel = e.id;
  pintarEntDet(e);
}
function pintarEntDet(e) {
  const box = $("entDet"); box.hidden = !e; if (!e) return;
  const admin = esAdmin(), puede = !S.prev && (admin || e.suc === miFarm()), r = resumenEnt(e), pct = r.n ? Math.round(r.rev / r.n * 100) : 0, dis = puede ? "" : "disabled";
  const quien = x => `<small class="ent-quien">${esc(x.porNombre || "")} · ${fFecha(x.fecha)}</small>`;
  S.entObs ??= new Set();
  const fila = it => { const x = respEnt(e, it.c), es = x && entEst(x.estado), id = esc(it.c), mal = x && x.estado !== "ok", abierto = mal || S.entObs.has(e.id + "__" + it.c);
    const sel = `<select data-ents="${id}" ${dis}>${mal ? "" : `<option value="">Elija la observación…</option>`}${ENT_EST.slice(1).map(([v, t]) => `<option value="${v}" ${x?.estado === v ? "selected" : ""}>${t}</option>`).join("")}</select>`;
    const obs = abierto ? `<div class="ent-obs">${sel}${mal && x.estado === "cantidad" ? `<label>Llegó <input type="number" min="0" step="1" value="${x.q ?? ""}" data-entq="${id}" ${dis}></label>` : ""}${mal ? `<input type="text" maxlength="150" placeholder="${x.estado === "otro" ? "Describa el problema" : "Detalle (opcional)"}" value="${esc(x.nota || "")}" data-entn="${id}" ${dis}>` : ""}${!mal && puede ? `<button type="button" class="ent-x" data-entobs="${id}" title="Cancelar">✕</button>` : ""}</div>` : "";
    const rev = !x ? (puede ? `<button type="button" class="ent-ck" data-entok="${id}" title="Conforme">✔</button><button type="button" class="ent-ob${abierto ? " act" : ""}" data-entobs="${id}">Observar</button>` : `<span class="ent-badge sin">Sin revisar</span>`)
      : x.estado === "ok" ? `<button type="button" class="ent-badge ok" ${puede ? `data-entobs="${id}" title="Clic si encontró un problema"` : "disabled"}>✔ Conforme</button>`
      : `<span class="ent-badge ${es?.[2] === "rojo" ? "rojo" : "amb"}">⚠ ${esc((es?.[1] || x.estado).replace(/ \(.*\)/, ""))}</span>${puede ? `<button type="button" class="ent-ck sm" data-entok="${id}" title="Sí está conforme">✔</button>` : ""}`;
    return `<tr class="${x ? (mal ? "ent-mal" : "ent-ok") : ""}"><td><div class="ent-med"><span class="ent-cod">${id}</span><div><b>${esc(it.n)}</b><small>${esc(it.l || "")}</small></div></div></td>
      <td class="c"><span class="ent-q">${nf(it.q)}</span></td><td><div class="ent-rev">${rev}${x ? `<small class="ent-quien">${esc(x.porNombre || "")} · ${fFecha(x.fecha)}</small>` : ""}${x && admin && !S.prev ? `<button type="button" class="ent-x" data-entborra="${id}" title="Borrar esta revisión (queda sin revisar)">↺</button>` : ""}</div>${obs}</td></tr>`; };
  const fv = admin ? S.entVer || "" : "", verEnt = (e.items || []).filter(it => { const x = respEnt(e, it.c);
    return !fv || (fv === "obs" ? x && x.estado !== "ok" : fv === "ok" ? x?.estado === "ok" : fv === "sin" ? !x : x?.estado === fv); });
  // otras observaciones: lo que llegó sin estar en la lista u observaciones generales
  const otras = [...S.entResp.entries()].filter(([, d]) => d.ent === e.id && d.x && !d.anulado).sort((a, b) => (a[1].fecha || "").localeCompare(b[1].fecha || ""));
  box.innerHTML = `<div class="ent-cab"><h2>${esc(corto(e.suc))} · entrega del ${fDia(e.fecha)}</h2>
      <div class="ent-prog"><small>${nf(r.rev)} de ${nf(r.n)} revisados${r.prob ? ` · <b class="rojo-t">${nf(r.prob)} con observación</b>` : ""}</small><span class="ent-barra"><i style="width:${pct}%"></i></span></div>
      ${admin ? `<label class="filtro ent-ver">Mostrar <select id="entVer">${[["", "Todos"], ["obs", "Con observación (no conformes)"], ["ok", "Conformes"], ["sin", "Sin revisar"], ...ENT_EST.slice(1)].map(([v, t]) => `<option value="${v}" ${fv === v ? "selected" : ""}>${v && v !== "obs" && v !== "ok" && v !== "sin" ? "· " : ""}${esc(t)}</option>`).join("")}</select></label>` : puede && r.rev < r.n ? `<div class="ent-conf"><button class="btn primario" type="button" id="entConfResto">✔ Dar conformidad al resto</button><small>Da conformidad a todos los productos que <b>no</b> fueron observados (${nf(r.n - r.rev)} pendientes).</small></div>` : ""}
      ${admin && r.rev ? `<button class="btn" type="button" id="entBorrarRev">↺ Borrar las revisiones</button>` : ""}<button class="btn" type="button" id="entXlsLista">⬇ Excel</button>${admin ? `<button class="btn" type="button" id="entBorrar">🗑 Quitar esta lista</button>` : ""}</div>
    <div class="tabla-wrap"><table class="tabla ent-tabla"><thead><tr><th>Medicamento</th><th class="c">Cantidad</th><th>Revisión</th></tr></thead><tbody>${verEnt.map(fila).join("") || `<tr><td colspan="3" class="muted">No hay productos con este filtro.</td></tr>`}</tbody></table></div>
    <div class="ent-otras"><h3>📝 Otras observaciones</h3><p class="muted">Si llegó un producto que no estaba en la lista (no estaba previsto su envío) o tiene una observación general de esta entrega, anótela aquí.</p>
      ${otras.length ? `<ul class="ent-olist">${otras.map(([k, d]) => `<li><span class="ent-badge ${d.x === "extra" ? "amb" : "sin"}">${d.x === "extra" ? "No estaba en la lista" : "Observación general"}</span>
        ${d.x === "extra" ? `${d.cod ? `<span class="ent-cod">${esc(d.cod)}</span>` : ""}<b>${esc(d.prod || "")}</b>${d.q ? ` · llegó <b>${nf(d.q)}</b>` : ""}` : ""}${d.nota ? ` <span>${d.x === "extra" ? "· " : ""}${esc(d.nota)}</span>` : ""}
        ${quien(d)}${puede && (admin || d.porUid === S.perfil?.uid) ? `<button type="button" class="ab-x" data-entanula="${esc(k)}" title="Quitar">✕</button>` : ""}</li>`).join("")}</ul>` : ""}
      ${puede ? `<div class="ent-onuevo"><select id="entOTipo"><option value="extra">Llegó un producto que no estaba en la lista</option><option value="general">Observación general</option></select>
        <span class="ent-oprod"><input type="text" id="entOProd" list="entOLista" placeholder="Código o nombre del medicamento" autocomplete="off"><datalist id="entOLista"></datalist>
        <input type="number" id="entOQ" min="1" step="1" placeholder="Cant."></span>
        <input type="text" id="entONota" maxlength="200" placeholder="Comentario (por ejemplo: se queda en la sucursal, se devuelve…)">
        <button type="button" class="btn primario" id="entOAdd">Agregar</button></div>` : ""}</div>`;
}
async function guardarRespEnt(e, c, cambios) {
  if (S.prev) return toast(PREVIA.message);
  const ant = respEnt(e, c) || {}, d = { ent: e.id, suc: e.suc, dia: e.fecha, cod: c, estado: ant.estado || "ok", q: ant.q ?? null, nota: ant.nota || "", ...cambios,
    porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario, fecha: new Date().toISOString() };
  S.entResp.set(e.id + "__" + c, d); pintarEnt();
  try { await setDoc(doc(db, "entrega_resp", e.id + "__" + c), d); } catch (x) { avisar(x); }
}
const entActual = () => S.ent?.find(x => x.id === S.entSel);
$("vEnt").addEventListener("click", async ev => {
  const card = ev.target.closest("[data-ent]"); if (card) { S.entSel = card.dataset.ent; pintarEnt(); $("entDet").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  const e = entActual(); if (!e) return;
  const ob = ev.target.closest("[data-entobs]");
  if (ob) { S.entObs ??= new Set(); const k = e.id + "__" + ob.dataset.entobs; S.entObs.has(k) ? S.entObs.delete(k) : S.entObs.add(k); pintarEnt();
    if (S.entObs.has(k)) $("entDet").querySelector(`[data-ents="${ob.dataset.entobs}"]`)?.focus(); return; }
  const ok = ev.target.closest("[data-entok]"); if (ok) { S.entObs?.delete(e.id + "__" + ok.dataset.entok); return guardarRespEnt(e, ok.dataset.entok, { estado: "ok", q: null, nota: "" }); }
  if (ev.target.closest("#entConfResto")) {
    if (S.prev) return toast(PREVIA.message);
    const abiertos = (e.items || []).filter(it => !respEnt(e, it.c) && S.entObs?.has(e.id + "__" + it.c));
    if (abiertos.length) return toast(`Primero elija la observación de ${abiertos.map(it => it.c).join(", ")} (o ciérrela con ✕).`);
    const pend = (e.items || []).filter(it => !respEnt(e, it.c)); if (!pend.length) return;
    if (!confirm(`¿Dar conformidad a los ${pend.length} productos que no fueron observados?\n\nRevise antes que todos los productos con problema ya estén observados.`)) return;
    const quien = { porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario, fecha: new Date().toISOString() };
    try { for (let i = 0; i < pend.length; i += 400) { const lote = writeBatch(db);
      for (const it of pend.slice(i, i + 400)) { const d = { ent: e.id, suc: e.suc, dia: e.fecha, cod: it.c, estado: "ok", q: null, nota: "", ...quien }; lote.set(doc(db, "entrega_resp", e.id + "__" + it.c), d); S.entResp.set(e.id + "__" + it.c, d); }
      await lote.commit(); } pintarEnt(); toast("Conformidad registrada"); } catch (x) { avisar(x); }
    return; }
  const bo = ev.target.closest("[data-entborra]");
  if (bo) { const k = e.id + "__" + bo.dataset.entborra; try { await deleteDoc(doc(db, "entrega_resp", k)); S.entResp.delete(k); pintarEnt(); } catch (x) { avisar(x); } return; }
  if (ev.target.closest("#entBorrarRev")) {
    const ks = [...S.entResp.entries()].filter(([, d]) => d.ent === e.id).map(([k]) => k);
    if (!ks.length || !confirm(`¿Borrar las ${ks.length} revisiones y observaciones de ${corto(e.suc)} del ${fDia(e.fecha)}? La lista queda sin revisar.`)) return;
    try { for (let i = 0; i < ks.length; i += 400) { const lote = writeBatch(db); ks.slice(i, i + 400).forEach(k => lote.delete(doc(db, "entrega_resp", k))); await lote.commit(); }
      ks.forEach(k => S.entResp.delete(k)); pintarEnt(); toast("Revisiones borradas"); } catch (x) { avisar(x); }
    return; }
  const an = ev.target.closest("[data-entanula]");
  if (an) { const d = S.entResp.get(an.dataset.entanula); if (!d || !confirm("¿Quitar esta observación?")) return;
    if (esAdmin()) { try { await deleteDoc(doc(db, "entrega_resp", an.dataset.entanula)); S.entResp.delete(an.dataset.entanula); pintarEnt(); } catch (x) { avisar(x); } return; }
    const n = { ...d, anulado: true, porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario, fecha: new Date().toISOString() };
    S.entResp.set(an.dataset.entanula, n); pintarEnt(); try { await setDoc(doc(db, "entrega_resp", an.dataset.entanula), n); } catch (x) { avisar(x); } return; }
  if (ev.target.closest("#entOAdd")) {
    if (S.prev) return toast(PREVIA.message);
    const tipo = $("entOTipo").value, txt = $("entOProd").value.trim(), nota = $("entONota").value.trim().slice(0, 200), q = Math.max(0, Math.round(+$("entOQ").value || 0));
    let cod = "", prod = "";
    if (tipo === "extra") { if (!txt) return toast("Escriba el código o el nombre del medicamento que llegó.");
      const m = txt.match(/^(\d{4,6})\b/), p = m && S.catIdx.get(m[1].padStart(5, "0"));
      cod = m ? m[1].padStart(5, "0") : ""; prod = p ? p.n : txt.replace(/^\d{4,6}\s*·\s*/, ""); }
    else if (!nota) return toast("Escriba la observación.");
    const id = `${e.id}__X${Date.now().toString(36)}`, d = { ent: e.id, suc: e.suc, dia: e.fecha, cod, prod, x: tipo, estado: "otro", q: tipo === "extra" && q ? q : null, nota,
      porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario, fecha: new Date().toISOString() };
    S.entResp.set(id, d); pintarEnt();
    try { await setDoc(doc(db, "entrega_resp", id), d); toast("Observación guardada"); } catch (x) { avisar(x); }
    return; }
  if (ev.target.closest("#entXlsLista")) return excelDe((e.items || []).map(it => ({ "Código": it.c, Medicamento: it.n, Laboratorio: it.l || "", Cantidad: it.q })),
    "Entrega", `entrega_${corto(e.suc).toLowerCase().replace(/\W+/g, "_")}_${e.fecha.split("-").reverse().join("-")}`, false);
  if (ev.target.closest("#entBorrar")) { if (!confirm(`¿Quitar la lista de ${corto(e.suc)} del ${fDia(e.fecha)}? La sucursal dejará de verla.`)) return; try { await deleteDoc(doc(db, "entregas", e.id)); S.entSel = ""; } catch (x) { avisar(x); } }
});
$("vEnt").addEventListener("change", ev => {
  if (ev.target.id === "entVer") { S.entVer = ev.target.value; return pintarEnt(); }
  const e = entActual(); if (!e) return;
  const s = ev.target.closest("[data-ents]"); if (s && s.value) S.entObs?.delete(e.id + "__" + s.dataset.ents); if (s && s.value) return guardarRespEnt(e, s.dataset.ents, { estado: s.value });
  const q = ev.target.closest("[data-entq]"); if (q) return guardarRespEnt(e, q.dataset.entq, { q: q.value === "" ? null : Math.max(0, Math.round(+q.value)) });
  const n = ev.target.closest("[data-entn]"); if (n) return guardarRespEnt(e, n.dataset.entn, { nota: n.value.trim().slice(0, 150) });
});
$("vEnt").addEventListener("input", ev => {
  if (ev.target.id !== "entOProd") return; const t = ev.target.value.trim(); if (t.length < 3 || /·/.test(t)) return;
  $("entOLista").innerHTML = buscarCat(t).map(p => `<option value="${esc(p.c + " · " + p.n)}">`).join("");
});
$("vEnt").addEventListener("change", ev => { if (ev.target.id === "entOTipo") document.querySelector(".ent-oprod")?.toggleAttribute("hidden", ev.target.value !== "extra"); });
$("entSuc").addEventListener("change", e => { S.entSuc = e.target.value; S.entSel = ""; pintarEnt(); });
// Excel de observaciones (Abastecimiento): todo lo que no llegó bien, de la sucursal elegida (o todas)
$("entXls").addEventListener("click", () => {
  const filas = [];
  for (const e of (S.ent || []).filter(x => !S.entSuc || x.suc === S.entSuc)) for (const it of e.items || []) { const x = respEnt(e, it.c); if (!x || x.estado === "ok") continue;
    filas.push({ Sucursal: corto(e.suc), "Fecha de entrega": fDia(e.fecha), "Código": it.c, Medicamento: it.n, Laboratorio: it.l || "", "Cantidad enviada": it.q, "Observación": entEst(x.estado)?.[1] || x.estado, "Cantidad que llegó": x.q ?? "", Detalle: x.nota || "", "Revisó": x.porNombre || "", "Fecha de revisión": fFecha(x.fecha) }); }
  for (const d of S.entResp.values()) { if (!d.x || d.anulado) continue; const e = (S.ent || []).find(x => x.id === d.ent); if (!e || (S.entSuc && e.suc !== S.entSuc)) continue;
    filas.push({ Sucursal: corto(e.suc), "Fecha de entrega": fDia(e.fecha), "Código": d.cod || "", Medicamento: d.prod || "", Laboratorio: "", "Cantidad enviada": "", "Observación": d.x === "extra" ? "Llegó sin estar en la lista" : "Observación general", "Cantidad que llegó": d.q ?? "", Detalle: d.nota || "", "Revisó": d.porNombre || "", "Fecha de revisión": fFecha(d.fecha) }); }
  if (!filas.length) return toast("No hay observaciones.");
  excelDe(filas, "Observaciones", "recepcion_observaciones" + (S.entSuc ? "_" + corto(S.entSuc).toLowerCase() : ""));
});
// subir listas: Excel con Código, Medicamento, Laboratorio y «Se atenderá» (o Cantidad); sucursal y fecha del nombre del archivo
// la sucursal que aparece en el nombre del archivo (la coincidencia más larga: «ParraReal» es PARRA REAL, «Parra» es PARRA, «Tambo» es MCDO. TAMBO)
const sucDeNombre = t => { const k = norm(t).replace(/\.XLSX?$/, "").replace(/[^A-Z]/g, ""); if (!k) return ""; let mejor = "", largo = 0;
  for (const f of FARMACIAS.filter(f => /^ALMACEN /.test(f))) {
    const cand = [corto(f), f.replace(/^ALMACEN /, ""), ...norm(corto(f)).split(/[^A-Z]+/).filter(w => w.length >= 4)].map(x => norm(x).replace(/[^A-Z]/g, ""));
    for (const c of cand) if (c && k.includes(c) && c.length > largo) { mejor = f; largo = c.length; } }
  return mejor; };
const fechaDeNombre = t => { const m = String(t).match(/(\d{1,2})[-_.](\d{1,2})[-_.](\d{2,4})/); if (!m) return hoyISO(); const a = m[3].length === 2 ? "20" + m[3] : m[3]; return `${a}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; };
$("entArch").addEventListener("change", async ev => {
  const archivos = [...ev.target.files]; ev.target.value = ""; if (!archivos.length) return;
  try { XLSX ??= await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm"); } catch { return toast("No se pudo leer el Excel. Revisa tu internet."); }
  S.entNuevas = [];
  for (const a of archivos) {
    try {
      const wb = XLSX.read(await a.arrayBuffer()), ws = wb.Sheets[wb.SheetNames[0]], filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
      const iCab = filas.findIndex(f => f.some(v => /^C[OÓ]DIGO$/i.test(String(v).trim()))); if (iCab < 0) { S.entNuevas.push({ archivo: a.name, error: "no tiene la columna «Código»" }); continue; }
      const cab = filas[iCab].map(v => norm(String(v))), col = re => cab.findIndex(h => re.test(h));
      const iC = col(/^CODIGO$/), iN = col(/MEDICAMENTO|PRODUCTO|DESCRIPCION/), iL = col(/^LABORATORIO$/), iQ = col(/SE ATENDERA|CANTIDAD|ENVIAR|PEDIR/);
      if (iQ < 0) { S.entNuevas.push({ archivo: a.name, error: "no tiene la columna «Se atenderá» o «Cantidad»" }); continue; }
      const items = filas.slice(iCab + 1).map(f => ({ c: String(f[iC] ?? "").trim(), n: String(f[iN] ?? "").trim(), l: iL >= 0 ? String(f[iL] ?? "").trim() : "", q: +String(f[iQ] ?? "").replace(",", ".") || 0 }))
        .filter(x => /^\d+$/.test(x.c) && x.q > 0).map(x => ({ ...x, c: x.c.padStart(5, "0") }));
      S.entNuevas.push({ archivo: a.name, suc: sucDeNombre(a.name) || sucDeNombre(wb.SheetNames[0]), fecha: fechaDeNombre(a.name), items: unirItems(items) });
    } catch (x) { S.entNuevas.push({ archivo: a.name, error: "no se pudo leer (" + (x.message || x) + ")" }); }
  }
  const ops = FARMACIAS.filter(f => /^ALMACEN /.test(f)).map(f => `<option value="${esc(f)}">${esc(corto(f))}</option>`).join("");
  $("entDlgLista").innerHTML = S.entNuevas.map((x, k) => x.error ? `<p class="rojo-t">✘ ${esc(x.archivo)}: ${esc(x.error)}</p>`
    : `<div class="ent-sube"><b>${esc(x.archivo)}</b> · ${nf(x.items.length)} productos<div class="filtros"><label class="filtro">Sucursal <select data-entsuc="${k}"><option value="">Elija…</option>${ops}</select></label><label class="filtro">Fecha de entrega <input type="date" min="2020-01-01" max="2100-12-31" value="${x.fecha}" data-entfe="${k}"></label></div></div>`).join("");
  S.entNuevas.forEach((x, k) => { const s = $("entDlgLista").querySelector(`[data-entsuc="${k}"]`); if (s) s.value = x.suc || ""; });
  msg("entDlgMsg", ""); $("entDlg").showModal();
});
$("entDlg").addEventListener("change", ev => { const s = ev.target.closest("[data-entsuc]"), f = ev.target.closest("[data-entfe]");
  if (s) S.entNuevas[+s.dataset.entsuc].suc = s.value; if (f) S.entNuevas[+f.dataset.entfe].fecha = f.value; });
$("entDlg").addEventListener("click", async ev => {
  if (ev.target.closest("[data-cerrar-dlg]") || ev.target === $("entDlg")) return $("entDlg").close();
  if (!ev.target.closest("#entGuardar")) return;
  const ok = (S.entNuevas || []).filter(x => !x.error && x.items.length);
  if (!ok.length) return msg("entDlgMsg", "No hay listas válidas para publicar.", true);
  if (ok.some(x => !x.suc || !/^\d{4}-\d{2}-\d{2}$/.test(x.fecha || ""))) return msg("entDlgMsg", "Elija la sucursal y la fecha de cada archivo.", true);
  try {
    for (const x of ok) { const id = `${x.suc.replace(/\W+/g, "_")}__${x.fecha}__${Date.now().toString(36)}`;
      await setDoc(doc(db, "entregas", id), { suc: x.suc, fecha: x.fecha, items: x.items, archivo: x.archivo, porNombre: S.perfil.nombre || S.perfil.usuario, creado: new Date().toISOString() }); }
    $("entDlg").close(); toast(`Publicadas ${ok.length} lista${ok.length === 1 ? "" : "s"} a las sucursales`);
  } catch (x) { msg("entDlgMsg", textoError(x), true); }
});

/* ===================== REPOSICIÓN POR REPORTES =====================
   Lee el reporte «Reposición Ventas» del sistema (.XLS): Producto, C-Lab, Stk-E, Stk-F, StkMin, Cant-E, Cant-F, P.V.F, Parcial,
   C-Alterno (código), agrupado por «Laboratorio :». El de droguería da su stock (y el StkMin = stock de todas las sucursales);
   el de cada sucursal, su venta en los días filtrados y su stock. Se calcula lo que se le debe atender a cada sucursal. */
S.rp = { sucs: [], suc: "", q: "", det: false };
const rpNum = v => { const x = String(v ?? "").trim().replace(/,/g, ""); return x === "" ? 0 : +x || 0; };
const rpDia = t => { const m = String(t).match(/(\d{2})-(\d{2})-(\d{4})/); return m ? new Date(+m[3], m[2] - 1, +m[1]) : null; };
function leerReporte(filas, archivo) {
  const txt = v => String(v ?? "").trim();
  const iCab = filas.findIndex(f => f.some(v => txt(v) === "Producto") && f.some(v => /C-Alterno/i.test(txt(v))));
  if (iCab < 0) throw new Error("no es un reporte «Reposición Ventas» (no tiene las columnas Producto … C-Alterno)");
  const cab = filas[iCab].map(txt), col = n => cab.findIndex(h => h.toUpperCase() === n.toUpperCase());
  const C = { lab: col("C-Lab"), se: col("Stk-E"), sf: col("Stk-F"), smin: col("StkMin"), ce: col("Cant-E"), cf: col("Cant-F"), pvf: col("P.V.F"), par: col("Parcial"), cod: col("C-Alterno") };
  // el valor puede caer en la celda de al lado (celdas combinadas del reporte)
  const val = (f, j) => j < 0 ? "" : txt(f[j]) !== "" ? txt(f[j]) : txt(f[j + 1]) !== "" && !cab[j + 1] ? txt(f[j + 1]) : txt(f[j - 1]) !== "" && !cab[j - 1] ? txt(f[j - 1]) : "";
  let est = "", desde = null, hasta = null, lab = "";
  for (const f of filas.slice(0, iCab)) for (const v of f) { const t = txt(v);
    if (/^Establecimiento\s*:/i.test(t)) est = t.replace(/^Establecimiento\s*:\s*/i, "");
    const m = t.match(/Desde\s+Fecha:\s*(\S+)\s+Hasta\s+Fecha:\s*(\S+)/i); if (m) { desde = rpDia(m[1]); hasta = rpDia(m[2]); } }
  const items = [], sinCod = [];
  for (const f of filas.slice(iCab + 1)) {
    const a = txt(f[0]); if (!a || a === "Producto") continue;
    if (/^Laboratorio\s*:/i.test(a)) { lab = f.slice(1).map(txt).find(Boolean) || lab; continue; }
    if (/^\*+\s*(Sub-)?Total|^Total Registros/i.test(a)) continue;   // (no «TOTAL» a secas: hay productos como «SIMILAC TOTAL…»)
    if (val(f, C.se) === "" && val(f, C.ce) === "") continue;
    const it = { n: a, lab, sig: val(f, C.lab), se: rpNum(val(f, C.se)), sf: rpNum(val(f, C.sf)), smin: rpNum(val(f, C.smin)), ce: rpNum(val(f, C.ce)), cf: rpNum(val(f, C.cf)),
      pvf: rpNum(val(f, C.pvf)), par: rpNum(val(f, C.par)), c: val(f, C.cod).replace(/\.0$/, "") };
    if (/^\d+$/.test(it.c)) it.c = it.c.padStart(5, "0");
    (it.c ? items : sinCod).push(it);
  }
  const dias = desde && hasta ? Math.round((hasta - desde) / 864e5) + 1 : null;
  return { archivo, est, desde, hasta, dias, items, sinCod, esDrog: /DROGUER/i.test(est), suc: sucDeNombre(est) || sucDeNombre(archivo) || "" };
}
async function rpLeerArchivo(a) {
  if (/\.txt$/i.test(a.name)) return leerReporteTxt(new TextDecoder("windows-1252").decode(await a.arrayBuffer()), a.name);
  XLSX ??= await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(await a.arrayBuffer()), ws = wb.Sheets[wb.SheetNames[0]];
  return leerReporte(XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false }), a.name);
}
// Reporte en TEXTO (separado por tabulaciones): codpro, despro, codlab, cant_e, cant_m (lo vendido), stkalm, stkalm_m (stock),
// stkfra (fraccionero), precio, deslab… No trae sucursal ni fechas: salen del NOMBRE del archivo («Ortega__1_al_21-11.TXT»).
function fechasDeNombre(t) {
  const y = new Date().getFullYear(), m = String(t).match(/(\d{1,2})(?:[-.](\d{1,2}))?(?:[-.](\d{2,4}))?[_\s-]*al[_\s-]*(\d{1,2})[-.](\d{1,2})(?:[-.](\d{2,4}))?/i);
  if (!m) return { desde: null, hasta: null };
  const ano = v => !v ? y : v.length === 2 ? 2000 + +v : +v, mh = +m[5], ah = ano(m[6]);
  const hasta = new Date(ah, mh - 1, +m[4]), md = m[2] ? +m[2] : mh, desde = new Date(m[3] ? ano(m[3]) : md > mh ? ah - 1 : ah, md - 1, +m[1]);
  return { desde, hasta };
}
function leerReporteTxt(txt, archivo) {
  const L = txt.split(/\r?\n/).filter(l => l.trim()), h = (L[0] || "").split("\t").map(x => x.trim().toLowerCase()), i = n => h.indexOf(n);
  if (i("codpro") < 0 || i("cant_e") < 0 || i("stkalm") < 0) throw new Error("no es el reporte de reposición en texto (faltan las columnas codpro, cant_e, stkalm…)");
  const items = [], sinCod = [];
  for (const l of L.slice(1)) { const c = l.split("\t"), v = k => i(k) >= 0 ? String(c[i(k)] ?? "").trim() : "";
    let cod = v("codpro"); const it = { n: v("despro"), lab: v("deslab") || v("codlab"), sig: v("codlab"), ce: rpNum(v("cant_e")), cf: rpNum(v("cant_m")),
      se: rpNum(v("stkalm")), sf: rpNum(v("stkalm_m")), smin: rpNum(v("stkmin")), pvf: rpNum(v("precio")), fr: Math.max(1, rpNum(v("stkfra")) || 1) };
    it.par = (it.ce + it.cf / it.fr) * it.pvf;
    if (/^\d+$/.test(cod)) cod = cod.padStart(5, "0"); it.c = cod;
    if (!it.n && !cod) continue; (cod ? items : sinCod).push(it); }
  const { desde, hasta } = fechasDeNombre(archivo.replace(/^[0-9a-f]{8}-/, "")), suc = sucDeNombre(archivo.replace(/^[0-9a-f]{8}-/, ""));
  return { archivo, est: suc ? nombreFarm(suc) : archivo, desde, hasta, dias: desde && hasta ? Math.round((hasta - desde) / 864e5) + 1 : null, items, sinCod, esDrog: false, suc };
}
function rpFracc(reps) {
  const fr = new Map();
  for (const r of reps) for (const it of r.items) if (it.fr > 0) fr.set(it.c, it.fr);   // el reporte en texto ya trae el fraccionero
  for (const r of reps) for (const it of r.items) if (!fr.has(it.c) && it.cf > 0 && it.pvf > 0.05) { const q = it.par / it.pvf - it.ce; if (q > 1e-6) { const x = Math.round(it.cf / q); if (x > 0) fr.set(it.c, x); } }
  return (c, n) => fr.get(c) || +(String(n).match(/X\s*(\d+)\s*(?:TAB|COM|CAP|CAPS|GRAG|AMP|SOB|SCH|UND|UDS|CPR|COMP|TB|TABS|SOBRES|PERLAS|OVULOS|PARCHES)/i)?.[1] || 0) || null;
}
function rpCalcular() {
  // SOLO con el reporte de la sucursal: lo que vendió en los días del reporte − lo que tiene ahora = lo que se le entrega
  // (tiene 4 y vendió 10 → 6). No se usa ninguna otra información.
  const R = S.rp, pedidos = [];
  for (const r of R.sucs) {
    const frDe = rpFracc([r]), dias = r.dias || 0;
    for (const it of r.items) {
      const fr = frDe(it.c, it.n), venta = it.ce + (fr ? it.cf / fr : 0), stock = it.se + (fr ? it.sf / fr : 0);
      const q = redPed(venta - stock);
      // si en «Comparar con mi Excel» se eligió otra cantidad para este producto, se entrega la elegida
      const el = S.rpEleg?.get(rpElKey(r, it.c)), qf = el ? el.q : q;
      if (qf > 0) pedidos.push({ r, it, qRep: q, q: qf, at: qf, el, venta, stock, fr, dias });
    }
    // añadidos desde «Solo en su Excel» que no están en el reporte de la sucursal
    const pre = rpElKey(r, ""), ya = new Set(r.items.map(it => it.c));
    for (const [k, el] of S.rpEleg || []) { if (!k.startsWith(pre) || !(el.q > 0)) continue; const c = k.slice(pre.length); if (ya.has(c)) continue;
      const e = rpCmpDe(r)?.items.get(c); pedidos.push({ r, it: { c, n: e?.n || el.n || c, lab: e?.l || el.l || "" }, qRep: 0, q: el.q, at: el.q, el, venta: 0, stock: 0, fr: null, dias }); }
  }
  R.res = pedidos;
}
const rpNomSuc0 = r => r.esDrog ? r.est : r.suc ? corto(r.suc) : r.est || r.archivo;
const rpNomSuc = r => { const n = rpNomSuc0(r), dd = d => d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}` : "?";
  return r && [...S.rp.sucs, ...(S.rp.arch || [])].filter(x => x !== r && rpNomSuc0(x) === n).length ? `${n} (${dd(r.desde)}–${dd(r.hasta)})` : n; };
function pintarRep() {
  const R = S.rp, fD = d => d ? d.toLocaleDateString("es-PE") : "?";
  const fila = (r, arch) => `<span class="${arch ? "rp-archivado" : ""}"><b>${esc(rpNomSuc(r))}</b> · ${fD(r.desde)} al ${fD(r.hasta)} (${r.dias || "?"} días) ${arch ? "" : `<button type="button" class="btn sm rp-fe" data-rpfe="${esc(r.id || r.archivo)}" title="Corregir las fechas del reporte">📅 fechas</button> `}· ${nf(r.items.length)} productos${r.subido ? ` <small class="muted">· guardado el ${new Date(r.subido).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}${r.porNombre ? " por " + esc(r.porNombre) : ""}</small>` : ""}
    <button type="button" class="btn sm" data-rparch="${esc(r.id || "")}" data-v="${arch ? "0" : "1"}" title="${arch ? "Volver a trabajar con este reporte" : "Guardarlo como terminado: sale de la lista pero no se borra (con sus decisiones y su Excel)"}">${arch ? "↩ Volver a trabajar" : "📦 Archivar"}</button> <button type="button" class="btn sm rp-borrar" data-rpborrar="${esc(r.id || "")}" title="Borrar TODO lo de ${esc(rpNomSuc0(r))} en este módulo: sus reportes, su Excel y sus decisiones">🗑 Eliminar todo de ${esc(rpNomSuc0(r))}</button>${!arch && rpAntDe(r) ? ` <button type="button" class="btn sm rp-ant" data-rpsep="${esc(r.id || "")}" title="Hay decisiones o un Excel de antes de subir este reporte: son del reporte anterior de esta sucursal">⚠ ${rpAntDe(r)} decisiones de un reporte anterior · separarlas</button>` : ""}</span>`;
  $("rpSucsTxt").innerHTML = (R.sucs.length ? R.sucs.map(r => fila(r, false)).join("<br>") : "Sin archivos") +
    ((R.arch || []).length ? `<br><button type="button" class="btn sm" data-rpverarch>${S.rpVerArch ? "▾" : "▸"} Archivados (${R.arch.length})</button>` + (S.rpVerArch ? "<br>" + R.arch.map(r => fila(r, true)).join("<br>") : "") : "");
  const avisos = [];
  for (const r of R.sucs) if (r.sinCod.length) avisos.push(`${rpNomSuc(r)}: ${r.sinCod.length} producto${r.sinCod.length === 1 ? "" : "s"} del reporte sin código: ${r.sinCod.map(x => x.n).join(", ")}.`);
  msg("rpMsg", avisos.join(" "), false);
  if (!R.sucs.length) { $("rpRes").innerHTML = ""; $("rpLista").hidden = true; pintarRpCmp(); return; }
  rpCalcular(); pintarRpCmp();
  $("rpRes").innerHTML = R.sucs.map(r => { const l = R.res.filter(p => p.r === r);
    return `<button type="button" class="card ent-card${R.suc === r.archivo ? " act" : ""}" data-rpsuc="${esc(r.archivo)}"><b>${esc(rpNomSuc(r))}</b>
      <small>Entregar <b>${nf(l.length)}</b> productos · ${nf(l.reduce((a, p) => a + p.q, 0))} unidades</small></button>`; }).join("");
  $("rpLista").hidden = false;
  $("rpSuc").innerHTML = `<option value="">Todas</option>` + R.sucs.map(r => `<option value="${esc(r.archivo)}">${esc(rpNomSuc(r))}</option>`).join(""); $("rpSuc").value = R.suc;
  const filas = rpFilas(), uno = R.suc || R.sucs.length === 1, det = R.det, n2 = v => nf(Math.round(v * 100) / 100);
  $("rpTit").textContent = `Lo que se va a entregar · ${nf(filas.length)} productos`;
  $("rpTabla").innerHTML = `<thead><tr>${uno ? "" : "<th>Sucursal</th>"}<th>Código</th><th>Medicamento</th><th>Laboratorio</th><th class="der">Cantidad</th>${det ? `<th class="der">Vendió</th><th class="der">Stock</th>` : ""}</tr></thead><tbody>` +
    (filas.length ? filas.slice(0, 2000).map(p => `<tr>${uno ? "" : `<td><b>${esc(rpNomSuc(p.r))}</b></td>`}<td><code>${esc(p.it.c)}</code></td><td><b>${esc(p.it.n)}</b></td><td>${esc(p.it.lab)}</td><td class="der"><b>${nf(p.q)}</b>${p.el ? ` <small class="muted" title="cantidad elegida en «Comparar con mi Excel» (${p.el.de === "rep" ? "del reporte" : p.el.de === "man" ? "escrita a mano" : "de su Excel"})">✎</small>` : ""}</td>
      ${det ? `<td class="der">${n2(p.venta)}</td><td class="der">${n2(p.stock)}</td>` : ""}</tr>`).join("")
      : `<tr class="vacia"><td colspan="7">Nada con estos filtros.</td></tr>`) + "</tbody>";
}
function rpFilas() {
  const R = S.rp, q = norm(R.q || "").trim();
  return (R.res || []).filter(p => (!R.suc || p.r.archivo === R.suc) && (!q || norm(`${p.it.c} ${p.it.n} ${p.it.lab}`).includes(q)))
    .sort((a, b) => rpNomSuc(a.r).localeCompare(rpNomSuc(b.r)) || a.it.lab.localeCompare(b.it.lab) || a.it.n.localeCompare(b.it.n));
}
// GUARDADO: cada reporte de sucursal (y su Excel para comparar) se guarda en proy_config/rp_… y se lee en vivo
const rpISO = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";
const rpId = r => r.id || r.k || "rp_" + norm(r.suc || r.est || r.archivo).replace(/[^A-Z0-9]+/g, "_");
const rpEmpacar = r => ({ tipo: "rp", k: r.k || "", archivado: !!r.archivado, archivo: r.archivo, est: r.est, suc: r.suc, desde: rpISO(r.desde), hasta: rpISO(r.hasta), dias: r.dias || 0,
  items: JSON.stringify(r.items.map(it => [it.c, it.n, it.lab, it.sig, it.se, it.sf, it.ce, it.cf, it.pvf, Math.round(it.par * 1000) / 1000, it.fr || 0])), sinCod: JSON.stringify(r.sinCod.map(it => it.n)),
  subido: new Date().toISOString(), porNombre: S.perfil?.nombre || S.perfil?.usuario || "" });
const rpDesempacar = d => { const f = t => t ? new Date(t + "T12:00:00") : null;
  return { k: d.k || "", archivado: !!d.archivado, archivo: d.archivo, est: d.est, suc: d.suc, desde: f(d.desde), hasta: f(d.hasta), dias: d.dias, subido: d.subido, porNombre: d.porNombre,
    items: JSON.parse(d.items || "[]").map(([c, n, lab, sig, se, sf, ce, cf, pvf, par, fr]) => ({ c, n, lab, sig, se, sf, ce, cf, pvf, par, ...(fr ? { fr } : {}) })), sinCod: JSON.parse(d.sinCod || "[]").map(n => ({ n })) }; };
function escucharRp() {
  if (S.rpSub) return; S.rpSub = true;
  S.subs.push(onSnapshot(query(collection(db, "proy_config"), where("tipo", "in", ["rp", "rpcmp", "rpel"])), sn => {
    const todos = sn.docs.filter(d => d.data().tipo === "rp").map(d => ({ ...rpDesempacar(d.data()), id: d.id })).sort((a, b) => rpNomSuc0(a).localeCompare(rpNomSuc0(b)) || (a.desde || 0) - (b.desde || 0));
    S.rp.sucs = todos.filter(r => !r.archivado); S.rp.arch = todos.filter(r => r.archivado);
    S.rpCmps = new Map(sn.docs.filter(d => d.data().tipo === "rpcmp").map(d => { const c = d.data();
      return [c.sk || c.suc || "", { id: d.id, subido: c.subido || "", archivo: c.archivo, suc: c.suc, items: new Map(JSON.parse(c.items || "[]").map(([cod, n, l, q]) => [cod, { c: cod, n, l, q }])) }]; }));
    const el = sn.docs.find(d => d.data().tipo === "rpel")?.data(); try { S.rpEleg = new Map(el ? JSON.parse(el.datos || "[]") : []); } catch { S.rpEleg = new Map(); }
    if (S.vista === "vRep") pintarRep();
  }, e => { S.rpSub = false; msg("rpMsg", "No se pudieron leer los reportes guardados: " + textoError(e), true); }));
  S.subs.push(() => { S.rpSub = false; });
}
// período del reporte: el TXT no trae fechas, se preguntan (con lo que dice el nombre del archivo ya puesto)
function pedirFechasRp(r) {
  return new Promise(ok => {
    const dl = $("rpFeDlg"), iso = d => d ? rpISO(d) : "";
    $("rpFeTxt").innerHTML = `<b>${esc(rpNomSuc(r))}</b> · ${esc(r.archivo.replace(/^[0-9a-f]{8}-/, ""))} · ${nf(r.items.length)} productos. Ponga el período que filtró en el sistema (se usa para la venta por día y «Le dura»).`;
    $("rpFeD").value = iso(r.desde); $("rpFeH").value = iso(r.hasta); msg("rpFeMsg", "");
    const dias = () => { const d = $("rpFeD").value, h = $("rpFeH").value; $("rpFeDias").textContent = d && h && h >= d ? `${nf(Math.round((new Date(h) - new Date(d)) / 864e5) + 1)} días` : ""; };
    dias(); $("rpFeD").oninput = $("rpFeH").oninput = dias;
    let listo = false;
    $("rpFeOk").onclick = () => { const d = $("rpFeD").value, h = $("rpFeH").value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{4}-\d{2}-\d{2}$/.test(h) || h < d) return msg("rpFeMsg", "Ponga las dos fechas (la final no puede ser antes que la inicial).", true);
      listo = true; dl.close(); const de = new Date(d + "T12:00:00"), ha = new Date(h + "T12:00:00"); ok({ desde: de, hasta: ha, dias: Math.round((ha - de) / 864e5) + 1 }); };
    dl.onclose = () => { if (!listo) ok(null); };
    dl.onclick = e => { if (e.target.closest("[data-cerrar-dlg]") || e.target === dl) dl.close(); };
    dl.showModal();
  });
}
async function rpCargar(files) {
  msg("rpMsg", "Leyendo…");
  for (const a of files) {
    try { const r = await rpLeerArchivo(a);
      if (/\.txt$/i.test(a.name)) { const f = await pedirFechasRp(r); if (!f) { msg("rpMsg", `«${a.name}»: no se subió (faltan las fechas).`, true); continue; } Object.assign(r, f); }
      // cada reporte es un trabajo aparte: NO reemplaza al anterior de la misma sucursal (solo si es el mismo archivo otra vez)
      const mismo = [...S.rp.sucs, ...(S.rp.arch || [])].find(x => x.k && x.archivo === r.archivo && x.suc === r.suc);
      r.k = mismo?.k || "rp_" + norm(r.suc || r.est || r.archivo).replace(/[^A-Z0-9]+/g, "_") + "_" + Date.now().toString(36); r.id = r.k;
      S.rp.sucs = S.rp.sucs.filter(x => x.id !== r.id); S.rp.sucs.push(r);
      if (!S.prev) await setDoc(doc(db, "proy_config", r.id), rpEmpacar(r));
      // ¿es el reporte anterior de esta sucursal? se le devuelven sus decisiones y su Excel (los que se separaron)
      const pa = "ANT:" + (r.suc || r.est || r.archivo) + "|", ant = [...S.rpEleg].filter(([k]) => k.startsWith(pa)), exA = S.rpCmps.get("ANT:" + (r.suc || r.est || r.archivo));
      if ((ant.length || exA) && confirm(`¿Este es el reporte ANTERIOR de ${rpNomSuc0(r)}? Se le devuelven ${ant.length} decisiones${exA ? " y su Excel (" + exA.archivo + ")" : ""} que se habían separado.`)) {
        for (const [k, v] of ant) { S.rpEleg.delete(k); S.rpEleg.set(r.k + "|" + k.slice(pa.length), v); }
        if (!S.prev) { await setDoc(doc(db, "proy_config", "rp_elegido"), { tipo: "rpel", datos: JSON.stringify([...S.rpEleg]) });
          if (exA?.id) await setDoc(doc(db, "proy_config", exA.id), { sk: r.k }, { merge: true }); } }
    } catch (e) { msg("rpMsg", `«${a.name}»: ${e.message || e}`, true); return; }
  }
  pintarRep(); toast("Reporte guardado");
}
// corregir las fechas de un reporte ya guardado
$("rpSucsTxt").addEventListener("click", async e => { const b = e.target.closest("[data-rpfe]"); if (!b) return; e.preventDefault(); e.stopPropagation();
  const r = S.rp.sucs.find(x => (x.id || x.archivo) === b.dataset.rpfe); if (!r) return; const f = await pedirFechasRp(r); if (!f) return;
  Object.assign(r, f); pintarRep();
  if (!S.prev) try { await setDoc(doc(db, "proy_config", r.id || rpId(r)), { desde: rpISO(f.desde), hasta: rpISO(f.hasta), dias: f.dias }, { merge: true }); toast("Fechas guardadas"); } catch (x) { avisar(x); } });
// archivar (terminado: sale de la lista, no se borra) / volver a trabajar; ver los archivados; separar lo del reporte anterior
$("rpSucsTxt").addEventListener("click", async e => {
  if (e.target.closest("[data-rpverarch]")) { e.preventDefault(); e.stopPropagation(); S.rpVerArch = !S.rpVerArch; pintarRep(); return; }
  // ELIMINAR TODO de una sucursal en este módulo: sus reportes (activos y archivados), su Excel y sus decisiones (también las separadas)
  const bo = e.target.closest("[data-rpborrar]");
  if (bo) { e.preventDefault(); e.stopPropagation();
    const r0 = [...S.rp.sucs, ...(S.rp.arch || [])].find(x => x.id === bo.dataset.rpborrar); if (!r0) return;
    const nom = rpNomSuc0(r0), misma = x => (r0.suc ? x.suc === r0.suc : rpNomSuc0(x) === nom), reps = [...S.rp.sucs, ...(S.rp.arch || [])].filter(misma);
    const bases = new Set(); for (const x of reps) { bases.add(x.k || ""); bases.add(x.suc || x.est || x.archivo); } bases.delete("");
    const esMia = k => [...bases].some(b => k === b || k === "ANT:" + b), elKeys = [...S.rpEleg.keys()].filter(k => esMia(k.slice(0, k.lastIndexOf("|"))));
    const exs = [...S.rpCmps].filter(([k]) => esMia(k));
    if (!confirm(`¿Eliminar TODO lo de ${nom} en este módulo?\n· ${reps.length} reporte(s)\n· ${exs.length} Excel de comparación\n· ${elKeys.length} decisiones\nNo se puede deshacer. Después puede volver a subir el reporte de ${nom} desde cero.`)) return;
    if (S.prev) return toast("En vista previa no se borra nada.");
    try {
      for (const x of reps) await deleteDoc(doc(db, "proy_config", x.id || rpId(x)));
      for (const [, x] of exs) if (x.id) await deleteDoc(doc(db, "proy_config", x.id));
      for (const k of elKeys) S.rpEleg.delete(k);
      await setDoc(doc(db, "proy_config", "rp_elegido"), { tipo: "rpel", datos: JSON.stringify([...S.rpEleg]) });
      S.rp.sucs = S.rp.sucs.filter(x => !misma(x)); S.rp.arch = (S.rp.arch || []).filter(x => !misma(x)); for (const [k] of exs) S.rpCmps.delete(k);
      if (reps.some(x => x.archivo === S.rpCmpSuc)) S.rpCmpSuc = ""; if (reps.some(x => x.archivo === S.rp.suc)) S.rp.suc = "";
      pintarRep(); toast(`Se eliminó todo lo de ${nom}. Ya puede subir su reporte de nuevo.`);
    } catch (x) { avisar(x); }
    return; }
  const a = e.target.closest("[data-rparch]"), sp = e.target.closest("[data-rpsep]"); if (!a && !sp) return; e.preventDefault(); e.stopPropagation();
  if (a) { const v = a.dataset.v === "1", r = [...S.rp.sucs, ...(S.rp.arch || [])].find(x => x.id === a.dataset.rparch); if (!r) return;
    if (v && !confirm(`¿Archivar el reporte de ${rpNomSuc(r)} (${r.desde?.toLocaleDateString("es-PE") || "?"} al ${r.hasta?.toLocaleDateString("es-PE") || "?"})? Sale de la lista y de lo que se va a entregar, pero queda guardado con sus decisiones y su Excel.`)) return;
    const todos = [...S.rp.sucs, ...(S.rp.arch || [])]; r.archivado = v; S.rp.sucs = todos.filter(x => !x.archivado); S.rp.arch = todos.filter(x => x.archivado);
    if (S.rpCmpSuc === r.archivo) S.rpCmpSuc = ""; pintarRep();
    if (!S.prev) try { await setDoc(doc(db, "proy_config", r.id), { archivado: v }, { merge: true }); toast(v ? "Reporte archivado" : "Reporte activo otra vez"); } catch (x) { avisar(x); }
    return; }
  const r = S.rp.sucs.find(x => x.id === sp.dataset.rpsep); if (!r) return; const t0 = Date.parse(r.subido), pre = rpElKey(r, ""), base = rpSk(r);
  const l = [...S.rpEleg].filter(([k, el]) => k.startsWith(pre) && el.fecha && Date.parse(el.fecha) < t0), e2 = S.rpCmps.get(base), exOld = e2?.subido && Date.parse(e2.subido) < t0;
  if (!confirm(`Estas ${l.length} decisiones${exOld ? " y su Excel (" + e2.archivo + ")" : ""} son de ANTES de subir este reporte de ${rpNomSuc(r)}: eran del reporte anterior. ¿Separarlas? Este reporte queda limpio para trabajar de nuevo; lo anterior NO se borra: si vuelve a subir el reporte anterior, se le devuelve.`)) return;
  for (const [k, v] of l) { S.rpEleg.delete(k); S.rpEleg.set("ANT:" + k, v); }
  if (exOld) { S.rpCmps.delete(base); S.rpCmps.set("ANT:" + base, e2); }
  pintarRep();
  if (!S.prev) try { await setDoc(doc(db, "proy_config", "rp_elegido"), { tipo: "rpel", datos: JSON.stringify([...S.rpEleg]) }); if (exOld && e2.id) await setDoc(doc(db, "proy_config", e2.id), { sk: "ANT:" + base }, { merge: true }); toast("Separado: este reporte quedó limpio"); } catch (x) { avisar(x); }
});
$("rpSucs").addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) rpCargar(f); });
$("rpLimpiar").addEventListener("click", async () => {
  if (!S.rp.sucs.length && !S.rpCmps.size) return; if (!confirm("¿Quitar los reportes guardados y su Excel de comparación?")) return;
  try { for (const r of [...S.rp.sucs, ...(S.rp.arch || [])]) await deleteDoc(doc(db, "proy_config", r.id || rpId(r))); for (const e of S.rpCmps.values()) if (e.id) await deleteDoc(doc(db, "proy_config", e.id)); } catch (x) { avisar(x); }
  S.rp = { sucs: [], suc: "", q: "", det: false }; S.rpCmps = new Map(); pintarRep(); });
$("rpSuc").addEventListener("change", e => { S.rp.suc = e.target.value; pintarRep(); });
$("rpQ").addEventListener("input", e => { S.rp.q = e.target.value; pintarRep(); });
$("rpDet").addEventListener("change", e => { S.rp.det = e.target.checked; pintarRep(); });
$("rpRes").addEventListener("click", e => { const b = e.target.closest("[data-rpsuc]"); if (!b) return;
  // al elegir una sucursal: su lista de entrega y su comparación
  S.rp.suc = S.rp.suc === b.dataset.rpsuc ? "" : b.dataset.rpsuc; if (S.rp.suc) { S.rpCmpSuc = S.rp.suc; S.rpCmpVer = ""; } pintarRep(); });
$("rpXls").addEventListener("click", () => {
  const R = S.rp, filas = rpFilas(); if (!filas.length) return toast("No hay nada para descargar.");
  const uno = R.suc || R.sucs.length === 1;
  const datos = filas.map(p => ({ ...(uno ? {} : { Sucursal: rpNomSuc(p.r) }), "Código": p.it.c, Medicamento: p.it.n, Laboratorio: p.it.lab, Cantidad: p.q,
    ...(R.det ? { [`Vendió (${p.dias} días)`]: Math.round(p.venta * 100) / 100, Stock: Math.round(p.stock * 100) / 100 } : {}) }));
  excelDe(datos, "Entregar", `entregar_${(uno ? rpNomSuc(filas[0].r) : "sucursales").toLowerCase().replace(/\W+/g, "_")}`);
});

// ---- comparar con el Excel del usuario: lo que está en los dos (igual o con otra cantidad), lo que falta en uno u otro ----
S.rpCmps = new Map(); S.rpCmpVer = ""; S.rpCmpSuc = "";
// cada sucursal se compara con SU Excel (se guarda uno por sucursal: proy_config/rpcmp_…)
const rpSk = r => r?.k || r?.suc || r?.est || r?.archivo || "";
const rpCmpR = () => S.rp.sucs.find(x => x.archivo === S.rpCmpSuc) || S.rp.sucs[0];
const rpCmpDe = r => S.rpCmps.get(rpSk(r)) || null;
// cantidad elegida (reporte o su Excel) para los de «Cantidad distinta»: rp_elegido = { «sucursal|código»: { q, de } }
S.rpEleg = new Map();
const rpElKey = (r, c) => (r.k || r.suc || r.est || r.archivo) + "|" + c;
// reportes de antes (guardados por sucursal): decisiones y Excel de ANTES de subir el reporte actual = eran del reporte anterior
const rpAntDe = r => { if (r.k || !r.subido) return 0; const t0 = Date.parse(r.subido), pre = rpElKey(r, ""); let n = 0;
  for (const [k, el] of S.rpEleg || []) if (k.startsWith(pre) && el.fecha && Date.parse(el.fecha) < t0) n++;
  const e = S.rpCmps.get(rpSk(r)); if (e?.subido && Date.parse(e.subido) < t0) n = n || 1; return n; };
// ELIMINAR EN BLOQUE (lo que se está viendo): los que les dura más de N días, o los que droguería tiene en 0
async function rpEliminarBloque(cond, txt) {
  const r = rpCmpR(); if (!r) return;
  const dias = r.dias || 0, l = rpComparar().filter(x => (!S.rpCmpVer || x.res === S.rpCmpVer) && rpPasaClas(x) && x.res !== "del" && cond(x, dias));
  if (!l.length) return toast("No hay productos que cumplan eso en lo que está viendo.");
  if (!confirm(`¿Eliminar ${l.length} producto${l.length === 1 ? "" : "s"} (${txt})? Pasan a «Eliminados» y no se entregan. Se puede deshacer.`)) return;
  const por = S.perfil?.nombre || S.perfil?.usuario || "", fecha = new Date().toISOString(), antes = [];
  for (const x of l) { const k = rpElKey(r, x.c); antes.push([k, S.rpEleg.get(k) || null]); S.rpEleg.set(k, { q: 0, de: "del", n: x.n, l: x.l, por, fecha, bloque: txt }); }
  S.rpBlUlt = antes; pintarRep(); toast(`${l.length} productos eliminados (${txt})`);
  if (!S.prev) try { await setDoc(doc(db, "proy_config", "rp_elegido"), { tipo: "rpel", datos: JSON.stringify([...S.rpEleg]) }); } catch (x) { avisar(x); }
}
$("rpBlDura").addEventListener("click", () => { const n = Math.max(1, Math.round(+$("rpBlDias").value || 0));
  rpEliminarBloque((x, d) => { const ld = rpDiasDura(x, d); return ld != null ? ld > n : (x.stock || 0) > 0 && !(x.venta > 0); }, `le dura más de ${n} días`); });
$("rpBlDrog").addEventListener("click", () => { if (!S.drogStk) return toast("Todavía se está leyendo el stock de droguería; intente en unos segundos.");
  rpEliminarBloque(x => !((S.drogStk[x.c]?.[0] || 0) > 0), "droguería en 0"); });
$("rpBlDesh").addEventListener("click", async () => { const a = S.rpBlUlt; if (!a) return;
  for (const [k, v] of a) v ? S.rpEleg.set(k, v) : S.rpEleg.delete(k); S.rpBlUlt = null; pintarRep(); toast("Se deshizo el último bloque");
  if (!S.prev) try { await setDoc(doc(db, "proy_config", "rp_elegido"), { tipo: "rpel", datos: JSON.stringify([...S.rpEleg]) }); } catch (x) { avisar(x); } });
async function rpElegir(c, q, de, info) {
  const r = S.rp.sucs.find(x => x.archivo === S.rpCmpSuc) || S.rp.sucs[0]; if (!r) return;
  let e = info || rpCmpDe(r)?.items.get(c);
  if (!e) { const pc = prodCat(c), u = (S.ped?.datos || []).find(d => d.cod === c); if (pc || u) e = { n: pc?.n || u?.nom || "", l: pc?.ln || u?.lab || "" }; }
  const k = rpElKey(r, c); if (de) S.rpEleg.set(k, { q, de, ...(e ? { n: e.n, l: e.l } : {}), por: S.perfil?.nombre || S.perfil?.usuario || "", fecha: new Date().toISOString() }); else S.rpEleg.delete(k);
  pintarRep();
  if (!S.prev) try { await setDoc(doc(db, "proy_config", "rp_elegido"), { tipo: "rpel", datos: JSON.stringify([...S.rpEleg]) }); } catch (x) { avisar(x); }
}
const RP_RES = { urg: ["Urgencias que no están en la lista (con stock en droguería)", "amb", "Urgencia"], man: ["Añadidos a mano", "azul", "Añadido"], ok: ["Igual", "verde", "Igual"], dif: ["Cantidad distinta", "amb", "Cantidad distinta"], rep: ["Solo en el reporte (no está en su Excel)", "rojo", "Falta en su Excel"], exc: ["Solo en su Excel (no sale del reporte)", "rojo", "Solo en su Excel"], del: ["Eliminados (no se entregan)", "gris", "Eliminado"], pen: ["Pendientes (por decidir; no se entregan aún)", "azul", "Pendiente"] };
async function rpLeerMiExcel(a) {
  XLSX ??= await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(await a.arrayBuffer()), filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false });
  const iCab = filas.findIndex(f => f.some(v => /^C[OÓ]DIGO$/i.test(String(v).trim()))); if (iCab < 0) throw new Error("no tiene la columna «Código»");
  const cab = filas[iCab].map(v => norm(String(v)).trim()), col = re => cab.findIndex(h => re.test(h));
  const iC = col(/^CODIGO$/), iN = col(/MEDICAMENTO|PRODUCTO|DESCRIPCION/), iL = col(/^LABORATORIO$/), iQ = col(/SE ATENDERA|CANTIDAD|ENTREGAR|ATENDER|ENVIAR|PEDIR/);
  if (iQ < 0) throw new Error("no tiene la columna «Se atenderá» o «Cantidad»");
  const m = new Map();
  for (const f of filas.slice(iCab + 1)) { let c = String(f[iC] ?? "").trim().replace(/\.0$/, ""); if (!/^\d+$/.test(c)) continue; c = c.padStart(5, "0");
    const q = +String(f[iQ] ?? "").replace(",", ".") || 0, x = m.get(c);
    m.set(c, { c, n: iN >= 0 ? String(f[iN]).trim() : "", l: iL >= 0 ? String(f[iL]).trim() : "", q: (x?.q || 0) + q }); }
  return { archivo: a.name, items: m, suc: sucDeNombre(a.name) };
}
// lo que sale del reporte (vendió − stock) sin elecciones: base de la comparación
function rpBase(r) { const frDe = rpFracc([r]), out = [];
  for (const it of r.items) { const fr = frDe(it.c, it.n), venta = it.ce + (fr ? it.cf / fr : 0), stock = it.se + (fr ? it.sf / fr : 0), q = redPed(venta - stock);
    if (q > 0) out.push({ it, qRep: q, venta, stock }); }
  return out; }
// para cuántos días le alcanza el stock actual: stock ÷ venta diaria (lo vendido ÷ días del reporte)
const rpDiasDura = (x, dias) => x.venta > 0 && dias > 0 ? Math.round((x.stock || 0) / (x.venta / dias)) : null;
// una elección con cantidad 0 cuenta como eliminada (no se entrega): así «Igual» = lo que se entrega
const rpTipoEl = el => el.de === "pen" ? "pen" : el.de === "del" || !(el.q > 0) ? "del" : "ok";
function rpComparar() {
  const R = S.rp, r = rpCmpR(); if (!r) return []; const E = rpCmpDe(r); if (!E) return [];
  const calc = new Map(rpBase(r).map(p => [p.it.c, p])), rep = new Map(r.items.map(it => [it.c, it])), frDe = rpFracc([r]);
  const out = [];
  for (const [c, p] of calc) { const e = E.items.get(c), qe = e ? e.q : null;
    const el = S.rpEleg?.get(rpElKey(r, c)), base = qe == null || qe === 0 ? "rep" : qe === p.qRep ? "ok" : "dif", usa = !!el;
    out.push({ c, n: p.it.n, l: p.it.lab, qr: p.qRep, qe, venta: p.venta, stock: p.stock, base, res: usa ? rpTipoEl(el) : base, el: usa ? el : null }); }
  for (const [c, e] of E.items) { if (calc.has(c) || !(e.q > 0)) continue; const it = rep.get(c), fr = it ? frDe(it.c, it.n) : null, el = S.rpEleg?.get(rpElKey(r, c));
    // si no está en el reporte (no vendió en esos días): vendió 0 y su stock es el del kardex (el mismo que en el módulo de la sucursal)
    const stK = !it && r.suc ? S.karStock?.[c]?.[r.suc]?.[0] : null;
    out.push({ c, n: e.n || it?.n || "", l: e.l || it?.lab || "", qr: 0, qe: e.q, venta: it ? it.ce + (fr ? it.cf / fr : 0) : 0, stock: it ? it.se + (fr ? it.sf / fr : 0) : stK != null ? +stK : 0,
      base: "exc", res: el ? rpTipoEl(el) : "exc", el: el || null,
      por: !it ? "no vendió en los días del reporte" : "su stock alcanza para lo que vendió" }); }
  // URGENCIAS de esta sucursal (los días del criterio de Atención) que no están ni en el reporte ni en su Excel y que droguería tiene en stock: para poder añadirlas
  const ya = new Set(out.map(x => x.c)), sucU = r.suc;
  if (sucU) { const desde = Date.now() - (S.rpUrgDias || 14) * 864e5, U = new Map();
    for (const d of S.ped?.datos || []) { if (d.suc !== sucU || !d.cod || !d.f || +d.f < desde || ya.has(d.cod)) continue;
      const u = U.get(d.cod); if (!u) U.set(d.cod, { d, n: 1 }); else { u.n++; if (d.f > u.d.f) u.d = d; } }
    for (const [c, { d, n }] of U) { const el = S.rpEleg?.get(rpElKey(r, c)), sd = S.drogStk ? +(S.drogStk[c]?.[0] || 0) : 0;
      if (!el && !(sd > 0)) continue;
      const stK = S.karStock?.[c]?.[sucU]?.[0];
      out.push({ c, n: d.nom || el?.n || "", l: d.lab || el?.l || "", qr: 0, qe: null, qu: Math.max(1, Math.round(d.q || 1)), venta: 0, stock: stK != null ? +stK : 0,
        base: "urg", res: el ? rpTipoEl(el) : "urg", el: el || null, por: `urgencia del ${d.f.toLocaleDateString("es-PE")}${d.q ? " · pidió " + nf(d.q) : ""}${n > 1 ? ` (${n} pedidos)` : ""}` });
      ya.add(c); } }
  // AÑADIDOS A MANO (productos que no salen del reporte, ni de su Excel, ni de urgencias)
  { const pre = rpElKey(r, "");
    for (const [k, el] of S.rpEleg || []) { if (!k.startsWith(pre)) continue; const c = k.slice(pre.length); if (ya.has(c) || rep.has(c)) continue;
      const stK = r.suc ? S.karStock?.[c]?.[r.suc]?.[0] : null;
      out.push({ c, n: el.n || prodCat(c)?.n || "", l: el.l || prodCat(c)?.ln || "", qr: 0, qe: null, venta: 0, stock: stK != null ? +stK : 0, base: "man", res: rpTipoEl(el) === "ok" ? "man" : rpTipoEl(el), el, por: "añadido a mano" }); ya.add(c); } }
  // PENDIENTES: el stock es el de HOY (último kardex), no el del reporte; las demás partes quedan como se cargó el reporte
  for (const x of out) if (x.res === "pen" && r.suc) { const v = S.karStock?.[x.c]?.[r.suc]?.[0];
    if (v != null || S.karStock) { x.stockRep = x.stock; x.stock = +(v || 0); x.stkHoy = true; } }
  return out.sort((a, b) => a.l.localeCompare(b.l) || a.n.localeCompare(b.n));
}
// NOTAS de cada producto (en vivo, las mismas que en el Kardex y el módulo de cada sucursal): comunicado de droguería,
// comentario de la sucursal, atención bloqueada, bloqueo en la sucursal o general, reemplazo
const RESP_TXT_RP = { si_requiere: "Sí se requiere", no_requiere: "No se requiere en esta sucursal", no_se_mueve: "No se mueve", otro_medicamento: "Existe otro producto en su cambio", otros: "Otro" };
function escucharRpNotas() {
  if (S.rpNotSub) return; S.rpNotSub = true; S.rpN = { gest: new Map(), resp: new Map(), bat: new Map(), reemp: new Map() };
  const vivo = (col, k) => S.subs.push(onSnapshot(collection(db, col), sn => { S.rpN[k] = new Map(sn.docs.map(d => [d.id, d.data()])); if (S.vista === "vRep") pintarRpCmp(); }, () => {}));
  vivo("gestion", "gest"); vivo("atencion_resp", "resp"); vivo("bloq_aten", "bat"); vivo("reemplazos", "reemp");
  // pedidos de urgencia (los mismos que usa el módulo de cada sucursal) y los días que se consideran (criterio de Atención)
  S.subs.push(onSnapshot(doc(db, "proy_config", "atencion_cfg"), d => { S.rpUrgDias = +d.data()?.def?.urgDias || 14; S.rpCfgProd = d.data()?.prod || {}; if (S.vista === "vRep") pintarRpCmp(); }, () => {}));
  cargarPedidos().then(() => { if (S.vista === "vRep") pintarRpCmp(); }).catch(() => {});
  window.cargarClasificacion?.().then(c => { S.rpClas = c; if (S.vista === "vRep") pintarRpCmp(); }).catch(() => {});
  S.subs.push(() => { S.rpNotSub = false; });
}
const quienFecha = d => { const f = d?.fecha?.toDate ? d.fecha.toDate() : d?.fecha ? new Date(d.fecha) : null;
  return [d?.porNombre || "", f && !isNaN(f) ? f.toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""].filter(Boolean).join(" · "); };
function rpNotas(suc, c) {
  const N = S.rpN || {}, l = [];
  const g = N.gest?.get(c); if (g) l.push({ t: "📢 " + (g.nota || "Comunicado de droguería"), q: quienFecha(g), k: "gest" });
  const r = suc && N.resp?.get(suc + "__" + c);
  if (r) { const alt = r.alternativa || (r.altCod ? String(r.altCod) : ""); l.push({ t: "💬 " + (RESP_TXT_RP[r.estado] || r.estado) + (alt ? ": " + alt : "") + (r.comentario ? (alt ? " · " : ": ") + r.comentario : ""), q: quienFecha(r), k: "resp" }); }
  const b = N.bat?.get(c); if (b) l.push({ t: "🚫 Atención bloqueada" + (b.motivo ? ": " + b.motivo : ""), q: quienFecha(b), k: "bat" });
  for (const id of [suc + "__" + c, "TODAS__" + c, "DROGUERIA FS__" + c]) { const x = S.bloqueos?.get(id); if (x?.estado === "bloqueado") l.push({ t: "⛔ Bloqueado" + (id.startsWith("TODAS") ? " en todas" : id.startsWith("DROG") ? " en droguería" : " en la sucursal") + (x.motivo ? ": " + x.motivo : ""), q: "", k: "bloq" }); }
  // cantidad fija que puso Abastecimiento en el Kardex (✋) para esa sucursal
  const cf = suc && S.rpCfgProd?.[suc]?.[c];
  if (cf?.q != null) l.push({ t: `✋ Cantidad fija (Kardex): ${nf(cf.q)}`, q: cf.fecha ? "desde " + String(cf.fecha).slice(0, 10).split("-").reverse().join("/") : "", k: "fija" });
  // urgencia de esa sucursal en los últimos días (como en el módulo de la sucursal)
  const desde = Date.now() - (S.rpUrgDias || 14) * 864e5;
  const urg = (S.ped?.datos || []).filter(d => d.suc === suc && d.cod === c && d.f && +d.f >= desde).sort((a, b) => b.f - a.f);
  if (urg.length) l.push({ t: `⚡ Urgencia del ${urg[0].f.toLocaleDateString("es-PE")}${urg[0].q ? " · pidió " + nf(urg[0].q) : ""}${urg.length > 1 ? ` (${urg.length} pedidos)` : ""}`, q: urg[0].quien || "", k: "urg" });
  const rv = N.reemp?.get(c); if (rv) l.push({ t: "🔁 Reemplazado por " + rv.nuevo + (rv.nNuevo ? " – " + rv.nNuevo : ""), q: "", k: "kr" });
  for (const [v, x] of N.reemp || []) if (x.nuevo === c) l.push({ t: "🔁 Reemplaza a " + v + (x.nViejo ? " – " + x.nViejo : ""), q: "", k: "kr" });
  return l;
}
// línea y familia de cada producto (la misma clasificación del Kardex), para filtrar la comparación
S.rpLin = ""; S.rpFam = "";
const nomNrp = t => String(t || "").trim().toUpperCase().replace(/\s+/g, " ");
function rpClasDe(n) { const C = S.rpClas; if (!C?.p) return { t: "", f: "" }; const a = C.p[nomNrp(n)] || [-1, -1, -1]; return { t: C.t[a[0]] || "", f: C.f[a[2]] || "" }; }
const rpPasaClas = x => { if (S.rpConNotas && !rpNotas(rpCmpR()?.suc || "", x.c).length) return false;   // «solo con notas y comentarios»
  if (!S.rpLin && !S.rpFam) return true; const k = rpClasDe(x.n); return (!S.rpLin || k.t === S.rpLin) && (!S.rpFam || k.f === S.rpFam); };
// lo que se va a entregar de cada fila: la elegida; si son iguales o solo sale del reporte, la del reporte; solo en su Excel: 0
const rpAt = x => x.el ? x.el.q : x.res === "dif" || x.res === "urg" ? null : x.res === "exc" ? 0 : x.qr;
const rpDeTxt = de => ({ rep: "del reporte", exc: "de su Excel", man: "escrita a mano", add: "añadido", del: "eliminado", pen: "pendiente" })[de] || "";
function pintarRpCmp() {
  const R = S.rp, box = $("rpCmpBox"); box.hidden = !R.sucs.length; if (!R.sucs.length) return;
  if (!S.rpCmpSuc || !R.sucs.some(x => x.archivo === S.rpCmpSuc)) S.rpCmpSuc = R.sucs[0].archivo;
  $("rpCmpSuc").innerHTML = R.sucs.map(r => `<option value="${esc(r.archivo)}">${esc(rpNomSuc(r))}</option>`).join(""); $("rpCmpSuc").value = S.rpCmpSuc;
  const E = rpCmpDe(rpCmpR());
  if (!E) $("rpBloque").hidden = true;
  if (!E) { $("rpCmpTxt").innerHTML = `Todavía no subió su Excel de <b>${esc(rpNomSuc(rpCmpR()))}</b>. Súbalo para compararlo (cada sucursal se compara con su propio Excel y queda guardado).`; $("rpCmpRes").innerHTML = ""; $("rpCmpTabla").innerHTML = ""; return; }
  // stock de droguería (solo para ver; del último kardex del sistema)
  if (!S.drogStk) cargarDrogStk().then(() => { if (S.vista === "vRep") pintarRpCmp(); });
  const sdV = c => S.drogStk ? +(S.drogStk[c]?.[0] || 0) : null, sdTxt = c => { const v = sdV(c); return v == null ? "…" : v > 0 ? `<b>${nf(Math.round(v * 100) / 100)}</b>` : '<span class="rojo-t">0</span>'; };
  escucharRpNotas(); const sucCmp = (R.sucs.find(x => x.archivo === S.rpCmpSuc) || {}).suc || "";
  const todos = rpComparar();
  // filtros de línea y familia (opciones: las de los productos de esta comparación)
  const opc = (k, sel, act) => { const v = [...new Set(todos.map(x => rpClasDe(x.n)[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    $(sel).innerHTML = `<option value="">Todas</option>` + v.map(o => `<option ${o === act ? "selected" : ""}>${esc(o)}</option>`).join(""); };
  opc("t", "rpLin", S.rpLin); opc("f", "rpFam", S.rpFam);
  const l = todos.filter(rpPasaClas), cuenta = k => l.filter(x => x.res === k).length, n2 = v => v == null ? "–" : nf(Math.round(v * 100) / 100);
  const dias = rpCmpR()?.dias || 0, leDura = x => { const d = rpDiasDura(x, dias); return d == null ? (x.stock > 0 ? '<span class="muted">sin venta</span>' : '<span class="muted">·</span>') : `<span class="${d < 7 ? "rojo-t" : ""}">${nf(d)} d</span>`; };
  $("rpCmpTxt").innerHTML = `Su Excel <b>${esc(E.archivo)}</b> (${nf(E.items.size)} productos) contra lo que sale del reporte de <b>${esc(rpNomSuc(R.sucs.find(x => x.archivo === S.rpCmpSuc)))}</b>.`;
  $("rpCmpRes").innerHTML = ["ok", "dif", "rep", "exc", "urg", "man", "pen", "del"].map(k => `<button type="button" class="card ent-card${S.rpCmpVer === k ? " act" : ""}" data-rpcmpver="${k}"><b>${nf(cuenta(k))}</b><small><span class="chip ${RP_RES[k][1]}">${RP_RES[k][0]}</span></small></button>`).join("");
  $("rpCmpVer").value = S.rpCmpVer;
  $("rpBloque").hidden = false; $("rpBlDesh").hidden = !S.rpBlUlt;
  const v = l.filter(x => !S.rpCmpVer || x.res === S.rpCmpVer);
  $("rpCmpTabla").innerHTML = `<thead><tr><th>Código</th><th>Medicamento</th><th>Laboratorio</th><th class="der">Reporte</th><th class="der">Su Excel</th><th class="der" title="Lo que se va a entregar: si son iguales, esa cantidad; si eligió, la elegida">Atender</th><th class="der">Diferencia</th><th class="der">Vendió</th><th class="der">Stock</th><th class="der" title="Para cuántos días le alcanza el stock que tiene: stock ÷ (lo que vendió ÷ días del reporte)">Le dura</th><th class="der" title="Stock de droguería del último kardex subido">Stock droguería</th><th>Notas y comentarios</th><th>Resultado</th></tr></thead><tbody>` +
    (v.length ? v.map(x => `<tr><td><code>${esc(x.c)}</code></td><td><b>${esc(x.n)}</b></td><td>${esc(x.l)}</td><td class="der"><b>${nf(x.qr)}</b></td><td class="der"><b>${x.qe == null ? "–" : nf(x.qe)}</b></td><td class="der rp-at">${rpAt(x) == null ? '<span class="muted">elegir →</span>' : `<b>${nf(rpAt(x))}</b>`}</td>
      <td class="der ${(x.qe || 0) - x.qr ? "rojo-t" : ""}">${(x.qe || 0) - x.qr > 0 ? "+" : ""}${nf((x.qe || 0) - x.qr)}</td><td class="der">${n2(x.venta)}</td><td class="der">${n2(x.stock)}${x.stkHoy ? `<small class="rp-hoy" title="Stock de hoy (último kardex). En el reporte decía ${n2(x.stockRep)}">hoy${Math.abs((x.stockRep || 0) - x.stock) > 1e-6 ? ` · rep. ${n2(x.stockRep)}` : ""}</small>` : ""}</td><td class="der">${leDura(x)}</td><td class="der">${sdTxt(x.c)}</td><td class="rp-notas">${rpNotas(sucCmp, x.c).map(n => `<div class="rp-nota ${n.k}">${esc(n.t)}${n.q ? ` <small>${esc(n.q)}</small>` : ""}</div>`).join("")}</td>
      <td>${x.res === "dif" || x.res === "rep" || x.res === "exc" || x.res === "urg" ? `${x.res === "dif" ? "" : `<span class="chip ${RP_RES[x.res][1]}">${RP_RES[x.res][2]}</span>${x.por ? `<br><small class="muted">${esc(x.por)}</small>` : ""}`}<div class="rp-eleg">${x.res === "dif"
          ? `<button type="button" class="btn sm" data-rpel="${esc(x.c)}" data-q="${x.qr}" data-de="rep">Reporte: ${nf(x.qr)}</button><button type="button" class="btn sm" data-rpel="${esc(x.c)}" data-q="${x.qe}" data-de="exc">Excel: ${nf(x.qe)}</button><button type="button" class="rp-b del-b" data-rpel="${esc(x.c)}" data-q="0" data-de="del" title="Eliminar (no se entrega)">✕</button>`
          : `<button type="button" class="rp-b ok-b" data-rpel="${esc(x.c)}" data-q="${x.res === "rep" ? x.qr : x.res === "urg" ? x.qu : x.qe}" data-de="add" title="Añadir ${nf(x.res === "rep" ? x.qr : x.res === "urg" ? x.qu : x.qe)}">✔</button><button type="button" class="rp-b del-b" data-rpel="${esc(x.c)}" data-q="0" data-de="del" title="Eliminar (no se entrega)">✕</button>`}<button type="button" class="rp-b pen-b" data-rpel="${esc(x.c)}" data-q="0" data-de="pen" title="Pendiente (decidir después)">/</button><input type="number" min="0" step="1" class="rp-man" data-rpman="${esc(x.c)}" placeholder="Otro" title="Escriba otra cantidad y pulse Enter"></div>`
        : `<span class="chip ${RP_RES[x.res][1]}">${RP_RES[x.res][2]}</span>${x.res === "ok" || x.res === "man" ? ` <button type="button" class="rp-b del-b rp-mini" data-rpel="${esc(x.c)}" data-q="0" data-de="del" title="Cancelar: no se entrega (pasa a Eliminados)">✕</button>` : ""}${x.el ? `<br><small class="muted">${x.el.de === "del" ? "eliminado" : x.el.de === "pen" ? "pendiente" : `elegido: <b>${nf(x.el.q)}</b> (${rpDeTxt(x.el.de)})`} <button type="button" class="ab-x rp-desh" data-rpel="${esc(x.c)}" title="Deshacer (vuelve a como estaba)">↺</button></small>` : ""}${x.por && !x.el ? `<br><small class="muted">${esc(x.por)}</small>` : ""}`}</td></tr>`).join("")
      : `<tr class="vacia"><td colspan="13">Nada en esta parte.</td></tr>`) + "</tbody>";
}
$("rpCmp").addEventListener("change", async e => { const a = e.target.files[0]; e.target.value = ""; if (!a) return;
  try { const x = await rpLeerMiExcel(a);
    // ¿de qué sucursal es? la del nombre del archivo si tiene su reporte; si no, la que está elegida en «Sucursal»
    const r = S.rp.sucs.find(y => x.suc && y.suc === x.suc) || rpCmpR(); if (!r) return toast("Suba primero el reporte de la sucursal.");
    S.rpCmpSuc = r.archivo; S.rpCmpVer = ""; const sk = rpSk(r), id = "rpcmp_" + norm(sk).replace(/[^A-Z0-9]+/g, "_");
    S.rpCmps.set(sk, { ...x, id }); pintarRep();
    if (!S.prev) await setDoc(doc(db, "proy_config", id), { tipo: "rpcmp", sk, archivo: x.archivo, suc: r.suc || "", items: JSON.stringify([...x.items.values()].map(y => [y.c, y.n, y.l, y.q])), subido: new Date().toISOString() });
    toast(`Su Excel quedó guardado para comparar con ${rpNomSuc(r)}`);
  } catch (x) { toast(`«${a.name}»: ${x.message || x}`); } });
$("rpLin").addEventListener("change", e => { S.rpLin = e.target.value; pintarRpCmp(); });
// AÑADIR un producto que no está en la lista (nuevo o que la sucursal necesita): se busca por código o nombre y se elige la cantidad
$("rpAddQ").addEventListener("input", async e => { await cargarCatalogo(); const l = buscarCat(e.target.value).slice(0, 8), sd = c => S.drogStk ? +(S.drogStk[c]?.[0] || 0) : null;
  $("rpAddLista").innerHTML = l.map(p => `<button type="button" data-rpadd="${esc(p.c)}"><code>${esc(p.c)}</code> ${esc(p.n)} <small class="muted">${esc(p.ln || "")} · droguería: ${sd(p.c) == null ? "…" : nf(Math.round(sd(p.c) * 100) / 100)}</small></button>`).join("");
  $("rpAddLista").hidden = !l.length; });
$("rpAddLista").addEventListener("click", e => { const b = e.target.closest("[data-rpadd]"); if (!b) return; const p = prodCat(b.dataset.rpadd); if (!p) return;
  S.rpAddSel = p; $("rpAddQ").value = `${p.c} – ${p.n}`; $("rpAddLista").hidden = true; $("rpAddCant").focus(); });
$("rpAddBtn").addEventListener("click", async () => {
  let p = S.rpAddSel; if (!p || !$("rpAddQ").value.startsWith(p.c)) { await cargarCatalogo(); p = prodCat($("rpAddQ").value.trim()) || null; }
  if (!p) return toast("Busque el producto (por código o nombre) y elíjalo de la lista.");
  const q = Math.max(0, Math.round(+$("rpAddCant").value || 0)); if (!q) return toast("Escriba la cantidad a entregar.");
  await rpElegir(p.c, q, "add", { n: p.n, l: p.ln || "" }); S.rpAddSel = null; $("rpAddQ").value = ""; $("rpAddCant").value = "";
  toast(`Añadido: ${p.n} · ${nf(q)}`); });
$("rpConNotas").addEventListener("change", e => { S.rpConNotas = e.target.checked; pintarRpCmp(); });
$("rpFam").addEventListener("change", e => { S.rpFam = e.target.value; pintarRpCmp(); });
$("rpCmpSuc").addEventListener("change", e => { S.rpCmpSuc = e.target.value; S.rp.suc = e.target.value; S.rpCmpVer = ""; pintarRep(); });
// cantidad escrita a mano (si no está de acuerdo con ninguna de las dos): se guarda al pulsar Enter o al salir del cuadro
$("rpCmpTabla").addEventListener("change", e => { const i = e.target.closest("[data-rpman]"); if (!i || i.value === "") return;
  const q = Math.max(0, Math.round(+i.value || 0)); rpElegir(i.dataset.rpman, q, q ? "man" : "del"); });
$("rpCmpTabla").addEventListener("click", e => { const b = e.target.closest("[data-rpel]"); if (!b) return; rpElegir(b.dataset.rpel, +b.dataset.q || 0, b.dataset.de || ""); });
$("rpCmpVer").addEventListener("change", e => { S.rpCmpVer = e.target.value; pintarRpCmp(); });
$("rpCmpRes").addEventListener("click", e => { const b = e.target.closest("[data-rpcmpver]"); if (!b) return; S.rpCmpVer = S.rpCmpVer === b.dataset.rpcmpver ? "" : b.dataset.rpcmpver; pintarRpCmp(); });
$("rpCmpXls").addEventListener("click", () => {
  const l = rpComparar().filter(x => (!S.rpCmpVer || x.res === S.rpCmpVer) && rpPasaClas(x)); if (!l.length) return toast("No hay nada para descargar con estos filtros.");
  const r2 = v => v == null ? "" : Math.round(v * 100) / 100;
  excelDe(l.map(x => ({ "Código": x.c, Medicamento: x.n, Laboratorio: x.l, "Reporte (vendió − stock)": x.qr, "Su Excel": x.qe ?? "", Atender: rpAt(x) ?? "", Diferencia: (x.qe || 0) - x.qr, "Vendió": r2(x.venta), Stock: r2(x.stock), "Stock en el reporte": x.stkHoy ? r2(x.stockRep) : r2(x.stock), "Le dura (días)": rpDiasDura(x, rpCmpR()?.dias || 0) ?? (x.stock > 0 ? "sin venta" : ""), "Stock droguería": S.drogStk ? r2(+(S.drogStk[x.c]?.[0] || 0)) : "", "Notas y comentarios": rpNotas((S.rp.sucs.find(y => y.archivo === S.rpCmpSuc) || {}).suc || "", x.c).map(n => n.t.replace(/^\S+ /, "") + (n.q ? " (" + n.q + ")" : "")).join(" · "), Resultado: RP_RES[x.res][0] + (x.por ? ": " + x.por : "") })),
    "Comparación", "comparacion_" + rpNomSuc(S.rp.sucs.find(x => x.archivo === S.rpCmpSuc) || {}).toLowerCase().replace(/\W+/g, "_"));
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
S.evFecha = hoyISO(); S.evMin = 15; S.evMax = 90; S.evDias = 365;
try { const g = JSON.parse(localStorage.getItem("ev_umbral") || "{}"); if (g.min) S.evMin = g.min; if (g.max) S.evMax = g.max; if (g.srd) S.evDias = g.srd; } catch {}
const sucsEval = () => FARMACIAS.filter(f => /^ALMACEN /.test(f) && (esAdmin() || !miFarm() || f === miFarm()));
async function cargarEval(forzar) {
  if (S.evCargando) { S.evOtra = Math.max(S.evOtra || 0, forzar ? 2 : 1); return; } S.evCargando = true;
  try {
    if (!S.evStock || forzar) { const d = await getDoc(doc(db, "red", "eval")); S.evStock = d.exists() ? d.data() : { s: {} }; }
    // detalle de cada sucursal (stock, venta diaria y días sin venta de cada producto): para elegir el periodo de «sin rotación»
    // se cargan las sucursales que falten (p. ej. después de salir de la vista previa de un químico, que solo trae la suya)
    if (!S.evR || forzar) { S.evR = {}; S.evRVisto = new Set(); }
    const faltan = sucsEval().filter(f => !S.evRVisto.has(f));
    if (faltan.length) {
      faltan.forEach(f => S.evRVisto.add(f));
      await Promise.all(faltan.map(async f => { try { const d = await getDoc(doc(db, "red", "ev_" + f)); if (d.exists()) {
        const x = d.data(); S.evR[f] = { fin: x.fin || "", corte: x.corte, filas: String(x.r || "").split(",").filter(Boolean).map(t => { const [c, st, dd, m, v] = t.split("|"); return { c, st: +st, d: +dd, ds: x.u === "dias" ? +m : (+m >= 99 ? 99999 : +m * 30), v: +v }; }) };
      } } catch {} }));
    }
    if (!S.evFechas || forzar) { const q = await getDocs(collection(db, "evaluacion")); S.evDocs = new Map(q.docs.map(d => [d.id, d.data()])); S.evFechas = [...S.evDocs.keys()].sort().reverse(); }
  } catch (e) { S.evErr = textoError(e); S.evStock ??= { s: {} }; }
  S.evDocs ??= new Map(); S.evFechas ??= [];
  S.evCargando = false;
  if (S.evOtra) { const fz = S.evOtra === 2; S.evOtra = 0; return cargarEval(fz); }   // se pidió otra carga mientras esta corría
  if (S.vista === "vEval") pintarEval();
}
// los 5 indicadores de stock de una sucursal (% de productos), con los días mínimo y máximo elegidos
function stockEval(f) {
  const R = S.evR?.[f];
  if (R) {   // con el detalle: «sin rotación» = tiene stock y no vendió en los últimos S.evDias días
    const n = { normo: 0, sobre: 0, sub: 0, sr: 0, de: 0 }, v = { normo: 0, sobre: 0, sub: 0, sr: 0 }; let dem = 0;
    for (const x of R.filas) {
      if (x.d > 0) dem++;
      if (x.st > 0 && x.ds > S.evDias) { n.sr++; v.sr += x.v; continue; }
      if (x.d > 0 && x.st <= 0) { n.de++; continue; }
      if (!(x.st > 0)) continue;
      const dias = x.d > 0 ? x.st / x.d : 9999, k = dias < S.evMin ? "sub" : dias > S.evMax ? "sobre" : "normo"; n[k]++; v[k] += x.v;
    }
    const tot = n.normo + n.sobre + n.sub + n.sr + n.de, pc = k => tot ? n[k] / tot * 100 : 0;
    return { n, v, tot, p: { normo: pc("normo"), sobre: pc("sobre"), sub: pc("sub"), sr: pc("sr"), de: pc("de") }, disp: dem ? (1 - n.de / dem) * 100 : null };
  }
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
  $("evMin").value = S.evMin; $("evMax").value = S.evMax; $("evSRd").value = desdeSR(); $("evSRn").textContent = S.evDias + " días";
  const fechas = [...new Set([S.evFecha, ...(S.evFechas || [])])].sort().reverse();
  $("evFecha").innerHTML = fechas.map(f => `<option value="${f}" ${f === S.evFecha ? "selected" : ""}>${fDia(f)}${S.evDocs?.has(f) ? "" : " (nueva)"}</option>`).join("");
  $("evNueva").hidden = $("evGen").hidden = !admin;
  $("evInfo").innerHTML = S.evStock?.publicado ? `Indicadores de stock con el kardex al <b>${fmtF(S.evStock.corte)}</b> (publicado el ${fFecha(S.evStock.publicado)}) · por cantidad de productos.${Object.keys(S.evR || {}).length ? ` Haga clic en el % de disponibilidad o de sin rotación para ver laboratorios y productos.` : admin ? ` <b class="mal">Falta el detalle por sucursal: pulse «⚙ Generar detalle» para poder elegir el periodo y abrir laboratorios y productos.</b>` : ""}${(() => { const sin = admin && Object.keys(S.evR || {}).length ? sucsEval().filter(f => !S.evR[f]) : []; return sin.length ? ` <b class="mal">Sin detalle: ${sin.map(corto).join(", ")}. Pulse «⚙ Generar detalle».</b>` : ""; })()}`
    : "Los indicadores de stock aparecerán después de subir el kardex o abrir Atención a sucursales.";
  msg("evMsg", S.evErr || "", true);
  const filas = sucsEval().map(f => ({ f, st: stockEval(f), e: evDe(f) }));
  const celNota = (f, k, val) => admin ? `<select class="ev-sel ${EV_NOTA[val || ""][1]}" data-evf="${esc(f)}" data-evk="${k}">${Object.entries(EV_NOTA).map(([v, [t]]) => `<option value="${v}" ${v === (val || "") ? "selected" : ""}>${t}</option>`).join("")}</select>`
    : `<span class="chip ${EV_NOTA[val || ""][1]}">${EV_NOTA[val || ""][0]}</span>`;
  // químicos (y vista previa): solo disponibilidad y sin rotación de su sucursal
  document.querySelectorAll(".ev-adm").forEach(el => el.hidden = !admin);
  document.querySelectorAll(".ev-quim").forEach(el => el.hidden = admin);
  const celDisp = (f, st) => S.evR?.[f] ? `<button type="button" class="ev-lnk" data-evdisp="${esc(f)}" title="Ver lo desabastecido por laboratorio">${p1(st?.disp)}</button>` : p1(st?.disp);
  const celSR = (f, st) => S.evR?.[f] ? `<button type="button" class="ev-lnk" data-evsr="${esc(f)}" title="Ver laboratorios y productos sin rotación">${p1(st?.p.sr)}</button>` : p1(st?.p.sr);
  if (!admin) {
    $("evTabla").innerHTML = `<thead><tr><th>Sucursal</th><th class="der">Disponibilidad</th><th class="der ev-r">Sin rotación</th></tr></thead><tbody>` +
      (filas.length ? filas.map(({ f, st }) => `<tr><td><b>${esc(corto(f))}</b></td><td class="der">${celDisp(f, st)}</td><td class="der ev-r">${celSR(f, st)}</td></tr>`).join("") : '<tr class="vacia"><td colspan="3">Sin datos de su sucursal.</td></tr>') + "</tbody>";
    $("evGraf").innerHTML = ""; return;
  }
  $("evTabla").innerHTML = `<thead><tr><th>Sucursal</th><th>Nivel de stockeo</th><th class="der">Capacidad de almacén</th>${EV_ITEMS.map(([, t]) => `<th>${t}</th>`).join("")}
      <th class="der">Disponibilidad</th><th class="der ev-n">Normostock</th><th class="der ev-s">Sobrestock</th><th class="der ev-b">Substock</th><th class="der ev-r">Sin rotación</th><th class="der ev-d">Desabastecido</th><th class="der">Cumplimiento de BPA</th><th></th></tr></thead><tbody>` +
    filas.map(({ f, st, e }) => { const nv = nivelStock(st?.p.normo), cap = capacidad(e.cap), bpa = bpaPct(e.bpa);
      return `<tr><td><b>${esc(corto(f))}</b></td><td><span class="chip ${nv[1]}">${nv[0]}</span></td><td class="der">${cap != null ? cap.toLocaleString("es-PE", { maximumFractionDigits: 2 }) + " m³" : "–"}</td>
        ${EV_ITEMS.map(([k]) => `<td>${celNota(f, k, e[k])}</td>`).join("")}
        <td class="der">${celDisp(f, st)}</td><td class="der ev-n">${p1(st?.p.normo)}</td><td class="der ev-s">${p1(st?.p.sobre)}</td><td class="der ev-b">${p1(st?.p.sub)}</td><td class="der ev-r">${celSR(f, st)}</td><td class="der ev-d">${p1(st?.p.de)}</td>
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
$("evTabla").addEventListener("click", e => { const s = e.target.closest("[data-evsr]"); if (s) return abrirSR(s.dataset.evsr, "sr"); const dp = e.target.closest("[data-evdisp]"); if (dp) return abrirSR(dp.dataset.evdisp, "disp"); const b = e.target.closest("[data-evdet]"); if (b) abrirDetEval(b.dataset.evdet); });
// «Sin rotación» de una sucursal: primero por laboratorio, luego los productos del laboratorio elegido
// periodo de «sin rotación»: desde (corte − días) hasta el corte del kardex
const corteEv = () => String(Object.values(S.evR || {})[0]?.corte || S.evStock?.corte || hoyISO()).slice(0, 10);
const desdeSR = () => { const d = new Date(corteEv() + "T12:00:00"); d.setDate(d.getDate() - S.evDias); return d.toISOString().slice(0, 10); };
const ultVenta = x => { if (x.ds >= 99999) return "sin venta en lo guardado"; const d = new Date(corteEv() + "T12:00:00"); d.setDate(d.getDate() - x.ds); return "última venta " + fDia(d.toISOString().slice(0, 10)) + (x.ds > 90 ? " aprox." : ""); };
const conNombre = x => { const pc = prodCat(x.c); return { ...x, n: pc?.n || "Código " + x.c, lab: pc?.ln || "SIN LABORATORIO" }; };
// sr: con stock y sin venta en el periodo (por valor en soles) · disp: se venden y están en 0 (por cantidad de productos)
const filasSR = (f, tab) => (S.evR?.[f]?.filas || []).filter(x => tab === "disp" ? x.d > 0 && x.st <= 0 && !(x.st > 0 && x.ds > S.evDias) : x.st > 0 && x.ds > S.evDias).map(conNombre);
function abrirSR(f, tab, lab) {
  S.srF = f; S.srTab = tab || S.srTab || "sr"; S.srLab = lab || ""; const sr = S.srTab === "sr", st = stockEval(f), todas = filasSR(f, S.srTab);
  const peso = x => sr ? x.v : 1, tot = todas.reduce((a, x) => a + peso(x), 0), pc = (v, t) => t ? p1(v / t * 100) : "–";
  let h = `<h2>${esc(nombreFarm(f))}</h2>
    <div class="pd-per sr-tabs"><button type="button" class="pd-chip" data-srtab="disp" aria-pressed="${!sr}">Disponibilidad</button><button type="button" class="pd-chip" data-srtab="sr" aria-pressed="${sr}">Sin rotación</button></div>
    <div class="sr-cab"><span class="sr-bola ${sr ? "sr-r" : "sr-d"}" title="${sr ? "% de productos sin rotación" : "Disponibilidad"}">${p1(sr ? st?.p.sr : st?.disp)}</span>
      ${sr ? `<fieldset class="sr-per"><legend>Periodo</legend><input type="date" id="srDesde" value="${desdeSR()}" min="2020-01-01" max="${corteEv()}"> <span>a</span> <input type="date" value="${corteEv()}" disabled title="Fecha del kardex (el stock es de ese día)"></fieldset>
      <span class="sr-bola sr-dias">${nf(S.evDias)}<small>días</small></span>` : `<p class="muted">Productos que se venden en la sucursal y tienen stock 0 · kardex al ${fmtF(corteEv())}.</p>`}</div>`;
  if (!S.srLab) {
    const g = new Map(); for (const x of todas) { const a = g.get(x.lab) || { n: 0, v: 0, w: 0 }; a.n++; a.v += x.v; a.w += peso(x); g.set(x.lab, a); }
    const labs = [...g].sort((a, b) => b[1].w - a[1].w || b[1].n - a[1].n);
    h += `<div class="tabla-wrap"><table class="tabla"><thead><tr><th>Laboratorio</th><th class="der">%</th><th class="der">Productos</th>${sr ? '<th class="der">Soles</th>' : ""}</tr></thead><tbody>` +
      (labs.length ? labs.map(([l, a]) => `<tr class="clic" data-srlab="${esc(l)}"><td><b>${esc(l)}</b></td><td class="der">${pc(a.w, tot)}</td><td class="der">${nf(a.n)}</td>${sr ? `<td class="der">${solesR(a.v)}</td>` : ""}</tr>`).join("")
        : `<tr class="vacia"><td colspan="4">${sr ? "Ningún producto sin rotación en ese periodo." : "No hay productos desabastecidos."}</td></tr>`) +
      `</tbody><tfoot><tr><td><b>Total</b></td><td class="der"><b>${tot ? "100%" : "–"}</b></td><td class="der"><b>${nf(todas.length)}</b></td>${sr ? `<td class="der"><b>${solesR(tot)}</b></td>` : ""}</tr></tfoot></table></div>`;
  } else {
    const ps = todas.filter(x => x.lab === S.srLab).sort((a, b) => sr ? b.v - a.v : b.d - a.d), tl = ps.reduce((a, x) => a + peso(x), 0);
    h += `<p><button class="btn sm" type="button" id="srVolver">← Todos los laboratorios</button></p>
      <h3>Laboratorio ${esc(S.srLab)} <small class="muted">· ${pc(tl, tot)}</small></h3>
      <div class="tabla-wrap"><table class="tabla"><thead><tr><th>Producto</th>${sr ? '<th class="der">%</th><th class="der">Cantidad</th><th class="der">Soles</th>' : '<th class="der">Venta por día</th><th class="der">Stock</th>'}</tr></thead><tbody>` +
      ps.map(x => `<tr><td><b>${esc(x.n)}</b> <code>${esc(x.c)}</code><br><small class="muted">${ultVenta(x)}</small></td>${sr ? `<td class="der">${pc(x.v, tl)}</td><td class="der">${nf(x.st)}</td><td class="der">${solesR(x.v)}</td>` : `<td class="der">${nf(Math.round(x.d * 100) / 100)}</td><td class="der">0</td>`}</tr>`).join("") +
      (sr ? `</tbody><tfoot><tr><td><b>Total</b></td><td class="der"><b>100%</b></td><td class="der"><b>${nf(Math.round(ps.reduce((a, x) => a + x.st, 0) * 1000) / 1000)}</b></td><td class="der"><b>${solesR(tl)}</b></td></tr></tfoot>` : "</tbody>") + "</table></div>";
  }
  h += `<p><button class="btn" type="button" id="srXls"><svg width="18" height="18"><use href="#i-bajar"/></svg>Descargar Excel</button></p>`;
  $("srDlgC").innerHTML = h; if (!$("srDlg").open) $("srDlg").showModal();
}
$("srDlg").addEventListener("click", e => {
  if (e.target.closest("[data-cerrar-dlg]") || e.target === $("srDlg")) return $("srDlg").close();
  const t = e.target.closest("[data-srtab]"); if (t) return abrirSR(S.srF, t.dataset.srtab);
  const l = e.target.closest("[data-srlab]"); if (l) return abrirSR(S.srF, S.srTab, l.dataset.srlab);
  if (e.target.closest("#srVolver")) return abrirSR(S.srF, S.srTab);
  if (e.target.closest("#srXls")) { const sr = S.srTab === "sr";
    excelDe(filasSR(S.srF, S.srTab).sort((a, b) => a.lab.localeCompare(b.lab) || b.v - a.v).map(x => ({ Sucursal: corto(S.srF), Laboratorio: x.lab, Código: x.c, Producto: x.n,
      ...(sr ? { Cantidad: x.st, "Soles (costo)": x.v } : { "Venta por día": Math.round(x.d * 100) / 100 }), "Última venta": ultVenta(x) })),
      sr ? "Sin rotación" : "Desabastecidos", sr ? `sin_rotacion_${corto(S.srF)}_${desdeSR()}_a_${corteEv()}` : `desabastecidos_${corto(S.srF)}_${corteEv()}`); }
});
const ponerDesde = v => { if (!v) return; S.evDias = Math.max(1, Math.round((new Date(corteEv() + "T12:00:00") - new Date(v + "T12:00:00")) / 864e5)); guardarUmbral(); pintarEval(); };
$("srDlg").addEventListener("change", e => { if (e.target.id !== "srDesde") return; ponerDesde(e.target.value); abrirSR(S.srF, S.srTab, S.srLab); });
const guardarUmbral = () => { try { localStorage.setItem("ev_umbral", JSON.stringify({ min: S.evMin, max: S.evMax, srd: S.evDias })); } catch {} };
$("evSRd").addEventListener("change", e => ponerDesde(e.target.value));
$("evFecha").addEventListener("change", e => { S.evFecha = e.target.value; pintarEval(); });
$("evNueva").addEventListener("click", () => { const f = prompt("Fecha de la nueva evaluación (AAAA-MM-DD):", hoyISO()); if (f && /^\d{4}-\d{2}-\d{2}$/.test(f)) { S.evFecha = f; pintarEval(); } });
["evMin", "evMax"].forEach(id => $(id).addEventListener("change", () => {
  S.evMin = Math.max(1, +$("evMin").value || 15); S.evMax = Math.max(S.evMin + 1, +$("evMax").value || 90);
  guardarUmbral();
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
    if (!esAdmin()) return { Sucursal: corto(f), "Disponibilidad %": r2(st?.disp), "Sin rotación %": r2(st?.p.sr), "Sin venta desde": desdeSR() };
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
  try {
    const [d, r] = await Promise.all([getDoc(doc(db, "red", "compras")), getDoc(doc(db, "red", "compras_rep")).catch(() => null)]);
    S.cp = d.exists() ? d.data() : { m: [], lab: {} }; S.cpRep = r?.exists() ? r.data() : { m: {} }; S.cpErr = "";
  }
  catch (e) { S.cpErr = textoError(e); S.cp = { m: [], lab: {} }; S.cpRep = { m: {} }; }
  S.cpCargando = false; if (S.vista === "vCompL") pintarCompras();
}
const MES_L = m => { const [y, mo] = m.split("-"); return ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Set", "Oct", "Nov", "Dic"][+mo - 1] + "-" + y.slice(2); };
const solesR = v => "S/ " + Math.round(v).toLocaleString("es-PE");
// Une lo calculado con el kardex (red/compras) y los meses subidos del reporte del sistema (red/compras_rep), que mandan.
function compUnidas() {
  const K = S.cp || { m: [], lab: {} }, R = S.cpRep?.m || {}, km = K.m || [];
  const meses = [...new Set([...km, ...Object.keys(R)])].sort(), lab = {};
  for (const [l, t] of Object.entries(K.lab || {})) String(t).split(",").forEach((v, i) => { if (+v && !R[km[i]]) (lab[l] ??= {})[km[i]] = +v; });
  for (const [mes, j] of Object.entries(R)) { let o = {}; try { o = JSON.parse(j); } catch {} for (const [l, v] of Object.entries(o)) if (+v) (lab[l] ??= {})[mes] = +v; }
  return { m: meses, lab: Object.fromEntries(Object.entries(lab).map(([l, o]) => [l, meses.map(m => o[m] || 0).join(",")])), rep: new Set(Object.keys(R)) };
}
function datosCompras() {
  const C = compUnidas(), todos = C.m || [];
  // toda la historia: desde el primer mes con compras hasta el último
  const tot0 = todos.map((_, i) => Object.values(C.lab || {}).reduce((a, t) => a + Math.max(0, +String(t).split(",")[i] || 0), 0));
  const i0 = Math.max(0, tot0.findIndex(v => v > 0)), i1 = Math.max(i0, tot0.findLastIndex(v => v > 0)), meses = todos.slice(i0, i1 + 1);
  S.cpDesde = meses[0] || ""; S.cpHasta = meses[meses.length - 1] || "";
  const labs = Object.entries(C.lab || {}).map(([l, t]) => { const v = String(t).split(",").map(Number).slice(i0, i1 + 1); return { l, v, tot: v.reduce((a, x) => a + Math.max(0, x), 0) }; })
    .filter(x => x.tot > 0).sort((a, b) => b.tot - a.tot);
  const totMes = meses.map((_, j) => labs.reduce((a, x) => a + Math.max(0, x.v[j]), 0)), tot = totMes.reduce((a, x) => a + x, 0);
  return { meses, labs, totMes, tot, rep: C.rep };
}
function pintarCompras() {
  const C = S.cp; msg("cpMsg", S.cpErr || "", true);
  if (!C) { $("cpTabla").innerHTML = '<tbody><tr class="vacia"><td>Cargando…</td></tr></tbody>'; return; }
  $("cpCalc").hidden = $("cpRep").hidden = !esAdmin();
  if (!C.m?.length && !Object.keys(S.cpRep?.m || {}).length) { $("cpInfo").textContent = esAdmin() ? "Aún no hay compras calculadas: pulsa «Calcular compras ahora» (usa el kardex que ya está guardado)." : "Las compras aparecerán cuando Abastecimiento las calcule."; $("cpTabla").innerHTML = ""; $("cpGraf").innerHTML = ""; return; }
  $("cpCalc").hidden = $("cpDiag").hidden = !esAdmin();
  const D = datosCompras();
  $("cpInfo").textContent = "";
  if (!S.cpLab || !D.labs.some(x => x.l === S.cpLab)) S.cpLab = D.labs[0]?.l || "";
  if (document.activeElement !== $("cpQ")) $("cpQ").value = S.cpQ2 || "";
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
  const filas = D.labs.filter(a => !q || q.split(/\s+/).every(w => norm(a.l).includes(w)));
  const celda = (v, t) => S.cpVer === "pct" ? (v > 0 ? fP(pct(v, t)) : "–") : (v ? solesR(v) : "–");
  $("cpTabla").innerHTML = `<thead><tr><th>Laboratorio</th>${D.meses.map(m => `<th class="der"${D.rep.has(m) ? ' title="Del reporte del sistema"' : ""}>${MES_L(m)}${D.rep.has(m) ? " 📄" : ""}</th>`).join("")}<th class="der">Periodo</th></tr></thead><tbody>` +
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
// un solo buscador: lo escrito filtra la tabla y el gráfico pasa al primer laboratorio que coincide
$("cpQ").addEventListener("input", () => {
  S.cpQ2 = $("cpQ").value; const q = norm(S.cpQ2).trim();
  const m = q && datosCompras().labs.find(a => q.split(/\s+/).every(w => norm(a.l).includes(w)));
  if (m && !(S.cpLab && q.split(/\s+/).every(w => norm(S.cpLab).includes(w)))) S.cpLab = m.l;
  pintarCompras(); resLabs();
});
$("cpQ").addEventListener("focus", resLabs);
const elegirLab = l => { S.cpLab = S.cpQ2 = l; $("cpRes").hidden = true; $("cpQ").value = l; $("cpQ").blur(); pintarCompras(); };
$("cpQ").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); const b = $("cpRes").querySelector("[data-cpsel]"); if (b) elegirLab(b.dataset.cpsel); } else if (e.key === "Escape") $("cpRes").hidden = true; });
$("cpRes").addEventListener("mousedown", e => { const b = e.target.closest("[data-cpsel]"); if (!b) return; e.preventDefault(); elegirLab(b.dataset.cpsel); });
$("cpQ").addEventListener("blur", () => setTimeout(() => { $("cpRes").hidden = true; }, 150));
$("cpVerBox").addEventListener("click", e => { const b = e.target.closest("[data-cpver]"); if (b) { S.cpVer = b.dataset.cpver; pintarCompras(); } });
$("cpTabla").addEventListener("click", e => { const r = e.target.closest("[data-cplab]"); if (r) { S.cpLab = r.dataset.cplab; pintarCompras(); scrollTo({ top: 0, behavior: "smooth" }); } });
$("cpMas").addEventListener("click", e => { if (e.target.closest("#cpMasBtn")) { S.cpMostrar = (S.cpMostrar || 100) + 100; pintarCompras(); } });
$("cpAct").addEventListener("click", () => cargarCompras(true));
// Reporte «Compras por Laboratorio» del sistema (.XLS, Establecimiento TODOS): cada mes que cubre reemplaza al del kardex.
// red/compras_rep = { m: { "2026-08": '{"LAB": soles, …}' }, sub: { "2026-08": "fecha de subida" } }
function leerReporteCompras(rows) {
  const txt = rows.map(r => r.join(" ")).join("\n");
  const rg = txt.match(/Desde\s+Fecha\s*:\s*(\d{1,2})-(\d{1,2})-(\d{4})\s+Hasta\s+Fecha\s*:\s*(\d{1,2})-(\d{1,2})-(\d{4})/i);
  if (!/Compras\s+por\s+Laboratorio/i.test(txt) || !rg) throw new Error("no parece el reporte «Compras por Laboratorio» (no encuentro «Desde Fecha … Hasta Fecha»).");
  const desde = `${rg[3]}-${rg[2].padStart(2, "0")}`, hasta = `${rg[6]}-${rg[5].padStart(2, "0")}`, meses = {};
  for (let m = desde; m <= hasta; ) { meses[m] = {}; const [y, mo] = m.split("-").map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; }
  let lab = "", filas = 0, total = 0;
  for (const r of rows) {
    const v = r.filter(c => c !== "" && c != null);
    if (/^Laboratorio\s*:?\s*$/i.test(String(v[0] || "").trim()) && v[1]) { lab = String(v[1]).trim(); continue; }
    if (typeof v[0] !== "number" || v.length < 8 || !lab) continue;
    const f = v[1]; let mes = "";
    if (typeof f === "number") mes = new Date(Math.round((f - 25569) * 864e5)).toISOString().slice(0, 7);
    else { const x = String(f).match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/); if (x) mes = `${x[3]}-${x[2].padStart(2, "0")}`; }
    mes = mes < desde ? desde : mes > hasta || !mes ? hasta : mes;   // la fecha del documento manda (es el filtro del reporte)
    const parcial = +v[v.length - 1] || 0; meses[mes][lab] = Math.round(((meses[mes][lab] || 0) + parcial) * 100) / 100; filas++; total += parcial;
  }
  if (!filas) throw new Error("no encontré filas de compras en el archivo.");
  return { desde, hasta, meses, filas, total };
}
$("cpRep").addEventListener("click", () => $("cpRepF").click());
$("cpRepF").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  msg("cpMsg", "Leyendo el reporte…");
  try {
    XLSX ??= await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
    const wb = XLSX.read(await f.arrayBuffer(), { type: "array" }), sh = wb.Sheets[wb.SheetNames[0]];
    const R = leerReporteCompras(XLSX.utils.sheet_to_json(sh, { header: 1, raw: true, defval: "" }));
    const prev = S.cpRep || { m: {} }, m = { ...(prev.m || {}) }, sub = { ...(prev.sub || {}) }, hoy = new Date().toISOString();
    for (const [mes, o] of Object.entries(R.meses)) { m[mes] = JSON.stringify(o); sub[mes] = hoy; }
    await setDoc(doc(db, "red", "compras_rep"), { m, sub });
    S.cpRep = { m, sub };
    msg("cpMsg", `Reporte cargado: ${MES_L(R.desde)}${R.hasta !== R.desde ? " a " + MES_L(R.hasta) : ""} · ${R.filas.toLocaleString("es-PE")} filas · total ${solesR(R.total)}. Esos meses ahora salen del reporte.`);
    pintarCompras();
  } catch (er) { msg("cpMsg", "No se pudo leer el reporte: " + (er?.code ? textoError(er) : er.message), true); }
});
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
// Evaluación: genera el detalle por sucursal (red/ev_…) con el kardex ya guardado, sin pasar por Atención a sucursales
$("evGen").addEventListener("click", async () => {
  const b = $("evGen"); b.disabled = true; msg("evMsg", "Generando el detalle de cada sucursal con el kardex guardado… puede tardar un par de minutos. No cierre la página.");
  try {
    if (!$("karFrame").src) $("karFrame").src = "proyeccion.html?solo=kar&v=" + VERSION_PROY;
    let w = null;
    for (let i = 0; i < 240 && !w; i++) { await new Promise(r => setTimeout(r, 500)); const x = $("karFrame").contentWindow; if (x?.publicarExtras) w = x; }
    if (!w) throw new Error("no terminó de cargar el módulo Kardex");
    const r = await w.publicarExtras(), ev = (r?.hechos || []).filter(h => h.startsWith("ev_")).length;
    await cargarEval(true);
    if (!ev) throw new Error((r?.errores || []).join(" · ") || "no se generó el detalle de ninguna sucursal");
    msg("evMsg", r.errores.length ? `Detalle generado (${ev} sucursales). Avisos: ` + r.errores.join(" · ") : ""); toast(`Detalle generado: ${ev} sucursales`);
  } catch (e) { msg("evMsg", "No se pudo generar el detalle: " + (e.message || e), true); }
  finally { b.disabled = false; }
});
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

/* ===================== productos que buscan los clientes ===================== */
// productos_nuevos/{id} = { prod, tipo: receta|consulta, cant, nota, suc, porUid, porNombre, creado, foto: true|false,
//   tambien: [{ suc, porNombre, f }] (otras sucursales a las que también se lo pidieron), estado, notaAdmin }
// productos_nuevos_foto/{id} = { d: "data:image/jpeg;base64,…", porUid }  (la foto aparte, para que la lista cargue rápido)
const NUE_EST = { nuevo: ["🆕 Nuevo", "amb"], evaluando: ["🔎 En evaluación", "azul"], se_compra: ["🛒 Se va a comprar", "verde"], disponible: ["✅ Ya disponible", "verde"], no_trabaja: ["⛔ No se trabajará", "rojo"] };
const NUE_TIPO = { receta: "📄 Receta", consulta: "🗣 Consulta del paciente" };
S.nueFotos = new Map(); S.nueMostrar = 30;
function escucharNue() {
  if (S.nueSub) return;
  S.nueSub = true;
  S.nueIni = false;
  S.subs.push(onSnapshot(collection(db, "productos_nuevos"), sn => {
    S.nue = sn.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.creado?.toMillis?.() || Date.now()) - (a.creado?.toMillis?.() || Date.now()));
    // aviso de lo que registran otros (no en la primera carga ni lo propio)
    if (S.nueIni) for (const c of sn.docChanges()) if (c.type === "added" && !c.doc.metadata.hasPendingWrites && c.doc.data().porUid !== S.perfil?.uid) alertarNue({ id: c.doc.id, ...c.doc.data() });
    S.nueIni = true;
    if (S.vista === "vNue") marcarNueVisto();
    S.nueErr = ""; pintarNav(); if (S.vista === "vNue") pintarNue();
  }, e => { S.nueErr = textoError(e); S.nueSub = false; if (S.vista === "vNue") pintarNue(); }));
}
const fNue = t => { const d = t?.toDate ? t.toDate() : null; return d ? d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit" }) + " " + d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) : "ahora"; };
const sucsNue = d => [d.suc, ...(d.tambien || []).map(t => t.suc)].filter(Boolean);
function filtrosNue() {
  const q = norm($("nueQ").value).trim().split(/\s+/).filter(Boolean), suc = $("nueSuc").value, est = $("nueEst").value;
  return (S.nue || []).filter(d => (!suc || sucsNue(d).includes(suc)) && (!est || (d.estado || "nuevo") === est)
    && (!q.length || q.every(w => norm([d.prod, d.nota, d.porNombre, corto(d.suc)].join(" ")).includes(w))));
}
function pintarNue() {
  msg("nueMsg", S.nueErr || "", true);
  const admin = esAdmin(), todos = S.nue || [];
  $("nueLink").hidden = !admin;
  if (!$("nueSuc").options.length || $("nueSuc").dataset.n !== String(FARMACIAS.length)) {
    $("nueSuc").innerHTML = '<option value="">Todas las sucursales</option>' + FARMACIAS.filter(f => /^ALMACEN /.test(f)).map(f => `<option value="${esc(f)}">${esc(corto(f))}</option>`).join("");
    $("nueSuc").dataset.n = String(FARMACIAS.length);
    $("nueEst").innerHTML = '<option value="">Todos los estados</option>' + Object.entries(NUE_EST).map(([k, [t]]) => `<option value="${k}">${t}</option>`).join("");
  }
  // lo más buscado: el mismo nombre (sin mayúsculas ni tildes) en varias sucursales o varias veces
  const g = new Map(); for (const d of todos) { const k = norm(d.prod).replace(/\s+/g, " ").trim(); const x = g.get(k) || { n: d.prod, veces: 0, s: new Set() }; x.veces += 1 + (d.tambien || []).length; sucsNue(d).forEach(f => x.s.add(f)); g.set(k, x); }
  const top = [...g.values()].sort((a, b) => b.s.size - a.s.size || b.veces - a.veces).slice(0, 5);
  const mes = new Date().toISOString().slice(0, 7), deMes = todos.filter(d => (d.creado?.toDate?.() || new Date()).toISOString().slice(0, 7) === mes);
  $("nueRes").innerHTML = `<div class="card pd-kpi"><small>Registrados este mes</small><b class="n">${nf(deMes.length)}</b><small>en total: ${nf(todos.length)}</small></div>
    <div class="card pd-kpi nue-top"><small>Lo más buscado</small>${top.length ? `<ol>${top.map(x => `<li><b>${esc(x.n)}</b> <small class="muted">· ${x.s.size} ${x.s.size === 1 ? "sucursal" : "sucursales"} · ${x.veces} ${x.veces === 1 ? "vez" : "veces"}</small></li>`).join("")}</ol>` : '<small class="muted">Aún no hay registros.</small>'}</div>`;
  const lista = filtrosNue(), miS = miFarm();
  $("nueLista").innerHTML = lista.length ? lista.slice(0, S.nueMostrar).map(d => {
    const e = NUE_EST[d.estado || "nuevo"] || NUE_EST.nuevo, ya = (miS && sucsNue(d).includes(miS)), otros = (d.tambien || []);
    return `<article class="card nue-item">
      <div class="nue-foto" data-nuefoto="${esc(d.id)}">${d.foto ? (S.nueFotos.get(d.id) ? `<img src="${S.nueFotos.get(d.id)}" alt="Foto">` : '<span class="muted">📷 cargando…</span>') : '<span class="nue-sin">Sin foto</span>'}</div>
      <div class="nue-cuerpo">
        <h3>${esc(d.prod)}</h3>
        <p class="muted">${NUE_TIPO[d.tipo] || ""}${d.cant ? ` · pedían ${nf(d.cant)}` : ""}</p>
        ${d.nota ? `<p>${esc(d.nota)}</p>` : ""}
        <p class="nue-quien"><b>${esc(d.suc ? corto(d.suc) : "Abastecimiento")}</b> · ${esc(d.porNombre || "")} · ${fNue(d.creado)}</p>
        ${otros.length ? `<p class="nue-tamb">🙋 También lo pidieron en: ${otros.map(t => `<b>${esc(corto(t.suc))}</b>`).join(", ")}</p>` : ""}
        <div class="nue-acc">
          ${admin ? `<select class="ev-sel" data-nueest="${esc(d.id)}">${Object.entries(NUE_EST).map(([k, [t]]) => `<option value="${k}" ${k === (d.estado || "nuevo") ? "selected" : ""}>${t}</option>`).join("")}</select>
            <input class="nue-na" data-nuenota="${esc(d.id)}" value="${esc(d.notaAdmin || "")}" placeholder="Nota de Abastecimiento (opcional)" maxlength="200">`
          : `<span class="chip ${e[1]}">${e[0]}</span>${d.notaAdmin ? ` <small>${esc(d.notaAdmin)}</small>` : ""}`}
          ${miS && !ya ? `<button class="btn sm" type="button" data-nuetamb="${esc(d.id)}">🙋 A mi sucursal también se lo pidieron</button>` : ""}
          <button class="btn sm nue-wa" type="button" data-nuewa="${esc(d.id)}" title="Enviar a un grupo de WhatsApp">📲 WhatsApp</button>
          ${admin || d.porUid === S.perfil?.uid ? `<button class="btn sm peligro" type="button" data-nueborrar="${esc(d.id)}" title="Borrar este registro">🗑</button>` : ""}
        </div>
      </div></article>`; }).join("") : `<p class="muted nue-vacio">${todos.length ? "Ningún registro con esos filtros." : "Todavía no se registró ningún producto. Use «📷 Registrar producto» cuando un cliente busque algo que no tenemos."}</p>`;
  $("nueMas").innerHTML = lista.length > S.nueMostrar ? `<button class="btn" type="button" id="nueMasBtn">Ver más (de ${lista.length})</button>` : "";
  cargarFotosNue(lista.slice(0, S.nueMostrar));
}
async function cargarFotosNue(lista) {
  const falta = lista.filter(d => d.foto && !S.nueFotos.has(d.id)); if (!falta.length) return;
  await Promise.all(falta.map(async d => { try { const x = await getDoc(doc(db, "productos_nuevos_foto", d.id)); S.nueFotos.set(d.id, x.exists() ? x.data().d : ""); } catch { S.nueFotos.set(d.id, ""); } }));
  if (S.vista === "vNue") for (const d of falta) { const el = document.querySelector(`[data-nuefoto="${CSS.escape(d.id)}"]`); if (el) el.innerHTML = S.nueFotos.get(d.id) ? `<img src="${S.nueFotos.get(d.id)}" alt="Foto">` : '<span class="nue-sin">Sin foto</span>'; }
}
// foto: se achica en el teléfono (máx. 1100 px, JPEG) para que pese poco
function achicarFoto(file) {
  return new Promise((ok, mal) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight; const k = Math.min(1, 1100 / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
      const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
      let q = 0.72, d = c.toDataURL("image/jpeg", q); while (d.length > 600000 && q > 0.3) { q -= 0.12; d = c.toDataURL("image/jpeg", q); }
      ok(d);
    };
    img.onerror = () => { URL.revokeObjectURL(url); mal(new Error("no se pudo leer la foto")); };
    img.src = url;
  });
}
function abrirNue() {
  S.nueFoto = ""; S.nueTipo = "receta";
  $("nueFotoPrev").innerHTML = ""; $("nueProd").value = ""; $("nueCant").value = "1"; $("nueNota").value = ""; $("nueCat").innerHTML = ""; msg("nueDMsg", "");
  document.querySelectorAll("[data-nuetipo]").forEach(b => b.setAttribute("aria-pressed", b.dataset.nuetipo === S.nueTipo));
  $("nueSucD").textContent = miFarm() ? corto(miFarm()) : "Abastecimiento (sin sucursal)";
  $("nueDlg").showModal();
}
$("nueNuevo").addEventListener("click", abrirNue);
$("nueFotoF").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try { S.nueFoto = await achicarFoto(f); $("nueFotoPrev").innerHTML = `<img src="${S.nueFoto}" alt="Foto"><button type="button" class="btn sm" id="nueFotoQuitar">Quitar foto</button>`; }
  catch (x) { msg("nueDMsg", x.message, true); }
});
// si lo que escriben ya está en el catálogo, se avisa (puede que sí lo trabajemos)
$("nueProd").addEventListener("input", () => {
  const t = $("nueProd").value.trim(), r = t.length >= 4 ? buscarCat(t).slice(0, 4) : [];
  $("nueCat").innerHTML = r.length ? `<small class="muted">¿Es alguno de estos? Ya están en nuestro catálogo:</small> ${r.map(p => `<span class="chip">${esc(p.n)} <code>${esc(p.c)}</code></span>`).join(" ")}` : "";
});
$("nueDlg").addEventListener("click", async e => {
  if (e.target.closest("[data-cerrar-dlg]") || e.target === $("nueDlg")) return $("nueDlg").close();
  const t = e.target.closest("[data-nuetipo]"); if (t) { S.nueTipo = t.dataset.nuetipo; document.querySelectorAll("[data-nuetipo]").forEach(b => b.setAttribute("aria-pressed", b === t)); return; }
  if (e.target.closest("#nueFotoQuitar")) { S.nueFoto = ""; $("nueFotoPrev").innerHTML = ""; return; }
  if (!e.target.closest("#nueGuardar")) return;
  const prod = $("nueProd").value.trim().replace(/\s+/g, " ");
  if (prod.length < 2 && !S.nueFoto) return msg("nueDMsg", "Escriba qué producto buscan o tome una foto de la receta.", true);
  const b = $("nueGuardar"); b.disabled = true; msg("nueDMsg", "Guardando…");
  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    if (S.nueFoto) await setDoc(doc(db, "productos_nuevos_foto", id), { d: S.nueFoto, porUid: S.perfil.uid });
    const reg = { prod: (prod || "(ver foto)").slice(0, 150), tipo: S.nueTipo, cant: Math.max(0, Math.round(+$("nueCant").value || 0)),
      nota: $("nueNota").value.trim().slice(0, 300), suc: miFarm() || "", porUid: S.perfil.uid, porNombre: S.perfil.nombre || S.perfil.usuario || "",
      creado: serverTimestamp(), foto: !!S.nueFoto, tambien: [], estado: "nuevo" };
    await setDoc(doc(db, "productos_nuevos", id), reg);
    if (S.nueFoto) S.nueFotos.set(id, S.nueFoto);
    // listo: se ofrece mandarlo al grupo de WhatsApp (el envío lo confirma la persona en WhatsApp)
    S.nueWa = { id, ...reg }; $("nueDlg").close(); $("nueOkDlg").showModal();
  } catch (x) { msg("nueDMsg", textoError(x), true); }
  finally { b.disabled = false; }
});
$("nueLista").addEventListener("click", async e => {
  const tb = e.target.closest("[data-nuetamb]");
  if (tb) { const d = (S.nue || []).find(x => x.id === tb.dataset.nuetamb); if (!d) return;
    try { await updateDoc(doc(db, "productos_nuevos", d.id), { tambien: [...(d.tambien || []), { suc: miFarm(), porNombre: S.perfil.nombre || S.perfil.usuario || "", f: new Date().toISOString() }] }); toast("Anotado: a su sucursal también se lo pidieron"); }
    catch (x) { toast(textoError(x)); } return; }
  const br = e.target.closest("[data-nueborrar]");
  if (br) { if (!confirm("¿Borrar este registro?")) return; const id = br.dataset.nueborrar;
    try { await deleteDoc(doc(db, "productos_nuevos", id)); deleteDoc(doc(db, "productos_nuevos_foto", id)).catch(() => {}); toast("Registro borrado"); } catch (x) { toast(textoError(x)); } return; }
  const im = e.target.closest(".nue-foto img"); if (im) window.open().document.write(`<title>Foto</title><img src="${im.src}" style="max-width:100%">`);
});
$("nueLista").addEventListener("change", async e => {
  const s = e.target.closest("[data-nueest]"), n = e.target.closest("[data-nuenota]"); if (!s && !n) return;
  try { await updateDoc(doc(db, "productos_nuevos", (s || n).dataset[s ? "nueest" : "nuenota"]), s ? { estado: s.value } : { notaAdmin: n.value.trim().slice(0, 200) }); toast("Guardado"); }
  catch (x) { toast(textoError(x)); }
});
["nueQ", "nueSuc", "nueEst"].forEach(id => $(id).addEventListener("input", () => { S.nueMostrar = 30; pintarNue(); }));
$("nueMas").addEventListener("click", e => { if (e.target.closest("#nueMasBtn")) { S.nueMostrar += 30; pintarNue(); } });
$("nueXls").addEventListener("click", () => {
  const l = filtrosNue(); if (!l.length) return toast("No hay registros para descargar.");
  excelDe(l.map(d => ({ Fecha: fNue(d.creado), Sucursal: d.suc ? corto(d.suc) : "Abastecimiento", Producto: d.prod, Tipo: (NUE_TIPO[d.tipo] || "").replace(/^\S+ /, ""), Cantidad: d.cant || "",
    Nota: d.nota || "", "Registró": d.porNombre || "", "También en": (d.tambien || []).map(t => corto(t.suc)).join(", "), Estado: (NUE_EST[d.estado || "nuevo"] || NUE_EST.nuevo)[0].replace(/^\S+ /, ""), "Nota de Abastecimiento": d.notaAdmin || "", Foto: d.foto ? "sí" : "no" })),
    "Productos buscados", "productos_que_buscan_" + hoyISO());
});

/* ===================== flujograma de abastecimiento ===================== */
// Símbolos estándar: ini/fin (óvalo), proc (rectángulo), sub (proceso predefinido: abre su flujograma), doc (documento),
// io (entrada/salida de datos), dec (decisión: «si» sigue hacia abajo; «no» va al costado y puede volver a un paso).
const FLUJO = [
  { t: "Compras", pasos: [
    { k: "ini", t: "Inicio" },
    { k: "proc", t: "A. Filtro de movimientos de productos en un periodo" },
    { k: "doc", t: "B. Envío de solicitud de cotización", id: "cot" },
    { k: "doc", t: "C. Recepción de propuesta de compra" },
    { k: "proc", t: "D. Evaluación: vencimiento, lotes, fechas, precio" },
    { k: "dec", t: "E. ¿Se confirma?", vuelve: "cot" },
    { k: "proc", t: "Espera de llegada de mercadería (x días)" },
    { k: "fin", t: "Pasa a 2. Recepción y revisión" }] },
  { t: "Recepción y revisión", sub: "Toda operación en droguería", pasos: [
    { k: "ini", t: "Inicio" },
    { k: "proc", t: "A. Recepción de mercadería" },
    { k: "io", t: "B. Registro de llegada" },
    { k: "proc", t: "C. Espera" },
    { k: "proc", t: "D. Revisión de mercadería" },
    { k: "dec", t: "E. ¿Conforme?", no: { k: "proc", t: "Se registra la observación" } },
    { k: "doc", t: "F. Envío de factura a administración" },
    { k: "fin", t: "Pasa a 3. Ingreso y almacenamiento" }] },
  { t: "Ingreso y almacenamiento", sub: "Administración y droguería", pasos: [
    { k: "ini", t: "Inicio" },
    { k: "proc", t: "G. Revisión con la orden de compra (comparación)" },
    { k: "doc", t: "H. Ingreso de la orden de compra" },
    { k: "proc", t: "I. Envío a gerencia: revisión de política, vencimiento y lotes" },
    { k: "proc", t: "J. Finalizar observación" },
    { k: "proc", t: "Separación de productos" },
    { k: "proc", t: "Ingreso de mercadería a almacén (almacenaje)" },
    { k: "fin", t: "Pasa a 4. Distribución" }] },
  { t: "Distribución", vars: [
    { t: "Actual", pasos: [
      { k: "ini", t: "Inicio" },
      { k: "doc", t: "Requerimiento de sucursales" },
      { k: "proc", t: "Revisión en droguería" },
      { k: "proc", t: "Filtrado" },
      { k: "proc", t: "Preparación" },
      { k: "proc", t: "Envío" },
      { k: "fin", t: "Entrega" }] },
    { t: "Futuro", pasos: [
      { k: "ini", t: "Inicio" },
      { k: "proc", t: "Evaluación de desabastecimiento", r: "Carlos" },
      { k: "doc", t: "Lista de atención", r: "Carlos" },
      { k: "io", t: "Ingreso a sistema", r: "Carlos" },
      { k: "proc", t: "Preparación", r: "Droguería" },
      { k: "proc", t: "Envío y entrega" },
      { k: "proc", t: "Evaluación de productos faltantes" },
      { k: "proc", t: "Seguimiento de productos pendientes" },
      { k: "doc", t: "Envío de faltantes a compras o gerencia" },
      { k: "dec", t: "¿Compras da respuesta?", no: { k: "proc", t: "Se espera" } },
      { k: "proc", t: "Se abastece" },
      { k: "fin", t: "Fin" }] }] }];
const FL_COL = { ini: ["#FFF3B0", "#B89400"], fin: ["#FFF3B0", "#B89400"], proc: ["#ECE6F7", "#7A64A8"], sub: ["#ECE6F7", "#5B2D6E"], doc: ["#DCEBFF", "#2F6FD0"], io: ["#FFE6CC", "#D9730D"], dec: ["#FFE3D3", "#D9602A"] };
const flLineas = (t, n) => { const out = []; let l = ""; for (const w of String(t).split(" ")) { if ((l + " " + w).trim().length > n && l) { out.push(l); l = w; } else l = (l + " " + w).trim(); } if (l) out.push(l); return out; };
// una figura centrada en (x, y) de ancho w y alto h, con su texto (y el responsable debajo, más chico)
function flFig(k, x, y, w, h, t, r, extra = "") {
  const [f, c] = FL_COL[k], x0 = x - w / 2, y0 = y - h / 2; let sh;
  if (k === "ini" || k === "fin") sh = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="${h / 2}" fill="${f}" stroke="${c}" stroke-width="2"/>`;
  else if (k === "dec") sh = `<polygon points="${x},${y0} ${x0 + w},${y} ${x},${y0 + h} ${x0},${y}" fill="${f}" stroke="${c}" stroke-width="2"/>`;
  else if (k === "io") sh = `<polygon points="${x0 + 18},${y0} ${x0 + w},${y0} ${x0 + w - 18},${y0 + h} ${x0},${y0 + h}" fill="${f}" stroke="${c}" stroke-width="2"/>`;
  else if (k === "doc") sh = `<path d="M${x0},${y0} H${x0 + w} V${y0 + h - 8} C${x0 + w * .75},${y0 + h - 22} ${x0 + w * .25},${y0 + h + 8} ${x0},${y0 + h - 8} Z" fill="${f}" stroke="${c}" stroke-width="2"/>`;
  else sh = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="4" fill="${f}" stroke="${c}" stroke-width="2"/>` + (k === "sub" ? `<line x1="${x0 + 12}" y1="${y0}" x2="${x0 + 12}" y2="${y0 + h}" stroke="${c}" stroke-width="2"/><line x1="${x0 + w - 12}" y1="${y0}" x2="${x0 + w - 12}" y2="${y0 + h}" stroke="${c}" stroke-width="2"/>` : "");
  const ls = flLineas(t, k === "dec" ? 16 : k === "sub" ? 18 : 26), lh = 16, tot = ls.length * lh + (r ? 14 : 0), ty = y - tot / 2 + 12 - (k === "doc" ? 4 : 0);
  return `<g${extra}>${sh}${ls.map((l, i) => `<text x="${x}" y="${ty + i * lh}" text-anchor="middle" class="fl-t">${esc(l)}</text>`).join("")}${r ? `<text x="${x}" y="${ty + ls.length * lh}" text-anchor="middle" class="fl-r">👤 ${esc(r)}</text>` : ""}</g>`;
}
const flFlecha = pts => `<polyline points="${pts.map(p => p.join(",")).join(" ")}" fill="none" stroke="#475467" stroke-width="1.8" marker-end="url(#flPunta)"/>`;
const FL_DEFS = '<defs><marker id="flPunta" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#475467"/></marker></defs>';
const flAlto = p => p.k === "dec" ? 110 : p.k === "ini" || p.k === "fin" ? 48 : Math.max(58, flLineas(p.t, 26).length * 16 + (p.r ? 14 : 0) + 22);
// flujograma general: Inicio → 4 procesos (clic para abrir) → Fin; horizontal en pantalla ancha, vertical en el celular
function flGeneral() {
  const ancho = $("flMapa").clientWidth || 1000, hor = ancho > 760, nodos = [{ k: "ini", t: "Inicio" }, ...FLUJO.map((f, i) => ({ k: "sub", t: `${i + 1}. ${f.t}${f.sub ? ` (${f.sub})` : ""}`, i })), { k: "fin", t: "Fin" }];
  let g = "", W, H;
  if (hor) {
    const ws = nodos.map(n => n.k === "sub" ? 170 : 96), gap = 46; W = ws.reduce((a, b) => a + b, 0) + gap * (nodos.length - 1) + 20; H = 130; let x = 10;
    nodos.forEach((n, j) => { const cx = x + ws[j] / 2; g += flFig(n.k, cx, 65, ws[j], n.k === "sub" ? 96 : 50, n.t, "", n.k === "sub" ? ` class="fl-clic${S.flSel === n.i ? " sel" : ""}" data-flp="${n.i}"` : "");
      if (j < nodos.length - 1) g += flFlecha([[x + ws[j] + 2, 65], [x + ws[j] + gap - 2, 65]]); x += ws[j] + gap; });
  } else {
    W = 320; let y = 10; H = 0; const hs = nodos.map(n => n.k === "sub" ? 80 : 46), gap = 30;
    nodos.forEach((n, j) => { const cy = y + hs[j] / 2; g += flFig(n.k, 160, cy, n.k === "sub" ? 260 : 130, hs[j], n.t, "", n.k === "sub" ? ` class="fl-clic${S.flSel === n.i ? " sel" : ""}" data-flp="${n.i}"` : "");
      if (j < nodos.length - 1) g += flFlecha([[160, y + hs[j] + 2], [160, y + hs[j] + gap - 2]]); y += hs[j] + gap; });
    H = y - gap + 10;
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="fl-svg" style="max-width:${W}px">${FL_DEFS}${g}</svg>`;
}
// flujograma de un proceso: columna principal; el «no» de cada decisión va a la derecha y vuelve al paso indicado
function flDetalle(f) {
  const cx = 170, sx = 430, wP = 250, wS = 190, gap = 34; let y = 12, g = ""; const pos = {}, vueltas = [];
  f.pasos.forEach((p, j) => {
    const h = flAlto(p), cy = y + h / 2, w = p.k === "dec" ? 220 : p.k === "ini" || p.k === "fin" ? 200 : wP;
    g += flFig(p.k, cx, cy, w, h, p.t, p.r); if (p.id) pos[p.id] = { cy, w };
    if (p.k === "dec" && p.no) {
      const hn = flAlto(p.no); g += flFig(p.no.k, sx, cy, wS, hn, p.no.t, p.no.r);
      g += flFlecha([[cx + w / 2, cy], [sx - wS / 2 - 2, cy]]) + `<text x="${cx + w / 2 + 10}" y="${cy - 6}" class="fl-no">No</text>`;
      if (p.vuelve) vueltas.push({ desde: cy - hn / 2, a: p.vuelve });
    } else if (p.k === "dec" && p.vuelve) {
      g += `<polyline points="${cx + w / 2},${cy} ${sx},${cy}" fill="none" stroke="#475467" stroke-width="1.8"/><text x="${cx + w / 2 + 10}" y="${cy - 6}" class="fl-no">No</text>`;
      vueltas.push({ desde: cy + 2, a: p.vuelve });
    }
    if (j < f.pasos.length - 1) { g += flFlecha([[cx, y + h + 2], [cx, y + h + gap - 2]]); if (p.k === "dec") g += `<text x="${cx + 8}" y="${y + h + 20}" class="fl-si">Sí</text>`; }
    y += h + gap;
  });
  for (const v of vueltas) { const d = pos[v.a]; if (d) g += flFlecha([[sx, v.desde - 2], [sx, d.cy], [cx + d.w / 2 + 2, d.cy]]); }
  return `<svg viewBox="0 0 560 ${y - gap + 14}" class="fl-svg" style="max-width:560px">${FL_DEFS}${g}</svg>`;
}
const FL_LEY = [["ini", "Inicio / fin"], ["sub", "Proceso (clic para abrir)"], ["proc", "Actividad"], ["doc", "Documento"], ["dec", "Decisión"], ["io", "Registro de datos"]];
S.flSel = -1;
function pintarFlujo() {
  $("flMapa").innerHTML = `<h3 class="fl-h">Flujograma general</h3>${flGeneral()}`;
  $("flLey").innerHTML = FL_LEY.map(([k, t]) => `<span><svg viewBox="0 0 60 34" width="46" height="26">${flFig(k, 30, 17, k === "dec" ? 44 : 54, k === "dec" ? 32 : 26, "", "")}</svg>${t}</span>`).join("");
  $("flDet").innerHTML = S.flSel < 0 ? '<p class="muted fl-ayuda">👆 Haga clic en uno de los 4 procesos para abrir su flujograma con sus subprocesos.</p>'
    : (f => `<section class="card fl-col"><div class="fl-cab"><h3>${S.flSel + 1}. ${esc(f.t)}${f.sub ? ` <small class="muted">(${esc(f.sub)})</small>` : ""}</h3><button class="btn sm fl-no-imp" type="button" id="flCerrar">← Volver al general</button></div>
      ${f.vars ? `<div class="fl-vars">${f.vars.map(v => `<div><h4 class="fl-var">${esc(v.t)}</h4>${flDetalle(v)}</div>`).join("")}</div>` : flDetalle(f)}</section>`)(FLUJO[S.flSel]);
}
$("flMapa").addEventListener("click", e => { const b = e.target.closest("[data-flp]"); if (!b) return; S.flSel = S.flSel === +b.dataset.flp ? -1 : +b.dataset.flp; pintarFlujo(); if (S.flSel >= 0) $("flDet").scrollIntoView({ behavior: "smooth", block: "start" }); });
$("flDet").addEventListener("click", e => { if (e.target.closest("#flCerrar")) { S.flSel = -1; pintarFlujo(); } });
addEventListener("resize", () => { if (S.vista === "vFlujo") pintarFlujo(); });
$("flImp").addEventListener("click", () => print());
$("flPant").addEventListener("click", () => { const el = $("vFlujo"); (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.())?.catch?.(() => {}); });

/* filtros tipo Excel en las tablas: fx.js (compartido con los módulos del kardex) */
const fxAplicar = (...a) => window.fxAplicar(...a);
/* ===================== lo que ve cada sucursal en «Lo que me van a atender» ===================== */
// aten_vis/{SUCURSAL} = { tipos: ["A","B",…] (sin el campo: todos), ocultos: [códigos], mostrar: [códigos que se ven aunque su tipo no] }
const AT_TIPOS = ["A", "B", "C", "D", "E"];
function visAten(i) {
  const V = S.atVis; if (!V) return true;
  if ((V.mostrar || []).includes(i.c)) return true;
  if ((V.ocultos || []).includes(i.c)) return false;
  return !V.tipos || V.tipos.includes(i.cat || "E");
}
function pintarVisAten(todos) {
  const box = $("atVisBox"), admin = esAdmin(); box.hidden = !admin || !todos.length; if (box.hidden) return;
  const V = S.atVis || {}, tipos = V.tipos || AT_TIPOS, n = todos.filter(visAten).length, porT = t => todos.filter(i => (i.cat || "E") === t).length;
  box.innerHTML = `<b>Lo que ve la sucursal:</b>
    <span class="at-vis-tipos">${AT_TIPOS.map(t => `<label class="check"><input type="checkbox" data-attipo="${t}" ${tipos.includes(t) ? "checked" : ""}> <span class="at-cat ${t}">${t}</span> <small class="muted">${nf(porT(t))}</small></label>`).join("")}</span>
    <span class="muted">· ve <b>${nf(n)}</b> de ${nf(todos.length)} productos${(V.ocultos || []).length ? ` · ${nf(V.ocultos.length)} ocultos uno por uno` : ""}${(V.mostrar || []).length ? ` · ${nf(V.mostrar.length)} mostrados aparte` : ""}</span>
    ${S.atVis ? '<button type="button" class="btn sm" id="atVisReset">Mostrar todo</button>' : ""}
    <small class="muted at-vis-ayuda">Marque los tipos que verá la sucursal. Con el botón de la última columna puede ocultar o mostrar productos uno por uno.</small>`;
}
async function guardarVisAten(cambio) {
  const suc = S.atSuc || FARMACIAS[0], V = S.atVis || {};
  const nuevo = { tipos: V.tipos || AT_TIPOS, ocultos: V.ocultos || [], mostrar: V.mostrar || [], ...cambio };
  try { await setDoc(doc(db, "aten_vis", suc), { ...nuevo, porNombre: S.perfil.nombre || S.perfil.usuario || "", actualizado: serverTimestamp() }); S.atVis = nuevo; pintarAten(); }
  catch (e) { toast(textoError(e)); }
}
$("atVisBox").addEventListener("change", e => {
  const t = e.target.closest("[data-attipo]"); if (!t) return;
  const tipos = [...$("atVisBox").querySelectorAll("[data-attipo]")].filter(x => x.checked).map(x => x.dataset.attipo);
  // al cambiar los tipos, los productos sueltos de esos tipos vuelven a seguir la regla general
  const V = S.atVis || {}, cat = new Map((S.aten?.items || []).map(i => [i.c, i.cat || "E"]));
  guardarVisAten({ tipos, ocultos: (V.ocultos || []).filter(c => cat.get(c) !== t.dataset.attipo), mostrar: (V.mostrar || []).filter(c => cat.get(c) !== t.dataset.attipo) });
});
$("atVisBox").addEventListener("click", async e => {
  if (!e.target.closest("#atVisReset")) return;
  if (!confirm("¿Volver a mostrar todo a la sucursal?")) return;
  try { await deleteDoc(doc(db, "aten_vis", S.atSuc || FARMACIAS[0])); S.atVis = null; pintarAten(); } catch (x) { toast(textoError(x)); }
});
$("atTabla").addEventListener("click", e => {
  const b = e.target.closest("[data-atvis]"); if (!b) return;
  const i = (S.aten?.items || []).find(x => x.c === b.dataset.atvis); if (!i) return;
  const V = S.atVis || {}, tipos = V.tipos || AT_TIPOS, porTipo = tipos.includes(i.cat || "E");
  let ocultos = (V.ocultos || []).filter(c => c !== i.c), mostrar = (V.mostrar || []).filter(c => c !== i.c);
  if (visAten(i)) { if (porTipo) ocultos.push(i.c); }   // ocultar: si su tipo es visible, se oculta aparte
  else if (!porTipo) mostrar.push(i.c);                 // mostrar: si su tipo está oculto, se muestra aparte
  guardarVisAten({ ocultos, mostrar });
});

/* ===================== busca en la red (catálogos de otras farmacias) ===================== */
// data/competencia/<tienda>.json = { fecha, p: { id: [nombre, marca, presentación, unidades, precio, oferta, tarjeta, url] } }
// (los descarga cada noche scripts/precios_competencia.py). El nombre de cada tienda se muestra disfrazado.
const RED_TIENDAS = [["mifarma", "mi.far.ma"], ["inkafarma", "in.ka.far.ma"], ["boticasperu", "bo.ti.cas.pe.ru"], ["farmaciaslider", "far.ma.cias.li.der"],
  ["universal", "u.ni.ver.sal"], ["boticasysalud", "bo.ti.ca.sa.lud"]];
async function cargarRedComp() {
  if (S.red2) return S.red2; if (S.red2P) return S.red2P;
  S.red2P = Promise.all(RED_TIENDAS.map(async ([a, alias]) => {
    try { const r = await fetch(`data/competencia/${a}.json?d=${hoyISO()}`); if (!r.ok) return [];
      const j = await r.json(); return Object.values(j.p || {}).map(x => ({ n: String(x[0] || ""), m: String(x[1] || ""), pr: x[4], of: x[5], t: alias, k: norm(x[0] + " " + (x[1] || "")) }));
    } catch { return []; }
  })).then(l => (S.red2 = l.flat()));
  return S.red2P;
}
let redT = 0;
$("redQ").addEventListener("input", () => { clearTimeout(redT); redT = setTimeout(buscarRed, 250); });
async function buscarRed() {
  const q = norm($("redQ").value).trim(), box = $("redRes");
  if (q.length < 3) { box.innerHTML = q ? '<p class="muted">Escriba al menos 3 letras.</p>' : ""; return; }
  if (!S.red2) box.innerHTML = '<p class="muted">Cargando los catálogos…</p>';
  const todos = await cargarRedComp(), ws = q.split(/\s+/);
  if (norm($("redQ").value).trim() !== q) return;
  const hall = todos.filter(x => ws.every(w => x.k.includes(w)));
  // el mismo producto en varias tiendas: se junta en una fila («Vendido por mi.farma · inka.farma»)
  const g = new Map();
  for (const x of hall) { const k = norm(x.n).replace(/[^A-Z0-9]+/g, " ").trim(); const a = g.get(k) || { n: x.n, m: x.m, t: [] }; if (!a.m && x.m) a.m = x.m; a.t.push(x); g.set(k, a); }
  const lista = [...g.values()].sort((a, b) => (norm(b.n).startsWith(ws[0]) - norm(a.n).startsWith(ws[0])) || b.t.length - a.t.length || a.n.localeCompare(b.n, "es")).slice(0, 60);
  S.redLista = lista;
  box.innerHTML = lista.length ? `<p class="muted">${nf(g.size)} ${g.size === 1 ? "producto" : "productos"}${g.size > 60 ? " · se muestran los primeros 60" : ""}</p>` + lista.map((a, j) => `<div class="red-item"><button type="button" class="btn sm red-add" data-redadd="${j}" title="Registrar este producto como buscado por un cliente">➕ Añadir</button>
      <b>${esc(a.n)}</b>${a.m ? `<small>LAB. ${esc(a.m.toUpperCase())}</small>` : ""}
      <span class="red-por">Vendido por ${[...new Map(a.t.map(x => [x.t, x])).values()].map(x => `<em>${esc(x.t)}</em>`).join(", ")}</span></div>`).join("")
    : '<p class="muted">Ninguna farmacia de la red lo tiene en su catálogo.</p>';
}
// «Añadir» en un resultado de la red: abre el registro con el nombre (y el laboratorio en la nota) ya puestos
$("redRes").addEventListener("click", e => {
  const b = e.target.closest("[data-redadd]"); if (!b) return; const a = S.redLista?.[+b.dataset.redadd]; if (!a) return;
  abrirNue(); $("nueProd").value = a.n.slice(0, 150); if (a.m) $("nueNota").value = ("Lab. " + a.m).slice(0, 300);
  $("nueProd").dispatchEvent(new Event("input"));
});

// WhatsApp: no se puede publicar solo en un grupo; se abre WhatsApp con el mensaje armado (y la foto, si el teléfono deja
// compartir archivos) para que la persona elija el grupo y lo envíe
function textoWa(d) {
  return [`🔎 *Producto que busca un cliente*`, `*${d.prod}*`, `${(NUE_TIPO[d.tipo] || "").replace(/^\S+ /, "")}${d.cant ? ` · pedían ${d.cant}` : ""}`,
    d.nota ? `📝 ${d.nota}` : "", `🏪 ${d.suc ? corto(d.suc) : "Abastecimiento"} · ${d.porNombre || ""}`, `Ver en la página: ${location.origin}`].filter(Boolean).join("\n");
}
async function compartirWa(d) {
  const texto = textoWa(d), foto = d.foto ? S.nueFotos.get(d.id) : "";
  if (foto && navigator.canShare) {
    try {
      const blob = await (await fetch(foto)).blob(), file = new File([blob], "receta.jpg", { type: blob.type || "image/jpeg" });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text: texto }); return; }
    } catch (e) { if (e?.name === "AbortError") return; }
  }
  window.open("https://wa.me/?text=" + encodeURIComponent(texto), "_blank");
}
$("nueOkDlg").addEventListener("click", e => {
  if (e.target.closest("#nueOkWa")) { compartirWa(S.nueWa); $("nueOkDlg").close(); return; }
  if (e.target.closest("[data-cerrar-dlg]") || e.target === $("nueOkDlg")) $("nueOkDlg").close();
});
$("nueLista").addEventListener("click", e => {
  const b = e.target.closest("[data-nuewa]"); if (!b) return; const d = (S.nue || []).find(x => x.id === b.dataset.nuewa); if (d) compartirWa(d);
});

/* ===================== instalar como app en el celular ===================== */
// Android/Chrome: botón «Descargar la app» (el aviso de instalación del navegador). iPhone: se explica cómo agregarla a inicio.
const enApp = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const esIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent), esCel = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
let pedirInstalar = null;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
function mostrarInstalar() {
  let no = false; try { no = localStorage.getItem("inst_no") === "1"; } catch {}
  const directo = new URLSearchParams(location.search).has("m");
  $("instalar").hidden = !esCel || enApp() || (no && !directo) || !(pedirInstalar || esIOS);
  if (esIOS && !pedirInstalar) { $("instTxt").innerHTML = "📲 Para instalar la app: toque <b>Compartir</b> (el cuadro con flecha ⬆) y luego <b>«Agregar a inicio»</b>."; $("instBtn").hidden = true; }
}
addEventListener("beforeinstallprompt", e => { e.preventDefault(); pedirInstalar = e; mostrarInstalar(); });
addEventListener("appinstalled", () => { pedirInstalar = null; $("instalar").hidden = true; toast("App instalada: búsquela en la pantalla de su celular"); });
$("instBtn").addEventListener("click", async () => { if (!pedirInstalar) return; pedirInstalar.prompt(); await pedirInstalar.userChoice.catch(() => {}); pedirInstalar = null; mostrarInstalar(); });
$("instNo").addEventListener("click", () => { $("instalar").hidden = true; try { localStorage.setItem("inst_no", "1"); } catch {} });
mostrarInstalar();
// administrador: copiar el enlace del módulo para mandarlo a las sucursales
$("nueLink")?.addEventListener("click", async () => {
  const url = location.origin + location.pathname + "?m=nuevos";
  try { await navigator.clipboard.writeText(url); toast("Enlace copiado: " + url); } catch { prompt("Copie este enlace:", url); }
});

/* ===================== menú plegable en el celular ===================== */
// En pantallas angostas el menú de módulos se esconde detrás de «☰ <módulo actual>»; al elegir uno se vuelve a plegar.
function pintarMenuBtn() {
  const v = VISTAS.find(x => x.vista === S.vista);
  $("menuTxt").textContent = S.vista === "vInicio" ? "Menú principal" : v ? v.nombre : S.vista === "vQuimico" || S.vista === "vAdmin" ? "Bloqueos" : S.vista === "vUsuarios" ? "Usuarios" : "Menú";
}
// se cierra al hacer clic fuera del menú o con Esc
document.addEventListener("click", e => { if (document.body.classList.contains("nav-abierta") && !e.target.closest("#nav, #menuBtn")) { document.body.classList.remove("nav-abierta"); $("menuBtn").setAttribute("aria-expanded", "false"); } });
document.addEventListener("keydown", e => { if (e.key === "Escape" && document.body.classList.contains("nav-abierta")) { document.body.classList.remove("nav-abierta"); $("menuBtn").setAttribute("aria-expanded", "false"); } });
$("menuBtn").addEventListener("click", () => { const ab = document.body.classList.toggle("nav-abierta"); $("menuBtn").setAttribute("aria-expanded", ab); });
$("nav").addEventListener("click", e => {
  if (!e.target.closest("[data-ir]")) return;
  document.body.classList.remove("nav-abierta"); $("menuBtn").setAttribute("aria-expanded", "false");
  // ir al menú principal desde el modo celular: se deja de abrir directo el módulo
  if (e.target.closest("[data-ir]").dataset.ir === "vInicio") { try { localStorage.removeItem("modo_m"); } catch {} document.body.classList.remove("modo-cel"); }
});

/* ===================== aviso cuando otro registra un producto buscado ===================== */
// Con la página abierta (aunque esté en otra pestaña o minimizada): sonido, notificación del navegador y número en el menú.
const nueMs = d => d.creado?.toMillis?.() || 0;
const nueVisto = () => { try { return +localStorage.getItem("nue_visto") || 0; } catch { return 0; } };
const nueSinVer = () => (S.nue || []).filter(d => d.porUid !== S.perfil?.uid && nueMs(d) > nueVisto()).length;
function marcarNueVisto() {
  const m = Math.max(0, ...(S.nue || []).map(nueMs)); if (!m) return;
  try { if (m > nueVisto()) { localStorage.setItem("nue_visto", String(m)); pintarNav(); } } catch {}
  if (document.title.startsWith("(")) document.title = document.title.replace(/^\(\d+\)\s*/, "");
}
let audioCtx = null;
// el navegador solo deja sonar después de que la persona tocó la página alguna vez
addEventListener("pointerdown", () => { try { audioCtx ??= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {} }, { once: true });
function sonarAviso() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [[880, 0], [1320, 0.13]].forEach(([f, d]) => {   // «ding-ding» corto, como un mensaje
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.28);
      o.start(t + d); o.stop(t + d + 0.3);
    });
  } catch {}
  try { navigator.vibrate?.([120, 80, 120]); } catch {}
}
function alertarNue(d) {
  sonarAviso();
  const quien = `${d.suc ? corto(d.suc) : "Abastecimiento"} · ${d.porNombre || ""}`;
  toast(`🔔 Nuevo: ${d.prod} (${quien})`);
  if (S.vista !== "vNue" || document.hidden) {
    const n = nueSinVer(); document.title = `(${n || 1}) ` + document.title.replace(/^\(\d+\)\s*/, "");
  }
  if ("Notification" in window && Notification.permission === "granted" && (document.hidden || S.vista !== "vNue")) {
    try {
      const nt = new Notification("🔎 Producto que busca un cliente", { body: `${d.prod}\n${quien}`, icon: "iconos/icono-192.png", tag: "nue-" + d.id });
      nt.onclick = () => { focus(); ir("vNue"); nt.close(); };
    } catch {}
  }
}
addEventListener("focus", () => { if (S.vista === "vNue") marcarNueVisto(); });
// botón para activar las notificaciones del navegador (lo tiene que pedir la persona con un toque)
function pintarAlertasBtn() {
  const b = $("nueAlertas"); if (!b) return;
  const p = "Notification" in window ? Notification.permission : "no";
  b.hidden = p === "granted" || p === "no";
  b.textContent = p === "denied" ? "🔕 Notificaciones bloqueadas en este navegador" : "🔔 Activar alertas";
  b.disabled = p === "denied";
}
$("nueAlertas").addEventListener("click", async () => {
  sonarAviso();   // de paso prueba el sonido
  try { await Notification.requestPermission(); } catch {}
  pintarAlertasBtn();
  if (Notification.permission === "granted") toast("Alertas activadas: sonará cuando otra sucursal registre algo");
});
pintarAlertasBtn();

/* ===================== editor de flujogramas ===================== */
// flujogramas/{id} = { nombre, nodos: [...], lineas: [...], actualizado, porNombre } (el dibujo lo maneja flued.js)
let FE = null;
S.fe = { lista: [], id: "", guardado: true };
const feIcono = k => `<svg viewBox="0 0 44 30" class="fe-ico">${svgDe({ nodos: [{ id: "i", k, x: 22, y: 15, w: k === "con" ? 22 : 38, h: k === "con" ? 22 : 22, t: k === "texto" ? "Aa" : "", c: "" }], lineas: [] }, {}, [0, 0, 44, 30]).replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg>`;
async function abrirFlued() {
  if (!FE) {
    // el panel se vuelve a pintar al cambiar de selección (no mientras se escribe en él)
    FE = crearEditor($("feLienzo"), { alCambiar: () => { if (!S.fe.escribiendo) pintarFeProps(); pintarFeTot(); feSucio(); } });
    $("fePaleta").innerHTML = FORMAS.map(([k, t]) => `<button type="button" class="fe-forma" data-feadd="${k}" title="${esc(t)}">${feIcono(k)}<small>${esc(t)}</small></button>`).join("");
    $("feLienzo").addEventListener("fe-editar", () => setTimeout(() => $("feTxt")?.focus(), 30));
  }
  if (S.fe.listo) return;   // render() se llama seguido: la lista se lee una sola vez
  S.fe.listo = true;
  try {
    const q = await getDocs(collection(db, "flujogramas"));
    S.fe.lista = q.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), "es"));
    // la primera vez se guarda el flujograma que se venía armando en SmartDraw
    if (!S.fe.lista.length && !S.prev) {
      const id = "abastecimiento-" + Date.now().toString(36), d = { nombre: "Flujograma de abastecimiento (SmartDraw)", ...ejemploAbastecimiento() };
      await setDoc(doc(db, "flujogramas", id), { ...d, actualizado: serverTimestamp(), porNombre: S.perfil.nombre || S.perfil.usuario || "" });
      S.fe.lista = [{ id, ...d }];
    }
    msg("feMsg", "");
  } catch (e) { msg("feMsg", textoError(e), true); }
  if (!S.fe.id || !S.fe.lista.some(x => x.id === S.fe.id)) feCargar(S.fe.lista[0]?.id || "");
  pintarFeLista();
}
function pintarFeLista() {
  $("feSel").innerHTML = S.fe.lista.length ? S.fe.lista.map(x => `<option value="${esc(x.id)}" ${x.id === S.fe.id ? "selected" : ""}>${esc(x.nombre || "Sin nombre")}</option>`).join("") : '<option value="">(sin flujogramas)</option>';
}
function feCargar(id) {
  const d = S.fe.lista.find(x => x.id === id); S.fe.id = id; S.fe.guardado = true;
  FE.cargar(d || { nodos: [], lineas: [] }); pintarFeEstado(); pintarFeProps(); pintarFeTot();
}
let feT = 0;
function feSucio() { S.fe.guardado = false; pintarFeEstado(); clearTimeout(feT); feT = setTimeout(feGuardar, 1500); }   // se guarda solo
async function feGuardar() {
  if (!S.fe.id || S.fe.guardado) return;
  const d = FE.datos(), x = S.fe.lista.find(y => y.id === S.fe.id); if (!x) return;
  $("feEstado").textContent = "Guardando…";
  try {
    await setDoc(doc(db, "flujogramas", S.fe.id), { nombre: x.nombre, nodos: d.nodos, lineas: d.lineas, areas: d.areas || [], actualizado: serverTimestamp(), porNombre: S.perfil.nombre || S.perfil.usuario || "" });
    Object.assign(x, d); S.fe.guardado = true;
  } catch (e) { toast(textoError(e)); }
  pintarFeEstado();
}
const pintarFeTot = () => { const t = FE ? totalMin(FE.datos()) : 0; $("feTot").textContent = t ? "⏱ Total: " + fmtMin(t) : ""; };
const pintarFeEstado = () => { $("feEstado").textContent = S.fe.guardado ? "✓ Guardado" : "Cambios sin guardar…"; $("feEstado").className = "fe-estado" + (S.fe.guardado ? " ok" : ""); };
function pintarFeProps() {
  const n = FE.nodoSel(), l = FE.lineaSel(), box = $("feProps");
  $("feCon").setAttribute("aria-pressed", FE.modo() === "con");
  $("feAyuda").textContent = FE.modo() === "con" ? (FE.sel().a ? "Ahora toque la figura de destino." : "Toque la figura de origen.") : "";
  if (n) {
    box.innerHTML = `<h4>Figura</h4>
      <label>Texto<textarea id="feTxt" rows="3">${esc(n.t)}</textarea></label>
      <label>Tiempo</label><div class="fe-dos"><input id="feTm" type="number" min="0" step="any" value="${esc(isNaN(parseFloat(n.tm)) ? "" : n.tm)}" placeholder="p. ej. 15">
        <select id="feTu">${UNIDADES.map(([k, t]) => `<option value="${k}" ${(n.tu || "min") === k ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <label>Forma<select id="feK">${FORMAS.map(([k, t]) => `<option value="${k}" ${k === n.k ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
      <label>Área (color)</label>
      <div class="fe-areas">${COLORES.map(c => { const a = FE.areas().find(x => x.c === c); return `<button type="button" data-fecol="${c}" class="${(n.c || "#FFFFFF") === c ? "sel" : ""}"><i style="background:${c}"></i>${c === "#FFFFFF" ? "Sin área" : esc(a?.n || "(sin nombre)")}</button>`; }).join("")}</div>
      <div class="fe-dos"><label>Ancho<input id="feW" type="number" value="${n.w}" min="30"></label><label>Alto<input id="feH" type="number" value="${n.h}" min="24"></label></div>
      <div class="fe-bots"><button type="button" class="btn sm" id="feDup">⧉ Duplicar</button><button type="button" class="btn sm peligro" id="feBorrar">🗑 Borrar</button></div>`;
  } else if (l) {
    const lados = (id, v) => `<div class="fe-lados" data-felado="${id}">${[["", "Auto"], ["t", "↑"], ["r", "→"], ["b", "↓"], ["l", "←"]].map(([k, t]) => `<button type="button" data-v="${k}" aria-pressed="${(v || "") === k}">${t}</button>`).join("")}</div>`;
    box.innerHTML = `<h4>Flecha</h4>
      <label>Etiqueta<input id="feLt" value="${esc(l.t || "")}" placeholder="Sí, No…"></label>
      <div class="fe-bots"><button type="button" class="btn sm" data-felt="Sí">Sí</button><button type="button" class="btn sm" data-felt="No">No</button><button type="button" class="btn sm" data-felt="">Sin texto</button></div>
      <label>Sale por</label>${lados("pa", l.pa)}<label>Llega por</label>${lados("pb", l.pb)}
      <div class="fe-bots"><button type="button" class="btn sm" id="feInv">⇄ Invertir</button><button type="button" class="btn sm peligro" id="feBorrar">🗑 Borrar</button></div>`;
  } else box.innerHTML = `<h4>Áreas de la leyenda</h4><p class="muted fe-mini">Cada color es un área. Escriba el nombre; en la leyenda salen las áreas con nombre que se usan.</p>
      <div class="fe-arealist">${FE.areas().map((a, i) => `<label class="fe-arow"><i style="background:${a.c}"></i><input data-feareai="${i}" value="${esc(a.n)}" placeholder="Nombre del área"></label>`).join("")}</div>
      <h4 style="margin-top:14px">Cómo se usa</h4><ul class="fe-guia">
      <li><b>Agregar:</b> toque una figura de la izquierda. Si tiene una figura elegida, la nueva se pone a su lado y se conecta sola.</li>
      <li><b>Mover:</b> arrastre la figura. <b>Tamaño:</b> el cuadrito verde de la esquina.</li>
      <li><b>Flechas:</b> «↗ Conectar» y toque origen y destino. Toque la flecha para ponerle Sí/No o cambiar por dónde sale y llega.</li>
      <li><b>Texto, tiempo (minutos, horas o días) y área:</b> doble clic en la figura.</li>
      <li><b>Mover el dibujo:</b> arrastre el fondo. <b>Zoom:</b> rueda del mouse o los botones.</li>
      <li><b>Atajos:</b> Supr borra · Ctrl+Z deshace · Ctrl+D duplica · flechas del teclado mueven.</li>
      <li>Se guarda solo.</li></ul>`;
}
$("fePaleta").addEventListener("click", e => { const b = e.target.closest("[data-feadd]"); if (b && FE) FE.agregar(b.dataset.feadd); });
$("feProps").addEventListener("input", e => {
  const id = e.target.id; S.fe.escribiendo = true;
  if (id === "feTxt") FE.cambiar({ t: e.target.value }); else if (id === "feTm") FE.cambiar({ tm: e.target.value === "" ? "" : Math.max(0, +e.target.value || 0) });
  else if (e.target.dataset.feareai != null) FE.ponerArea(+e.target.dataset.feareai, { n: e.target.value.slice(0, 40) });
  else if (id === "feW" || id === "feH") FE.cambiar({ [id === "feW" ? "w" : "h"]: Math.max(24, +e.target.value || 0) });
  else if (id === "feLt") FE.cambiar({ t: e.target.value });
  S.fe.escribiendo = false;
});
$("feProps").addEventListener("change", e => { if (e.target.id === "feK") FE.cambiar({ k: e.target.value }); else if (e.target.id === "feTu") FE.cambiar({ tu: e.target.value }); });
$("feProps").addEventListener("click", e => {
  const c = e.target.closest("[data-fecol]"); if (c) return FE.cambiar({ c: c.dataset.fecol === "#FFFFFF" ? "" : c.dataset.fecol });
  const lt = e.target.closest("[data-felt]"); if (lt) return FE.cambiar({ t: lt.dataset.felt });
  const ld = e.target.closest("[data-felado] [data-v]"); if (ld) return FE.cambiar({ [ld.closest("[data-felado]").dataset.felado]: ld.dataset.v });
  if (e.target.closest("#feDup")) return FE.duplicar();
  if (e.target.closest("#feInv")) return FE.invertir();
  if (e.target.closest("#feBorrar")) return FE.borrar();
});
$("feCon").addEventListener("click", () => FE.conectar());
$("feDes").addEventListener("click", () => FE.deshacer());
$("feReh").addEventListener("click", () => FE.rehacer());
$("feMas").addEventListener("click", () => FE.zoom(1 / 1.25));
$("feMenos").addEventListener("click", () => FE.zoom(1.25));
$("feAjus").addEventListener("click", () => FE.ajustar());
$("fe100").addEventListener("click", () => FE.real());
// pantalla completa: el editor ocupa toda la pantalla (Esc o el mismo botón para salir)
function fePantalla(on) {
  document.body.classList.toggle("fe-full", on); $("feFull").textContent = on ? "✕ Salir de pantalla completa" : "⛶ Pantalla completa";
  try { if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {}); else if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); } catch {}
}
$("feFull").addEventListener("click", () => fePantalla(!document.body.classList.contains("fe-full")));
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && document.body.classList.contains("fe-full")) fePantalla(false); });
$("feSel").addEventListener("change", async e => { await feGuardar(); feCargar(e.target.value); });
$("feNuevo").addEventListener("click", async () => {
  const nombre = prompt("Nombre del nuevo flujograma:", "Nuevo flujograma"); if (!nombre) return;
  await feGuardar();
  const id = "f-" + Date.now().toString(36), d = { nombre: nombre.trim().slice(0, 80), nodos: [{ id: "ini", k: "term", x: 200, y: 200, w: 100, h: 40, t: "Inicio", tm: "", c: "" }], lineas: [] };
  try { await setDoc(doc(db, "flujogramas", id), { ...d, actualizado: serverTimestamp(), porNombre: S.perfil.nombre || S.perfil.usuario || "" }); S.fe.lista.push({ id, ...d }); pintarFeLista(); feCargar(id); pintarFeLista(); }
  catch (x) { toast(textoError(x)); }
});
$("feRen").addEventListener("click", async () => {
  const x = S.fe.lista.find(y => y.id === S.fe.id); if (!x) return;
  const nombre = prompt("Nuevo nombre:", x.nombre); if (!nombre) return;
  x.nombre = nombre.trim().slice(0, 80); S.fe.guardado = false; await feGuardar(); pintarFeLista();
});
$("feCopia").addEventListener("click", async () => {
  const x = S.fe.lista.find(y => y.id === S.fe.id); if (!x) return; await feGuardar();
  const id = "f-" + Date.now().toString(36), d = { nombre: (x.nombre + " (copia)").slice(0, 80), ...FE.datos() };
  try { await setDoc(doc(db, "flujogramas", id), { ...d, actualizado: serverTimestamp(), porNombre: S.perfil.nombre || S.perfil.usuario || "" }); S.fe.lista.push({ id, ...d }); feCargar(id); pintarFeLista(); toast("Copia creada"); }
  catch (e) { toast(textoError(e)); }
});
$("feBorrarF").addEventListener("click", async () => {
  const x = S.fe.lista.find(y => y.id === S.fe.id); if (!x || !confirm(`¿Borrar el flujograma «${x.nombre}»? No se puede deshacer.`)) return;
  try { await deleteDoc(doc(db, "flujogramas", x.id)); S.fe.lista = S.fe.lista.filter(y => y.id !== x.id); feCargar(S.fe.lista[0]?.id || ""); pintarFeLista(); } catch (e) { toast(textoError(e)); }
});
// exportar: imagen PNG (alta resolución) o imprimir / guardar como PDF
function feSvgSuelto() { const s = FE.svg(); return s.replace('class="fe-svg"', `class="fe-svg" width="${limites(FE.datos())[2]}" height="${limites(FE.datos())[3]}"`); }
$("fePng").addEventListener("click", () => {
  const nombre = (S.fe.lista.find(y => y.id === S.fe.id)?.nombre || "flujograma").replace(/[^\w\- áéíóúñ]+/gi, "_");
  const [, , w, h] = limites(FE.datos()), k = 2.5, img = new Image();
  img.onload = () => { const c = document.createElement("canvas"); c.width = w * k; c.height = h * k; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    const a = document.createElement("a"); a.href = c.toDataURL("image/png"); a.download = nombre + ".png"; a.click(); };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(feSvgSuelto());
});
$("feImp").addEventListener("click", () => {
  const nombre = S.fe.lista.find(y => y.id === S.fe.id)?.nombre || "Flujograma", v = open("", "_blank"); if (!v) return toast("Permita las ventanas emergentes para imprimir");
  v.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(nombre)}</title><style>@page{size:A4 landscape;margin:10mm}body{margin:0;font-family:system-ui}h1{font-size:16px;margin:0 0 8px}svg{width:100%;height:auto}</style></head><body><h1>${esc(nombre)}</h1>${FE.svg()}<script>setTimeout(()=>print(),300)<\/script></body></html>`);
  v.document.close();
});
addEventListener("keydown", e => { if (S.vista === "vFlued" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); clearTimeout(feT); feGuardar(); } });
addEventListener("beforeunload", e => { if (S.vista === "vFlued" && !S.fe.guardado) { feGuardar(); e.preventDefault(); } });

/* ===================== rutas de reparto ===================== */
// rutas/config = { puntos: [{ id, n, u (texto), lat, lon, salida }], grupos: [{ id, n, ids: [...], modelo }] }
S.ru = { listo: false, puntos: [], grupos: [], ver: "", res: new Map() };
const ruId = () => Math.random().toString(36).slice(2, 9);
const ruSalida = () => S.ru.puntos.find(p => p.salida && p.lat != null) || S.ru.puntos.find(p => p.lat != null);
const ruPt = id => S.ru.puntos.find(p => p.id === id);
const ruColor = g => COLORES_G[S.ru.grupos.indexOf(g) % COLORES_G.length];
let ruMapa = null, ruCapa = null, ruT = null;
async function abrirRutas() {
  if (S.ru.listo) return;
  S.ru.listo = true;
  try {
    const d = await getDoc(doc(db, "rutas", "config"));
    if (d.exists()) { const x = d.data(); S.ru.puntos = x.puntos || []; S.ru.grupos = x.grupos || []; }
  } catch (e) { msg("ruMsg", "No se pudieron leer las rutas guardadas (" + textoError(e) + "). Se muestran las ubicaciones iniciales.", true); }
  if (!S.ru.puntos.length) S.ru.puntos = PUNTOS_INICIALES.map(([n, u, salida]) => { const [lat, lon] = leerUbicacion(u); return { id: ruId(), n, u, lat, lon, salida: !!salida }; });
  if (!S.ru.grupos.length) {
    const id = n => S.ru.puntos.find(p => p.n === n)?.id;
    S.ru.grupos = [{ id: ruId(), n: "Grupo 1", ids: ["PARRA", "PIOPATA", "SUMAR"].map(id).filter(Boolean), modelo: "auto" }];
  }
  pintarRuPts(); pintarRuGrupos(); calcRutas();
  try {
    const L = await cargarLeaflet();
    ruMapa = L.map("ruMapa", { scrollWheelZoom: true }).setView([-12.066, -75.21], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(ruMapa);
    ruCapa = L.layerGroup().addTo(ruMapa);
    pintarRuMapa(true);
  } catch (e) { $("ruMapa").innerHTML = `<p class="muted" style="padding:20px">No se pudo cargar el mapa: ${esc(e.message)}. Los enlaces de Google Maps siguen funcionando.</p>`; }
}
function ruGuardar() {
  $("ruEst").textContent = "Guardando…"; clearTimeout(ruT);
  ruT = setTimeout(async () => {
    try {
      await setDoc(doc(db, "rutas", "config"), { puntos: S.ru.puntos, grupos: S.ru.grupos, actualizado: serverTimestamp(), porNombre: S.perfil?.nombre || S.perfil?.usuario || "" });
      $("ruEst").textContent = "✓ Guardado " + new Date().toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { $("ruEst").textContent = "⚠ No se guardó: " + (e.code === "permission-denied" ? "falta publicar las reglas nuevas (firestore.rules)." : textoError(e)); }
  }, 700);
}
function pintarRuPts() {
  $("ruPts").innerHTML = `<thead><tr><th title="Punto de salida y regreso">Salida</th><th>Nombre</th><th>Ubicación</th><th></th></tr></thead><tbody>` +
    S.ru.puntos.map(p => `<tr data-pid="${p.id}"><td style="text-align:center"><input type="radio" name="ruSal" data-rsal ${p.salida ? "checked" : ""} title="Punto de salida y regreso"></td>
      <td><input type="text" data-rn value="${esc(p.n)}" maxlength="40"></td>
      <td class="ru-ub"><input type="text" data-ru value="${esc(p.u || (p.lat != null ? fmtDMS(p.lat, p.lon) : ""))}" class="${p.lat == null ? "mal" : ""}" placeholder="12°04'09.34&quot;S 75°12'34.34&quot;W"></td>
      <td><button class="btn sm peligro" type="button" data-rdel title="Quitar">🗑</button></td></tr>`).join("") + "</tbody>";
}
function pintarRuGrupos() {
  const sal = ruSalida(), usados = new Map(); S.ru.grupos.forEach(g => g.ids.forEach(i => usados.set(i, g)));
  $("ruGrupos").innerHTML = S.ru.grupos.map(g => `<div class="ru-g${S.ru.ver === g.id ? " sel" : ""}" data-gid="${g.id}" style="--gc:${ruColor(g)}">
      <div class="ru-g-top"><input type="text" data-gn value="${esc(g.n)}" maxlength="40" aria-label="Nombre del grupo">
        <select data-gm title="Método para ordenar la ruta">${MODELOS.map(([v, t]) => `<option value="${v}" ${v === (g.modelo || "auto") ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
        <button class="btn sm peligro" type="button" data-gdel title="Quitar grupo">🗑</button></div>
      <div class="ru-chips">${S.ru.puntos.filter(p => p !== sal && p.lat != null).map(p => { const en = g.ids.includes(p.id), otro = !en && usados.get(p.id);
        return `<button type="button" class="ru-chip${en ? " on" : ""}${otro ? " otro" : ""}" data-gp="${p.id}" title="${otro ? "Está en " + esc(otro.n) : ""}">${esc(p.n)}</button>`; }).join("")}</div>
      <div class="ru-res" data-gres>${g.ids.length ? "Calculando…" : '<span class="muted">Toque las sucursales de este grupo.</span>'}</div></div>`).join("")
    || '<p class="muted">No hay grupos. Use «Nuevo grupo».</p>';
}
// ruta de cada grupo con su método y, para comparar, lo que darían los demás métodos
async function calcRutas() {
  const sal = ruSalida(); if (!sal) return;
  for (const g of S.ru.grupos) {
    const pts = g.ids.map(ruPt).filter(p => p && p.lat != null && p !== sal), el = () => document.querySelector(`[data-gid="${g.id}"] [data-gres]`);
    if (!pts.length) { S.ru.res.delete(g.id); continue; }
    const firma = [sal, ...pts].map(p => p.lat + "," + p.lon).join(";") + "|" + g.modelo;
    let r = S.ru.res.get(g.id);
    if (!r || r.firma !== firma) {
      const M = await matriz([sal, ...pts]), idx = pts.map((_, i) => i + 1);
      const largo = (o, T) => { let d = 0, p = 0; for (const x of o) { d += T[p][x]; p = x; } return d + T[p][0]; };
      const o = ordenar(M.km, idx, g.modelo || "auto");
      const cmp = MODELOS.filter(([v]) => v !== "auto" && !(v === "exacto" && idx.length > 9)).map(([v, t]) => [v, t, largo(ordenar(M.km, idx, v), M.km)]);
      r = { firma, orden: o.map(i => pts[i - 1]), km: largo(o, M.km), min: M.min ? largo(o, M.min) : null, fuente: M.fuente, cmp };
      S.ru.res.set(g.id, r);
    }
    const e = el(); if (!e) continue;
    const mejor = Math.min(...r.cmp.map(c => c[2]));
    e.innerHTML = `<div class="ru-orden"><span>🏠 ${esc(sal.n)}</span> → ${r.orden.map((p, i) => `<span><i>${i + 1}</i>${esc(p.n)}</span>`).join(" → ")} → <span>🏠</span></div>
      <b class="km">${r.km.toFixed(1)} km</b>${r.min != null ? ` · ~${Math.round(r.min)} min manejando` : ""} <small class="muted">(${r.fuente === "calles" ? "por calles" : "aprox.: línea recta × 1,3"})</small>
      <div class="ru-cmp">Otros métodos: ${r.cmp.map(([v, t, d]) => `${esc(t.split(" (")[0].split(":")[0])} ${d <= mejor + 0.05 ? `<b>${d.toFixed(1)}</b>` : d.toFixed(1)}`).join(" · ")} km</div>
      <div class="ru-acc"><a class="btn sm primario" href="${esc(linkMaps(sal, r.orden))}" target="_blank" rel="noopener">📍 Abrir en Google Maps</a><button class="btn sm" type="button" data-gver>🗺 Ver en el mapa</button></div>`;
  }
  pintarRuMapa();
}
async function pintarRuMapa(encuadrar) {
  if (!ruMapa || !window.L) return;
  const L = window.L, sal = ruSalida(); ruCapa.clearLayers(); const lim = [];
  const ver = S.ru.ver ? S.ru.grupos.filter(g => g.id === S.ru.ver) : S.ru.grupos;
  const enRuta = new Set(ver.flatMap(g => g.ids));
  for (const p of S.ru.puntos) if (p.lat != null && p !== sal && !enRuta.has(p.id))
    L.circleMarker([p.lat, p.lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#8a94a6", fillOpacity: 1 }).bindTooltip(p.n).addTo(ruCapa);
  if (sal) { L.marker([sal.lat, sal.lon], { icon: L.divIcon({ className: "", html: '<div class="ru-sal">🏠</div>', iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 1000 }).bindTooltip(sal.n, { permanent: false }).addTo(ruCapa); lim.push([sal.lat, sal.lon]); }
  $("ruLey").innerHTML = (sal ? `<span>🏠 ${esc(sal.n)} (salida)</span>` : "") + ver.map(g => { const r = S.ru.res.get(g.id); return r ? `<span><b style="color:${ruColor(g)}">━</b> ${esc(g.n)}: ${r.km.toFixed(1)} km</span>` : ""; }).join("")
    + (S.ru.ver ? ` <button class="btn sm" type="button" id="ruLeyTodos">Ver todos</button>` : "");
  for (const g of ver) {
    const r = S.ru.res.get(g.id); if (!r || !sal) continue; const c = ruColor(g);
    r.orden.forEach((p, i) => { lim.push([p.lat, p.lon]);
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", html: `<div class="ru-num" style="background:${c}">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) }).bindTooltip(`${g.n} · ${i + 1}. ${p.n}`).addTo(ruCapa); });
    const linea = L.polyline([[sal.lat, sal.lon], ...r.orden.map(p => [p.lat, p.lon]), [sal.lat, sal.lon]], { color: c, weight: 4, opacity: .55, dashArray: "6 8" }).addTo(ruCapa);
    trazo([sal, ...r.orden, sal]).then(t => { if (!ruCapa.hasLayer(linea)) return; ruCapa.removeLayer(linea); L.polyline(t, { color: c, weight: 5, opacity: .85 }).addTo(ruCapa); });
  }
  if ((encuadrar || S.ru.ver) && lim.length) ruMapa.fitBounds(lim, { padding: [30, 30], maxZoom: 16 });
  setTimeout(() => ruMapa.invalidateSize(), 50);
}
$("ruPts").addEventListener("change", e => {
  const tr = e.target.closest("[data-pid]"); if (!tr) return; const p = ruPt(tr.dataset.pid); if (!p) return;
  if (e.target.matches("[data-rn]")) p.n = e.target.value.trim().slice(0, 40) || "Sin nombre";
  else if (e.target.matches("[data-ru]")) { const v = leerUbicacion(e.target.value); p.u = e.target.value.trim(); [p.lat, p.lon] = v || [null, null]; e.target.classList.toggle("mal", !v); if (!v) return msg("ruMsg", `No se entiende la ubicación de ${p.n}. Use 12°04'09.34"S 75°12'34.34"W o -12.0692, -75.2095.`, true); msg("ruMsg", ""); }
  else if (e.target.matches("[data-rsal]")) S.ru.puntos.forEach(x => x.salida = x === p);
  S.ru.res.clear(); pintarRuGrupos(); calcRutas(); ruGuardar();
});
$("ruPts").addEventListener("click", e => {
  const b = e.target.closest("[data-rdel]"); if (!b) return; const p = ruPt(b.closest("[data-pid]").dataset.pid);
  if (!p || !confirm(`¿Quitar ${p.n} de las ubicaciones?`)) return;
  S.ru.puntos = S.ru.puntos.filter(x => x !== p); S.ru.grupos.forEach(g => g.ids = g.ids.filter(i => i !== p.id));
  if (p.salida && S.ru.puntos[0]) S.ru.puntos[0].salida = true;
  S.ru.res.clear(); pintarRuPts(); pintarRuGrupos(); calcRutas(); ruGuardar();
});
$("ruNuevoP").addEventListener("click", () => {
  S.ru.puntos.push({ id: ruId(), n: "Nueva sucursal", u: "", lat: null, lon: null, salida: false }); pintarRuPts(); pintarRuGrupos();
  const ins = $("ruPts").querySelectorAll("[data-rn]"); ins[ins.length - 1]?.select();
});
$("ruNuevoG").addEventListener("click", () => {
  const g = { id: ruId(), n: "Grupo " + (S.ru.grupos.length + 1), ids: [], modelo: "auto" }; S.ru.grupos.push(g); S.ru.ver = g.id; pintarRuGrupos(); pintarRuMapa(); ruGuardar();
});
const ruVerTodos = () => { S.ru.ver = ""; pintarRuGrupos(); calcRutas(); pintarRuMapa(true); };
$("ruTodosG").addEventListener("click", ruVerTodos);
$("ruLey").addEventListener("click", e => { if (e.target.closest("#ruLeyTodos")) ruVerTodos(); });
$("ruGrupos").addEventListener("click", e => {
  const caja = e.target.closest("[data-gid]"); if (!caja) return; const g = S.ru.grupos.find(x => x.id === caja.dataset.gid); if (!g) return;
  const ch = e.target.closest("[data-gp]");
  if (ch) { const id = ch.dataset.gp; g.ids = g.ids.includes(id) ? g.ids.filter(i => i !== id) : [...g.ids, id]; S.ru.ver = g.id; pintarRuGrupos(); calcRutas(); ruGuardar(); return; }
  if (e.target.closest("[data-gdel]")) { if (!confirm(`¿Quitar ${g.n}?`)) return; S.ru.grupos = S.ru.grupos.filter(x => x !== g); S.ru.res.delete(g.id); if (S.ru.ver === g.id) S.ru.ver = ""; pintarRuGrupos(); calcRutas(); ruGuardar(); return; }
  if (e.target.closest("[data-gver]")) { S.ru.ver = g.id; document.querySelectorAll(".ru-g").forEach(x => x.classList.toggle("sel", x.dataset.gid === g.id)); pintarRuMapa(true); if (innerWidth < 980) $("ruMapa").scrollIntoView({ behavior: "smooth" }); }
});
$("ruGrupos").addEventListener("change", e => {
  const caja = e.target.closest("[data-gid]"); const g = caja && S.ru.grupos.find(x => x.id === caja.dataset.gid); if (!g) return;
  if (e.target.matches("[data-gn]")) { g.n = e.target.value.trim().slice(0, 40) || "Grupo"; pintarRuMapa(); }
  else if (e.target.matches("[data-gm]")) { g.modelo = e.target.value; calcRutas(); }
  ruGuardar();
});
