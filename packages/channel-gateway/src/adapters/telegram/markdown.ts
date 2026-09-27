/**
 * Rendering an agent's Markdown into what Telegram actually displays.
 *
 * Telegram has no Markdown mode that survives real agent output: its own
 * "Markdown" breaks on an unbalanced `_` or `*`, so the reliable path is HTML
 * parse mode with a small, closed tag set. This module turns Markdown into that
 * HTML and splits it so no chunk crosses Telegram's per-message limit or leaves
 * a fenced code block half-open. It is transport fidelity — how one provider
 * shows formatted text — not a usage opinion: a consumer asks for it per
 * message through {@link OutboundMessage.format}.
 *
 * The approach follows nanobot's telegram renderer (MIT): protect code, render
 * the rest, restore code last.
 * @module @wowyuarm/dsh-channel-gateway/adapters/telegram-markdown
 */

import { ChannelGatewayError } from '../../errors.ts'
import { avoidSurrogateSplit } from '../text.ts'

/** Sentinels that stand in for code while the surrounding text is transformed. */
const CODE_BLOCK = (index: number): string => `\u0000CB${String(index)}\u0000`
const INLINE_CODE = (index: number): string => `\u0000IC${String(index)}\u0000`
/** Header markers that survive HTML escaping, restored to `<b>` at the end. */
const HEADER_OPEN = '\u2770B\u2771'
const HEADER_CLOSE = '\u2770/B\u2771'

/** The four characters that would otherwise be read as HTML markup. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Display width of a string, counting East Asian wide characters as two. */
function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1
  return width
}

/** Whether a code point occupies two columns in a monospace terminal. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  )
}

/** Strip inline Markdown so a table cell measures and prints as plain text. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

/**
 * Turn a Markdown pipe table into a monospace box. Telegram cannot lay out a
 * table, but a `<pre>` block preserves the alignment this produces. Returns the
 * input unchanged when the lines are not actually a table (no separator row).
 */
function renderTableBox(lines: readonly string[]): string {
  const rows: string[][] = []
  let hasSeparator = false
  for (const line of lines) {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(stripInlineMarkdown)
    if (cells.filter(cell => cell !== '').every(cell => /^:?-+:?$/.test(cell))) {
      hasSeparator = true
      continue
    }
    rows.push(cells)
  }
  if (rows.length === 0 || !hasSeparator) return lines.join('\n')

  const columns = Math.max(...rows.map(row => row.length))
  for (const row of rows) while (row.length < columns) row.push('')
  const widths = Array.from({ length: columns }, (_column, column) => Math.max(...rows.map(row => displayWidth(row[column] ?? ''))))
  const drawRow = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell + ' '.repeat((widths[column] ?? 0) - displayWidth(cell))).join('  ')

  const out = [drawRow(rows[0] ?? []), widths.map(width => '─'.repeat(width)).join('  ')]
  for (const row of rows.slice(1)) out.push(drawRow(row))
  return out.join('\n')
}

/**
 * Render Markdown as Telegram-safe HTML. Code is pulled out first so its
 * content is never treated as Markdown, everything else is escaped and
 * translated to the allowed tags, then code is restored escaped inside
 * `<code>`/`<pre>`.
 */
export function renderTelegramHtml(text: string): string {
  if (text === '') return ''

  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  let out = text.replace(/```(?:[^\n]*\n)?([\s\S]*?)```/g, (_match, code: string) => {
    // Drop the newline that sits before the closing fence so the <pre> block
    // does not render a trailing blank line.
    codeBlocks.push(code.replace(/\n$/, ''))
    return CODE_BLOCK(codeBlocks.length - 1)
  })

  // Tables become box drawings, parked as code blocks so they land in a <pre>.
  const lines = out.split('\n')
  const rebuilt: string[] = []
  let index = 0
  while (index < lines.length) {
    if (/^\s*\|.+\|/.test(lines[index] ?? '')) {
      const table: string[] = []
      while (index < lines.length && /^\s*\|.+\|/.test(lines[index] ?? '')) {
        table.push(lines[index] ?? '')
        index += 1
      }
      const box = renderTableBox(table)
      if (box !== table.join('\n')) {
        codeBlocks.push(box)
        rebuilt.push(CODE_BLOCK(codeBlocks.length - 1))
      } else {
        rebuilt.push(...table)
      }
    } else {
      rebuilt.push(lines[index] ?? '')
      index += 1
    }
  }
  out = rebuilt.join('\n')

  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    inlineCodes.push(code)
    return INLINE_CODE(inlineCodes.length - 1)
  })

  out = out.replace(/^#{1,6}\s+(.+)$/gm, (_match, heading: string) => `${HEADER_OPEN}${heading}${HEADER_CLOSE}`)
  out = out.replace(/^>\s*(.*)$/gm, '$1')
  out = escapeTelegramHtml(out)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/__(.+?)__/g, '<b>$1</b>')
  out = out.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, '<i>$1</i>')
  out = out.replace(/~~(.+?)~~/g, '<s>$1</s>')
  out = out.replace(/^[-*]\s+/gm, '• ')
  out = out.replace(/^(\d+)\.\s+/gm, '$1. ')

  inlineCodes.forEach((code, i) => {
    out = out.replace(INLINE_CODE(i), () => `<code>${escapeTelegramHtml(code)}</code>`)
  })
  codeBlocks.forEach((code, i) => {
    out = out.replace(CODE_BLOCK(i), () => `<pre><code>${escapeTelegramHtml(code)}</code></pre>`)
  })
  out = out.replaceAll(HEADER_OPEN, '<b>').replaceAll(HEADER_CLOSE, '</b>')
  return out
}

