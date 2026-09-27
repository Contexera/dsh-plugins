/**
 * The context-continuity coordinator: the one deep module that turns a
 * subject's successful `context_rollover` tool result into its next context
 * generation, and schedules the quiet follow-up owed to a resolved checkpoint.
 *
 * Authority split:
 * - the host's durable store owns the subject→Session binding and rollover audit;
 * - the Session log projection owns intent, checkpoints, and delivery state;
 * - this coordinator owns only process locks and is always reconstructible.
 *
 * The coordinator reacts exclusively after the successful `tool/result` is
 * durably appended — never inside a tool body — so a render/finalize failure
 * can never outrun result durability. The actual swap waits for the containing
 * turn to end and the Agent to be idle, captures later input so no
 * old-generation model request opens, and then defers to the host lifecycle
 * through {@link ContextContinuityHost.executeTransition}.
 * @module @wowyuarm/dsh-context-continuity/coordinator
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextContinuityHost } from './host.ts'
import { isDroppedNotice } from './host.ts'
import type { ContextMessageCodec } from './message-codec.ts'
import { continuationDelivered, type ContextCheckpointEntry, type ContextProjectionState, type PendingRolloverIntent } from './projection-state.ts'
import type { TransitionPlan } from './types.ts'

/** Result seq and handoff envelope carried from the projection's pending intent. */
interface SubjectIntent {
  readonly toolCallId: string
  readonly resultSeq: number
  readonly turn: number
  readonly handoff: string
  readonly checkpointRef?: string | undefined
  readonly relatedFiles: readonly { readonly path: string; readonly reason: string }[]
}

/** One subject's in-process rollover bookkeeping; locks/promises only, never facts. */
interface SubjectTransition {
  readonly agent: Agent
  readonly intent: SubjectIntent
  turnEnded: boolean
  swapping?: Promise<void>
}

/**
 * Rebuild one subject's in-process intent from the projection's pending
 * rollover. Three call sites consume it — the live result, crash recovery with
 * the turn still open, and crash recovery past the turn end — and they must
 * agree field for field; this is the single definition of that list.
 */
function intentFromPending(pending: PendingRolloverIntent): SubjectIntent {
  return {
    toolCallId: pending.toolCallId,
    resultSeq: pending.resultSeq,
    turn: pending.turn,
    handoff: pending.handoff,
    ...(pending.checkpointRef === undefined ? {} : { checkpointRef: pending.checkpointRef }),
    relatedFiles: pending.relatedFiles,
  }
}

export class ContextContinuityCoordinator<SubjectId> {
  private readonly subjects = new Map<SubjectId, SubjectTransition>()
  private readonly capturedInput = new Map<SubjectId, readonly UserMessage[]>()
  /** Per-subject latch for the in-process scheduling→delivery window. */
  private readonly scheduledContinuations = new Set<string>()
  private disposed = false

  constructor(
    private readonly host: ContextContinuityHost<SubjectId>,
    private readonly codec: ContextMessageCodec,
  ) {}

  /** Whether one subject has a pending or in-flight rollover; tools use this to reject. */
  isTransitioning(id: SubjectId): boolean {
    return this.subjects.has(id)
  }

  /**
   * Root `session/event` observer for subject Sessions. The store's dispatch
   * carrier is untagged, so the host maps session ids to subjects and calls
   * this for every subject event. All reactions are gated on the projection
   * state, which itself only records successful durable pairs.
   */
  onSessionEvent(id: SubjectId, agent: Agent, event: SessionEvent): void {
    if (this.disposed) return
    if (event.type === 'tool/result') {
      this.onToolResult(id, agent, event)
      return
    }
    if (event.type === 'turn/end') {
      this.onTurnEnd(id, agent)
    }
  }

  /** Build the first handoff message of one generation; the host lifecycle delivers it. */
  handoffMessageFor(plan: TransitionPlan): UserMessage {
    return this.codec.createHandoffMessage({
      handoff: plan.handoff,
      previousSessionId: plan.previousSessionId,
      newSessionId: plan.newSessionId,
      trigger: plan.trigger,
      handoffEventSeq: plan.handoffEventSeq,
      ...(plan.checkpointRef === undefined ? {} : { checkpointRef: plan.checkpointRef }),
      ...(plan.relatedFiles.length === 0 ? {} : { relatedFiles: plan.relatedFiles }),
    })
  }

  /**
   * Whether one Agent's pending transition requires the admission gate: a
   * pending rollover must stop old-generation turns from admitting queued
   * input. The gate arms only for the old-generation Agent instance — the new
   * generation activates mid-swap and must be free to consume the handoff and
   * carried input immediately.
   */
  needsAdmissionGate(agent: Agent): boolean {
    const id = this.host.subjectForAgent(agent)?.id
    if (id === undefined) return false
    return this.subjects.get(id)?.agent === agent
  }

