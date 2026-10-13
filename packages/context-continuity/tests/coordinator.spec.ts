/**
 * The context-continuity coordinator: rollover scheduling, carried input, and
 * checkpoint continuations.
 *
 * The coordinator owns only process locks; every fact it acts on comes from the
 * projection and every effect it produces goes through the host. These tests
 * pin the ordering the engine promises — durable result first, then the turn
 * end, then true idle, then the host swap — and the delivery discipline of one
 * quiet continuation per resolved checkpoint.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { ContextContinuityCoordinator } from '../src/coordinator.ts'
import type { ContextContinuityHost } from '../src/host.ts'
import { ContextMessageCodec, producerNoticeSource } from '../src/message-codec.ts'
import { emptyContextProjectionState } from '../src/projection.ts'
import type {
  ContextCheckpointEntry,
  ContextProjectionState,
  PendingRolloverIntent,
} from '../src/projection-state.ts'
import type { TransitionPlan } from '../src/types.ts'
import { PLUGIN_ID } from './test-producer.ts'

const SUBJECT = 'member-1'
const SESSION = 'session-a' as SessionId
const NEW_SESSION = 'session-b' as SessionId

const codec = new ContextMessageCodec({
  pluginId: PLUGIN_ID,
  handoffIntro: 'A context handoff opens this generation.',
  handoffVerifyNote: 'Nothing external was rolled back.',
})

/** One inbox the coordinator drains and edits, shaped like the live Agent's. */
class FakeInbox {
  nextStep: UserMessage[] = []
  nextTurn: UserMessage[] = []
  remove(id: string): void {
    this.nextStep = this.nextStep.filter(message => message.id !== id)
    this.nextTurn = this.nextTurn.filter(message => message.id !== id)
  }
}

class FakeAgent {
  readonly inbox = new FakeInbox()
  readonly followups: UserMessage[] = []
  followupError: Error | undefined
  private idle = true
  private waiters: Array<() => void> = []

  whenIdle(): Promise<void> {
    if (this.idle) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
  }

  followup(message: UserMessage): void {
    if (this.followupError !== undefined) throw this.followupError
    this.followups.push(message)
  }

  /** Model a driver that has not converged yet: `whenIdle` waits for `goIdle`. */
  holdIdle(): void {
    this.idle = false
  }

  goIdle(): void {
    this.idle = true
    for (const resolve of this.waiters.splice(0)) resolve()
  }
}

function state(overrides: Partial<ContextProjectionState> = {}): ContextProjectionState {
  return {
    ...emptyContextProjectionState({ sessionId: SESSION }),
    ...overrides,
  }
}

function pending(overrides: Partial<PendingRolloverIntent> = {}): PendingRolloverIntent {
  return {
    handoff: 'Continue the migration from step 3.',
    checkpointRef: undefined,
    relatedFiles: [],
    toolCallId: 'call-1',
    resultSeq: 12,
    turn: 3,
    turnEndSeq: -1,
    ...overrides,
  }
}

function checkpoint(overrides: Partial<ContextCheckpointEntry> = {}): ContextCheckpointEntry {
  return { checkpointRef: 'checkpoint:1', name: 'after design', resultSeq: 30, turn: 4, turnEndSeq: -1, ...overrides }
}

const toolResult = (seq: number, error?: string): SessionEvent =>
  ({ type: 'tool/result', seq, data: error === undefined ? {} : { error } }) as unknown as SessionEvent
const turnEnd = (seq: number): SessionEvent => ({ type: 'turn/end', seq }) as unknown as SessionEvent

const external = (text: string): UserMessage =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const notice = (text: string): UserMessage =>
  createUserMessage({ content: [{ type: 'text', text }], source: producerNoticeSource(PLUGIN_ID, text) })

/** Let queued microtasks and the idle-wait chain run to completion. */
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}

