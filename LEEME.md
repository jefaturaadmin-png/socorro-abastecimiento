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

- **Subir kardex (.TXT)**: uno o varios archivos exportados de LolFar (también el grande, de cientos de MB). Se leen en el navegador; cada movimiento se identifica por `numkar`, así que lo repetido se descarta solo. Se guarda en Firebase el resumen por mes, producto y almacén (índice en `proy_config/meses`, datos en `proy_blobs`) y el stock actual (`proy_config/maestro`).
- Cantidades en cajas: enteras + fracciones ÷ unidades por caja (`stkfra`). Demanda = ventas − anulaciones de cada farmacia; DROGUERIA FS es el almacén central (compras y envíos). Se ignoran CANJES.
- Con eso la página calcula los pronósticos (Media 3/6 meses, con estacionalidad, SES, Holt y AR estacional) y su error en los últimos 6 meses. Hacen falta al menos 4 meses completos.
- **Reposición**: compra de droguería para 30/60/75 días; reparto a cada farmacia para 1 semana/15 días/1 mes. Los productos bloqueados en Abastecimiento no se reparten a esa farmacia (ni se compran si el bloqueo es general).

## Actualizar el catálogo

Cuando haya productos nuevos, vuelve a correr la celda de Colab que genera `catalogo.json` y súbelo al repositorio reemplazando el anterior.

## Al publicar cambios

En `index.html` los archivos llevan `?v=AAAAMMDDHHMM` (y `app.js` también al importar `config.js`). Cambia ese número en cada publicación para que los navegadores descarguen los archivos nuevos en vez de usar los guardados.

## Comparativo de precios (solo administrador)

Pestaña **Comparativo** (verde; `comparativo.html` + `comparativo.js`, abierta dentro del panel).

- **Competencia (automático):** cada noche a las 10:37 p. m. GitHub Actions (`.github/workflows/precios.yml`) corre `scripts/precios_competencia.py`, descarga los precios de **Mifarma** (sitemap + su servicio de productos), **Boticas Perú** (grilla de la categoría raíz) y **Farmacias Líder** (sus 131 categorías + búsquedas amplias) y los guarda en `data/competencia/`: el catálogo del día (`mifarma.json`, `boticasperu.json`, `farmaciaslider.json`) y el historial (`hist-*.json`, un punto solo cuando el precio cambia). No usa Firebase. Para correrlo a mano: GitHub → **Actions** → *Precios de la competencia* → **Run workflow**. Si una tienda devuelve mucho menos productos que la vez anterior, no se guarda (protección ante fallas).
- **Nuestro precio:** botón **Subir lista de precios** (archivo de Lolfar). Se guarda en Firebase (`comp_config/lista`) con su historial (`comp_config/historial`, solo cambios). El **costo** se toma del kardex que ya se sube en Proyección.
- **Parejas:** la página sugiere el producto equivalente de cada tienda comparando nombre, concentración y presentación (marcado con **?**). Al hacer clic en un producto se confirma, se cambia por otra opción, se busca otro o se marca **No lo vende**. Lo confirmado se guarda en `comp_config/pares` y manda sobre las sugerencias. **Confirmar sugeridos ≥ 80 %** confirma de una vez las de la tabla visible.
- Si las presentaciones tienen distinto número de unidades (p. ej. caja x100 vs x10), se compara por unidad. La comparación usa la oferta para todos los medios de pago, no la de tarjeta.
- Reglas: `firestore.rules` incluye `comp_config` y `comp_blobs` (solo administrador); hay que volver a **Publicar** las reglas en Firebase.

## Cierre del ingreso de información (solo administrador)

En **Bloqueos**, botón **Cerrar ingreso de información**: se elige desde qué fecha y hora (y, si se quiere, hasta cuándo), a quiénes (todos los químicos o algunos) y un mensaje. Se guarda en cada usuario (`usuarios/{uid}.cierre = { desde, hasta, motivo }`). Mientras está vigente el químico ve un aviso y no puede bloquear productos, pedir reactivaciones ni pedir cambio de sucursal; puede seguir entrando y viendo. **Quitar cierre** lo borra de todos.
- Reglas: `firestore.rules` rechaza esas escrituras con la hora del servidor mientras el cierre está vigente; hay que volver a **Publicar** las reglas en Firebase para que también se haga cumplir desde el servidor.

## Estadística Proyx (solo administrador)

Módulo del menú principal (`proyeccion.html?solo=est`, código en `estadistica.js` y `frepple.js`). Planificación de inventario con la estructura de la pantalla "Inventory planning" de frePPLe: lista de productos con estado del inventario, stock de seguridad, punto de pedido, cantidad a pedir, riesgo de quiebre y valor en soles; y por producto las pestañas **Atributos**, **Pronóstico** (venta real vs pronóstico, corrección por mes, método elegible), **Plan** (12 meses, parámetros de stock de seguridad y cantidad a pedir) y **Pedidos propuestos**. El motor de pronóstico (`frepple.js`) es un port del código abierto de frePPLe (licencia MIT). Los ajustes por producto se guardan en `proy_config/estadistica`. Botón para descargar los pedidos propuestos en Excel (CSV).

## Atención a sucursales (solo administrador)

Módulo del menú principal (`proyeccion.html?solo=suc`, código en `sucursales.js`). Lista lo que hay que enviar a cada sucursal para cubrir N días + N días de seguridad (7 + 7, 15 + 15, 30 + 30 u otros), según la venta de cada sucursal (ventas de los últimos 15/30/60/90 días del kardex o el motor estadístico sobre su venta mensual). Muestra la cobertura en días con colores, reparte el stock de droguería primero a las sucursales con menos cobertura y marca lo que falta para pasar de otra sucursal con exceso o para comprar. Resumen por sucursal, detalle por producto en toda la red y lista de despacho en Excel (CSV).

## Faltantes de droguería y vistas por usuario

- **Rol Colaborador**: usuario sin sucursal que solo ve las **vistas** que le marque el administrador (al crear o editar el usuario). Las vistas se guardan en `usuarios/{uid}.vistas` y se definen en `VISTAS` (app.js); un químico también puede recibir vistas además de sus bloqueos.
- **Faltantes de droguería** (vista `faltantes`): productos en 0 en droguería que piden las sucursales, consolidados y ordenados de más sucursales y más cantidad a menos. La lista la publica el administrador desde Atención a sucursales (`faltantes/actual`, se publica sola al abrir el módulo y con el botón "Actualizar lista del equipo"). El colaborador responde por producto: A. Descontinuado, B. Agotado en laboratorio (1 semana, 2 semanas, 1 mes, 2 meses, 3 meses u otra fecha), C. En tránsito (fecha de llegada opcional), D. Pendiente de solicitud, E. Existe otro medicamento (hasta 2 del catálogo). Respuestas en `faltantes_estado/{código}`; el administrador las ve en Atención a sucursales.
- Reglas: hay que volver a **Publicar** `firestore.rules` en Firebase.