  /**
   * Capture the inbox messages queued for an old generation at its turn-stop
   * boundary: real input is preserved verbatim for delivery after the handoff;
   * ephemeral domain notices are dropped because the new generation rederives
   * them. Removing them from the inbox lets the turn close cleanly instead of
   * admitting another old-generation step.
   */
  captureQueuedInput(agent: Agent): readonly UserMessage[] {
    const id = this.host.subjectForAgent(agent)?.id
    if (id === undefined) return []
    if (this.subjects.get(id)?.agent !== agent) return []
    const removed = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    for (const message of removed) agent.inbox.remove(message.id)
    return this.captureInput(agent, removed)
  }

  /**
   * Capture messages a racing pre-step already claimed from the inbox before
   * rejecting that old-generation step. A rejected step's claimed message is
   * otherwise neither discarded nor re-emitted, so the gate preserves it here.
   */
  captureClaimedInput(agent: Agent, messages: readonly UserMessage[]): readonly UserMessage[] {
    return this.captureInput(agent, messages)
  }

  private captureInput(agent: Agent, messages: readonly UserMessage[]): readonly UserMessage[] {
    const id = this.host.subjectForAgent(agent)?.id
    if (id === undefined) return []
    if (this.subjects.get(id)?.agent !== agent) return []
    const preserved: UserMessage[] = []
    for (const message of messages) {
      if (isDroppedNotice(this.codec, this.host, message)) continue
      preserved.push(message)
    }
    if (preserved.length > 0) this.capturedInput.set(id, [...(this.capturedInput.get(id) ?? []), ...preserved])
    return preserved
  }

  /** Drain the captured input of one subject for delivery after the handoff. */
  drainCapturedInput(id: SubjectId): readonly UserMessage[] {
    const captured = this.capturedInput.get(id) ?? []
    this.capturedInput.delete(id)
    return captured
  }

  /** Drop one subject's bookkeeping; the host calls this on dispose/removal. */
  stopTracking(id: SubjectId): void {
    this.subjects.delete(id)
    this.capturedInput.delete(id)
  }

  dispose(): void {
    this.disposed = true
    this.subjects.clear()
    this.capturedInput.clear()
  }

  private onToolResult(id: SubjectId, agent: Agent, event: SessionEvent & { type: 'tool/result' }): void {
    if (event.data.error !== undefined) return
    const subject = this.host.subjectForAgent(agent)
    if (subject === undefined) return
    const state = this.host.projectionForSubject(id, subject.sessionId)
    if (state?.pending === null || state === undefined) return
    const pending = state.pending
    // React only to the intent's own result landing durably, and only once.
    if (pending.resultSeq !== event.seq) return
    if (this.subjects.has(id)) return
    this.subjects.set(id, { agent, intent: intentFromPending(pending), turnEnded: false })
  }

  private onTurnEnd(id: SubjectId, agent: Agent): void {
    // Checkpoint continuations first: a turn that resolved checkpoints owes
    // each of them exactly one quiet next-turn follow-up. The projection's
    // continuations state deduplicates across restarts; this in-memory latch
    // closes the same-process window between scheduling and the delivery event
    // landing in the log.
    this.scheduleCheckpointContinuations(id, agent)
    const transition = this.subjects.get(id)
    if (transition === undefined || transition.turnEnded) return
    const subject = this.host.subjectForAgent(agent)
    if (subject === undefined || transition.agent !== agent) return
    transition.turnEnded = true
    // Wait for true idle (the turn-end event fires before the driver fully
    // converges), then perform the swap off the session-event dispatch path.
    void agent.whenIdle().then(() => {
      if (this.disposed) return
      const current = this.subjects.get(id)
      if (current === undefined || current !== transition) return
      if (this.host.agentForSubject(id) !== agent) return
      void this.performTransition(id, subject.sessionId, transition)
    }, error => {
      this.host.log(`context rollover idle wait failed: ${error instanceof Error ? error.message : String(error)} (subject ${String(id)})`)
      this.subjects.delete(id)
    })
  }

  /**
   * Claim the in-process latch for one resolved checkpoint continuation.
   * Returns the latch key when this caller won it, or undefined when the
   * checkpoint never concluded a turn, was already delivered durably, or is
   * latched already. The caller releases the latch on its own failure path.
   */
  private claimContinuationLatch(id: SubjectId, state: ContextProjectionState, checkpoint: ContextCheckpointEntry): string | undefined {
    if (checkpoint.turnEndSeq === -1) return undefined
    if (continuationDelivered(state, checkpoint.checkpointRef)) return undefined
    const latch = `${String(id)}:${checkpoint.checkpointRef}`
    if (this.scheduledContinuations.has(latch)) return undefined
    this.scheduledContinuations.add(latch)
    return latch
  }

