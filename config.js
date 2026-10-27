// =====================================================================
//  Configuración de Socorro · Abastecimiento
//  Lo único que normalmente cambiarás aquí son las listas de abajo.
// =====================================================================

// Pega aquí EXACTAMENTE el bloque que te dio Firebase (Configuración del proyecto → Tus apps).
export const firebaseConfig = {
  apiKey: "AIzaSyAO7wNY1HK9RQfMOtgts_z0zffCfZD-zQ0",
  authDomain: "abastecimiento-ed1ed.firebaseapp.com",
  projectId: "abastecimiento-ed1ed",
  storageBucket: "abastecimiento-ed1ed.firebasestorage.app",
  messagingSenderId: "932754423866",
  appId: "1:932754423866:web:ed7a66951c79ae51063503",
  measurementId: "G-2DWD8EGT5Y"
};

// Los usuarios entran solo con su nombre de usuario; internamente se completa con este dominio.
// No es un correo real. No lo cambies después de crear usuarios.
export const DOMINIO = "socorro.app";

// Farmacias activas (mismo nombre que en el kardex).
export const FARMACIAS = [
  "ALMACEN PRINCIPAL",
  "ALMACEN MERCADO",
  "ALMACEN TUPAC",
  "ALMACEN ORTEGA",
  "ALMACEN HUANCAS",
  "ALMACEN HEROES",
  "ALMACEN MCDO.TAMBO",
  "ALMACEN PARRA",
  "ALMACEN SUMAR",
  "ALMACEN SUCURSAL",
  "ALMACEN PIOPATA",
  "ALMACEN CONCEPCION",
  "ALMACEN LIBERTAD",
  "ALMACEN ANDALUZ",
  "DROGUERIA FS"
];

// Cómo se MUESTRA un almacén en la página. Por dentro y en el Excel se usa siempre el nombre del kardex.
export const NOMBRES_VISIBLES = {
  "ALMACEN PRINCIPAL": "ALMACEN REAL",
  "ALMACEN SUCURSAL": "ALMACEN PUNO"
};

// Motivos para bloquear. "clase" define el color de la etiqueta.
export const MOTIVOS_BLOQUEO = [
  { texto: "Sacado por vencimiento", clase: "m-venc" },
  { texto: "Sacado por emergencia", clase: "m-emer" },
  { texto: "Sobrestock", clase: "m-sobre" },
  { texto: "No rota en esta farmacia", clase: "m-norota" },
  { texto: "Descontinuado", clase: "m-desc" },
  { texto: "Quiebre de laboratorio", clase: "m-quiebre" },
  { texto: "Cambio de presentación", clase: "m-sobre" },
  { texto: "Código duplicado", clase: "m-norota" },
  { texto: "Otro", clase: "m-otro" }
];

// Motivos para pedir o aprobar una reactivación.
export const MOTIVOS_REACTIVACION = [
  "Autorización de la química",
  "Volvió a tener demanda",
  "Se resolvió el vencimiento o sobrestock",
  "Se bloqueó por error",
  "Otro"
];

// Formulario de Google "Productos agotados o de extrema urgencia". La página envía a este mismo formulario, así lo
// que se pide desde la página cae en la misma hoja de Drive que llenan desde el link del formulario.
// "sucursales": el texto EXACTO de cada opción de la pregunta Sucursal en el formulario (si no coincide, Google la rechaza).
export const FORM_URGENCIA = {
  url: "https://docs.google.com/forms/d/e/1FAIpQLSf5J0UyLA58p9VJtHQR1qs936zqlWqic-Fj-75MoMTr8bjUtA/formResponse",
  campoSucursal: "entry.568217798",
  campoProducto: "entry.459218140",
  sucursales: {
    "ALMACEN PRINCIPAL": "Real",
    "ALMACEN MERCADO": "Mercado",
    "ALMACEN TUPAC": "Tupac",
    "ALMACEN ORTEGA": "Ortega",
    "ALMACEN HUANCAS": "Huancas",
    "ALMACEN HEROES": "Heroes",
    "ALMACEN MCDO.TAMBO": "Mcdo. Tambo",
    "ALMACEN PARRA": "Parra",
    "ALMACEN SUMAR": "Sumar",
    "ALMACEN SUCURSAL": "Puno",
    "ALMACEN PIOPATA": "Piopata",
    "ALMACEN CONCEPCION": "Concepcion",
    "ALMACEN LIBERTAD": "Libertad",
    "ALMACEN ANDALUZ": "Andaluz"
  }
};