function harness(options: { ephemeral?: (message: UserMessage) => boolean; executeError?: Error | (() => Error | undefined); executeThrows?: Error } = {}) {
  const agent = new FakeAgent()
  const plans: TransitionPlan[] = []
  const logs: string[] = []
  let projection: ContextProjectionState | undefined
  // The subject's live binding: which Agent runs it now, as the host has it.
  let bound: FakeAgent | undefined = agent
  const host: ContextContinuityHost<string> = {
    agentForSubject: id => (id === SUBJECT && bound !== undefined ? (bound as unknown as Agent) : undefined),
    subjectForAgent: candidate => (bound !== undefined && candidate === (bound as unknown as Agent) ? { id: SUBJECT, sessionId: SESSION } : undefined),
    projectionForSubject: () => projection,
    // Deliberately not `async`: a host is allowed to fail before it ever
    // returns a promise, and the coordinator has to survive that too.
    executeTransition: (_id, plan) => {
      if (options.executeThrows !== undefined) throw options.executeThrows
      const failure = typeof options.executeError === 'function' ? options.executeError() : options.executeError
      if (failure !== undefined) return Promise.reject(failure)
      plans.push(plan)
      return Promise.resolve()
    },
    rolloverIdentity: previousSessionId => ({ newSessionId: NEW_SESSION, requestId: `rollover:${previousSessionId}` }),
    isEphemeralNotice: options.ephemeral ?? (message => message.source.kind === PLUGIN_ID),
    log: message => {
      logs.push(message)
    },
  }
  const coordinator = new ContextContinuityCoordinator<string>(host, codec)
  const asAgent = agent as unknown as Agent
  return {
    agent,
    asAgent,
    coordinator,
    plans,
    logs,
    setProjection: (next: ContextProjectionState | undefined) => {
      projection = next
    },
    /** Move the host's binding: the Agent that runs the subject from now on. */
    handoverTo: (next: FakeAgent | undefined) => {
      bound = next
    },
    /** The projection a fresh pending intent produces, plus its successful result. */
    armIntent: (overrides: Partial<PendingRolloverIntent> = {}) => {
      const intent = pending(overrides)
      projection = state({ pending: intent })
      coordinator.onSessionEvent(SUBJECT, asAgent, toolResult(intent.resultSeq))
      return intent
    },
  }
}

describe('rollover: durable intent to host swap', () => {
  it('arms only when the intent\'s own result lands durably', async () => {
    const test = harness()
    test.setProjection(state({ pending: pending({ resultSeq: 12 }) }))
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, toolResult(11))
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, toolResult(12))
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(true)
    expect(test.plans).toEqual([])
  })

  it('ignores an errored result even at the intent\'s own seq', () => {
    const test = harness()
    test.setProjection(state({ pending: pending({ resultSeq: 12 }) }))
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, toolResult(12, 'tool failed'))
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
  })

  it('ignores every event for a subject with no pending intent', async () => {
    const test = harness()
    test.setProjection(state())
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, toolResult(12))
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
    expect(test.plans).toEqual([])
  })

  it('waits for the containing turn to end before swapping', async () => {
    const test = harness()
    test.armIntent()
    await settle()
    expect(test.plans).toEqual([])

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.plans).toHaveLength(1)
  })

  it('waits for true idle after the turn end', async () => {
    const test = harness()
    test.agent.holdIdle()
    test.armIntent()
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.plans).toEqual([])

    test.agent.goIdle()
    await settle()
    expect(test.plans).toHaveLength(1)
  })

  it('plans the swap from the durable intent and the host-derived identity', async () => {
    const test = harness()
    const intent = test.armIntent({
      checkpointRef: 'checkpoint:7',
      relatedFiles: [{ path: 'src/index.ts', reason: 'entry point' }],
    })
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()

    expect(test.plans[0]).toEqual({
      previousSessionId: SESSION,
      newSessionId: NEW_SESSION,
      handoff: intent.handoff,
      handoffEventSeq: intent.resultSeq,
      trigger: 'model',
      relatedFiles: intent.relatedFiles,
      checkpointRef: 'checkpoint:7',
      requestId: `rollover:${SESSION}`,
      carriedInput: [],
    })
  })

  it('clears the transition once the host swap resolves', async () => {
    const test = harness()
    test.armIntent()
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
    expect(test.coordinator.needsAdmissionGate(test.asAgent)).toBe(false)
  })

  it('keeps the previous generation recoverable when the host swap rejects', async () => {
    const test = harness({ executeError: new Error('activation failed') })
    test.armIntent()
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.logs.some(line => line.includes('activation failed'))).toBe(true)
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
  })

  it('arms the admission gate for the old-generation agent only', () => {
    const test = harness()
    test.armIntent()
    expect(test.coordinator.needsAdmissionGate(test.asAgent)).toBe(true)
    expect(test.coordinator.needsAdmissionGate({} as Agent)).toBe(false)
  })

  it('builds the handoff message of one generation from its plan', () => {
    const test = harness()
    const message = test.coordinator.handoffMessageFor({
      previousSessionId: SESSION,
      newSessionId: NEW_SESSION,
      handoff: 'Continue.',
      handoffEventSeq: 21,
      trigger: 'pressure',
      relatedFiles: [{ path: 'docs/a.md', reason: 'spec' }],
      checkpointRef: 'checkpoint:2',
      requestId: 'rollover:x',
      carriedInput: [],
    })
    const decoded = codec.handoffOf(message)
    expect(decoded?.previousSessionId).toBe(SESSION)
    expect(decoded?.newSessionId).toBe(NEW_SESSION)
    expect(decoded?.trigger).toBe('pressure')
    expect(decoded?.handoffEventSeq).toBe(21)
    expect(decoded?.checkpointRef).toBe('checkpoint:2')
    expect(decoded?.relatedFiles).toEqual(['docs/a.md'])
  })
})

