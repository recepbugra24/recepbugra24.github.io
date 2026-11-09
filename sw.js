// Balıkçı Meram service worker: uygulamanın çekim olmadan da açılması için.
// - Sayfa: önce ağ, olmazsa önbellek
// - Uygulama dosyaları (/assets/*, ikonlar): önce önbellek
// - Harita ve uydu karoları: bakılan karolar saklanır (en fazla MAX_TILES adet)
// - Hava durumu: önbelleğe alınmaz (her zaman güncel olmalı)

const VERSION = 'v2'
const APP_CACHE = `meram-app-${VERSION}`
const TILE_CACHE = 'meram-tiles-v1' // sürüm değişse de indirilmiş harita karoları kalsın
const MAX_TILES = 1500
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![APP_CACHE, TILE_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

const isTile = (url) =>
  /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname) || url.hostname === 'server.arcgisonline.com'

async function trimTiles() {
  const cache = await caches.open(TILE_CACHE)
  const keys = await cache.keys()
  if (keys.length > MAX_TILES) {
    await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)))
  }
}

async function tileResponse(request) {
  const cache = await caches.open(TILE_CACHE)
  const hit = await cache.match(request.url)
  if (hit) return hit
  try {
    // CORS ile iste: opak yanıtlar tarayıcı kotasını gereksiz şişirir
    const res = await fetch(request.url, { mode: 'cors', credentials: 'omit' })
    if (res.ok) {
      cache.put(request.url, res.clone()).then(trimTiles)
    }
    return res
  } catch {
    return new Response('', { status: 504 })
  }
}

// Sayfa (index.html): her zaman sunucudan, tarayıcının kendi önbelleğini de atlayarak.
// Böylece yeni yayınlanan sürüm hemen gelir. İnternet yoksa son kaydedilen sayfa açılır.
async function networkFirst(request) {
  const cache = await caches.open(APP_CACHE)
  try {
    const res = await fetch(request.url, { cache: 'no-store', credentials: 'same-origin' })
    const yol = new URL(request.url).pathname
    if (res.ok && (yol === '/' || yol === '/index.html')) cache.put('/', res.clone()) // tek kopya: sorgu parametreleri önbelleği şişirmesin
    return res
  } catch {
    return (await cache.match('/')) || Response.error()
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(APP_CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok) cache.put(request, res.clone())
  return res
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)

  if (isTile(url)) {
    event.respondWith(tileResponse(request))
    return
  }
  if (url.origin !== self.location.origin) return // hava durumu vb. doğrudan ağdan

  // Sayfanın kendisi ve "yeni sürüm var mı?" kontrolü (/?v=...) önce ağdan
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(request))
    return
  }
  event.respondWith(cacheFirst(request))
})
