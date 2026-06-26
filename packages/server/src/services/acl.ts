import { readFileSync } from 'fs'
import { resolve } from 'path'
import yaml from 'js-yaml'
import micromatch from 'micromatch'
import type { Redis } from 'ioredis'
import { TRUST_TIERS } from '../types/kaif.js'
import type { AgentACL, AgentACLConfig, TrustTier } from '../types/kaif.js'
import { KAIFError } from '../errors.js'
import { assertTierMinimum } from './trust-score.js'
import { validateSpiffeID } from './svid.js'

let _acl: AgentACLConfig | null = null
let _aclPath: string | null = null
let _sighupHandler: (() => void) | null = null

const TRUST_TIER_NAMES = new Set<TrustTier>(TRUST_TIERS.map(t => t.tier))

function fail(message: string): never {
  throw new Error(`Invalid agents ACL: ${message}`)
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${path} must be a non-empty string`)
  }
  return value
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`)
  return value
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`${path} must be an integer >= 0`)
  }
  return value
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`${path} must be an integer > 0`)
  }
  return value
}

function validateScopePattern(scope: string, path: string): void {
  if (scope.includes('/')) {
    fail(`${path} must use colon-delimited scope grammar and cannot contain "/"`)
  }
  if (scope.includes('**')) {
    fail(`${path} must not use recursive wildcard "**"`)
  }
}

export function validateACLConfig(rawConfig: unknown): AgentACLConfig {
  const configObj = requireObject(rawConfig, 'root')
  const agents = requireObject(configObj['agents'], 'agents')
  const entries = Object.entries(agents)

  if (entries.length === 0) fail('agents must contain at least one entry')

  const seenSpiffeIds = new Set<string>()
  const validated: AgentACLConfig = { agents: {} }

  for (const [name, rawAgent] of entries) {
    if (name.trim().length === 0) fail('agent name must be non-empty')

    const agent = requireObject(rawAgent, `agents.${name}`)
    const spiffeId = requireString(agent['spiffe_id'], `agents.${name}.spiffe_id`)
    if (!validateSpiffeID(spiffeId)) {
      fail(`agents.${name}.spiffe_id is not a valid SPIFFE ID`)
    }
    if (seenSpiffeIds.has(spiffeId)) {
      fail(`agents.${name}.spiffe_id duplicates another agent`)
    }
    seenSpiffeIds.add(spiffeId)

    const trustTier = requireString(agent['trust_tier_minimum'], `agents.${name}.trust_tier_minimum`)
    if (!TRUST_TIER_NAMES.has(trustTier as TrustTier)) {
      fail(`agents.${name}.trust_tier_minimum is not a valid trust tier`)
    }

    const scopes = agent['permitted_scopes']
    if (!Array.isArray(scopes) || scopes.length === 0) {
      fail(`agents.${name}.permitted_scopes must be a non-empty string array`)
    }

    const permittedScopes = scopes.map((scope, index) => {
      const validatedScope = requireString(scope, `agents.${name}.permitted_scopes[${index}]`)
      validateScopePattern(validatedScope, `agents.${name}.permitted_scopes[${index}]`)
      return validatedScope
    })

    validated.agents[name] = {
      spiffe_id:                spiffeId,
      trust_tier_minimum:       trustTier as TrustTier,
      permitted_scopes:         permittedScopes,
      may_sub_delegate:         requireBoolean(agent['may_sub_delegate'], `agents.${name}.may_sub_delegate`),
      max_delegation_depth:     requireNonNegativeInteger(agent['max_delegation_depth'], `agents.${name}.max_delegation_depth`),
      delegation_ttl_seconds:   requirePositiveInteger(agent['delegation_ttl_seconds'], `agents.${name}.delegation_ttl_seconds`),
      human_principal_required: requireBoolean(agent['human_principal_required'], `agents.${name}.human_principal_required`),
    }
  }

  return validated
}

export function loadACL(configPath?: string): AgentACLConfig {
  const path = configPath
    ?? process.env['KAIF_AGENTS_CONFIG_PATH']
    ?? resolve(process.cwd(), 'config/agents.yaml')

  if (_acl && _aclPath === path) return _acl

  const raw = readFileSync(path, 'utf8')
  _acl = validateACLConfig(yaml.load(raw))
  _aclPath = path

  // Register SIGHUP reload — remove only our own previous handler.
  if (_sighupHandler) process.off('SIGHUP', _sighupHandler)
  _sighupHandler = () => {
    _acl = null
    loadACL(path)
  }
  process.on('SIGHUP', _sighupHandler)

  return _acl
}

export function _resetACLCache(): void {
  _acl = null
  _aclPath = null
  if (_sighupHandler) {
    process.off('SIGHUP', _sighupHandler)
    _sighupHandler = null
  }
}

export function getAgentACL(spiffe_id: string, configPath?: string): AgentACL | null {
  const config = loadACL(configPath)
  for (const entry of Object.values(config.agents)) {
    if (entry.spiffe_id === spiffe_id) return entry
  }
  return null
}

// Look up ACL entry by the yaml name key (e.g. "lyra"), not SPIFFE ID
export function getAgentACLByName(name: string, configPath?: string): AgentACL | null {
  const config = loadACL(configPath)
  return config.agents[name] ?? null
}

export function validateScopes(
  requested: string[],
  permitted: string[]
): { valid: boolean; denied: string[] } {
  const denied: string[] = []

  for (const scope of requested) {
    const matched = permitted.some(pattern => micromatch.isMatch(scope, pattern))
    if (!matched) denied.push(scope)
  }

  return { valid: denied.length === 0, denied }
}

export async function assertAuthorised(params: {
  redis:            Redis
  agent_acl:        AgentACL
  requested_scopes: string[]
  authorization_tier_value: number
  delegation_depth: number
}): Promise<void> {
  const { agent_acl, requested_scopes, authorization_tier_value, delegation_depth } = params

  // SPIFFE ID must be valid — verify it before any ACL lookup
  if (!validateSpiffeID(agent_acl.spiffe_id)) {
    throw new KAIFError('access_denied', 'Agent SPIFFE ID is malformed')
  }

  // Authorization tier check
  assertTierMinimum(authorization_tier_value, agent_acl.trust_tier_minimum)

  // Delegation depth check
  if (delegation_depth > agent_acl.max_delegation_depth) {
    throw new KAIFError(
      'delegation_depth_exceeded',
      `Delegation depth ${delegation_depth} exceeds agent maximum of ${agent_acl.max_delegation_depth}`
    )
  }

  // Scope check
  const { valid, denied } = validateScopes(requested_scopes, agent_acl.permitted_scopes)
  if (!valid) {
    throw new KAIFError(
      'invalid_scope',
      `Requested scopes not permitted: ${denied.join(', ')}`
    )
  }
}
