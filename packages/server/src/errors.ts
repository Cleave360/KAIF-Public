const HTTP_STATUS: Record<string, number> = {
  invalid_request:           400,
  invalid_grant:             400,
  invalid_client:            401,
  invalid_scope:             400,
  insufficient_scope:        403,
  insufficient_trust:        403,
  delegation_depth_exceeded: 403,
  access_denied:             403,
  server_error:              500,
}

export class KAIFError extends Error {
  readonly code:        string
  readonly description: string
  readonly httpStatus:  number

  constructor(code: string, description: string, httpStatus?: number) {
    super(description)
    this.name        = 'KAIFError'
    this.code        = code
    this.description = description
    this.httpStatus  = httpStatus ?? HTTP_STATUS[code] ?? 400
  }

  toJSON(): Record<string, string> {
    return {
      error:             this.code,
      error_description: this.description,
    }
  }
}
