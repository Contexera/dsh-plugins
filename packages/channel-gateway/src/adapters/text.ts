/**
 * Text splitting primitives every adapter shares: breaking a message into
 * provider-sized chunks without cutting a word, or a Unicode character, in two.
 * @module @wowyuarm/dsh-channel-gateway/adapters/text
 */

/** Whether one UTF-16 unit is the first half of a surrogate pair. */
export function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

/** Whether one UTF-16 unit is the second half of a surrogate pair. */
export function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

/**
 * Pull a break position back by one when it would land between the two halves
 * of a surrogate pair — cutting there would send half a character.
 */
export function avoidSurrogateSplit(text: string, pos: number): number {
  if (pos > 0 && pos < text.length && isHighSurrogate(text.charCodeAt(pos - 1)) && isLowSurrogate(text.charCodeAt(pos))) {
    return pos - 1
  }
  return pos
}

/**
 * How much of `text` the first chunk takes: the last line break in range, else
 * the last space, else the limit itself. The result is always positive and never
 * exceeds `limit`, so `splitText` advances, and it never lands between the two
 * halves of a surrogate pair.
 */
function breakAt(text: string, limit: number): number {
  let end = limit
  if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1
  if (end <= 0) return limit
  const window = text.slice(0, end)
  const newline = window.lastIndexOf('\n')
  if (newline > 0) return newline + 1
  const space = window.lastIndexOf(' ')
  if (space > 0) return space + 1
  return end
}

/** Split text no chunk of which exceeds `limit`; `''` yields no chunk at all. */
export function splitText(text: string, limit: number): string[] {
  if (text === '') return []
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const cut = breakAt(rest, limit)
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  chunks.push(rest)
  return chunks
}
