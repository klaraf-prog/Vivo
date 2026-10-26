const CACHE='someday-v2-20261021';
self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['./manifest.webmanifest','./icon-192.png','./icon-512.png']).catch(()=>{})))});
self.addEventListener('activate',event=>{event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('someday-')&&k!==CACHE).map(k=>caches.delete(k))))]))});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return; if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)));return}event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)))});
