import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeFoundry } from '../src/services/foundry.js'

const originalEnv = { ...process.env }

function setBaseEnv(): void {
  process.env['KAIF_ISSUER'] = 'https://auth.test'
  process.env['KAIF_REDIS_URL'] = 'redis://localhost:6379'
  process.env['KAIF_SPIRE_BUNDLE_ENDPOINT'] = 'https://spire.test/'
  process.env['KAIF_SPIRE_TRUST_DOMAIN'] = 'kindred.systems'
  process.env['KAIF_IDP_JWKS_URL'] = 'https://idp.test/jwks'
  process.env['KAIF_IDP_ISSUER'] = 'https://idp.test'
  process.env['KAIF_AGENTS_CONFIG_PATH'] = new URL('../config/agents.yaml', import.meta.url).pathname
  process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT'] = 'https://example-resource.services.ai.azure.com/api/projects/kindred-1882'
  process.env['KAIF_FOUNDRY_API_VERSION'] = '2025-05-15-preview'
  process.env['KAIF_FOUNDRY_INVOKE_PATH'] = '/agents/mock/runs'
}

describe('invokeFoundry', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    setBaseEnv()
    delete process.env['KAIF_FOUNDRY_API_KEY']
    delete process.env['KAIF_FOUNDRY_AAD_SCOPE']
    delete process.env['KAIF_FOUNDRY_MODE']
    delete process.env['KAIF_FOUNDRY_MODEL']
    delete process.env['KAIF_FOUNDRY_AGENT_NAME']
    delete process.env['KAIF_FOUNDRY_AGENT_VERSION']
    delete process.env['AZURE_TENANT_ID']
    delete process.env['AZURE_CLIENT_ID']
    delete process.env['AZURE_CLIENT_SECRET']
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
  })

  it('uses api-key auth when configured', async () => {
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'api_key'
    process.env['KAIF_FOUNDRY_API_KEY'] = 'test-api-key'

    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : String(input)
      expect(url).toContain('/api/projects/kindred-1882/agents/mock/runs')
      expect(url).toContain('api-version=2025-05-15-preview')
      expect((init?.headers as Record<string, string>)['api-key']).toBe('test-api-key')
      expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json')
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ms-request-id': 'req-123' },
      })
    })

    const response = await invokeFoundry(
      { body: { prompt: 'hello' } },
      { fetchImpl: fetchImpl as typeof fetch }
    )

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(response.status).toBe(200)
    expect(response.headers['x-ms-request-id']).toBe('req-123')
    expect(response.body).toEqual({ ok: true })
  })

  it('uses bearer auth when configured for Azure AD', async () => {
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'azure_ad'
    process.env['KAIF_FOUNDRY_AAD_SCOPE'] = 'https://ai.azure.com/.default'

    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer foundry-token')
      return new Response(JSON.stringify({ result: 'ok' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    })

    const response = await invokeFoundry(
      { path: '/agents/runtime/runs', body: { prompt: 'hello' } },
      {
        fetchImpl: fetchImpl as typeof fetch,
        tokenProvider: async (scope) => {
          expect(scope).toBe('https://ai.azure.com/.default')
          return { token: 'foundry-token' }
        },
      }
    )

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(response.status).toBe(202)
    expect(response.body).toEqual({ result: 'ok' })
  })

  it('supports auth mode none for local mock bridges', async () => {
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'none'

    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['authorization']).toBeUndefined()
      expect((init?.headers as Record<string, string>)['api-key']).toBeUndefined()
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    })

    const response = await invokeFoundry(
      { method: 'GET', path: '/health' },
      { fetchImpl: fetchImpl as typeof fetch }
    )

    expect(response.status).toBe(200)
    expect(response.body).toBe('ok')
  })

  it('defaults project agent calls to /openai/v1/responses when invoke path is omitted', async () => {
    process.env['KAIF_FOUNDRY_PROJECT_ENDPOINT'] = 'https://example-resource.services.ai.azure.com/api/projects/kindred-1882'
    process.env['KAIF_FOUNDRY_API_VERSION'] = '2025-05-15-preview'
    process.env['KAIF_FOUNDRY_MODE'] = 'project_agent'
    process.env['KAIF_FOUNDRY_AUTH_MODE'] = 'azure_ad'
    process.env['KAIF_FOUNDRY_AAD_SCOPE'] = 'https://ai.azure.com/.default'
    process.env['KAIF_FOUNDRY_MODEL'] = 'gpt-5-mini'
    process.env['KAIF_FOUNDRY_AGENT_NAME'] = 'BoundaryAgent'
    process.env['KAIF_FOUNDRY_AGENT_VERSION'] = '2'
    delete process.env['KAIF_FOUNDRY_INVOKE_PATH']

    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input.toString() : String(input)
      expect(url).toContain('/api/projects/kindred-1882/openai/v1/responses')
      expect(url).not.toContain('api-version=')
      return new Response(JSON.stringify({ id: 'resp_123', status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const response = await invokeFoundry(
      { body: { model: 'gpt-5-mini', input: [{ role: 'user', content: 'hello' }] } },
      {
        fetchImpl: fetchImpl as typeof fetch,
        tokenProvider: async () => ({ token: 'foundry-token' }),
      }
    )

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: 'resp_123', status: 'completed' })
  })
})
