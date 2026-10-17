/**
 * The opaque handle for a remembered event: a canonical reference naming
 * `(sessionId, seq)`. It carries no authority. The prefix is the format version:
 * refs already written into a live conversation must keep decoding as they did.
 * @module @contexera/dsh-context-continuity/context-ref
 */

import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'

export const CONTEXT_REF_PREFIX = 'context-hit-'

export interface ContextRefTarget {
  readonly sessionId: SessionId
  readonly seq: SessionSeq
}

/**
 * One ref as prose may quote it: long enough to identify, never a payload dump.
 */
export function brief(ref: string): string {
  return ref.length > 120 ? `${ref.slice(0, 120)}…` : ref
}

/**
 * The canonical ref for one remembered event. The payload is a base64url JSON
 * tuple, which round-trips across restarts and stays opaque to the model.
 */
export function contextRefFor(sessionId: SessionId, seq: SessionSeq): string {
  const payload = JSON.stringify([sessionId, Number(seq)])
  return `${CONTEXT_REF_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`
}

/**
 * Decode one model-supplied ref, or `undefined` when it is not a ref this codec
 * issued. Base64url decoding is lenient, so the check is a re-encode: only the
 * exact canonical form survives, and a padded, reordered, or hand-edited
 * payload is rejected rather than silently reinterpreted.
 */
export function parseContextRef(ref: string): ContextRefTarget | undefined {
  if (!ref.startsWith(CONTEXT_REF_PREFIX)) return undefined
  const payload = ref.slice(CONTEXT_REF_PREFIX.length)
  if (payload === '') return undefined
  const decoded = Buffer.from(payload, 'base64url').toString('utf8')
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== payload) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
  const tuple: readonly unknown[] = parsed
  const sessionId = tuple[0]
  const seq = tuple[1]
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined
  return { sessionId: sessionId as SessionId, seq: SessionSeq(seq) }
}
