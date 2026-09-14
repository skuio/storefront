/**
 * Opaque keyset cursors for the catalogue list endpoints.
 *
 * A cursor is base64 of a JSON tuple of the sort keys of the last row on the
 * page. It is opaque by contract: callers echo it back and never parse it.
 * Orders keep their own older two-part encoding — cursors already issued to
 * SKU.io are live watermarks, so that format must not change.
 */

const toBase64 = (raw: string): string => {
  const bytes = new TextEncoder().encode(raw)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/=+$/, '')
}

const fromBase64 = (encoded: string): string => {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export const encodeKeysetCursor = (parts: (string | number)[]): string => toBase64(JSON.stringify(parts))

/** Null when the cursor was not issued by this store, so the caller can 422 rather than guess. */
export function decodeKeysetCursor(cursor: string, length: number): (string | number)[] | null {
  try {
    const parts: unknown = JSON.parse(fromBase64(cursor))
    if (!Array.isArray(parts) || parts.length !== length) return null
    if (!parts.every((p) => typeof p === 'string' || typeof p === 'number')) return null
    return parts as (string | number)[]
  } catch {
    return null
  }
}
