/**
 * The read-only state one Session's context-continuity projection folds from
 * its durable event log. Every field is derived from the log alone, so a cold
 * fold and the live incremental fold converge on the same value.
 * @module @contexera/dsh-context-continuity/projection-state
 */

/** One checkpoint recorded by a successful `context_checkpoint` call. */
export interface ContextCheckpointEntry {
  readonly checkpointRef: string
  readonly name: string
  readonly resultSeq: number
  readonly turn: number
  /** Seq of the `turn/end` that resolved the checkpoint; -1 until resolved. */
  readonly turnEndSeq: number
}

/** Rollover intent awaiting its containing turn to finish and the Agent to idle. */
export interface PendingRolloverIntent {
  readonly handoff: string
  readonly checkpointRef?: string | undefined
  readonly relatedFiles: readonly { readonly path: string; readonly reason: string }[]
  readonly toolCallId: string
  readonly resultSeq: number
  readonly turn: number
  /** Seq of the `turn/end` that released the intent for the swap; -1 until observed. */
  readonly turnEndSeq: number
}

/** Quiet-continuation delivery state for one checkpoint, keyed by checkpointRef. */
export interface ContinuationDeliveryState {
  readonly checkpointRef: string
  /** Seq of the delivered continuation notice in this Session; -1 until delivered. */
  readonly deliveredSeq: number
}

/** One non-checkpoint message queued after the pending intent; a carry candidate. */
export interface CarriedCandidate {
  readonly messageId: string
  /** The turn that surfaced the message onto the model-visible input, if any. */
  readonly surfacedTurn: number
  /** Whether a completed assistant answer proved the old generation handled it. */
  readonly consumed: boolean
}

/**
 * One host-contributed timeline anchor beyond explicit checkpoints: a domain
 * fact that entered model context and is worth returning to.
 */
export interface DomainBoundary {
  /** Host-defined anchor kind, e.g. `team_message`, `loom_delivery`. */
  readonly kind: string
  readonly label: string
  readonly resultSeq: number
  readonly turn: number
  /** Seq of the resolving `turn/end`; -1 until resolved at a completed turn. */
  readonly turnEndSeq: number
  /**
   * Opaque domain topic ids this boundary is attributable to. A boundary is a
   * selectable default anchor exactly when the topics carried by the prefix a
   * return would keep are exactly one.
   */
  readonly attributions: readonly string[]
}

/** The read-only projection of one Session's context-continuity state. */
export interface ContextProjectionState {
  /** The Session this state folds; it keys every durable ref the fold derives. */
  readonly sessionId: string
  /**
   * The length of the fork-inherited prefix: events whose `seq` is below this
   * cut belong to the ancestor generation this Session continues and are
   * skipped unchanged.
   */
  readonly inheritedEventCount: number
  readonly checkpoints: readonly ContextCheckpointEntry[]
  /** Rollover intent awaiting its containing turn end, at most one. */
  readonly pending: PendingRolloverIntent | null
  /** Quiet continuations recorded (with or without delivery), keyed by checkpoint ref. */
  readonly continuations: readonly ContinuationDeliveryState[]
  readonly carriedCandidates: readonly CarriedCandidate[]
  /** The most recently opened turn; user/message events carry no turn of their own. */
  readonly lastTurn: number
  readonly openCalls: readonly { readonly callId: string; readonly name: string; readonly arguments: string }[]
  readonly boundaries: readonly DomainBoundary[]
  /** Domain topics whose first anchor already landed; later re-arrivals produce no boundary. */
  readonly seenTopics: readonly string[]
  /** Seq of the latest resolved `turn/end`; the head boundary of the timeline. */
  readonly lastTurnEndSeq: number
}

/** Whether one checkpoint's quiet continuation has already been delivered durably. */
export function continuationDelivered(state: ContextProjectionState, checkpointRef: string): boolean {
  return state.continuations.some(entry => entry.checkpointRef === checkpointRef && entry.deliveredSeq !== -1)
}