describe('carried input', () => {
  it('preserves real input and drops ephemeral notices, removing both from the inbox', async () => {
    const test = harness()
    test.armIntent()
    const keep = external('please also fix the docs')
    const drop = notice('Team Workspace participation changed')
    test.agent.inbox.nextTurn.push(keep, drop)
    test.agent.inbox.nextStep.push(notice('pressure notice'))

    const captured = test.coordinator.captureQueuedInput(test.asAgent)
    expect(captured).toEqual([keep])
    expect(test.agent.inbox.nextTurn).toEqual([])
    expect(test.agent.inbox.nextStep).toEqual([])

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.plans[0]?.carriedInput).toEqual([keep])
  })

  it('never drops the engine\'s own envelopes, whatever the host calls ephemeral', async () => {
    const test = harness({ ephemeral: () => true })
    test.armIntent()
    const handoff = codec.createHandoffMessage({
      handoff: 'earlier handoff',
      previousSessionId: 'session-0' as SessionId,
      newSessionId: SESSION,
      trigger: 'model',
      handoffEventSeq: 3,
    })
    const continuation = codec.createCheckpointContinuationMessage('checkpoint:9')
    const otherNotice = notice('domain notice')
    test.agent.inbox.nextTurn.push(handoff, continuation, otherNotice)

    expect(test.coordinator.captureQueuedInput(test.asAgent)).toEqual([handoff, continuation])
  })

  it('captures a racing pre-step claim', async () => {
    const test = harness()
    test.armIntent()
    const claimed = external('arrived mid-step')
    expect(test.coordinator.captureClaimedInput(test.asAgent, [claimed])).toEqual([claimed])

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.plans[0]?.carriedInput).toEqual([claimed])
  })

  it('captures nothing while no transition is pending', () => {
    const test = harness()
    test.setProjection(state())
    const queued = external('keep me')
    test.agent.inbox.nextTurn.push(queued)
    expect(test.coordinator.captureQueuedInput(test.asAgent)).toEqual([])
    expect(test.agent.inbox.nextTurn).toEqual([queued])
  })

  it('drains captured input once', () => {
    const test = harness()
    test.armIntent()
    const queued = external('keep me')
    test.agent.inbox.nextTurn.push(queued)
    test.coordinator.captureQueuedInput(test.asAgent)
    expect(test.coordinator.drainCapturedInput(SUBJECT)).toEqual([queued])
    expect(test.coordinator.drainCapturedInput(SUBJECT)).toEqual([])
  })
})

describe('checkpoint continuations', () => {
  it('delivers exactly one quiet follow-up per resolved checkpoint', async () => {
    const test = harness()
    test.setProjection(state({ checkpoints: [checkpoint({ turnEndSeq: 31 })] }))
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(31))
    await settle()
    expect(test.agent.followups).toHaveLength(1)
    expect(codec.continuationCheckpointRefOf(test.agent.followups[0]!)).toBe('checkpoint:1')

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(32))
    await settle()
    expect(test.agent.followups).toHaveLength(1)
  })

  it('skips a checkpoint whose turn never resolved', async () => {
    const test = harness()
    test.setProjection(state({ checkpoints: [checkpoint({ turnEndSeq: -1 })] }))
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(31))
    await settle()
    expect(test.agent.followups).toEqual([])
  })

  it('skips a checkpoint whose continuation is already durable', async () => {
    const test = harness()
    test.setProjection(state({
      checkpoints: [checkpoint({ turnEndSeq: 31 })],
      continuations: [{ checkpointRef: 'checkpoint:1', deliveredSeq: 33 }],
    }))
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(31))
    await settle()
    expect(test.agent.followups).toEqual([])
  })

  it('repairs an undelivered continuation exactly once across restarts', () => {
    const test = harness()
    const repaired = state({ checkpoints: [checkpoint({ turnEndSeq: 31 })] })
    test.coordinator.repairContinuations(test.asAgent, repaired)
    test.coordinator.repairContinuations(test.asAgent, repaired)
    expect(test.agent.followups).toHaveLength(1)
  })

  it('releases the latch and logs when delivery throws, so a repair can retry', () => {
    const test = harness()
    test.agent.followupError = new Error('inbox closed')
    const projection = state({ checkpoints: [checkpoint({ turnEndSeq: 31 })] })
    test.coordinator.repairContinuations(test.asAgent, projection)
    expect(test.logs.some(line => line.includes('repair failed'))).toBe(true)

    test.agent.followupError = undefined
    test.coordinator.repairContinuations(test.asAgent, projection)
    expect(test.agent.followups).toHaveLength(1)
  })

  it('keeps the two families independent: a resolved checkpoint never rolls the subject over', async () => {
    const test = harness()
    test.setProjection(state({ checkpoints: [checkpoint({ turnEndSeq: 31 })] }))
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(31))
    await settle()
    expect(test.plans).toEqual([])
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
  })
})

