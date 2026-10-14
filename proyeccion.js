// Proyección de compras: guarda sus datos en Firebase (colecciones proy_*, solo administrador).
// Ofrece a la página del kardex la misma forma de guardar que tenía como artefacto (db + assets).
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs, onSnapshot
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { firebaseConfig } from "./config.js?v=202610141100";

const app = initializeApp(firebaseConfig), auth = getAuth(app), db = getFirestore(app);
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
  document.querySelector("main").innerHTML = `<div class="empty" style="margin-top:24px"><h2>Proyección de compras</h2><p>${texto}</p></div>`;
  document.querySelector(".bar .tabs")?.remove(); document.getElementById("btnPron")?.remove();
}

let arrancado = false;
onAuthStateChanged(auth, async u => {
  if (!u) return bloquear("Ingresa como administrador en la página de Abastecimiento para ver la proyección.");
  try {
    const p = (await getDoc(doc(db, "usuarios", u.uid))).data() || {};
    if (String(p.rol || "").trim().toLowerCase() !== "admin") return bloquear("Esta sección es solo para el administrador.");
  } catch { return bloquear("No se pudo comprobar tu usuario. Recarga la página."); }
  if (arrancado) return; arrancado = true;
  window.claude = { use: async n => n === "db" ? dbShim : n === "assets" ? assetsShim : null };
  window.iniciarKardex();
});
