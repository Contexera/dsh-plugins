import { ChannelGatewayError } from '../errors.ts'

export function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

export function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

export function avoidSurrogateSplit(text: string, pos: number): number {
  if (pos > 0 && pos < text.length && isHighSurrogate(text.charCodeAt(pos - 1)) && isLowSurrogate(text.charCodeAt(pos))) {
    return pos - 1
  }
  return pos
}

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

export function splitText(text: string, limit: number): string[] {
  if (limit < 1) throw new ChannelGatewayError(`split limit must be at least 1; got ${String(limit)}`)
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
