import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * The public site is a Vite build (web/dist): index.html at `/`, the files the build produced,
 * and the same index.html for the single-page onboarding and app under `/onboarding` and `/app`. `/join`, `/v1`,
 * `/health` and the operator routes keep belonging to the backend, so there is deliberately no
 * catch-all fallback.
 */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

const ONE_YEAR = 'public, max-age=31536000, immutable'
const ONE_DAY = 'public, max-age=86400'
/** The service worker and the manifest must be re-checked on every visit, or an update never reaches phones. */
const ALWAYS_REVALIDATE = new Set(['sw.js', 'manifest.webmanifest'])

/** Adds headers to a response that was actually served; a 404 or a fall-through gets none. */
function headersOnServed(values: Record<string, string>): MiddlewareHandler {
  return async (context, next) => {
    await next()
    if (context.finalized && (context.res.status === 200 || context.res.status === 206)) {
      for (const [name, value] of Object.entries(values)) context.header(name, value)
    }
  }
}

/** Sends the single-page app shell (index.html) with the given status; never cached. */
export type Shell = (context: Context, status?: ContentfulStatusCode) => Response

/** Registers the built site; returns its shell, or null when `root` holds no build, so dev without one still starts. */
export function registerWeb(app: Hono, root: string): Shell | null {
  const base = path.resolve(root)
  if (!existsSync(path.join(base, 'index.html'))) return null
  const html = readFileSync(path.join(base, 'index.html'), 'utf8')
  const shell: Shell = (context, status = 200) => {
    context.header('Cache-Control', 'no-store')
    context.header('Content-Security-Policy', CSP)
    context.header('X-Content-Type-Options', 'nosniff')
    context.header('Referrer-Policy', 'no-referrer')
    return context.html(html, status)
  }
  for (const route of ['/onboarding', '/onboarding/*', '/app', '/app/*', '/terms', '/privacy', '/akses']) app.get(route, (context) => shell(context))
  // The dashboard is for the admins only: the page itself is the same shell, kept out of search results.
  for (const route of ['/dashboard', '/dashboard/*']) {
    app.get(route, (context) => {
      context.header('X-Robots-Tag', 'noindex, nofollow')
      return shell(context)
    })
  }

  app.get(
    '/',
    headersOnServed({ 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' }),
    serveStatic({ root: base, path: 'index.html' }),
  )

  const asset = (cache: string): [MiddlewareHandler, MiddlewareHandler] => [
    headersOnServed({ 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' }),
    serveStatic({ root: base }),
  ]

  // Top-level files (logos, favicon) and folders (assets, avatars) of the build, nothing else.
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name === 'index.html' || entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      app.get(`/${entry.name}/*`, ...asset(entry.name === 'assets' ? ONE_YEAR : ONE_DAY))
    } else {
      app.get(`/${entry.name}`, ...asset(ALWAYS_REVALIDATE.has(entry.name) ? 'no-cache' : ONE_DAY))
    }
  }
  return shell
}