/**
 * The latch is process state the projection cannot see, so its lifecycle has to
 * be asserted directly: it must exist for the scheduling window, and it must be
 * gone once the durable delivery event proves it served its purpose — otherwise
 * a long-running subject accumulates one entry per checkpoint forever.
 */
describe('checkpoint continuation latch lifecycle', () => {
  /** Several subjects on one coordinator, each with its own Agent and projection. */
  function multiHarness() {
    const agents = new Map<string, FakeAgent>()
    const projections = new Map<string, ContextProjectionState>()
    const host: ContextContinuityHost<string> = {
      agentForSubject: id => agents.get(id) as unknown as Agent | undefined,
      subjectForAgent: candidate => {
        for (const [id, agent] of agents) {
          if ((agent as unknown as Agent) === candidate) return { id, sessionId: SESSION }
        }
        return undefined
      },
      projectionForSubject: id => projections.get(id),
      executeTransition: () => Promise.resolve(),
      rolloverIdentity: previousSessionId => ({ newSessionId: NEW_SESSION, requestId: `rollover:${previousSessionId}` }),
      isEphemeralNotice: () => false,
      log: () => undefined,
    }
    const coordinator = new ContextContinuityCoordinator<string>(host, codec)
    return {
      coordinator,
      addSubject(id: string, overrides: Partial<ContextProjectionState> = {}) {
        const agent = new FakeAgent()
        agents.set(id, agent)
        projections.set(id, state(overrides))
        return { agent, asAgent: agent as unknown as Agent }
      },
      setProjection(id: string, next: ContextProjectionState) {
        projections.set(id, next)
      },
    }
  }

  /** The private latch map, read directly: it is the subject of these assertions. */
  const latchesOf = (coordinator: ContextContinuityCoordinator<string>) =>
    (coordinator as unknown as { scheduledContinuations: Map<string, Set<string>> }).scheduledContinuations

  const continuationEvent = (seq: number, checkpointRef: string): SessionEvent =>
    ({ type: 'user/message', seq, data: codec.createCheckpointContinuationMessage(checkpointRef) }) as unknown as SessionEvent

  it('holds one latch per resolved checkpoint, then releases it on the durable delivery', async () => {
    const test = multiHarness()
    const { agent, asAgent } = test.addSubject(SUBJECT, {
      checkpoints: [checkpoint({ checkpointRef: 'checkpoint:1', turnEndSeq: 31 })],
    })
    test.coordinator.onSessionEvent(SUBJECT, asAgent, turnEnd(31))
    await settle()
    expect(agent.followups).toHaveLength(1)
    expect(latchesOf(test.coordinator).get(SUBJECT)).toEqual(new Set(['checkpoint:1']))

    // The notice lands durably: the projection records it and the latch retires.
    test.coordinator.onSessionEvent(SUBJECT, asAgent, continuationEvent(33, 'checkpoint:1'))
    expect(latchesOf(test.coordinator).has(SUBJECT)).toBe(false)

    // Released means a repair over a stale projection may schedule again; a
    // latch that outlived its delivery would silently suppress that.
    test.coordinator.repairContinuations(asAgent, state({
      checkpoints: [checkpoint({ checkpointRef: 'checkpoint:1', turnEndSeq: 31 })],
    }))
    expect(agent.followups).toHaveLength(2)
  })

  it('does not accumulate latches across many resolved checkpoints', async () => {
    const test = multiHarness()
    const refs = Array.from({ length: 64 }, (_value, index) => `checkpoint:${String(index)}`)
    const { asAgent } = test.addSubject(SUBJECT, {
      checkpoints: refs.map(ref => checkpoint({ checkpointRef: ref, turnEndSeq: 31 })),
    })
    test.coordinator.onSessionEvent(SUBJECT, asAgent, turnEnd(31))
    await settle()
    expect(latchesOf(test.coordinator).get(SUBJECT)?.size).toBe(64)

    for (const [index, ref] of refs.entries()) {
      test.coordinator.onSessionEvent(SUBJECT, asAgent, continuationEvent(40 + index, ref))
    }
    expect(latchesOf(test.coordinator).has(SUBJECT)).toBe(false)
    expect(latchesOf(test.coordinator).size).toBe(0)
  })

  it('releases every latch of a subject that stops being tracked', async () => {
    const test = multiHarness()
    const { asAgent } = test.addSubject(SUBJECT, {
      checkpoints: [checkpoint({ checkpointRef: 'checkpoint:1', turnEndSeq: 31 })],
    })
    test.coordinator.onSessionEvent(SUBJECT, asAgent, turnEnd(31))
    await settle()
    expect(latchesOf(test.coordinator).has(SUBJECT)).toBe(true)

    test.coordinator.stopTracking(SUBJECT)
    expect(latchesOf(test.coordinator).has(SUBJECT)).toBe(false)
  })

  it('clears every subject\'s latches on dispose', async () => {
    const test = multiHarness()
    for (const id of ['member-1', 'member-2']) {
      const { asAgent } = test.addSubject(id, {
        checkpoints: [checkpoint({ checkpointRef: 'checkpoint:1', turnEndSeq: 31 })],
      })
      test.coordinator.onSessionEvent(id, asAgent, turnEnd(31))
      await settle()
    }
    expect(latchesOf(test.coordinator).size).toBe(2)

    test.coordinator.dispose()
    expect(latchesOf(test.coordinator).size).toBe(0)
  })

  it('keeps an identical checkpoint ref on two subjects from suppressing either', async () => {
    const test = multiHarness()
    const first = test.addSubject('member-1', {
      checkpoints: [checkpoint({ checkpointRef: 'checkpoint:shared', turnEndSeq: 31 })],
    })
    const second = test.addSubject('member-2', {
      checkpoints: [checkpoint({ checkpointRef: 'checkpoint:shared', turnEndSeq: 31 })],
    })

    test.coordinator.onSessionEvent('member-1', first.asAgent, turnEnd(31))
    test.coordinator.onSessionEvent('member-2', second.asAgent, turnEnd(31))
    await settle()

    expect(first.agent.followups).toHaveLength(1)
    expect(second.agent.followups).toHaveLength(1)
  })

  it('keeps subjects whose ids and refs contain the separator from colliding', async () => {
    // Under a `${subject}:${ref}` key both of these are the same string, so the
    // second subject's continuation would be suppressed as a duplicate.
    const test = multiHarness()
    const first = test.addSubject('team:a', {
      checkpoints: [checkpoint({ checkpointRef: 'b:checkpoint', turnEndSeq: 31 })],
    })
    const second = test.addSubject('team:a:b', {
      checkpoints: [checkpoint({ checkpointRef: 'checkpoint', turnEndSeq: 31 })],
    })

    test.coordinator.onSessionEvent('team:a', first.asAgent, turnEnd(31))
    test.coordinator.onSessionEvent('team:a:b', second.asAgent, turnEnd(31))
    await settle()

    expect(first.agent.followups).toHaveLength(1)
    expect(second.agent.followups).toHaveLength(1)
  })

  it('treats a ref with slashes or Unicode as one opaque value', async () => {
    const test = multiHarness()
    const weird = 'checkpoint/../设计:✓'
    const { agent, asAgent } = test.addSubject(SUBJECT, {
      checkpoints: [checkpoint({ checkpointRef: weird, turnEndSeq: 31 })],
    })
    test.coordinator.onSessionEvent(SUBJECT, asAgent, turnEnd(31))
    await settle()
    expect(agent.followups).toHaveLength(1)
    expect(codec.continuationCheckpointRefOf(agent.followups[0]!)).toBe(weird)

    // Only that exact ref retires the latch; a lookalike does not.
    test.coordinator.onSessionEvent(SUBJECT, asAgent, continuationEvent(33, 'checkpoint/../设计'))
    expect(latchesOf(test.coordinator).get(SUBJECT)).toEqual(new Set([weird]))
    test.coordinator.onSessionEvent(SUBJECT, asAgent, continuationEvent(34, weird))
    expect(latchesOf(test.coordinator).has(SUBJECT)).toBe(false)
  })

  it('ignores an ordinary user message when deciding what to release', async () => {
    const test = multiHarness()
    const { asAgent } = test.addSubject(SUBJECT, {
      checkpoints: [checkpoint({ checkpointRef: 'checkpoint:1', turnEndSeq: 31 })],
    })
    test.coordinator.onSessionEvent(SUBJECT, asAgent, turnEnd(31))
    await settle()

    test.coordinator.onSessionEvent(SUBJECT, asAgent, {
      type: 'user/message', seq: 33, data: external('an ordinary prompt'),
    } as unknown as SessionEvent)
    expect(latchesOf(test.coordinator).get(SUBJECT)).toEqual(new Set(['checkpoint:1']))
  })
})

