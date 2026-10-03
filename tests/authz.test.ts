import { describe, expect, it } from 'vitest'
import { mergeAnnotations, resolveToolAccess, type AccessPolicy, type LiveEvidence } from '../src/authz.ts'

function policy(overrides: Partial<AccessPolicy> = {}): AccessPolicy {
  return { permissionMode: 'review-all', toolPermission: undefined, trustReadOnlyHint: false, ...overrides }
}

function evidence(overrides: Partial<LiveEvidence> = {}): LiveEvidence {
  return { listed: true, annotations: {}, ...overrides }
}

describe('resolveToolAccess — the single authorization seam', () => {
  it('review-all mode reviews everything, even explicit grants', () => {
    expect(resolveToolAccess(policy({ permissionMode: 'review-all', toolPermission: 'allow' }), evidence())).toBe('review')
    expect(resolveToolAccess(policy({ permissionMode: 'review-all' }), evidence())).toBe('review')
  })

  it('unknown permission mode values fall to review (strictest)', () => {
    expect(resolveToolAccess(policy({ permissionMode: 'Allowlist' }), evidence())).toBe('review')
    expect(resolveToolAccess(policy({ permissionMode: undefined }), evidence())).toBe('review')
    expect(resolveToolAccess(policy({ permissionMode: 'allowlist-but-worse' }), evidence())).toBe('review')
  })

  it('rule 1: destructiveHint is a hard veto even over an explicit allow', () => {
    const p = policy({ permissionMode: 'allowlist', toolPermission: 'allow' })
    expect(resolveToolAccess(p, evidence({ annotations: { destructiveHint: true } }))).toBe('review')
    // ...and over trustReadOnlyHint
    const t = policy({ permissionMode: 'allowlist', trustReadOnlyHint: true })
    expect(resolveToolAccess(t, evidence({ annotations: { destructiveHint: true, readOnlyHint: true } }))).toBe('review')
  })

  it('rule 2: an explicit allow needs no server evidence at all', () => {
    const p = policy({ permissionMode: 'allowlist', toolPermission: 'allow' })
    expect(resolveToolAccess(p, { listed: false })).toBe('allow')
    expect(resolveToolAccess(p)).toBe('allow')
  })

  it('rule 2: an explicit review stays review inside allowlist mode', () => {
    const p = policy({ permissionMode: 'allowlist', toolPermission: 'review' })
    expect(resolveToolAccess(p, evidence())).toBe('review')
  })

  it('unknown toolPermission values are treated as absent, not as allow', () => {
    const p = policy({ permissionMode: 'allowlist', toolPermission: 'Allow' })
    expect(resolveToolAccess(p, evidence())).toBe('review')
  })

  it('rule 3: trustReadOnlyHint allows only with a LIVE read-only declaration', () => {
    const p = policy({ permissionMode: 'allowlist', trustReadOnlyHint: true })
    expect(resolveToolAccess(p, evidence({ annotations: { readOnlyHint: true } }))).toBe('allow')
    // No live listing this run → fail closed.
    expect(resolveToolAccess(p, { listed: false })).toBe('review')
    expect(resolveToolAccess(p)).toBe('review')
    // Server listed the tool but did NOT claim read-only.
    expect(resolveToolAccess(p, evidence({ annotations: { readOnlyHint: false } }))).toBe('review')
    expect(resolveToolAccess(p, evidence({ annotations: {} }))).toBe('review')
  })

  it('trustReadOnlyHint without the opt-in never allows', () => {
    const p = policy({ permissionMode: 'allowlist', trustReadOnlyHint: false })
    expect(resolveToolAccess(p, evidence({ annotations: { readOnlyHint: true } }))).toBe('review')
  })
})

describe('mergeAnnotations — merging only ever raises scrutiny', () => {
  it('a raising hint counts when any occurrence declares it', () => {
    expect(mergeAnnotations({ destructiveHint: true }, { destructiveHint: false }).destructiveHint).toBe(true)
    expect(mergeAnnotations({ destructiveHint: false }, { destructiveHint: true }).destructiveHint).toBe(true)
  })

  it('a lowering hint survives only when every occurrence declares it', () => {
    expect(mergeAnnotations({ readOnlyHint: true }, { readOnlyHint: true }).readOnlyHint).toBe(true)
    expect(mergeAnnotations({ readOnlyHint: true }, { readOnlyHint: false }).readOnlyHint).toBe(false)
    expect(mergeAnnotations({ readOnlyHint: true }, {}).readOnlyHint).toBe(false)
  })

  it('an absent lowering hint in the FIRST listing stays absent unless next claims it', () => {
    const merged = mergeAnnotations(undefined, { readOnlyHint: true })
    expect(merged.readOnlyHint).toBe(true)
  })
})
