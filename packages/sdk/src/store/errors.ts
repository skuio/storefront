export type StoreErrorCode = 'not_found' | 'validation_failed' | 'conflict' | 'unavailable' | 'rate_limited' | 'invalid_grant'

/** A domain error the API maps straight to a status code. */
export class StoreError extends Error {
  readonly code: StoreErrorCode
  readonly details: Record<string, string> | null

  constructor(code: StoreErrorCode, message: string, details: Record<string, string> | null = null) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.details = details
  }

  get status(): number {
    switch (this.code) {
      case 'not_found':
        return 404
      case 'validation_failed':
        return 422
      case 'conflict':
        return 409
      case 'unavailable':
        return 503
      case 'rate_limited':
        return 429
      case 'invalid_grant':
        return 400
    }
  }
}

export const notFound = (what: string) => new StoreError('not_found', `${what} not found`)
export const invalid = (message: string, details: Record<string, string> | null = null) =>
  new StoreError('validation_failed', message, details)
export const conflict = (message: string) => new StoreError('conflict', message)
