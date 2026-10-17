import { describe, expect, it } from 'vitest'
import {
  renderTelegramHtml,
  splitTelegramHtml,
  splitTelegramMarkdown,
} from '../src/adapters/telegram/markdown.ts'

const LIMIT = 4096

describe('renderTelegramHtml', () => {
  it('renders inline formatting and links as the allowed tags', () => {
    expect(renderTelegramHtml('**bold** and _italic_ and ~~gone~~')).toBe('<b>bold</b> and <i>italic</i> and <s>gone</s>')
    expect(renderTelegramHtml('see [docs](https://x.test)')).toBe('see <a href="https://x.test">docs</a>')
  })

  it('renders headers as bold and bullets as a marker', () => {
    expect(renderTelegramHtml('# Title')).toBe('<b>Title</b>')
    expect(renderTelegramHtml('- one\n- two')).toBe('• one\n• two')
  })

  it('escapes HTML in prose but keeps code content intact inside tags', () => {
    expect(renderTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
    expect(renderTelegramHtml('`a < b`')).toBe('<code>a &lt; b</code>')
    expect(renderTelegramHtml('```\nif (a < b) {}\n```')).toBe('<pre><code>if (a &lt; b) {}</code></pre>')
  })

  it('cannot break out of a link attribute', () => {
    expect(renderTelegramHtml('[x](https://a/?q="onmouseover=alert(1))'))
      .toBe('<a href="https://a/?q=%22onmouseover=alert(1">x</a>)')
  })

  it('does not treat markdown inside a code fence as markdown', () => {
    expect(renderTelegramHtml('```\n**not bold**\n```')).toBe('<pre><code>**not bold**</code></pre>')
  })

  it('renders a pipe table as an aligned monospace box', () => {
    const html = renderTelegramHtml('| a | bb |\n| - | - |\n| 1 | 2 |')
    expect(html.startsWith('<pre><code>')).toBe(true)
    expect(html).toContain('a ')
    expect(html).toContain('─')
  })
})

describe('splitTelegramMarkdown', () => {
  it('returns one chunk when the text already fits', () => {
    expect(splitTelegramMarkdown('short', LIMIT)).toEqual(['short'])
    expect(splitTelegramMarkdown('', LIMIT)).toEqual([])
  })

  it('closes and reopens a fenced code block across a split', () => {
    const body = `${'x'.repeat(40)}\n`.repeat(4)
    const content = '```js\n' + body + '```'
    const chunks = splitTelegramMarkdown(content, 80)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
    }
    expect(chunks[1]?.startsWith('```js')).toBe(true)
  })
})

describe('splitTelegramHtml', () => {
  it('keeps every rendered chunk within the limit', () => {
    const content = 'word '.repeat(2000)
    const chunks = splitTelegramHtml(content, LIMIT)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT)
  })

  it('re-splits when HTML escaping pushes a chunk over the limit', () => {
    const content = '<'.repeat(2000)
    const chunks = splitTelegramHtml(content, LIMIT)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT)
    expect(chunks.join('')).toBe('&lt;'.repeat(2000))
  })
})
