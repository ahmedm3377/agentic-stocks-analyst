/**
 * Unique id for React keys / list items.
 * `crypto.randomUUID()` is only guaranteed in secure contexts (https or localhost);
 * plain http:// IPs often omit it, which breaks the app on EC2 without TLS.
 */
export function randomId(): string {
  const c = globalThis.crypto
  if (c != null && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