describe('crash recovery', () => {
  it('adopts an intent whose turn never ended and then follows live events', async () => {
    const test = harness()
    const intent = pending({ turnEndSeq: -1 })
    test.setProjection(state({ pending: intent }))
    test.coordinator.recoverPendingTransition(SUBJECT, test.asAgent, SESSION)
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(true)
    await settle()
    expect(test.plans).toEqual([])

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.plans[0]?.handoffEventSeq).toBe(intent.resultSeq)
  })

  it('completes an intent whose turn already ended, without waiting for another', async () => {
    const test = harness()
    test.setProjection(state({ pending: pending({ turnEndSeq: 13 }) }))
    test.coordinator.recoverPendingTransition(SUBJECT, test.asAgent, SESSION)
    await settle()
    expect(test.plans).toHaveLength(1)
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
  })

  it('does nothing without a pending intent', async () => {
    const test = harness()
    test.setProjection(state())
    test.coordinator.recoverPendingTransition(SUBJECT, test.asAgent, SESSION)
    await settle()
    expect(test.plans).toEqual([])
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
  })

  it('never re-arms an already tracked subject', async () => {
    const test = harness()
    test.armIntent()
    test.setProjection(state({ pending: pending({ turnEndSeq: 13 }) }))
    test.coordinator.recoverPendingTransition(SUBJECT, test.asAgent, SESSION)
    await settle()
    expect(test.plans).toEqual([])
  })
})

