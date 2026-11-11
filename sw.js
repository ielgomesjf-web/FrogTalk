// Ajudante do FrogTalk:
//  - mostra as notificações (no celular o navegador só deixa por aqui) e abre a conversa certa quando tocam nela;
//  - deixa o FrogTalk abrir mesmo sem internet (e virar "aplicativo"). Sempre tenta a versão NOVA primeiro;
//    só usa a guardada quando a internet falha — assim nunca fica preso numa versão velha.
const CAIXA = 'frogchat-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return; // (os brokers e afins: direto)
  e.respondWith((async () => {
    try {
      const resp = await fetch(req);
      if (resp && resp.ok) {
        const copia = resp.clone();
        caches.open(CAIXA).then(c => c.put(req, copia)).catch(() => {});
      }
      return resp;
    } catch (err) {
      const guardada = await caches.match(req, { ignoreSearch: true });
      if (guardada) return guardada;
      if (req.mode === 'navigate') { const pag = await caches.match('./'); if (pag) return pag; }
      throw err;
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const sala = e.notification.data;
  e.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const j of janelas) {
      if ('focus' in j) { j.postMessage({ abrir: sala }); return j.focus(); }
    }
    return self.clients.openWindow('./');
  })());
});
