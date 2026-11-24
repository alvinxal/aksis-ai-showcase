/** True when a write request comes from this site itself (a request without an Origin header is not a browser form). */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
