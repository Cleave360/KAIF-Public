/**
 * KAIF mock service — demonstrates KAIF JWT validation in a relying party.
 *
 * Fetches the KAIF server's JWKS and verifies incoming Bearer tokens.
 * Every protected route calls verifyKAIFToken() before processing.
 *
 * Required env vars:
 *   KAIF_SERVER_URL  — e.g. http://kaif-server:8080
 *   SERVICE_PORT     — default 9000
 */
import Fastify from 'fastify'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { JWTPayload } from 'jose'

const KAIF_SERVER_URL = process.env['KAIF_SERVER_URL'] ?? 'http://localhost:8080'
const PORT            = parseInt(process.env['SERVICE_PORT'] ?? '9000', 10)

// Fetch JWKS from KAIF server at startup (cached by jose)
const JWKS = createRemoteJWKSet(
  new URL(`${KAIF_SERVER_URL}/.well-known/jwks.json`)
)

interface KAIFClaims extends JWTPayload {
  scope?: string
  kaif?: {
    trust_score:      number
    trust_tier:       string
    delegation_depth: number
    delegation_id:    string
    principal_chain:  string[]
  }
  actor?: { sub: string }
}

async function verifyKAIFToken(authHeader: string | undefined): Promise<KAIFClaims> {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or malformed Authorization header')
  }
  const token = authHeader.slice(7)
  const { payload } = await jwtVerify<KAIFClaims>(token, JWKS, {
    issuer: KAIF_SERVER_URL,
  })
  return payload
}

const app = Fastify({ logger: true })

// Protected endpoint — requires valid KAIF token with invoke:completion scope
app.post('/complete', async (request, reply) => {
  let claims: KAIFClaims
  try {
    claims = await verifyKAIFToken(
      request.headers.authorization
    )
  } catch (err) {
    return reply.status(401).send({ error: 'invalid_token', error_description: String(err) })
  }

  const scopes = (claims.scope ?? '').split(' ')
  if (!scopes.includes('invoke:completion')) {
    return reply.status(403).send({ error: 'insufficient_scope' })
  }

  app.log.info({
    principal:  claims.sub,
    agent:      claims.actor?.sub,
    trust_tier: claims.kaif?.trust_tier,
    depth:      claims.kaif?.delegation_depth,
  }, 'REQUEST_AUTHORISED')

  return reply.send({
    ok:         true,
    principal:  claims.sub,
    trust_tier: claims.kaif?.trust_tier ?? 'UNKNOWN',
  })
})

app.get('/health', async () => ({ status: 'ok' }))

app.listen({ port: PORT, host: '0.0.0.0' }).catch(err => {
  console.error(err)
  process.exit(1)
})
