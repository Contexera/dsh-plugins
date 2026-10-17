/**
 * A summary the subject wrote itself, waiting to stand in for a span: the
 * out-of-band channel from `context_compact` to the compaction engine. Entries
 * are keyed by the Session object, so an abandoned entry cannot outlive it.
 * @module @contexera/dsh-context-continuity/pending-summary
 */

import type { Session } from '@deepseek-ai/dsh-session'

const pending = new WeakMap<Session, string>()

/** Offer one subject-authored summary for the next compaction of this session. */
export function offerPendingSummary(session: Session, summary: string): void {
  pending.set(session, summary)
}

/**
 * The subject-authored summary waiting for this session, if any. Reading does
 * not consume it: one attempt may summarize more than once.
 */
export function pendingSummaryFor(session: Session): string | undefined {
  return pending.get(session)
}

/** Drop any summary waiting for this session, once its compaction attempt has finished. */
export function clearPendingSummary(session: Session): void {
  pending.delete(session)
}
