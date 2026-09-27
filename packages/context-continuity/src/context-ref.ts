/**
 * The one opaque handle for a remembered event: a canonical reference the model
 * copies from a search hit into a read.
 *
 * A context ref names `(sessionId, seq)` — the *canonical source* of an event,
 * never the generation it happened to be inherited into — and nothing else. It
 * carries no authority: a ref is data the model repeats, so every read
 * revalidates the named Session against the host's authorization on each call.
 * The prefix is the format version; a future codec gets a new one, because refs
 * already written into a live conversation must keep decoding the way they did.
 * @module @wowyuarm/dsh-context-continuity/context-ref
 */

import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'

/** The prefix every context ref carries. */
export const CONTEXT_REF_PREFIX = 'context-hit-'

/** One decoded context ref: the Session that owns the event, and its seq. */
export interface ContextRefTarget {
  readonly sessionId: SessionId
  readonly seq: SessionSeq
}

/**
 * One ref as prose may quote it: long enough to identify, never a payload dump.
 * Used wherever a message repeats a ref that is not a selection surface — a
 * rejection, or a timeline anchor the subject cannot return to.
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
