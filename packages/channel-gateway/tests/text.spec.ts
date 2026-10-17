import { describe, expect, it } from 'vitest'
import { splitText } from '../src/adapters/text.ts'
import { errorText } from '../src/errors.ts'

describe('splitText', () => {
  it('refuses a limit no chunk could satisfy', () => {
    expect(() => splitText('ab', 0)).toThrow(/at least 1/)
    expect(() => splitText('ab', -5)).toThrow(/at least 1/)
  })

  it('splits at the last break in range and joins back to the original', () => {
    expect(splitText('hello world again', 12)).toEqual(['hello world ', 'again'])
    expect(splitText('a'.repeat(10), 3)).toEqual(['aaa', 'aaa', 'aaa', 'a'])
  })

  it('never splits a surrogate pair', () => {
    const text = `a${'😀'.repeat(3)}b`
    for (const chunk of splitText(text, 3)) expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/u)
  })
})

describe('errorText', () => {
  it('names a thrown value without ever reading [object Object]', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorText(circular)).toContain('Circular')
    expect(errorText(circular)).not.toBe('[object Object]')
    expect(errorText(Symbol('tag'))).toBe('Symbol(tag)')
    expect(errorText(10n)).toBe('10n')
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
  })
})