describe('lifecycle', () => {
  it('stops reacting after dispose', async () => {
    const test = harness()
    test.armIntent()
    test.coordinator.dispose()
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, toolResult(12))
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
    expect(test.plans).toEqual([])
  })

  it('drops one subject\'s bookkeeping on request', () => {
    const test = harness()
    test.armIntent()
    test.coordinator.stopTracking(SUBJECT)
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
    expect(test.coordinator.captureQueuedInput(test.asAgent)).toEqual([])
  })

  it('ignores events from an agent the host does not bind to the subject', () => {
    const test = harness()
    test.armIntent()
    test.coordinator.onSessionEvent(SUBJECT, {} as Agent, turnEnd(13))
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(true)
  })
})

describe('held step: the rollover answers it, or the turn end hands the input back', () => {
  it('an armed hold admits nothing until a turn ends without the rollover', async () => {
    const test = harness()
    const input = external('what is the status of the release?')
    expect(test.coordinator.needsAdmissionGate(test.asAgent)).toBe(false)

    expect(test.coordinator.holdClaimedInput(test.asAgent, [input])).toEqual([input])
    expect(test.coordinator.isHoldingInput(test.asAgent)).toBe(true)
    expect(test.coordinator.needsAdmissionGate(test.asAgent)).toBe(true)

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    expect(test.agent.followups).toEqual([input])
    expect(test.coordinator.isHoldingInput(test.asAgent)).toBe(false)
    expect(test.coordinator.needsAdmissionGate(test.asAgent)).toBe(false)
  })

  it('hands the input back exactly once, however many turns end', async () => {
    const test = harness()
    const input = external('continue')
    test.coordinator.holdClaimedInput(test.asAgent, [input])

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(21))
    await settle()
    expect(test.agent.followups).toEqual([input])
  })

  it('hands the input to a rollover that lands while the fallback is still waiting', async () => {
    const test = harness()
    const input = external('held across the swap')
    test.coordinator.holdClaimedInput(test.asAgent, [input])
    test.agent.holdIdle()
    // The held turn ends, so the fallback is scheduled but cannot deliver yet.
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    // The turn the fallback answers is the one that got the instruction, and in
    // it the model did roll over.
    test.armIntent({ resultSeq: 12 })
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(21))
    test.agent.goIdle()
    await settle()
    expect(test.plans).toHaveLength(1)
    expect(test.plans[0]!.carriedInput).toEqual([input])
    expect(test.agent.followups).toEqual([])
  })

  it('says in the log that the rollover did not happen', async () => {
    const test = harness()
    test.coordinator.holdClaimedInput(test.asAgent, [external('held')])
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    expect(test.logs.join('\n')).toContain('the requested rollover did not happen')
  })

  it('waits for true idle before queueing the returned input as the next turn', async () => {
    const test = harness()
    const input = external('held while the driver converges')
    test.coordinator.holdClaimedInput(test.asAgent, [input])
    test.agent.holdIdle()
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    expect(test.agent.followups).toEqual([])

    test.agent.goIdle()
    await settle()
    expect(test.agent.followups).toEqual([input])
  })

  it('arming and capturing are one call, because a capture taken first keeps nothing', async () => {
    const test = harness()
    const input = external('continue')
    // The capture is refused while no hold is armed, which is why the hold and
    // the capture cannot be two host calls in the other order.
    expect(test.coordinator.captureClaimedInput(test.asAgent, [input])).toEqual([])
    test.coordinator.holdClaimedInput(test.asAgent, [input])
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    expect(test.agent.followups).toEqual([input])
  })

  it('keeps several claimed messages in the order they were claimed', async () => {
    const test = harness()
    const first = external('first')
    const second = external('second')
    test.coordinator.holdClaimedInput(test.asAgent, [first])
    test.coordinator.holdClaimedInput(test.asAgent, [second])
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    expect(test.agent.followups).toEqual([first, second])
  })

  it('drains the inbox into the hold too, so nothing opens a step behind it', async () => {
    const test = harness()
    const queued = external('queued while held')
    test.coordinator.holdClaimedInput(test.asAgent, [external('held')])
    test.agent.inbox.nextTurn.push(queued)
    expect(test.coordinator.captureQueuedInput(test.asAgent)).toEqual([queued])
    expect(test.agent.inbox.nextTurn).toEqual([])
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    expect(test.agent.followups).toHaveLength(2)
  })

  it('drops an ephemeral notice while holding, exactly as it does at a rollover', async () => {
    const test = harness()
    const kept = external('real input')
    const dropped = notice('domain notice')
    expect(test.coordinator.holdClaimedInput(test.asAgent, [dropped, kept])).toEqual([kept])
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    expect(test.agent.followups).toEqual([kept])
  })

  it('returns nothing for a turn that ends with no hold armed', async () => {
    const test = harness()
    expect(test.coordinator.isHoldingInput(test.asAgent)).toBe(false)
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    expect(test.agent.followups).toEqual([])
    expect(test.logs).toEqual([])
  })

  it('a rollover answers the hold by carrying its input into the new generation', async () => {
    const test = harness()
    const input = external('held across the swap')
    test.coordinator.holdClaimedInput(test.asAgent, [input])
    test.armIntent({ resultSeq: 12 })
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(true)

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    expect(test.plans).toHaveLength(1)
    expect(test.plans[0]!.carriedInput).toEqual([input])
    // The swap is the hold's other exit: the input travels with it, never as a
    // follow-up into the generation the hold exists to leave behind.
    expect(test.agent.followups).toEqual([])
    // The successor generation starts ungated: the hold was answered, not left armed.
    expect(test.coordinator.isHoldingInput(test.asAgent)).toBe(false)
    expect(test.coordinator.needsAdmissionGate(test.asAgent)).toBe(false)
  })

  it('a turn ending while the swap is still in flight does not steal the held input', async () => {
    const test = harness()
    const input = external('held across the swap')
    test.coordinator.holdClaimedInput(test.asAgent, [input])
    test.armIntent({ resultSeq: 12 })
    test.agent.holdIdle()
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    // The swap is scheduled but the driver has not converged. A second turn end
    // must not hand the input to the generation the swap exists to leave behind.
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(21))
    await settle()
    expect(test.agent.followups).toEqual([])
    expect(test.coordinator.isHoldingInput(test.asAgent)).toBe(true)

    test.agent.goIdle()
    await settle()
    expect(test.plans).toHaveLength(1)
    expect(test.plans[0]!.carriedInput).toEqual([input])
  })

  it('forgets one subject\'s hold when its bookkeeping is dropped', () => {
    const test = harness()
    test.coordinator.holdClaimedInput(test.asAgent, [external('held')])
    test.coordinator.stopTracking(SUBJECT)
    expect(test.coordinator.isHoldingInput(test.asAgent)).toBe(false)
    expect(test.coordinator.needsAdmissionGate(test.asAgent)).toBe(false)
  })

  it('a disposal drops every hold it was carrying', () => {
    const test = harness()
    test.coordinator.holdClaimedInput(test.asAgent, [external('held')])
    test.coordinator.dispose()
    expect(test.coordinator.isHoldingInput(test.asAgent)).toBe(false)
  })
})

