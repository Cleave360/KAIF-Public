import { describe, it, expect, afterEach } from 'vitest'
import {
  _resetACLCache,
  loadACL,
  validateACLConfig,
} from '../src/services/acl.js'

const validConfig = {
  agents: {
    lyra: {
      spiffe_id: 'spiffe://kindred.systems/ns/adaptive-layer/agent/lyra',
      trust_tier_minimum: 'STANDARD',
      permitted_scopes: ['invoke:completion', 'vault:read:*'],
      may_sub_delegate: false,
      max_delegation_depth: 1,
      delegation_ttl_seconds: 900,
      human_principal_required: true,
    },
  },
}

describe('ACL validation', () => {
  afterEach(() => {
    _resetACLCache()
  })

  it('accepts a valid ACL config', () => {
    const config = validateACLConfig(validConfig)
    expect(config.agents.lyra?.spiffe_id).toBe(validConfig.agents.lyra.spiffe_id)
  })

  it('rejects invalid SPIFFE IDs', () => {
    expect(() => validateACLConfig({
      agents: {
        bad: {
          ...validConfig.agents.lyra,
          spiffe_id: 'not-a-spiffe-id',
        },
      },
    })).toThrow(/spiffe_id is not a valid SPIFFE ID/)
  })

  it('rejects unknown trust tiers', () => {
    expect(() => validateACLConfig({
      agents: {
        bad: {
          ...validConfig.agents.lyra,
          trust_tier_minimum: 'ROOT',
        },
      },
    })).toThrow(/trust_tier_minimum is not a valid trust tier/)
  })

  it('rejects slash-delimited scope patterns', () => {
    expect(() => validateACLConfig({
      agents: {
        bad: {
          ...validConfig.agents.lyra,
          permitted_scopes: ['vault/read/*'],
        },
      },
    })).toThrow(/cannot contain "\/"/)
  })

  it('rejects negative delegation depth', () => {
    expect(() => validateACLConfig({
      agents: {
        bad: {
          ...validConfig.agents.lyra,
          max_delegation_depth: -1,
        },
      },
    })).toThrow(/max_delegation_depth must be an integer >= 0/)
  })

  it('loadACL removes only its own SIGHUP handler', () => {
    const keepHandler = () => {}
    process.on('SIGHUP', keepHandler)

    try {
      const path = new URL('../config/agents.yaml', import.meta.url).pathname
      loadACL(path)
      loadACL(path)

      expect(process.listeners('SIGHUP')).toContain(keepHandler)
    } finally {
      process.off('SIGHUP', keepHandler)
    }
  })
})