/** The fenced-code region that a break at `pos` would sit inside, if any. */
function fenceContext(content: string, pos: number): { inside: boolean; opening: number; fence: string } {
  const before = content.slice(0, pos)
  if ((before.match(/```/g) ?? []).length % 2 === 0) return { inside: false, opening: -1, fence: '' }
  const opening = before.lastIndexOf('```')
  if (opening < 0) return { inside: true, opening: -1, fence: '```' }
  const lineEnd = content.indexOf('\n', opening)
  return { inside: true, opening, fence: lineEnd < 0 ? content.slice(opening) : content.slice(opening, lineEnd) }
}

/** Last index of `sub` at or after `from`, or -1 — Python's `str.rfind(sub, from)`. */
function rfindFrom(text: string, sub: string, from: number): number {
  const index = text.lastIndexOf(sub)
  return index >= from ? index : -1
}

/**
 * Split raw Markdown so no chunk exceeds `maxLen` and no chunk leaves a fenced
 * code block open: when a break falls inside a fence, the chunk is closed with
 * ``` and the next chunk reopens the same fence line. Ported from nanobot.
 */
export function splitTelegramMarkdown(content: string, maxLen: number): string[] {
  let rest = content.replace(/^\s+/, '')
  if (rest === '') return []
  if (rest.length <= maxLen) return [rest]

  const chunks: string[] = []
  while (rest !== '') {
    if (rest.length <= maxLen) {
      chunks.push(rest)
      break
    }
    const cut = rest.slice(0, maxLen)
    let pos = cut.lastIndexOf('\n')
    if (pos <= 0) pos = cut.lastIndexOf(' ')
    if (pos <= 0) pos = maxLen

    const { inside, opening, fence } = fenceContext(rest, pos)
    if (inside) {
      if (opening > 0) {
        pos = opening
      } else {
        const closing = '\n```'
        let minCodePos = fence.length
        if (rest.startsWith(`${fence}\n`)) minCodePos += 1
        // When the only break in range is the opening fence line, cutting there
        // would re-emit the same fence and never advance; fall back accordingly.
        if (pos < minCodePos) {
          if (minCodePos + closing.length >= maxLen) {
            chunks.push(rest.slice(0, avoidSurrogateSplit(rest, maxLen)))
            rest = rest.slice(maxLen).replace(/^\s+/, '')
            continue
          }
          pos = adjustedFenceBreak(rest, maxLen - closing.length, minCodePos)
        } else if (pos + closing.length > maxLen) {
          const budget = maxLen - closing.length
          if (budget <= minCodePos) {
            chunks.push(rest.slice(0, avoidSurrogateSplit(rest, maxLen)))
            rest = rest.slice(maxLen).replace(/^\s+/, '')
            continue
          }
          pos = adjustedFenceBreak(rest, budget, minCodePos)
        }
        if (pos <= minCodePos) {
          chunks.push(rest.slice(0, avoidSurrogateSplit(rest, maxLen)))
          rest = rest.slice(maxLen).replace(/^\s+/, '')
          continue
        }
        pos = avoidSurrogateSplit(rest, pos)
        chunks.push(rest.slice(0, pos) + closing)
        let remainder = rest.slice(pos)
        if (remainder.startsWith('\n')) remainder = remainder.slice(1)
        rest = `${fence}\n${remainder}`
        continue
      }
    }
    pos = avoidSurrogateSplit(rest, pos)
    chunks.push(rest.slice(0, pos))
    rest = rest.slice(pos).replace(/^\s+/, '')
  }
  return chunks
}

/** The break point inside a fence: last newline in budget, else space, else budget. */
function adjustedFenceBreak(content: string, budget: number, minCodePos: number): number {
  const recut = content.slice(0, budget)
  let adjusted = rfindFrom(recut, '\n', minCodePos)
  if (adjusted < minCodePos) adjusted = rfindFrom(recut, ' ', minCodePos)
  return adjusted > minCodePos ? adjusted : budget
}

/**
 * Render Markdown to HTML chunks each within `maxLen`. HTML can be longer than
 * its Markdown (tags, escaped entities), so a chunk whose HTML overflows is
 * re-split from the raw Markdown with a smaller budget rather than by slicing
 * HTML, which would cut a tag in half.
 */
export function splitTelegramHtml(content: string, maxLen: number): string[] {
  const html: string[] = []
  const pending = splitTelegramMarkdown(content, maxLen)
  while (pending.length > 0) {
    const chunk = pending.shift() ?? ''
    const rendered = renderTelegramHtml(chunk)
    if (rendered.length <= maxLen) {
      html.push(rendered)
      continue
    }
    let nextLimit = Math.max(1, Math.floor((chunk.length * maxLen) / rendered.length) - 8)
    nextLimit = Math.min(nextLimit, chunk.length - 1)
    if (nextLimit <= 0) throw new ChannelGatewayError('a rendered Telegram HTML token exceeds the message limit')
    const parts = splitTelegramMarkdown(chunk, nextLimit)
    if (parts.length === 1 && parts[0] === chunk) {
      throw new ChannelGatewayError('unable to split Telegram Markdown within the HTML limit')
    }
    pending.unshift(...parts)
  }
  return html
}