describe('a rejected swap hands the input it drained back', () => {
  it('queues captured input as the next turn when the host swap rejects', async () => {
    const test = harness({ executeError: new Error('activation failed') })
    const input = external('queued for the next generation')
    test.armIntent()
    test.agent.inbox.nextTurn.push(input)
    test.coordinator.captureQueuedInput(test.asAgent)

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()

    // The swap never ran, so the messages it was to carry belong to the
    // generation still standing — not to a plan that no longer exists.
    expect(test.agent.followups).toEqual([input])
    expect(test.logs.join('\n')).toContain('the input it was to carry is handed back unchanged')
    // The old generation stays open: neither the latch nor the gate is left armed.
    expect(test.coordinator.isTransitioning(SUBJECT)).toBe(false)
    expect(test.coordinator.needsAdmissionGate(test.asAgent)).toBe(false)
  })

  it('hands a held input back when the swap it was waiting for rejects', async () => {
    const test = harness({ executeError: new Error('activation failed') })
    const input = external('held across a swap that never happened')
    test.coordinator.holdClaimedInput(test.asAgent, [input])
    test.armIntent({ resultSeq: 12 })

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()

    expect(test.agent.followups).toEqual([input])
    expect(test.coordinator.isHoldingInput(test.asAgent)).toBe(false)
    expect(test.coordinator.needsAdmissionGate(test.asAgent)).toBe(false)
  })

  it('hands the input back when the host fails before it returns a promise', async () => {
    const test = harness({ executeThrows: new Error('no lifecycle mounted') })
    const input = external('queued for a swap that never started')
    test.armIntent()
    test.agent.inbox.nextTurn.push(input)
    test.coordinator.captureQueuedInput(test.asAgent)

    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()

    // Unguarded, that throw leaves performTransition as a rejected promise
    // nobody awaits, and the input it had already drained goes with it.
    expect(test.agent.followups).toEqual([input])
    expect(test.logs.some(line => line.includes('no lifecycle mounted'))).toBe(true)
  })

  it('waits for true idle before queueing it, as the hold\'s exit does', async () => {
    const test = harness({
      // A failed swap can leave the driver mid-convergence, which is exactly
      // when the hand-back must wait instead of queueing into a busy driver.
      executeError: () => {
        test.agent.holdIdle()
        return new Error('activation failed')
      },
    })
    const input = external('delivered after the driver converges')
    test.armIntent()
    test.agent.inbox.nextTurn.push(input)
    test.coordinator.captureQueuedInput(test.asAgent)
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.agent.followups).toEqual([])

    test.agent.goIdle()
    await settle()
    expect(test.agent.followups).toEqual([input])
  })

  it('gives the input to a swap the subject arms afterwards instead of following it up', async () => {
    let attempts = 0
    const test = harness({
      executeError: () => {
        attempts += 1
        if (attempts > 1) return undefined
        // A failed swap can leave the driver converging, which is what keeps
        // the hand-back waiting long enough for the subject to roll over.
        test.agent.holdIdle()
        return new Error('activation failed')
      },
    })
    const input = external('belongs with the generation that does land')
    test.armIntent()
    test.agent.inbox.nextTurn.push(input)
    test.coordinator.captureQueuedInput(test.asAgent)
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(13))
    await settle()
    expect(test.plans).toEqual([])

    // The old generation is recoverable: it rolls over again, and this time
    // the swap takes the input the failed one could not.
    test.armIntent({ resultSeq: 14 })
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(15))
    test.agent.goIdle()
    await settle()

    expect(test.agent.followups).toEqual([])
    expect(test.plans).toHaveLength(1)
    expect(test.plans[0]!.carriedInput).toEqual([input])
  })
})

