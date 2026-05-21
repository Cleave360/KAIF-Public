import { describe, it, expect } from 'vitest'
import { allFixtures } from '../fixtures/index.js'
import { VALID_TRUST_TIERS } from '../types.js'

describe('fixture registry', () => {
  it('exports exactly seven fixtures', () => {
    expect(allFixtures).toHaveLength(7)
  })

  it('fixture IDs are unique and match KAIF-00N pattern', () => {
    const ids = allFixtures.map(f => f.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^KAIF-\d{3}$/)
    }
  })

  it('fixture IDs are in ascending order', () => {
    const ids = allFixtures.map(f => f.id)
    expect(ids).toEqual([...ids].sort())
  })

  it('every fixture has required non-empty string fields', () => {
    for (const f of allFixtures) {
      expect(typeof f.name).toBe('string')
      expect(f.name.length).toBeGreaterThan(0)
      expect(typeof f.description).toBe('string')
      expect(f.description.length).toBeGreaterThan(0)
      expect(typeof f.section).toBe('string')
      expect(f.section.length).toBeGreaterThan(0)
    }
  })

  it('every fixture has buildRequest and assert functions', () => {
    for (const f of allFixtures) {
      expect(typeof f.buildRequest).toBe('function')
      expect(typeof f.assert).toBe('function')
    }
  })

  it('KAIF-001 is required (MUST)', () => {
    const f = allFixtures.find(f => f.id === 'KAIF-001')
    expect(f?.required).toBe(true)
  })

  it('KAIF-005 is not required (SHOULD / advisory)', () => {
    const f = allFixtures.find(f => f.id === 'KAIF-005')
    expect(f?.required).toBe(false)
  })

  it('KAIF-005 implements execute() override', () => {
    const f = allFixtures.find(f => f.id === 'KAIF-005')
    expect(typeof f?.execute).toBe('function')
  })

  it('all other fixtures do not implement execute()', () => {
    const others = allFixtures.filter(f => f.id !== 'KAIF-005')
    for (const f of others) {
      expect(f.execute).toBeUndefined()
    }
  })
})

describe('VALID_TRUST_TIERS', () => {
  it('contains exactly the four defined tiers', () => {
    expect(VALID_TRUST_TIERS).toEqual(['PROVISIONAL', 'STANDARD', 'VERIFIED', 'TRUSTED'])
  })
})
