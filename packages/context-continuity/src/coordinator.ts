/**
 * The context-continuity coordinator: turns a successful `context_rollover` tool
 * result into the subject's next context generation. It owns only process locks
 * and reacts only after the successful `tool/result` is durably appended, never
 * inside a tool body.
 * @module @contexera/dsh-context-continuity/coordinator
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextContinuityHost } from './host.ts'
import { isDroppedNotice } from './host.ts'
import type { ContextMessageCodec } from './message-codec.ts'
import { continuationDelivered, type ContextCheckpointEntry, type ContextProjectionState, type PendingRolloverIntent } from './projection-state.ts'
import type { TransitionPlan } from './types.ts'

interface SubjectIntent {
  readonly toolCallId: string
  readonly resultSeq: number
  readonly turn: number
  readonly handoff: string
  readonly checkpointRef?: string | undefined
  readonly relatedFiles: readonly { readonly path: string; readonly reason: string }[]
}

interface SubjectTransition {
  readonly agent: Agent
  readonly intent: SubjectIntent
  turnEnded: boolean
}

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
  private readonly holds = new Map<SubjectId, Agent>()
  private readonly scheduledContinuations = new Map<SubjectId, Set<string>>()
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
   * carrier is untagged, so the host maps session ids to subjects and calls this
   * for every subject event.
   */
  onSessionEvent(id: SubjectId, agent: Agent, event: SessionEvent): void {
    if (this.disposed) return
    if (event.type === 'tool/result') {
      this.onToolResult(id, agent, event)
      return
    }
    if (event.type === 'user/message') {
      this.releaseDeliveredContinuations(id, event)
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
   * Whether one Agent's pending transition requires the admission gate. The gate
   * arms only for the old-generation Agent instance: the new generation
   * activates mid-swap and must be free to consume the handoff and carried input
   * immediately.
   */
  needsAdmissionGate(agent: Agent): boolean {
    const id = this.host.subjectForAgent(agent)?.id
    if (id === undefined) return false
    if (this.holds.get(id) === agent) return true
    return this.subjects.get(id)?.agent === agent
  }

  /** Whether one Agent's subject is holding input for a requested rollover. */
  isHoldingInput(agent: Agent): boolean {
    const id = this.host.subjectForAgent(agent)?.id
    if (id === undefined) return false
    return this.holds.get(id) === agent
  }

  /**
   * Arm one subject's hold and keep the messages its rejected step had already
   * claimed. Arming and capturing are one call: the capture is refused while no
   * hold is armed.
   */
  holdClaimedInput(agent: Agent, messages: readonly UserMessage[]): readonly UserMessage[] {
    const id = this.host.subjectForAgent(agent)?.id
    if (id === undefined) return []
    const held = this.holds.get(id)
    if (held !== undefined && held !== agent) return []
    this.holds.set(id, agent)
    return this.captureInput(agent, messages)
  }

  private returnHeldInput(id: SubjectId, agent: Agent): void {
    if (this.holds.get(id) !== agent) return
    this.holds.delete(id)
    this.handBackInput(id, agent, this.drainCapturedInput(id), 'the requested rollover did not happen; the held input is handed back unchanged')
  }

  private handBackInput(id: SubjectId, agent: Agent, input: readonly UserMessage[], why: string): void {
    if (input.length === 0) return
    const failed = (error: unknown): void => {
      this.host.log(`held input delivery failed: ${error instanceof Error ? error.message : String(error)} (subject ${String(id)})`)
    }
    const deliver = (target: Agent): void => {
      if (this.disposed) return
      const where = target === agent ? '' : '; handing it to the Agent that runs the subject now'
      this.host.log(`${why}${where} (${input.length} message(s), subject ${String(id)})`)
      for (const message of input) {
        try {
          target.followup(message)
        } catch (error) {
          failed(error)
        }
      }
    }
    const keepForNext = (): void => {
      this.capturedInput.set(id, [...input, ...(this.capturedInput.get(id) ?? [])])
    }
    void agent.whenIdle().then(() => {
      if (this.disposed) return
      const current = this.host.agentForSubject(id)
      if (current === agent) {
        if (this.subjects.has(id)) {
          keepForNext()
          return
        }
        deliver(current)
        return
      }
      if (current === undefined) {
        this.host.log(`${why}; no live Agent to hand it to, keeping it for the subject's next generation (${input.length} message(s), subject ${String(id)})`)
        keepForNext()
        return
      }
      void current.whenIdle().then(() => {
        deliver(current)
      }, failed)
    }, failed)
  }

  /**
   * Capture the inbox messages queued for an old generation at its turn-stop
   * boundary. Ephemeral domain notices are dropped because the new generation
   * rederives them.
   */
  captureQueuedInput(agent: Agent): readonly UserMessage[] {
    const id = this.host.subjectForAgent(agent)?.id
    if (id === undefined) return []
    if (!this.capturesFor(id, agent)) return []
    const removed = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    for (const message of removed) agent.inbox.remove(message.id)
    return this.captureInput(agent, removed)
  }

  /**
   * Capture messages a racing pre-step already claimed from the inbox before
   * rejecting that old-generation step.
   */
  captureClaimedInput(agent: Agent, messages: readonly UserMessage[]): readonly UserMessage[] {
    return this.captureInput(agent, messages)
  }

  private captureInput(agent: Agent, messages: readonly UserMessage[]): readonly UserMessage[] {
    const id = this.host.subjectForAgent(agent)?.id
    if (id === undefined) return []
    if (!this.capturesFor(id, agent)) return []
    const preserved: UserMessage[] = []
    for (const message of messages) {
      if (isDroppedNotice(this.codec, this.host, message)) continue
      preserved.push(message)
    }
    if (preserved.length > 0) this.capturedInput.set(id, [...(this.capturedInput.get(id) ?? []), ...preserved])
    return preserved
  }

  private capturesFor(id: SubjectId, agent: Agent): boolean {
    return this.subjects.get(id)?.agent === agent || this.holds.get(id) === agent
  }

  drainCapturedInput(id: SubjectId): readonly UserMessage[] {
    const captured = this.capturedInput.get(id) ?? []
    this.capturedInput.delete(id)
    return captured
  }

  /**
   * Drop one subject's bookkeeping; the host calls this on dispose/removal. Its
   * continuation latches go with it, or a dead subject's latches would leak.
   */
  stopTracking(id: SubjectId): void {
    this.subjects.delete(id)
    this.capturedInput.delete(id)
    this.holds.delete(id)
    this.scheduledContinuations.delete(id)
  }

  dispose(): void {
    this.disposed = true
    this.subjects.clear()
    this.capturedInput.clear()
    this.holds.clear()
    this.scheduledContinuations.clear()
  }

  private onToolResult(id: SubjectId, agent: Agent, event: SessionEvent & { type: 'tool/result' }): void {
    if (event.data.error !== undefined) return
    const subject = this.host.subjectForAgent(agent)
    if (subject === undefined) return
    const state = this.host.projectionForSubject(id, subject.sessionId)
    if (state?.pending === null || state === undefined) return
    const pending = state.pending
    if (pending.resultSeq !== event.seq) return
    if (this.subjects.has(id)) return
    this.subjects.set(id, { agent, intent: intentFromPending(pending), turnEnded: false })
  }

  private onTurnEnd(id: SubjectId, agent: Agent): void {
    this.scheduleCheckpointContinuations(id, agent)
    const transition = this.subjects.get(id)
    if (transition !== undefined && !transition.turnEnded) {
      const subject = this.host.subjectForAgent(agent)
      if (subject !== undefined && transition.agent === agent) {
        transition.turnEnded = true
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
        return
      }
    }
    if (this.subjects.has(id)) return
    this.returnHeldInput(id, agent)
  }

  private claimContinuationLatch(id: SubjectId, state: ContextProjectionState, checkpoint: ContextCheckpointEntry): boolean {
    if (checkpoint.turnEndSeq === -1) return false
    if (continuationDelivered(state, checkpoint.checkpointRef)) return false
    const latched = this.scheduledContinuations.get(id) ?? new Set<string>()
    if (latched.has(checkpoint.checkpointRef)) return false
    latched.add(checkpoint.checkpointRef)
    this.scheduledContinuations.set(id, latched)
    return true
  }

  private releaseContinuationLatch(id: SubjectId, checkpointRef: string): void {
    const latched = this.scheduledContinuations.get(id)
    if (latched === undefined) return
    latched.delete(checkpointRef)
    if (latched.size === 0) this.scheduledContinuations.delete(id)
  }

  private releaseDeliveredContinuations(id: SubjectId, event: SessionEvent & { type: 'user/message' }): void {
    if (this.scheduledContinuations.size === 0) return
    const checkpointRef = this.codec.continuationCheckpointRefOf(event.data)
    if (checkpointRef === undefined) return
    this.releaseContinuationLatch(id, checkpointRef)
  }

  private scheduleCheckpointContinuations(id: SubjectId, agent: Agent): void {
    const subject = this.host.subjectForAgent(agent)
    if (subject === undefined) return
    const state = this.host.projectionForSubject(id, subject.sessionId)
    if (state === undefined) return
    for (const checkpoint of state.checkpoints) {
      if (!this.claimContinuationLatch(id, state, checkpoint)) continue
      const checkpointRef = checkpoint.checkpointRef
      void agent.whenIdle().then(() => {
        if (this.disposed) return
        try {
          agent.followup(this.codec.createCheckpointContinuationMessage(checkpointRef))
        } catch (error) {
          this.releaseContinuationLatch(id, checkpointRef)
          this.host.log(`context continuation scheduling failed: ${error instanceof Error ? error.message : String(error)} (subject ${String(id)})`)
        }
      }, () => {
        this.releaseContinuationLatch(id, checkpointRef)
      })
    }
  }

  private async performTransition(id: SubjectId, previousSessionId: SessionId, transition: SubjectTransition): Promise<void> {
    const identity = this.host.rolloverIdentity(previousSessionId, transition.intent.toolCallId)
    this.holds.delete(id)
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
    try {
      await this.host.executeTransition(id, plan)
      this.subjects.delete(id)
    } catch (error) {
      this.host.log(`context rollover failed, leaving the previous generation recoverable: ${error instanceof Error ? error.message : String(error)} (subject ${String(id)})`)
      this.subjects.delete(id)
      this.handBackInput(
        id,
        transition.agent,
        plan.carriedInput,
        'context rollover failed; the input it was to carry is handed back unchanged',
      )
    }
  }

  /**
   * Crash-recovery hook the host runs during subject activation: re-derive
   * pending intent from the projection and finish a transition a restart
   * interrupted.
   */
  recoverPendingTransition(id: SubjectId, agent: Agent, sessionId: SessionId): void {
    if (this.disposed || this.subjects.has(id)) return
    const state = this.host.projectionForSubject(id, sessionId)
    if (state?.pending === null || state === undefined) return
    const pending = state.pending
    if (pending.turnEndSeq === -1) {
      this.subjects.set(id, { agent, intent: intentFromPending(pending), turnEnded: false })
      return
    }
    const transition: SubjectTransition = { agent, intent: intentFromPending(pending), turnEnded: true }
    this.subjects.set(id, transition)
    void this.performTransition(id, sessionId, transition)
  }

  /**
   * Crash-recovery for quiet continuations: schedule the follow-up for one
   * resolved checkpoint when the result was durable but the delivery never
   * landed. The projection's continuations state is the durable delivery record.
   */
  repairContinuations(agent: Agent, state: ContextProjectionState): void {
    if (this.disposed) return
    const id = this.host.subjectForAgent(agent)?.id
    if (id === undefined) return
    for (const checkpoint of state.checkpoints) {
      if (!this.claimContinuationLatch(id, state, checkpoint)) continue
      try {
        agent.followup(this.codec.createCheckpointContinuationMessage(checkpoint.checkpointRef))
      } catch (error) {
        this.releaseContinuationLatch(id, checkpoint.checkpointRef)
        this.host.log(`context continuation repair failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
