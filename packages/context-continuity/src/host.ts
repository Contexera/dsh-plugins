/**
 * The host hook contract for context continuity.
 *
 * The engine owns the universal mechanics — the idle-boundary generation swap,
 * the admission gate, carried input, checkpoint continuations, the timeline
 * lineage walk, and the shared return-anchor policy. It knows nothing about
 * what a subject is or what the subject's domain treats as meaningful. A host
 * supplies that through this contract: how to resolve a subject to its live
 * Agent and back, how to fold one Session's projection, how to actually perform
 * a swap in its own lifecycle, and the two domain-specific dimensions —
 * which queued messages are ephemeral domain notices, and how to derive a
 * durable idempotency identity for a rollover.
 *
 * The Agent Team implements this over its Member ledger; a single-Individual
 * harness implements it over one Individual and its continuity store. Neither
 * shape leaks into the engine.
 * @module @wowyuarm/dsh-context-continuity/host
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextSubject, RolloverIdentity, TransitionPlan } from './types.ts'
import type { ContextProjectionState } from './projection-state.ts'
import type { ContextMessageCodec } from './message-codec.ts'

/** Resolve subjects and their live Agents in both directions. */
export interface SubjectResolver<SubjectId> {
  /** The live Agent of one subject, or undefined when it is not currently activated. */
  agentForSubject(id: SubjectId): Agent | undefined
  /** The durable subject of one live Agent, or undefined when the Agent is not a subject. */
  subjectForAgent(agent: Agent): ContextSubject<SubjectId> | undefined
}

/**
 * Everything the context-continuity engine needs from its host. The engine
 * calls these; it never reaches into host state directly.
 */
export interface ContextContinuityHost<SubjectId> extends SubjectResolver<SubjectId> {
  /**
   * Fold one subject Session's projection from its durable events. The engine
   * reads this on every successful context-tool result and every turn end, so
   * a host is expected to fold incrementally and cache per subject.
   */
  projectionForSubject(id: SubjectId, sessionId: SessionId): ContextProjectionState | undefined

  /**
   * Perform one prepared generation swap at a true idle boundary, in the
   * host's own lifecycle: commit the rollover, dispose the old Agent, archive
   * the old Session, create and activate the successor, deliver the handoff
   * first, then the carried input. Resolves once the subject runs its new
   * generation; rejects to leave the previous generation recoverable.
   */
  executeTransition(id: SubjectId, plan: TransitionPlan): Promise<void>

  /**
   * Derive the durable, collision-resistant identity of one rollover from the
   * previous Session and the successful tool call. A Session id naming scheme
   * and a request id scheme are host-owned so crash replay converges on one
   * operation without the engine owning any naming.
   */
  rolloverIdentity(previousSessionId: SessionId, toolCallId: string): RolloverIdentity

  /**
   * Whether one queued message is an ephemeral domain notice the successor
   * generation will rederive (and so must be dropped rather than carried), as
   * opposed to real external input that must survive the swap. The engine
   * carries everything this returns false for.
   */
  isEphemeralNotice(message: UserMessage): boolean

  /** Log one engine diagnostic. */
  log(message: string): void
}

/**
 * Whether one queued message is an ephemeral domain notice the successor
 * generation rederives, and so must be dropped rather than carried.
 *
 * The engine's own handoff and continuation envelopes carry the host's plugin
 * attribution but are ordinary delivered context the successor keeps, so they
 * are excluded before the host's domain judgement is consulted. Both the
 * transition coordinator and the projection apply this one rule.
 */
export function isDroppedNotice(
  codec: Pick<ContextMessageCodec, 'isContextSource'>,
  host: Pick<ContextContinuityHost<never>, 'isEphemeralNotice'>,
  message: UserMessage,
): boolean {
  if (codec.isContextSource(message)) return false
  return host.isEphemeralNotice(message)
}