describe('a hand-back follows the subject to the Agent that runs it now', () => {
  it('delivers there instead of to the Agent the input was taken from', async () => {
    const test = harness()
    const input = external('held while the subject moved on')
    test.coordinator.holdClaimedInput(test.asAgent, [input])
    test.agent.holdIdle()
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()
    expect(test.agent.followups).toEqual([])

    // The subject runs another Agent before the driver converges — a swap that
    // landed, or an activation again. The Agent this input was taken from no
    // longer answers for the subject, so a follow-up at it reaches nobody.
    const successor = new FakeAgent()
    test.handoverTo(successor)
    test.agent.goIdle()
    await settle()

    expect(test.agent.followups).toEqual([])
    expect(successor.followups).toEqual([input])
    expect(test.logs.join('\n')).toContain('runs the subject now')
  })

  it('keeps the input for the subject\'s next generation when no Agent is live', async () => {
    const test = harness()
    const input = external('held while the subject was away')
    test.coordinator.holdClaimedInput(test.asAgent, [input])
    test.agent.holdIdle()
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(20))
    await settle()

    // Deactivated: no Agent may run it, and the one it was taken from must not
    // be woken for a subject it no longer answers for.
    test.handoverTo(undefined)
    test.agent.goIdle()
    await settle()
    expect(test.agent.followups).toEqual([])
    expect(test.logs.join('\n')).toContain('no live Agent to hand it to')

    // The subject comes back and rolls over: the kept input still rides along.
    test.handoverTo(test.agent)
    test.armIntent({ resultSeq: 30 })
    test.coordinator.onSessionEvent(SUBJECT, test.asAgent, turnEnd(21))
    await settle()
    expect(test.plans).toHaveLength(1)
    expect(test.plans[0]!.carriedInput).toEqual([input])
  })
})
