/**
 * Generic context-continuity vocabulary, parameterized over a host's own
 * subject identity: any durable identity that outlives a single model Session.
 * @module @contexera/dsh-context-continuity/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/**
 * The minimum a host must expose about one subject: a stable id and the
 * Session generation it is bound to right now.
 */
export interface ContextSubject<SubjectId> {
  readonly id: SubjectId
  readonly sessionId: SessionId
}

/** Why a rollover happened: the model asked, or a pressure notice was honored. */
export type RolloverTrigger = 'model' | 'pressure'

/** One workspace path a handoff called out as relevant to the next generation. */
export interface RelatedFile {
  readonly path: string
  readonly reason: string
}

/**
 * Everything a host lifecycle needs to perform one generation swap, assembled
 * by the engine from the durable rollover intent.
 */
export interface TransitionPlan {
  readonly previousSessionId: SessionId
  readonly newSessionId: SessionId
  readonly handoff: string
  readonly handoffEventSeq: number
  readonly trigger: RolloverTrigger
  readonly relatedFiles: readonly RelatedFile[]
  readonly checkpointRef?: string | undefined
  /** Host-owned idempotency id for the swap operation. */
  readonly requestId: string
  /** Input that arrived during the transition, delivered after the handoff. */
  readonly carriedInput: readonly UserMessage[]
}

/**
 * The stable, collision-resistant identity of one rollover, derived by the host
 * from the previous Session and the successful tool call id. The engine derives
 * nothing itself.
 */
export interface RolloverIdentity {
  readonly newSessionId: SessionId
  readonly requestId: string
}
