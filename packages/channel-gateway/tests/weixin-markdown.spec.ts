import { describe, expect, it } from 'vitest'
import { sanitizeWeixinMarkdown, splitWeixinMarkdown } from '../src/adapters/weixin/markdown.ts'

describe('sanitizeWeixinMarkdown', () => {
  it('replaces angle brackets with full-width forms outside code', () => {
    expect(sanitizeWeixinMarkdown('a < b > c')).toBe('a ＜ b ＞ c')
  })

  it('keeps code regions byte-for-byte', () => {
    expect(sanitizeWeixinMarkdown('`a < b`')).toBe('`a < b`')
    expect(sanitizeWeixinMarkdown('```\nx > y\n```')).toBe('```\nx > y\n```')
  })

  it('drops image links, strikethrough, and deep headers', () => {
    expect(sanitizeWeixinMarkdown('before ![alt](http://x/y.png) after')).toBe('before  after')
    expect(sanitizeWeixinMarkdown('~~gone~~ text')).toBe('gone text')
    expect(sanitizeWeixinMarkdown('##### deep')).toBe('deep')
  })
})

describe('splitWeixinMarkdown', () => {
  it('returns one chunk when it already fits and none for empty', () => {
    expect(splitWeixinMarkdown('short', 2048)).toEqual(['short'])
    expect(splitWeixinMarkdown('   ', 2048)).toEqual([])
  })

  it('balances fenced code blocks across a split', () => {
    const content = '```\n' + `${'x'.repeat(40)}\n`.repeat(4)
    const chunks = splitWeixinMarkdown(content, 80)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
    }
  })
})
