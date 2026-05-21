/**
 * KAIF mock agent — demonstrates SDK usage in a compose environment.
 *
 * Required env vars:
 *   KAIF_SERVER_URL      — e.g. http://kaif-server:8080
 *   AGENT_SPIFFE_ID      — e.g. spiffe://kindred.systems/ns/examples/agent/mock
 *   DELEGATION_GRANT_ID  — delegation grant JWT from POST /provision
 *
 * The SVID is fetched by the SPIRE agent and written to /tmp/svid.jwt
 * by the spire-agent container via SVIDStore.
 */
import { KAIFClient } from '@kaif/sdk'

const KAIF_SERVER_URL    = process.env['KAIF_SERVER_URL']
const AGENT_SPIFFE_ID    = process.env['AGENT_SPIFFE_ID']
const DELEGATION_TOKEN   = process.env['DELEGATION_TOKEN']

if (!KAIF_SERVER_URL || !AGENT_SPIFFE_ID || !DELEGATION_TOKEN) {
  console.error('Missing required env vars: KAIF_SERVER_URL, AGENT_SPIFFE_ID, DELEGATION_TOKEN')
  process.exit(1)
}

const SCOPE    = 'invoke:completion'
const AUDIENCE = KAIF_SERVER_URL

async function main(): Promise<void> {
  const client = new KAIFClient({
    server_url:       KAIF_SERVER_URL!,
    spiffe_id:        AGENT_SPIFFE_ID!,
    svid_path:        '/tmp/svid.jwt',
    delegation_token: DELEGATION_TOKEN!,
  })

  console.log('Requesting KAIF token...')
  const token = await client.getToken(SCOPE, AUDIENCE)
  console.log(`Token acquired (${token.length} chars)`)

  const header = await client.authHeader(SCOPE, AUDIENCE)
  console.log('Authorization header:', header.substring(0, 40) + '...')

  // Simulate using the token for a downstream service call
  console.log('Calling downstream service...')
  const res = await fetch(`${KAIF_SERVER_URL}/introspect`, {
    method:  'POST',
    headers: {
      'content-type':  'application/json',
      'authorization': header,
    },
    body: JSON.stringify({ token }),
  })
  const introspect = await res.json() as { active: boolean }
  console.log('Introspect active:', introspect.active)

  console.log('Revoking tokens...')
  await client.revoke()
  console.log('Done.')
}

main().catch(err => {
  console.error('mock-agent error:', err)
  process.exit(1)
})
