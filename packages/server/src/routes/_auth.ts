import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'
import type { Redis } from 'ioredis'
import { verifyJWT } from '../crypto/jwt.js'
import { isRevoked } from '../services/revocation.js'

export interface KAIFAuthenticatedRequest extends FastifyRequest {
  kaifAuth?: Record<string, unknown>
  kaifBearerToken?: string
}

export interface RequireKAIFAuthOptions {
  redis: Redis
  requiredScopes?: string[]
}

export function scopesFromPayload(payload: Record<string, unknown>): string[] {
  const scope = payload['scope']
  return typeof scope === 'string' ? scope.split(' ').filter(Boolean) : []
}

export function hasRequiredScopes(payload: Record<string, unknown>, requiredScopes: string[]): boolean {
  const scopes = new Set(scopesFromPayload(payload))
  return requiredScopes.every(scope => scopes.has(scope))
}

function getConfirmationThumbprint(payload: Record<string, unknown>): string | null {
  const cnf = payload['cnf']
  if (typeof cnf !== 'object' || cnf === null) return null

  const claims = cnf as Record<string, unknown>
  if (typeof claims['jkt'] === 'string') return claims['jkt']
  if (typeof claims['x5t#S256'] === 'string') return claims['x5t#S256']
  return null
}

export function requireKAIFAuth(opts: RequireKAIFAuthOptions): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return void reply.status(401).send({
        error: 'invalid_client',
        error_description: 'Authorization: Bearer <token> required',
      })
    }

    const token = authHeader.slice(7)
    let payload: Record<string, unknown>
    try {
      payload = await verifyJWT(token) as Record<string, unknown>
    } catch {
      return void reply.status(401).send({
        error: 'invalid_client',
        error_description: 'Invalid or expired bearer token',
      })
    }

    const jti = typeof payload['jti'] === 'string' ? payload['jti'] : null
    if (!jti) {
      return void reply.status(401).send({
        error: 'invalid_client',
        error_description: 'Bearer token missing jti claim',
      })
    }

    if (await isRevoked(opts.redis, jti)) {
      return void reply.status(401).send({
        error: 'invalid_client',
        error_description: 'Bearer token has been revoked',
      })
    }

    const presentedThumbprint = request.headers['x-client-cert-thumbprint']
    if (typeof presentedThumbprint === 'string') {
      const expectedThumbprint = getConfirmationThumbprint(payload)
      if (!expectedThumbprint || presentedThumbprint !== expectedThumbprint) {
        return void reply.status(401).send({
          error: 'cnf_binding_mismatch',
          error_description: 'Bearer token CNF binding does not match presented credential',
        })
      }
    }

    if (opts.requiredScopes && !hasRequiredScopes(payload, opts.requiredScopes)) {
      return void reply.status(403).send({
        error: 'insufficient_scope',
        error_description: `Bearer token requires scope: ${opts.requiredScopes.join(' ')}`,
      })
    }

    const authenticated = request as KAIFAuthenticatedRequest
    authenticated.kaifAuth = payload
    authenticated.kaifBearerToken = token
  }
}
