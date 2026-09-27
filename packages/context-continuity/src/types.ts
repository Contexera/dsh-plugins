/**
 * Generic context-continuity vocabulary, parameterized over a host's own
 * subject identity.
 *
 * A "subject" is any durable identity that outlives a single model Session:
 * the Agent Team calls it a Member, a single-Individual harness calls it an
 * Individual, a solo long-running coding agent is its own single subject. The
 * engine never names the subject; it only needs a stable id and the Session
 * the subject is currently bound to.
 * @module @wowyuarm/dsh-context-continuity/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/**
 * The minimum a host must expose about one subject: a stable id and the
 * Session generation it is bound to right now. The engine reads nothing else
 * off a subject; richer host records (roles, workspaces, memory paths) stay
 * on the host side.
 */
export interface ContextSubject<SubjectId> {
  readonly id: SubjectId
  /** The Session generation this subject is bound to at read time. */
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
 * Everything a host lifecycle needs to perform one generation swap. The
 * engine assembles this from the durable rollover intent; the host executes
 * it (dispose old Agent, create/activate the successor, deliver the handoff).
 *
 * `requestId` and `newSessionId` are host-derived idempotency identity: the
 * engine asks the host to derive them from the previous Session and the
 * successful tool call (see {@link RolloverIdentity}), so crash replay
 * converges on one operation without the engine owning any naming scheme.
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
 * The stable, collision-resistant identity of one rollover, derived by the
 * host from the previous Session and the successful tool call id. The engine
 * derives nothing itself: a Session id naming scheme and a request id scheme
 * are durable, host-owned concerns.
 */
export interface RolloverIdentity {
  readonly newSessionId: SessionId
  readonly requestId: string
}
