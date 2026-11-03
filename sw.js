// Service worker mínimo: permite instalar la página como app en el celular (no guarda nada en caché;
// todo se pide siempre a la red, así cada versión nueva se ve al instante).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
