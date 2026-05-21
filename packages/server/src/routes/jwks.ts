import type { FastifyInstance } from 'fastify'
import { getJWKS } from '../crypto/keys.js'

export async function jwksRoute(app: FastifyInstance): Promise<void> {
  app.get('/.well-known/jwks.json', async (_request, reply) => {
    const jwks = await getJWKS()
    return reply
      .header('Cache-Control', 'public, max-age=3600')
      .status(200)
      .send(jwks)
  })
}
