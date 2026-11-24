/**
 * Aksis is used from a phone. This is a first line of defence on the server, from the User-Agent, so a
 * desktop browser (or an iPad, which reports itself as a Mac) cannot spend a one-time invitation link.
 * The pages repeat the check for the person, but only this one is out of their hands.
 */
export function looksLikePhone(userAgent: string): boolean {
  return /iPhone|iPod/.test(userAgent) || (/Android/.test(userAgent) && /Mobile/.test(userAgent))
}

/** True for a browser that is clearly not a phone. A request without a User-Agent is not a browser, so it is left alone. */
export function isNotPhone(userAgent: string | undefined): boolean {
  return Boolean(userAgent) && !looksLikePhone(userAgent!)
}
