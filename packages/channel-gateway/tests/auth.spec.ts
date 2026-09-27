import { describe, expect, it } from 'vitest'
import { allowlistAuth } from '../src/auth.ts'

const request = {
  channel: 'telegram',
  actor: { id: '42' },
  place: { route: 'chat:42', kind: 'direct' as const },
  visibility: 'private' as const,
}

describe('allowlistAuth', () => {
  it('admits an actor named as channel:actorId', () => {
    expect(allowlistAuth(['telegram:42']).authorize(request)).toBe(true)
  })

  it('admits nobody when the list is empty', () => {
    expect(allowlistAuth([]).authorize(request)).toBe(false)
  })

  it('admits every actor of one channel through channel:*', () => {
    const policy = allowlistAuth(['telegram:*'])
    expect(policy.authorize(request)).toBe(true)
    expect(policy.authorize({ ...request, channel: 'weixin' })).toBe(false)
  })

  it('admits everyone only when * is spelled out', () => {
    expect(allowlistAuth(['*']).authorize({ ...request, channel: 'weixin' })).toBe(true)
  })

  it('compares the whole actor id, not a prefix', () => {
    expect(allowlistAuth(['telegram:4']).authorize(request)).toBe(false)
  })

  it('ignores blank entries and surrounding space', () => {
    expect(allowlistAuth(['  ', ' telegram:42 ']).authorize(request)).toBe(true)
  })

  it('decides from the actor id, never from a display name', () => {
    const named = { ...request, actor: { id: '99', displayName: 'telegram:42' } }
    expect(allowlistAuth(['telegram:42']).authorize(named)).toBe(false)
  })
})