  /**
   * Quiet follow-ups for checkpoints resolved by the turn that just ended. A
   * successful `context_checkpoint` result concludes its turn; work continues
   * in the next turn with one host-generated notice. The projection folds
   * delivery, so a restart repairs a missing follow-up through
   * repairContinuations without duplicating a delivered one; this live path
   * latches per checkpoint in memory for the scheduling window.
   */
  private scheduleCheckpointContinuations(id: SubjectId, agent: Agent): void {
    const subject = this.host.subjectForAgent(agent)
    if (subject === undefined) return
    const state = this.host.projectionForSubject(id, subject.sessionId)
    if (state === undefined) return
    for (const checkpoint of state.checkpoints) {
      const latch = this.claimContinuationLatch(id, state, checkpoint)
      if (latch === undefined) continue
      // The continuation waits for true idle, then queues its own turn: the
      // same discipline the rollover path uses (a next-turn message queued
      // while the driver is still converging never latches a wake).
      void agent.whenIdle().then(() => {
        if (this.disposed) return
        try {
          agent.followup(this.codec.createCheckpointContinuationMessage(checkpoint.checkpointRef))
        } catch (error) {
          this.scheduledContinuations.delete(latch)
          this.host.log(`context continuation scheduling failed: ${error instanceof Error ? error.message : String(error)} (subject ${String(id)})`)
        }
      }, () => {
        this.scheduledContinuations.delete(latch)
      })
    }
  }

  private async performTransition(id: SubjectId, previousSessionId: SessionId, transition: SubjectTransition): Promise<void> {
    const identity = this.host.rolloverIdentity(previousSessionId, transition.intent.toolCallId)
    const plan: TransitionPlan = {
      previousSessionId,
      newSessionId: identity.newSessionId,
      handoff: transition.intent.handoff,
      handoffEventSeq: transition.intent.resultSeq,
      trigger: 'model',
      relatedFiles: transition.intent.relatedFiles,
      ...(transition.intent.checkpointRef === undefined ? {} : { checkpointRef: transition.intent.checkpointRef }),
      requestId: identity.requestId,
      carriedInput: this.drainCapturedInput(id),
    }
    const swap = this.host.executeTransition(id, plan)
    transition.swapping = swap
    try {
      await swap
      this.subjects.delete(id)
    } catch (error) {
      this.host.log(`context rollover failed, leaving the previous generation recoverable: ${error instanceof Error ? error.message : String(error)} (subject ${String(id)})`)
      this.subjects.delete(id)
    }
  }

  /**
   * Crash-recovery hook the host runs during subject activation: re-derive
   * pending intent from the projection and finish a transition that a restart
   * interrupted after the successful result was durable.
   */
  recoverPendingTransition(id: SubjectId, agent: Agent, sessionId: SessionId): void {
    if (this.disposed || this.subjects.has(id)) return
    const state = this.host.projectionForSubject(id, sessionId)
    if (state?.pending === null || state === undefined) return
    const pending = state.pending
    if (pending.turnEndSeq === -1) {
      // The containing turn never ended durably; treat the intent as still
      // waiting and observe the live events from here.
      this.subjects.set(id, { agent, intent: intentFromPending(pending), turnEnded: false })
      return
    }
    // The turn already ended before the crash; the Agent is idle at
    // activation, so the swap can proceed directly.
    const transition: SubjectTransition = { agent, intent: intentFromPending(pending), turnEnded: true }
    this.subjects.set(id, transition)
    void this.performTransition(id, sessionId, transition)
  }

  /**
   * Crash-recovery for quiet continuations: schedule the follow-up for one
   * resolved checkpoint exactly once when the result was durable but the
   * delivery never landed. The projection's continuations state is the durable
   * delivery record — a checkpoint whose delivery event exists in the log is
   * never re-scheduled.
   */
  repairContinuations(agent: Agent, state: ContextProjectionState): void {
    if (this.disposed) return
    const id = this.host.subjectForAgent(agent)?.id
    if (id === undefined) return
    for (const checkpoint of state.checkpoints) {
      const latch = this.claimContinuationLatch(id, state, checkpoint)
      if (latch === undefined) continue
      try {
        agent.followup(this.codec.createCheckpointContinuationMessage(checkpoint.checkpointRef))
      } catch (error) {
        this.scheduledContinuations.delete(latch)
        this.host.log(`context continuation repair failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
