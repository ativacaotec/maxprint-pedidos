const CACHE = 'catalogo-ativacao-v3';
const ASSETS = ['./index.html','./manifest.webmanifest','./icon-180.png','./icon-192.png','./icon-512.png','./favicon.png'];

// instala buscando tudo da rede, ignorando o cache do navegador
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(u =>
        fetch(u, {cache: 'reload'}).then(r => r.ok ? c.put(u, r) : null).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });

// pagina: rede primeiro (sempre a versao mais nova), cache quando estiver offline
// demais arquivos: cache primeiro, que sao fixos
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const ehPagina = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  if (ehPagina) {
    e.respondWith(
      fetch(e.request, {cache: 'reload'})
        .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', cp)); return r; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request)
      .then(r => { if (r && r.status === 200 && r.type === 'basic') { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; })
      .catch(() => caches.match('./index.html')))
  );
});
