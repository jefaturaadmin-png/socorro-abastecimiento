# Socorro · Abastecimiento — bloqueos por farmacia

Cada químico bloquea los productos que no se deben abastecer a su farmacia y, si cambia la situación, pide la reactivación. Solo el administrador (Abastecimiento) reactiva o rechaza.

**Ingreso de las sucursales (por ahora sin usuario ni contraseña):** al abrir la página cada persona escribe su nombre y elige su sucursal. Eso queda guardado (quién ingresó, de qué sucursal y cuándo) y cada bloqueo o solicitud lleva su nombre. El equipo recuerda el último nombre y sucursal para que solo tenga que confirmar. El administrador sigue entrando con usuario y contraseña desde el enlace *"Soy de Abastecimiento"*.

## Archivos

| Archivo | Para qué |
|---|---|
| `index.html`, `styles.css`, `app.js` | La página |
| `config.js` | Datos de Firebase, lista de farmacias y motivos (lo único que se edita) |
| `catalogo.json` | Catálogo de productos (lo genera Colab; agrégalo tú) |
| `firestore.rules` | Reglas de seguridad (se pegan en la consola de Firebase) |

## Puesta en marcha (una sola vez)

1. **Verifica `config.js`**: abre Firebase → ⚙ Configuración del proyecto → Tus apps → `abastecimiento`, copia el bloque `firebaseConfig` y reemplázalo en `config.js` (así te aseguras de que la `apiKey` esté exacta).
2. **Activar el ingreso por sucursal**: Firebase → Authentication → **Método de acceso** (Sign-in method) → **Anónimo** → Habilitar → Guardar. Sin esto las sucursales no podrán ingresar.
3. **Reglas**: Firebase → Firestore Database → pestaña **Reglas** → borra todo, pega el contenido de `firestore.rules` → **Publicar**.
4. **Tu usuario administrador** (solo este se crea a mano):
   1. Firebase → Authentication → **Usuarios** → **Agregar usuario**: correo `carlos@socorro.app`, una contraseña. Copia el **UID** que aparece.
   2. Firestore Database → **Iniciar colección** → ID `usuarios` → ID del documento: pega el **UID** → campos:
      - `usuario` (string): `carlos`
      - `nombre` (string): `Carlos Aguirre`
      - `rol` (string): `admin`
      - `farmacia` (string): vacío
      - `activo` (boolean): `true`
5. **GitHub**: sube todos los archivos (incluido `catalogo.json`) a la raíz del repositorio → Settings → Pages → Branch `main`, carpeta `/ (root)` → Save. En unos minutos tendrás la dirección `https://<tu-usuario>.github.io/<repositorio>/`.
6. **Dominio autorizado**: Firebase → Authentication → Configuración → **Dominios autorizados** → agrega `<tu-usuario>.github.io`.
7. Entra a la página con el enlace *"Soy de Abastecimiento"*, usuario `carlos` y tu contraseña. Las sucursales no necesitan usuario: solo comparte la dirección de la página. En la pestaña **Usuarios** verás quién ingresó y desde qué sucursal (y, si algún día lo necesitas, puedes crear usuarios con contraseña).

## Uso diario

- **Químico**: abre la página, escribe su nombre y elige su sucursal → **Ingresar**. Busca el producto, elige el motivo y lo bloquea. Para volver a abastecerlo pulsa **Pedir reactivación**.
- **Administrador**: en **Bloqueos** ve las solicitudes pendientes (Aprobar / Rechazar), todos los bloqueos con filtros, puede bloquear en una farmacia o en **todas**, y **Descargar bloqueos activos (CSV)** para cruzarlo con la reposición.
- Si un químico se va: en **Usuarios** pulsa **Deshabilitar** (para las sucursales sin usuario esto bloquea ese equipo/navegador). Para cambiarle la contraseña, bórralo en Authentication y créalo de nuevo con el mismo usuario (su historial se mantiene).

## Actualizar el catálogo

Cuando haya productos nuevos, vuelve a correr la celda de Colab que genera `catalogo.json` y súbelo al repositorio reemplazando el anterior.
