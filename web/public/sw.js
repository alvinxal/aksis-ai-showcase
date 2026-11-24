// Aksis AI service worker. It keeps the app openable when the connection drops and makes the page
// installable. It never touches the API or invitation links: /v1 and /join always go to the network.
const CACHE = 'aksis-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/logo-icon.svg'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/join/')) return

  // A page: the network first, and the saved shell when there is none.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')))
    return
  }

  // Built files, avatars and icons never change under the same name: serve a saved copy when there is one.
  if (/^\/(assets|avatars|icons)\//.test(url.pathname) || /\.(svg|webp|png|woff2)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const saved = await cache.match(request)
        if (saved) return saved
        const response = await fetch(request)
        if (response.ok) cache.put(request, response.clone())
        return response
      }),
    )
  }
})

// Morning reminders sent by the server (see src/push.ts). The text and the address come from our own server; the
// address is limited to the app so a notification can only open a page of Aksis.
self.addEventListener('push', (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    message = {}
  }
  const title = typeof message.title === 'string' && message.title ? message.title.slice(0, 80) : 'Aksis'
  const body = typeof message.body === 'string' ? message.body.slice(0, 240) : ''
  const url = typeof message.url === 'string' && message.url.startsWith('/app') ? message.url : '/app'
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: typeof message.tag === 'string' ? message.tag.slice(0, 40) : 'aksis',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL((event.notification.data && event.notification.data.url) || '/app', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (!open) return self.clients.openWindow(target)
      await open.focus()
      if ('navigate' in open) await open.navigate(target).catch(() => undefined)
    }),
  )
})

