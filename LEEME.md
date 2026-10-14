# Socorro · Abastecimiento — bloqueos por farmacia

**Dirección:** https://abastecimiento.fssocorro.com (dominio en Squarespace: registro CNAME `abastecimiento` → `jefaturaadmin-png.github.io`; el archivo `CNAME` del repositorio lo conecta en GitHub Pages).

Cada químico bloquea los productos que no se deben abastecer a su farmacia y, si cambia la situación, pide la reactivación. Solo el administrador (Abastecimiento) reactiva o rechaza.

## Archivos

| Archivo | Para qué |
|---|---|
| `index.html`, `styles.css`, `app.js` | La página |
| `config.js` | Datos de Firebase, lista de farmacias y motivos (lo único que se edita) |
| `catalogo.json` | Catálogo de productos (lo genera Colab; agrégalo tú) |
| `firestore.rules` | Reglas de seguridad (se pegan en la consola de Firebase) |

## Puesta en marcha (una sola vez)

1. **Verifica `config.js`**: abre Firebase → ⚙ Configuración del proyecto → Tus apps → `abastecimiento`, copia el bloque `firebaseConfig` y reemplázalo en `config.js` (así te aseguras de que la `apiKey` esté exacta).
2. **Reglas**: Firebase → Firestore Database → pestaña **Reglas** → borra todo, pega el contenido de `firestore.rules` → **Publicar**.
3. **Tu usuario administrador** (solo este se crea a mano):
   1. Firebase → Authentication → **Usuarios** → **Agregar usuario**: correo `carlos@socorro.app`, una contraseña. Copia el **UID** que aparece.
   2. Firestore Database → **Iniciar colección** → ID `usuarios` → ID del documento: pega el **UID** → campos:
      - `usuario` (string): `carlos`
      - `nombre` (string): `Carlos Aguirre`
      - `rol` (string): `admin`
      - `farmacia` (string): vacío
      - `activo` (boolean): `true`
4. **GitHub**: sube todos los archivos (incluido `catalogo.json`) a la raíz del repositorio → Settings → Pages → Branch `main`, carpeta `/ (root)` → Save. En unos minutos tendrás la dirección `https://<tu-usuario>.github.io/<repositorio>/`.
5. **Dominio autorizado**: Firebase → Authentication → Configuración → **Dominios autorizados** → agrega `abastecimiento.fssocorro.com` (y `jefaturaadmin-png.github.io`).
6. Entra a la página con `carlos` y tu contraseña → pestaña **Usuarios** → crea un usuario por farmacia (por ejemplo `mercado`, `tupac`…), elige su farmacia y entrégale su contraseña.

## Uso diario

- **Químico**: entra con su usuario y la contraseña inicial que le diste; en ese primer ingreso la página le pide crear su propia contraseña. Busca el producto (con ↑/↓ y Enter, o agregándolo si no está en la lista), elige el motivo y lo bloquea. Para volver a abastecerlo pulsa **Pedir reactivación**. Puede **Exportar a Excel** los productos bloqueados de su sucursal.
- **Administrador**: en **Bloqueos** ve las solicitudes pendientes (Aprobar / Rechazar), todos los bloqueos con filtros, puede bloquear en una farmacia o en **todas**, y **Descargar Excel** (de todas o de la farmacia elegida en los filtros) para cruzarlo con la reposición. En **Usuarios** ves quién ya cambió su contraseña inicial; el botón **Generar** propone una contraseña inicial.
- Si un químico se va: en **Usuarios** pulsa **Deshabilitar**. Para cambiarle la contraseña, bórralo en Authentication y créalo de nuevo con el mismo usuario (su historial se mantiene).

## Proyección de compras (solo administrador)

Pestaña **Proyección de compras** (`proyeccion.html` + `proyeccion.js`), abierta dentro del panel.

- **Subir kardex (.TXT)**: uno o varios archivos exportados de LolFar (también el grande, de cientos de MB). Se leen en el navegador; cada movimiento se identifica por `numkar`, así que lo repetido se descarta solo. Se guarda en Firebase el resumen por mes, producto y almacén (`proy_meses`, `proy_blobs`) y el stock actual (`proy_config/maestro`).
- Cantidades en cajas: enteras + fracciones ÷ unidades por caja (`stkfra`). Demanda = ventas − anulaciones de cada farmacia; DROGUERIA FS es el almacén central (compras y envíos). Se ignoran CANJES.
- Con eso la página calcula los pronósticos (Media 3/6 meses, con estacionalidad, SES, Holt y AR estacional) y su error en los últimos 6 meses. Hacen falta al menos 4 meses completos.
- **Reposición**: compra de droguería para 30/60/75 días; reparto a cada farmacia para 1 semana/15 días/1 mes. Los productos bloqueados en Abastecimiento no se reparten a esa farmacia (ni se compran si el bloqueo es general).

## Actualizar el catálogo

Cuando haya productos nuevos, vuelve a correr la celda de Colab que genera `catalogo.json` y súbelo al repositorio reemplazando el anterior.

## Al publicar cambios

En `index.html` los archivos llevan `?v=AAAAMMDDHHMM` (y `app.js` también al importar `config.js`). Cambia ese número en cada publicación para que los navegadores descarguen los archivos nuevos en vez de usar los guardados.
