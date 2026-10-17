/**
 * The host hook contract for context continuity: the engine owns the universal
 * mechanics, the host supplies subject resolution, projection folding, its own
 * lifecycle swap, and the domain-specific dimensions.
 * @module @contexera/dsh-context-continuity/host
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextSubject, RolloverIdentity, TransitionPlan } from './types.ts'
import type { ContextProjectionState } from './projection-state.ts'
import type { ContextMessageCodec } from './message-codec.ts'

export interface SubjectResolver<SubjectId> {
  /** The live Agent of one subject, or undefined when it is not currently activated. */
  agentForSubject(id: SubjectId): Agent | undefined
  /** The durable subject of one live Agent, or undefined when the Agent is not a subject. */
  subjectForAgent(agent: Agent): ContextSubject<SubjectId> | undefined
}

/** Everything the context-continuity engine needs from its host. */
export interface ContextContinuityHost<SubjectId> extends SubjectResolver<SubjectId> {
  /** Fold one subject Session's projection from its durable events. */
  projectionForSubject(id: SubjectId, sessionId: SessionId): ContextProjectionState | undefined

  /**
   * Perform one prepared generation swap at a true idle boundary, in the host's
   * own lifecycle. Resolves once the subject runs its new generation; rejects
   * to leave the previous generation recoverable.
   */
  executeTransition(id: SubjectId, plan: TransitionPlan): Promise<void>

  /**
   * Derive the durable, collision-resistant identity of one rollover from the
   * previous Session and the successful tool call. Naming schemes are
   * host-owned so crash replay converges on one operation.
   */
  rolloverIdentity(previousSessionId: SessionId, toolCallId: string): RolloverIdentity

  /**
   * Whether one queued message is an ephemeral domain notice the successor
   * generation will rederive (and so must be dropped rather than carried), as
   * opposed to real external input that must survive the swap.
   */
  isEphemeralNotice(message: UserMessage): boolean

  /** Log one engine diagnostic. */
  log(message: string): void
}

/**
 * Whether one queued message is an ephemeral domain notice the successor
 * generation rederives, and so must be dropped rather than carried. The
 * engine's own handoff and continuation envelopes carry the host's plugin
 * attribution but are ordinary delivered context the successor keeps, so they
 * are excluded before the host's domain judgement is consulted.
 */
export function isDroppedNotice(
  codec: Pick<ContextMessageCodec, 'isContextSource'>,
  host: Pick<ContextContinuityHost<never>, 'isEphemeralNotice'>,
  message: UserMessage,
): boolean {
  if (codec.isContextSource(message)) return false
  return host.isEphemeralNotice(message)
}
