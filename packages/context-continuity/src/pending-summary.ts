/**
 * A summary the subject wrote itself, waiting to stand in for a span.
 *
 * The engine hook that decides who writes a summary receives only the replayed
 * input and the agent, so a subject-authored summary has to reach it out of
 * band. This module is that channel, and it lives here rather than in a shared
 * contract because both ends are this package: `context_compact` writes it and
 * {@link module:@contexera/dsh-context-continuity/compaction-engine
 * ContinuityCompactionEngine} reads it.
 *
 * It is keyed by the Session rather than by session id so an abandoned entry
 * cannot outlive its session, and it is cleared by the call that set it rather
 * than by the read: the engine may summarize more than once for one attempt, and
 * a failed attempt must not leave a stale summary behind for the next automatic
 * compaction to pick up. Keying on the object is reliable because `agent.session`
 * is one stable readonly instance for an agent's whole life, so the writing tool
 * and the reading engine always see the same key.
 * @module @contexera/dsh-context-continuity/pending-summary
 */

import type { Session } from '@deepseek-ai/dsh-session'

const pending = new WeakMap<Session, string>()

/**
 * Offer one subject-authored summary for the next compaction of this session.
 *
 * @param session - the session whose next compaction should use the summary.
 * @param summary - the checkpoint text, as the subject wrote it.
 */
export function offerPendingSummary(session: Session, summary: string): void {
  pending.set(session, summary)
}

/**
 * The subject-authored summary waiting for this session, if any.
 *
 * Reading does not consume it: one attempt may summarize more than once, and the
 * caller that offered it is the one that knows when the attempt is over.
 *
 * @param session - the session being compacted.
 * @returns the summary, or `undefined` when the engine should write its own.
 */
export function pendingSummaryFor(session: Session): string | undefined {
  return pending.get(session)
}

/**
 * Drop any summary waiting for this session. Called by the offering call once
 * its compaction attempt has finished, whether it succeeded or not.
 *
 * @param session - the session to clear.
 */
export function clearPendingSummary(session: Session): void {
  pending.delete(session)
}
