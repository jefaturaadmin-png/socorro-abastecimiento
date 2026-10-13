# Socorro · Abastecimiento — bloqueos por farmacia

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
5. **Dominio autorizado**: Firebase → Authentication → Configuración → **Dominios autorizados** → agrega `<tu-usuario>.github.io`.
6. Entra a la página con `carlos` y tu contraseña → pestaña **Usuarios** → crea un usuario por farmacia (por ejemplo `mercado`, `tupac`…), elige su farmacia y entrégale su contraseña.

## Uso diario

- **Químico**: busca el producto, elige el motivo y lo bloquea. Para volver a abastecerlo pulsa **Pedir reactivación**.
- **Administrador**: en **Bloqueos** ve las solicitudes pendientes (Aprobar / Rechazar), todos los bloqueos con filtros, puede bloquear en una farmacia o en **todas**, y **Descargar bloqueos activos (CSV)** para cruzarlo con la reposición.
- Si un químico se va: en **Usuarios** pulsa **Deshabilitar**. Para cambiarle la contraseña, bórralo en Authentication y créalo de nuevo con el mismo usuario (su historial se mantiene).

## Actualizar el catálogo

Cuando haya productos nuevos, vuelve a correr la celda de Colab que genera `catalogo.json` y súbelo al repositorio reemplazando el anterior.

## Al publicar cambios

En `index.html` los archivos llevan `?v=AAAAMMDDHHMM` (y `app.js` también al importar `config.js`). Cambia ese número en cada publicación para que los navegadores descarguen los archivos nuevos en vez de usar los guardados.
