/**
 * The read-only state one Session's context-continuity projection folds from
 * its durable event log. Every field here is derived from the log alone, so a
 * cold fold over stored events and the live incremental fold converge on the
 * same value — there is no second store.
 *
 * The state also carries the Session identity it folds and the length of the
 * prefix that Session inherited from the generation it continues. Both belong
 * here rather than in a fold closure: the framework keys one projection unit
 * per key and drives it for every Session, so identity must travel in the
 * state, and a seeded Session's log repeats its ancestor's events — which are
 * the ancestor's facts, not this generation's.
 *
 * The universal fields (checkpoints, pending rollover, quiet continuations,
 * carried candidates, open calls, turn cursors) are owned by the engine. The
 * one host-specific dimension is {@link ContextProjectionState.boundaries}:
 * which domain events count as timeline anchors, and how they are labelled and
 * attributed, is decided by the host through {@link DomainAnchorRule}. The Agent
 * Team anchors on committed messages, claim changes, and first Thread arrivals;
 * a single-Individual harness anchors on committed Input/Effect/Delivery facts.
 * @module @wowyuarm/dsh-context-continuity/projection-state
 */

/** One checkpoint recorded by a successful `context_checkpoint` call. */
export interface ContextCheckpointEntry {
  /** Opaque stable ref; the selection authority for a seeded return. */
  readonly checkpointRef: string
  /** Model-supplied display label. */
  readonly name: string
  /** Seq of the successful tool result that recorded the checkpoint. */
  readonly resultSeq: number
  /** Turn the checkpoint concluded; the completed-turn boundary anchor. */
  readonly turn: number
  /** Seq of the `turn/end` that resolved the checkpoint; -1 until resolved. */
  readonly turnEndSeq: number
}

/** Rollover intent awaiting its containing turn to finish and the Agent to idle. */
export interface PendingRolloverIntent {
  readonly handoff: string
  readonly checkpointRef?: string | undefined
  readonly relatedFiles: readonly { readonly path: string; readonly reason: string }[]
  /** The provider-issued call id of the successful rollover call. */
  readonly toolCallId: string
  /** Seq of the successful rollover tool result. */
  readonly resultSeq: number
  /** Turn containing the successful call; the swap waits for its end. */
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
  /** The queued message id; the transition dedupes carried input by it. */
  readonly messageId: string
  /** The turn that surfaced the message onto the model-visible input, if any. */
  readonly surfacedTurn: number
  /** Whether a completed assistant answer proved the old generation handled it. */
  readonly consumed: boolean
}

/**
 * One host-contributed timeline anchor beyond explicit checkpoints: a domain
 * fact that entered model context and is worth returning to. The engine
 * resolves each to its containing completed turn and applies one shared
 * restorable-anchor policy; the host decides what the fact is and how it reads.
 */
export interface DomainBoundary {
  /** Host-defined anchor kind, e.g. `team_message`, `loom_delivery`. */
  readonly kind: string
  /** Model-facing display label. */
  readonly label: string
  /** Seq of the event that anchored this boundary. */
  readonly resultSeq: number
  /** Turn the boundary belongs to. */
  readonly turn: number
  /** Seq of the resolving `turn/end`; -1 until resolved at a completed turn. */
  readonly turnEndSeq: number
  /**
   * Opaque domain topic ids this boundary is attributable to. The shared
   * restorable-anchor policy treats a boundary as a selectable default anchor
   * exactly when it resolved at a completed turn and is attributable to exactly
   * one topic; the host defines what a topic is (Team: a Thread; a harness:
   * a continuity subject line).
   */
  readonly attributions: readonly string[]
}

/** The read-only projection of one Session's context-continuity state. */
export interface ContextProjectionState {
  /**
   * The Session this state folds. It keys every durable ref the fold derives
   * (`checkpointRefFor`, boundary naming), so one registered unit serves every
   * Session and two generations never collide on a repeated call id.
   */
  readonly sessionId: string
  /**
   * The length of the fork-inherited prefix: events whose `seq` is below this
   * cut belong to the ancestor generation this Session continues and are
   * skipped unchanged. Folding them here would re-key the ancestor's record
   * under this Session's identity and re-derive its rollover intent as this
   * generation's own pending swap.
   */
  readonly inheritedEventCount: number
  /** Checkpoints recorded by a successful call, resolved ones anchored to their turn end. */
  readonly checkpoints: readonly ContextCheckpointEntry[]
  /** Rollover intent awaiting its containing turn end, at most one. */
  readonly pending: PendingRolloverIntent | null
  /** Quiet continuations recorded (with or without delivery), keyed by checkpoint ref. */
  readonly continuations: readonly ContinuationDeliveryState[]
  /** Non-checkpoint messages queued into the inbox after the pending intent's tool result. */
  readonly carriedCandidates: readonly CarriedCandidate[]
  /** The most recently opened turn; user/message events carry no turn of their own. */
  readonly lastTurn: number
  /** Context-tool calls whose results have not landed yet, paired call-to-result across cuts. */
  readonly openCalls: readonly { readonly callId: string; readonly name: string; readonly arguments: string }[]
  /** Host-contributed timeline boundaries beyond explicit checkpoints. */
  readonly boundaries: readonly DomainBoundary[]
  /**
   * Domain topics whose first anchor already landed. The first arrival of a
   * topic is the one preserved push-face anchor; later re-arrivals produce no
   * boundary. Fold-internal so cold and live folds replay it identically.
   */
  readonly seenTopics: readonly string[]
  /** Seq of the latest resolved `turn/end`; the head boundary of the timeline. */
  readonly lastTurnEndSeq: number
}

/** Whether one checkpoint's quiet continuation has already been delivered durably. */
export function continuationDelivered(state: ContextProjectionState, checkpointRef: string): boolean {
  return state.continuations.some(entry => entry.checkpointRef === checkpointRef && entry.deliveredSeq !== -1)
}
