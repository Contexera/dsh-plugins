/**
 * Preparing an agent's Markdown for the WeChat iLink client.
 *
 * The iLink client renders a reduced Markdown and mishandles some constructs:
 * a bare angle bracket in normal text is read as markup and can hide everything
 * after it, image links render as nothing useful, and `~~` and deep headers are
 * not supported. This module removes or neutralizes those constructs and splits
 * the result so no chunk exceeds the per-message limit or leaves a fenced code
 * block open. Like the Telegram renderer it is transport fidelity, asked for per
 * message through {@link OutboundMessage.format}; the rules follow nanobot (MIT).
 * @module @wowyuarm/dsh-channel-gateway/adapters/weixin-markdown
 */

/**
 * Remove or neutralize Markdown the iLink client renders badly, keeping fenced
 * and inline code byte-for-byte: outside code, drop image links, replace angle
 * brackets with full-width forms, drop `~~`, and drop `#####`/`######` headers.
 */
export function sanitizeWeixinMarkdown(content: string): string {
  if (content === '') return content
  // Odd indices are code regions the split preserved; even indices are text.
  const parts = content.split(/(```[\s\S]*?```|`[^`\n]*`)/)
  for (let index = 0; index < parts.length; index += 2) {
    parts[index] = (parts[index] ?? '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/</g, '＜')
      .replace(/>/g, '＞')
      .replace(/~~/g, '')
      .replace(/^#{5,6}\s+/gm, '')
  }
  return parts.join('')
}

/**
 * Split sanitized text so no chunk exceeds `maxLen` and each chunk balances its
 * fenced code blocks: a chunk that ends mid-fence is closed with ```, and the
 * next chunk reopens the fence. Ported from nanobot.
 */
export function splitWeixinMarkdown(content: string, maxLen: number): string[] {
  const sanitized = sanitizeWeixinMarkdown(content).trim()
  if (sanitized === '') return []
  if (maxLen <= 0 || sanitized.length <= maxLen) return [sanitized]

  const chunks: string[] = []
  let remaining = sanitized
  let inFence = false
  while (remaining !== '') {
    const prefix = inFence ? '```\n' : ''
    const suffixBudget = 4 // room for a trailing "\n```" when a slice leaves a fence open
    const available = maxLen - prefix.length - suffixBudget
    if (available <= 0) return [sanitized]

    let rawPiece: string
    if (remaining.length <= available) {
      rawPiece = remaining
    } else {
      const candidate = remaining.slice(0, available)
      let cut = candidate.lastIndexOf('\n\n')
      if (cut <= 0) cut = candidate.lastIndexOf('\n')
      if (cut <= 0) {
        let punctuation = -1
        for (const mark of '。！？；.!?; ') punctuation = Math.max(punctuation, candidate.lastIndexOf(mark))
        cut = punctuation >= 0 ? punctuation + 1 : available
      }
      rawPiece = remaining.slice(0, cut)
    }
    remaining = remaining.slice(rawPiece.length).replace(/^\s+/, '')

    const toggles = (rawPiece.match(/```/g) ?? []).length
    const nextInFence: boolean = inFence !== (toggles % 2 === 1)
    let rendered = prefix + rawPiece.replace(/\s+$/, '')
    if (nextInFence) rendered += '\n```'
    chunks.push(rendered)
    inFence = nextInFence
  }
  return chunks
}
