import { loadConfig, type KAIFConfig } from '../config.js'
import { KAIFError } from '../errors.js'

export interface FoundryInvocationRequest {
  path?: string
  method?: 'GET' | 'POST'
  body?: unknown
  headers?: Record<string, string>
}

export interface FoundryInvocationResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

interface AccessToken {
  token: string
  expiresOnTimestamp?: number
}

interface FoundryDeps {
  fetchImpl?: typeof fetch
  tokenProvider?: (scope: string) => Promise<AccessToken>
}

export interface FoundryRequestOptions extends FoundryDeps {}

function requireFoundryConfig(config: KAIFConfig): asserts config is KAIFConfig & {
  foundry_project_endpoint: string
  foundry_auth_mode: 'azure_ad' | 'api_key' | 'none'
} {
  if (!config.foundry_project_endpoint) {
    throw new KAIFError('server_error', 'Foundry project endpoint is not configured')
  }
  if (!config.foundry_auth_mode) {
    throw new KAIFError('server_error', 'Foundry auth mode is not configured')
  }
}

function resolveFoundryPath(config: KAIFConfig, path?: string): string {
  if (path) return path
  if (config.foundry_invoke_path) return config.foundry_invoke_path
  if (config.foundry_mode === 'project_agent') return '/openai/v1/responses'
  throw new KAIFError('server_error', 'Foundry invoke path is not configured')
}

function buildFoundryUrl(config: KAIFConfig, path?: string): URL {
  requireFoundryConfig(config)
  const url = new URL(config.foundry_project_endpoint)
  const normalizedPath = resolveFoundryPath(config, path)
  url.pathname = `${url.pathname.replace(/\/$/, '')}${normalizedPath}`
  const usesOpenAIV1Path = normalizedPath.startsWith('/openai/v1/')
  if (config.foundry_api_version && !usesOpenAIV1Path) {
    url.searchParams.set('api-version', config.foundry_api_version)
  }
  return url
}

async function defaultTokenProvider(scope: string): Promise<AccessToken> {
  const identity = await import('@azure/identity')
  const credential = (
    process.env['AZURE_TENANT_ID']
    && process.env['AZURE_CLIENT_ID']
    && process.env['AZURE_CLIENT_SECRET']
  )
    ? new identity.ClientSecretCredential(
      process.env['AZURE_TENANT_ID'],
      process.env['AZURE_CLIENT_ID'],
      process.env['AZURE_CLIENT_SECRET']
    )
    : new identity.DefaultAzureCredential()

  const token = await credential.getToken(scope)
  if (!token?.token) {
    throw new KAIFError('server_error', 'Azure AD did not return a Foundry access token')
  }
  return token
}

async function buildAuthHeaders(config: KAIFConfig, deps: FoundryDeps): Promise<Record<string, string>> {
  requireFoundryConfig(config)

  if (config.foundry_auth_mode === 'none') {
    return {}
  }

  if (config.foundry_auth_mode === 'api_key') {
    if (!config.foundry_api_key) {
      throw new KAIFError('server_error', 'Foundry API key is not configured')
    }
    return { 'api-key': config.foundry_api_key }
  }

  if (!config.foundry_aad_scope) {
    throw new KAIFError('server_error', 'Foundry Azure AD scope is not configured')
  }

  const provider = deps.tokenProvider ?? defaultTokenProvider
  const token = await provider(config.foundry_aad_scope)
  return { authorization: `Bearer ${token.token}` }
}

function normalizeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => { out[key] = value })
  return out
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return response.json()
  }
  const text = await response.text()
  return text.length > 0 ? text : null
}

export async function invokeFoundry(
  request: FoundryInvocationRequest,
  deps: FoundryRequestOptions = {}
): Promise<FoundryInvocationResponse> {
  const config = loadConfig()
  const url = buildFoundryUrl(config, request.path)
  const authHeaders = await buildAuthHeaders(config, deps)
  const fetchImpl = deps.fetchImpl ?? fetch

  const response = await fetchImpl(url, {
    method: request.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders,
      ...(request.headers ?? {}),
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
  })

  return {
    status: response.status,
    headers: normalizeResponseHeaders(response.headers),
    body: await parseResponseBody(response),
  }
}

export function _buildFoundryUrlForTest(config: KAIFConfig, path?: string): URL {
  return buildFoundryUrl(config, path)
}
