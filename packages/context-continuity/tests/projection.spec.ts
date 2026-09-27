/**
 * The context-continuity projection: the one fold over a Session's durable
 * events, as the Harness projection framework drives it.
 *
 * Rules carry this unit, and the spec pins them: an event the unit does not
 * care about returns the **same** state reference (an unchanged reference is
 * what suppresses all downstream work), nothing is read from outside the log —
 * every durable ref is the host's own answer, derived from the recorded Session
 * identity and the successful tool call — and one registered definition serves
 * every Session, seeded successors included, because identity and the
 * fork-inherited cut travel in the state. The remaining groups walk the
 * transitions the coordinator later acts on: open-call pairing, the single
 * pending intent per unresolved turn, carry candidates, continuation delivery,
 * and host-contributed boundaries.
 */
import { describe, expect, it } from 'vitest'
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { ContextMessageCodec, producerNoticeSource } from '../src/message-codec.ts'
import { continuationDelivered, type ContextProjectionState } from '../src/projection-state.ts'
import {
  CONTEXT_CHECKPOINT_TOOL_NAME,
  CONTEXT_CONTINUITY_PROJECTION_KEY,
  CONTEXT_ROLLOVER_TOOL_NAME,
  contextProjectionStateSchema,
  createContextProjectionDefinition,
  emptyContextProjectionState,
  foldContextProjection,
  type ContextFoldTarget,
  type ContextProjectionConfig,
  type ContextProjectionHost,
  type DomainBoundaryContribution,
  type DomainBoundaryInput,
} from '../src/projection.ts'
import { PLUGIN_ID } from './test-producer.ts'

const SESSION = 'session-a'
const OTHER_SESSION = 'session-b'

const codec = new ContextMessageCodec({
  pluginId: PLUGIN_ID,
  handoffIntro: 'A context handoff opens this generation.',
  handoffVerifyNote: 'Nothing external was rolled back.',
})

let eventSeq = 0
function nextSeq(): SessionSeq {
  eventSeq += 1
  return SessionSeq(eventSeq)
}

function turnStart(turn: number): SessionEvent {
  return { type: 'turn/start', seq: nextSeq(), time: 0, data: { turn } } as SessionEvent
}

function turnEnd(turn: number): SessionEvent {
  return { type: 'turn/end', seq: nextSeq(), time: 0, data: { turn, reason: { kind: 'completed' } } } as SessionEvent
}

function stepStart(turn: number, step: number): SessionEvent {
  return { type: 'step/start', seq: nextSeq(), time: 0, data: { turn, step } } as SessionEvent
}

function stepEnd(turn: number, step: number): SessionEvent {
  return { type: 'step/end', seq: nextSeq(), time: 0, data: { turn, step } } as SessionEvent
}

function toolCall(turn: number, callId: string, name: string, args: unknown, raw = JSON.stringify(args)): SessionEvent {
  return {
    type: 'tool/call',
    seq: nextSeq(),
    time: 0,
    data: { turn, step: 1, callId: ToolCallId(callId), name, arguments: raw },
  } as SessionEvent
}

function toolResult(
  turn: number,
  callId: string,
  options: { isError?: boolean; internalError?: boolean; meta?: unknown } = {},
): SessionEvent {
  const message = createToolResultMessage({
    callId: ToolCallId(callId),
    content: [{ type: 'text', text: options.isError === true ? 'Error: rejected' : 'ok' }],
    isError: options.isError === true,
  })
  // Durable `tool/result` events carry the presentation payload at the DATA
  // level, never inside the message blocks; a test that smuggled it into the
  // content would fold green against an implementation reading the same wrong
  // place.
  return {
    type: 'tool/result',
    seq: nextSeq(),
    time: 0,
    data: {
      turn,
      step: 1,
      message,
      ...(options.internalError === true ? { error: { name: 'ToolError', code: 'BOOM' } } : {}),
      ...(options.meta === undefined ? {} : { meta: options.meta }),
    },
  } as SessionEvent
}

function userMessageEvent(message: UserMessage): SessionEvent {
  return { type: 'user/message', seq: nextSeq(), time: 0, data: message } as SessionEvent
}

function inboxSpliced(inserted: readonly UserMessage[]): SessionEvent {
  return { type: 'agent/inbox/spliced', seq: nextSeq(), time: 0, data: { target: 'next-turn', start: 0, inserted } } as SessionEvent
}

function assistantMessage(turn: number, options: { interrupted?: boolean } = {}): SessionEvent {
  return {
    type: 'assistant/message',
    seq: nextSeq(),
    time: 0,
    surfaceOp: 'append',
    data: {
      turn,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'answered' }], source: { provider: 'test', model: 'test' } }),
      stream: [],
      ...(options.interrupted === true ? { interrupted: true } : {}),
    },
  } as SessionEvent
}

/** One external input, the carrier a swap must preserve. */
function external(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One host-owned ephemeral notice the successor generation rederives. */
function notice(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: producerNoticeSource(PLUGIN_ID, text) })
}

/** Thread refs quoted in a text body, the domain vocabulary this spec's host reads. */
function threadsIn(text: string): readonly string[] {
  const refs: string[] = []
  for (const match of text.matchAll(/Thread: (thread:[0-9a-z-]+)/g)) {
    if (!refs.includes(match[1]!)) refs.push(match[1]!)
  }
  return refs
}

/** The domain topics one event introduces: Thread refs quoted in a body or named by a result's meta. */
function topicsOf(input: DomainBoundaryInput): readonly string[] {
  if (input.source === 'user-message') {
    const text = input.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    return threadsIn(text)
  }
  const meta: unknown = input.meta
  const threadRef = typeof meta === 'object' && meta !== null ? (meta as { threadRef?: unknown }).threadRef : undefined
  return typeof threadRef === 'string' && threadRef !== '' ? [threadRef] : []
}

/**
 * This spec's domain judgement, shared by every harness that contributes
 * boundaries: a Thread is a topic, only a first arrival anchors, and the label
 * states what arrived rather than what the delivery said about itself.
 */
function firstArrivalBoundary(input: DomainBoundaryInput): DomainBoundaryContribution | undefined {
  const fresh = topicsOf(input).filter(topic => !input.seenTopics.includes(topic))
  return fresh.length === 0 ? undefined : { kind: 'team_message', label: `First arrival: ${fresh.join(', ')}`, topics: fresh }
}

interface HarnessOptions {
  readonly tracksCall?: (name: string, raw: string) => boolean
  readonly domainBoundaryOf?: (input: DomainBoundaryInput) => DomainBoundaryContribution | undefined
  readonly ephemeral?: (message: UserMessage) => boolean
  readonly rolloverToolNames?: readonly string[]
  readonly checkpointToolName?: string
  /** The Session this harness folds by default; a test may fold another one through the same definition. */
  readonly sessionId?: string
  readonly inheritedEventCount?: number
}

/** The header the framework hands `init` for one Session. */
function headerOf(sessionId: string): SessionHeader {
  return { id: sessionId } as SessionHeader
}

/**
 * One projection host whose durable refs are inspectable and whose domain
 * judgement is recorded, so a test can assert what the fold asked and what it
 * stored. Its ref shapes are deliberately its own: the engine names nothing.
 */
function projectionHarness(options: HarnessOptions = {}) {
  const asked: DomainBoundaryInput[] = []
  const host: ContextProjectionHost = {
    checkpointRefFor: (sessionId, toolCallId) => `context-checkpoint:${sessionId}:${toolCallId}`,
    boundaryRefFor: (sessionId, seq) => `team-boundary:${sessionId}:${seq}`,
    isEphemeralNotice: options.ephemeral ?? (message => message.source.kind === PLUGIN_ID),
    ...(options.tracksCall === undefined ? {} : { tracksCall: options.tracksCall }),
    ...(options.domainBoundaryOf === undefined
      ? {}
      : {
          domainBoundaryOf: (input: DomainBoundaryInput): DomainBoundaryContribution | undefined => {
            asked.push(input)
            return options.domainBoundaryOf!(input)
          },
        }),
  }
  const config: ContextProjectionConfig = {
    codec,
    host,
    ...(options.rolloverToolNames === undefined ? {} : { rolloverToolNames: options.rolloverToolNames }),
    ...(options.checkpointToolName === undefined ? {} : { checkpointToolName: options.checkpointToolName }),
  }
  const definition = createContextProjectionDefinition(config)
  const target: ContextFoldTarget = {
    sessionId: options.sessionId ?? SESSION,
    inheritedEventCount: options.inheritedEventCount ?? 0,
  }
  /** Fold one log the way the framework drives the registered unit for one Session. */
  const foldFor = (session: ContextFoldTarget, events: readonly SessionEvent[]): ContextProjectionState => {
    let state = definition.init(headerOf(session.sessionId), SessionLogOffset(session.inheritedEventCount ?? 0))
    for (const event of events) state = definition.apply(state, event)
    return state
  }
  const fold = (events: readonly SessionEvent[]): ContextProjectionState => foldFor(target, events)
  return {
    host,
    config,
    target,
    definition,
    asked,
    fold,
    foldFor,
    apply: (state: ContextProjectionState, event: SessionEvent): ContextProjectionState => definition.apply(state, event),
  }
}

/** A log carrying one successful rollover call, so a pending intent is armed. */
function rolloverPair(turn: number, callId: string, args: unknown): SessionEvent[] {
  return [toolCall(turn, callId, CONTEXT_ROLLOVER_TOOL_NAME, args), toolResult(turn, callId)]
}

/** A log carrying one successful checkpoint call. */
function checkpointPair(turn: number, callId: string, name: string): SessionEvent[] {
  return [toolCall(turn, callId, CONTEXT_CHECKPOINT_TOOL_NAME, { name }), toolResult(turn, callId)]
}

/** The Session identity plus one armed intent; the state splices fold onto. */
function armedHarness(options: HarnessOptions = {}) {
  const harness = projectionHarness(options)
  const state = harness.fold([turnStart(1), ...rolloverPair(1, 'call-r', { handoff: 'carry the queued input' })])
  return { ...harness, state }
}

describe('projection definition', () => {
  it('registers one host-only unit under its own key and version', () => {
    const { definition } = projectionHarness()
    expect(definition.key).toBe(CONTEXT_CONTINUITY_PROJECTION_KEY)
    expect(definition.key).toBe('contextContinuity')
    // v2: the state carries the Session identity it folds and the inherited
    // cut, so one registration can serve every Session.
    expect(definition.stateVersion).toBe(2)
    // Host-only: the state is read through the registry, never published as a
    // client view.
    expect('wire' in definition).toBe(false)
  })

  it('starts from the empty state of the Session being folded', () => {
    const { definition, fold, target } = projectionHarness()
    const initial = definition.init(headerOf(SESSION), SessionLogOffset(0))
    expect(initial).toEqual(emptyContextProjectionState(target))
    expect(initial.sessionId).toBe(SESSION)
    expect(initial.inheritedEventCount).toBe(0)

    const seeded = definition.init(headerOf(OTHER_SESSION), SessionLogOffset(7))
    expect(seeded.sessionId).toBe(OTHER_SESSION)
    expect(seeded.inheritedEventCount).toBe(7)

    const folded = fold([
      turnStart(1),
      ...checkpointPair(1, 'call-cp', 'anchor'),
      ...rolloverPair(1, 'call-r', { handoff: 'next' }),
      turnEnd(1),
    ])
    expect(contextProjectionStateSchema.safeParse(folded).success).toBe(true)
    expect(contextProjectionStateSchema.safeParse(emptyContextProjectionState(target)).success).toBe(true)
  })

  it('refuses a cached row written by another shape instead of folding it onward', () => {
    const { target } = projectionHarness()
    // `stateSchema` is what the framework runs before it seeds a fold from a
    // persisted row: a row from an older vocabulary (here the Team's
    // pre-extraction `seenThreads`) must be discarded, not forward-applied.
    const legacy: Record<string, unknown> = { ...emptyContextProjectionState(target), seenThreads: [] }
    expect(contextProjectionStateSchema.safeParse(legacy).success).toBe(false)

    const missing: Record<string, unknown> = { ...emptyContextProjectionState(target) }
    delete missing['seenTopics']
    expect(contextProjectionStateSchema.safeParse(missing).success).toBe(false)

    // A v1 row predates the Session identity and the inherited cut; it must be
    // discarded (the `stateVersion` bump is the deliberate form of the same
    // decision) rather than folded into a state that names nothing.
    const versionOne: Record<string, unknown> = { ...emptyContextProjectionState(target) }
    delete versionOne['sessionId']
    delete versionOne['inheritedEventCount']
    expect(contextProjectionStateSchema.safeParse(versionOne).success).toBe(false)

    const negativeCut: Record<string, unknown> = { ...emptyContextProjectionState(target), inheritedEventCount: -1 }
    expect(contextProjectionStateSchema.safeParse(negativeCut).success).toBe(false)
  })
})

describe('an event the unit does not fold', () => {
  it('returns the same state reference, so the framework does no downstream work', () => {
    const { definition, apply, fold } = projectionHarness()
    const closed = turnEnd(1)
    const state = fold([turnStart(1), ...checkpointPair(1, 'call-cp', 'anchor'), closed])
    expect(state.checkpoints).toHaveLength(1)

    const ignored: readonly SessionEvent[] = [
      stepStart(1, 1),
      stepEnd(1, 1),
      toolCall(1, 'call-read', 'read_file', { path: 'src/index.ts' }),
      toolResult(1, 'call-ghost'),
      turnStart(1),
      closed,
      userMessageEvent(external('ordinary queued input')),
      inboxSpliced([external('queued while nothing is pending')]),
      assistantMessage(1),
    ]
    for (const event of ignored) {
      expect(Object.is(apply(state, event), state), `${event.type}@${String(event.seq)} allocated`).toBe(true)
    }
  })

  it('allocates only when a fact actually changed', () => {
    const { definition, fold } = projectionHarness()
    const state = fold([turnStart(1)])
    const next = definition.apply(state, turnStart(2))
    expect(Object.is(next, state)).toBe(false)
    expect(next.lastTurn).toBe(2)
  })
})

describe('open tool calls', () => {
  it('tracks the engine\'s own tools and the host\'s effect calls, and nothing else', () => {
    const { fold } = projectionHarness({ tracksCall: name => name === 'team_message' })
    const state = fold([
      turnStart(1),
      toolCall(1, 'call-engine', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'next' }),
      toolCall(1, 'call-host', 'team_message', { action: 'start' }),
      toolCall(1, 'call-other', 'read_file', { path: 'a' }),
    ])
    expect(state.openCalls.map(call => [call.callId, call.name])).toEqual([
      ['call-engine', CONTEXT_ROLLOVER_TOOL_NAME],
      ['call-host', 'team_message'],
    ])
  })

  it('an unpaired result touches nothing', () => {
    const { apply, fold } = projectionHarness()
    const state = fold([turnStart(1), toolCall(1, 'call-open', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'x' })])

    const unknown = toolResult(1, 'call-unknown')
    expect(Object.is(apply(state, unknown), state)).toBe(true)

    const paired = toolResult(1, 'call-open')
    const afterPair = apply(state, paired)
    expect(afterPair.pending).not.toBeNull()
    expect(afterPair.openCalls).toEqual([])

    // The pair is consumed once: a second result for the same call id has no
    // open call left to pair with.
    const again = toolResult(1, 'call-open')
    expect(Object.is(apply(afterPair, again), afterPair)).toBe(true)
  })

  it('a failed result consumes its call and records nothing', () => {
    const { fold } = projectionHarness()
    const modelVisible = fold([
      turnStart(1),
      toolCall(1, 'call-rejected', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'x' }),
      toolResult(1, 'call-rejected', { isError: true }),
    ])
    expect(modelVisible.pending).toBeNull()
    expect(modelVisible.openCalls).toEqual([])

    const internalFailure = fold([
      turnStart(1),
      toolCall(1, 'call-broken', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'x' }),
      toolResult(1, 'call-broken', { internalError: true }),
    ])
    expect(internalFailure.pending).toBeNull()
    expect(internalFailure.openCalls).toEqual([])
  })

  it('pairs a provider retry reusing a call id with the retry\'s own arguments', () => {
    const { fold } = projectionHarness()
    const state = fold([
      turnStart(1),
      toolCall(1, 'call-reused', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'invalid attempt', checkpointRef: `context-checkpoint-${'a'.repeat(64)}` }),
      toolResult(1, 'call-reused', { isError: true }),
      turnEnd(1),
      turnStart(2),
      toolCall(2, 'call-reused', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'fresh retry' }),
      toolResult(2, 'call-reused'),
      turnEnd(2),
    ])
    expect(state.pending).toMatchObject({ toolCallId: 'call-reused', handoff: 'fresh retry', turn: 2 })
    expect(state.pending?.checkpointRef).toBeUndefined()
    expect(state.openCalls).toEqual([])
  })
})

describe('rollover intent', () => {
  it('a successful pair records the intent, and its own turn end releases it', () => {
    const { fold } = projectionHarness()
    const result = toolResult(1, 'call-r')
    const closed = turnEnd(1)
    const log = [
      turnStart(1),
      toolCall(1, 'call-r', CONTEXT_ROLLOVER_TOOL_NAME, {
        handoff: 'continue the migration from step 3',
        relatedFiles: [{ path: 'src/index.ts', reason: 'entry point' }],
      }),
      result,
    ]
    expect(fold(log).pending).toEqual({
      handoff: 'continue the migration from step 3',
      relatedFiles: [{ path: 'src/index.ts', reason: 'entry point' }],
      toolCallId: 'call-r',
      resultSeq: result.seq,
      turn: 1,
      turnEndSeq: -1,
    })
    expect(fold([...log, closed]).pending?.turnEndSeq).toBe(closed.seq)
  })

  it('defaults the related files to none', () => {
    const { fold } = projectionHarness()
    const state = fold([turnStart(1), ...rolloverPair(1, 'call-r', { handoff: 'no files named' })])
    expect(state.pending?.relatedFiles).toEqual([])
  })

  it('never invents an intent it cannot read back', () => {
    const unreadable = [
      '{"handoff":', // unparsable arguments
      '{}', // no handoff at all
      JSON.stringify({ handoff: '   ' }), // blank handoff — the tool's own shape rejects it
      JSON.stringify({ handoff: 'x', relatedFiles: 'src/index.ts' }), // wrong-typed files
      JSON.stringify({ handoff: 'x', relatedFiles: [{ path: 'a.ts' }] }), // incomplete file entry
    ]
    for (const raw of unreadable) {
      const { fold } = projectionHarness()
      const state = fold([
        turnStart(1),
        toolCall(1, 'call-bad', CONTEXT_ROLLOVER_TOOL_NAME, undefined, raw),
        toolResult(1, 'call-bad'),
      ])
      expect(state.pending, raw).toBeNull()
      // The landed result consumed its call either way: nothing dangles.
      expect(state.openCalls, raw).toEqual([])
    }
  })

  it('holds one intent per unresolved turn and lets a later turn replace a spent one', () => {
    const { fold } = projectionHarness()
    const sameTurn = fold([
      turnStart(1),
      ...rolloverPair(1, 'call-first', { handoff: 'first' }),
      ...rolloverPair(1, 'call-second', { handoff: 'second' }),
      turnEnd(1),
    ])
    expect(sameTurn.pending).toMatchObject({ toolCallId: 'call-first', handoff: 'first' })

    // A pending whose turn already ended is ready, not spent forever: once the
    // coordinator's process lock is gone, an explicit retry must be able to
    // take the slot, or the subject can never roll over again.
    const laterTurn = fold([
      turnStart(1),
      ...rolloverPair(1, 'call-spent', { handoff: 'swap that never came' }),
      turnEnd(1),
      turnStart(2),
      ...rolloverPair(2, 'call-retry', { handoff: 'explicit retry' }),
      turnEnd(2),
    ])
    expect(laterTurn.pending).toMatchObject({ toolCallId: 'call-retry', handoff: 'explicit retry', turn: 2 })
  })

  it('folds the tool names its host declares, so a legacy alias still recovers', () => {
    const { fold } = projectionHarness({
      rolloverToolNames: [CONTEXT_ROLLOVER_TOOL_NAME, 'new_context'],
      checkpointToolName: 'context_checkpoint_legacy',
    })
    const legacy = fold([turnStart(1), toolCall(1, 'call-legacy', 'new_context', { handoff: 'legacy intent' }), toolResult(1, 'call-legacy')])
    expect(legacy.pending).toMatchObject({ handoff: 'legacy intent' })

    const checkpoint = fold([
      turnStart(1),
      toolCall(1, 'call-cp', 'context_checkpoint_legacy', { name: 'anchor' }),
      toolResult(1, 'call-cp'),
    ])
    expect(checkpoint.checkpoints.map(entry => entry.name)).toEqual(['anchor'])

    // A name the host did not declare is an ordinary call: it is not even
    // tracked, so its result pairs with nothing.
    const undeclared = fold([turnStart(1), ...checkpointPair(1, 'call-cp', 'anchor')])
    expect(undeclared.checkpoints).toEqual([])
    expect(undeclared.openCalls).toEqual([])
  })
})

describe('checkpoints', () => {
  it('records the checkpoint under the ref its host derived', () => {
    const { fold } = projectionHarness()
    const result = toolResult(3, 'call-cp')
    const closed = turnEnd(3)
    const log = [turnStart(3), toolCall(3, 'call-cp', CONTEXT_CHECKPOINT_TOOL_NAME, { name: 'after design' }), result]
    expect(fold(log).checkpoints).toEqual([
      {
        checkpointRef: `context-checkpoint:${SESSION}:call-cp`,
        name: 'after design',
        resultSeq: result.seq,
        turn: 3,
        turnEndSeq: -1,
      },
    ])
    expect(fold([...log, closed]).checkpoints[0]?.turnEndSeq).toBe(closed.seq)
  })

  it('records nothing for a checkpoint call without a usable name', () => {
    for (const raw of ['{"name":', '{}', JSON.stringify({ name: '' }), JSON.stringify({ name: '   ' })]) {
      const { fold } = projectionHarness()
      const state = fold([
        turnStart(1),
        toolCall(1, 'call-cp', CONTEXT_CHECKPOINT_TOOL_NAME, undefined, raw),
        toolResult(1, 'call-cp'),
        turnEnd(1),
      ])
      expect(state.checkpoints, raw).toEqual([])
      expect(state.openCalls, raw).toEqual([])
    }
  })
})

describe('one definition, many Sessions', () => {
  /**
   * One log renumbered so `seq` is the event's position in it — what a real
   * Session log guarantees, and the unit a fork-inherited prefix is counted in.
   * The specs above fold synthetic logs whose seqs come from a shared counter,
   * which is fine while the cut is zero and wrong the moment it is not.
   */
  function localSeqs(events: readonly SessionEvent[]): SessionEvent[] {
    return events.map((event, index) => ({ ...event, seq: SessionSeq(index) }) as SessionEvent)
  }

  it('derives every ref from the state\'s own Session, so a repeated call id never collides', () => {
    const { foldFor } = projectionHarness()
    const log = (): SessionEvent[] => localSeqs([turnStart(1), ...checkpointPair(1, 'call-shared', 'anchor')])
    const first = foldFor({ sessionId: SESSION }, log())
    const second = foldFor({ sessionId: OTHER_SESSION }, log())
    expect(first.sessionId).toBe(SESSION)
    expect(second.sessionId).toBe(OTHER_SESSION)
    expect(first.checkpoints[0]?.checkpointRef).toBe(`context-checkpoint:${SESSION}:call-shared`)
    expect(second.checkpoints[0]?.checkpointRef).toBe(`context-checkpoint:${OTHER_SESSION}:call-shared`)
  })

  it('skips the fork-inherited prefix, so an ancestor\'s facts are never re-keyed as this generation\'s', () => {
    const { foldFor } = projectionHarness({
      tracksCall: name => name === 'team_message',
      domainBoundaryOf: firstArrivalBoundary,
    })
    const ancestorRef = `context-checkpoint:${SESSION}:call-cp`
    const prefix: SessionEvent[] = [
      turnStart(1),
      ...checkpointPair(1, 'call-cp', 'ancestor anchor'),
      userMessageEvent(codec.createCheckpointContinuationMessage(ancestorRef)),
      ...rolloverPair(1, 'call-r', { handoff: 'the handoff that opened this generation' }),
      userMessageEvent(notice('Thread: thread:1111-aaaa handover')),
      inboxSpliced([external('queued behind the ancestor\'s intent')]),
      turnEnd(1),
    ]
    const own: SessionEvent[] = [
      turnStart(2),
      ...checkpointPair(2, 'call-own', 'this generation\'s anchor'),
      turnEnd(2),
    ]
    const log = localSeqs([...prefix, ...own])
    const state = foldFor({ sessionId: OTHER_SESSION, inheritedEventCount: prefix.length }, log)

    // Everything the ancestor's prefix would have contributed under the
    // child's identity is absent: no re-keyed checkpoint, no inherited
    // rollover intent, no inherited continuation delivery, no carried input,
    // no ancestor boundary or topic.
    expect(state.checkpoints.map(entry => entry.checkpointRef)).toEqual([`context-checkpoint:${OTHER_SESSION}:call-own`])
    expect(state.pending).toBeNull()
    expect(state.continuations).toEqual([])
    expect(state.carriedCandidates).toEqual([])
    expect(state.boundaries).toEqual([])
    expect(state.seenTopics).toEqual([])
    // Its own span does fold, and the cut it was seeded with is remembered.
    expect(state.lastTurn).toBe(2)
    expect(state.lastTurnEndSeq).toBe(log.at(-1)!.seq)
    expect(state.inheritedEventCount).toBe(prefix.length)

    // The same events folded as the generation they belong to do carry those
    // facts: the prefix is real, it is simply not this Session's.
    const asAncestor = foldFor({ sessionId: SESSION }, localSeqs(prefix))
    expect(asAncestor.pending).not.toBeNull()
    expect(asAncestor.checkpoints).toHaveLength(1)
    expect(asAncestor.continuations).toHaveLength(1)
    expect(asAncestor.carriedCandidates).toHaveLength(1)
    expect(asAncestor.seenTopics).toEqual(['thread:1111-aaaa'])
  })

  it('treats the inherited cut as a floor and returns the same reference below it', () => {
    const { apply, foldFor } = projectionHarness()
    const prefix: SessionEvent[] = [
      turnStart(1),
      ...rolloverPair(1, 'call-r', { handoff: 'the ancestor\'s intent' }),
      turnEnd(1),
    ]
    const log = localSeqs([...prefix, turnStart(2)])
    const state = foldFor({ sessionId: OTHER_SESSION, inheritedEventCount: prefix.length }, log.slice(0, prefix.length))
    expect(state).toEqual(emptyContextProjectionState({ sessionId: OTHER_SESSION, inheritedEventCount: prefix.length }))

    for (const event of log.slice(0, prefix.length)) {
      expect(Object.is(apply(state, event), state), `${event.type}@${String(event.seq)} allocated`).toBe(true)
    }
    // The cut is exclusive: the first event this Session owns folds normally.
    const firstOwn = log.at(-1)!
    const next = apply(state, firstOwn)
    expect(Object.is(next, state)).toBe(false)
    expect(next.lastTurn).toBe(2)
  })
})

describe('continuation delivery', () => {
  it('records one delivery per checkpoint ref and never rewrites it', () => {
    const { apply, fold } = projectionHarness()
    const checkpointRef = `context-checkpoint:${SESSION}:call-cp`
    const delivered = userMessageEvent(codec.createCheckpointContinuationMessage(checkpointRef))
    const state = fold([turnStart(1), delivered])
    expect(state.continuations).toEqual([{ checkpointRef, deliveredSeq: delivered.seq }])
    expect(continuationDelivered(state, checkpointRef)).toBe(true)

    // A replayed delivery of the same continuation must not move the seq the
    // log already proved.
    const replay = userMessageEvent(codec.createCheckpointContinuationMessage(checkpointRef))
    expect(Object.is(apply(state, replay), state)).toBe(true)
  })

  it('completes a host-seeded scheduled continuation instead of adding a second', () => {
    const { definition, target } = projectionHarness()
    const checkpointRef = `context-checkpoint:${SESSION}:call-scheduled`
    const scheduled: ContextProjectionState = {
      ...emptyContextProjectionState(target),
      continuations: [{ checkpointRef, deliveredSeq: -1 }],
    }
    expect(continuationDelivered(scheduled, checkpointRef)).toBe(false)

    const delivered = definition.apply(
      scheduled,
      userMessageEvent(codec.createCheckpointContinuationMessage(checkpointRef)),
    )
    expect(delivered.continuations).toHaveLength(1)
    expect(continuationDelivered(delivered, checkpointRef)).toBe(true)
  })

  it('ignores a continuation-shaped message another plugin wrote', () => {
    const other = new ContextMessageCodec({
      pluginId: '@other/dsh-continuity',
      handoffIntro: 'Another subject continues.',
      handoffVerifyNote: 'Nothing was rolled back.',
    })
    const { apply, fold } = projectionHarness()
    const state = fold([turnStart(1)])
    const foreign = userMessageEvent(other.createCheckpointContinuationMessage('context-checkpoint:foreign'))
    expect(Object.is(apply(state, foreign), state)).toBe(true)
  })
})

describe('carry candidates', () => {
  it('records queued input only once an intent exists', () => {
    const { apply, fold } = projectionHarness()
    const beforeIntent = fold([turnStart(1)])
    const early = external('arrived before the intent')
    expect(Object.is(apply(beforeIntent, inboxSpliced([early])), beforeIntent)).toBe(true)

    const armed = armedHarness()
    const queued = external('arrived after the intent')
    const next = armed.apply(armed.state, inboxSpliced([queued]))
    expect(next.carriedCandidates).toEqual([{ messageId: queued.id, surfacedTurn: -1, consumed: false }])
  })

  it('keeps real input and the engine\'s own envelopes, dropping host notices', () => {
    const armed = armedHarness()
    const keep = external('please also fix the docs')
    const handoff = codec.createHandoffMessage({
      handoff: 'an earlier handoff',
      previousSessionId: 'session-0',
      newSessionId: SESSION,
      trigger: 'model',
      handoffEventSeq: 3,
    })
    const continuation = codec.createCheckpointContinuationMessage(`context-checkpoint:${SESSION}:call-cp`)
    const drop = notice('Team Workspace participation changed')

    const next = armed.apply(armed.state, inboxSpliced([keep, handoff, continuation, drop]))
    expect(next.carriedCandidates.map(candidate => candidate.messageId)).toEqual([keep.id, handoff.id, continuation.id])
  })

  it('dedupes by message id, within one splice and across splices', () => {
    const armed = armedHarness()
    const queued = external('queued once')
    const once = armed.apply(armed.state, inboxSpliced([queued, queued]))
    expect(once.carriedCandidates).toHaveLength(1)

    const twice = armed.apply(once, inboxSpliced([queued, external('queued later')]))
    expect(twice.carriedCandidates).toHaveLength(2)
  })

  it('surfaces a candidate into the turn that claimed it, and only its answer consumes it', () => {
    const armed = armedHarness()
    const queued = external('arrived mid-step')
    const withCandidate = armed.apply(armed.state, inboxSpliced([queued]))
    const surfaced = armed.apply(withCandidate, userMessageEvent(queued))
    expect(surfaced.carriedCandidates).toEqual([{ messageId: queued.id, surfacedTurn: 1, consumed: false }])

    // A cancelled turn proves nothing, and another turn's answer does not
    // answer for this one: the input stays carried either way.
    const interrupted = armed.apply(surfaced, assistantMessage(1, { interrupted: true }))
    expect(Object.is(interrupted, surfaced)).toBe(true)
    const otherTurn = armed.apply(surfaced, assistantMessage(2))
    expect(Object.is(otherTurn, surfaced)).toBe(true)

    const answered = armed.apply(surfaced, assistantMessage(1))
    expect(answered.carriedCandidates).toEqual([{ messageId: queued.id, surfacedTurn: 1, consumed: true }])
  })

  it('never consumes a candidate that was never surfaced', () => {
    const armed = armedHarness()
    const queued = external('still queued')
    const pendingOnly = armed.apply(armed.state, inboxSpliced([queued]))
    const answered = armed.apply(pendingOnly, assistantMessage(1))
    expect(Object.is(answered, pendingOnly)).toBe(true)
    expect(answered.carriedCandidates[0]?.consumed).toBe(false)
  })
})

describe('host-contributed boundaries', () => {
  function domainHarness(): ReturnType<typeof projectionHarness> {
    return projectionHarness({ tracksCall: name => name === 'team_message', domainBoundaryOf: firstArrivalBoundary })
  }

  it('records a contribution, resolves it at the containing turn end, and remembers its topics', () => {
    const { fold } = domainHarness()
    const arrival = userMessageEvent(notice('Thread: thread:1111-aaaa handover'))
    const closed = turnEnd(1)
    const state = fold([turnStart(1), arrival, closed])
    expect(state.boundaries).toEqual([
      {
        kind: 'team_message',
        label: 'First arrival: thread:1111-aaaa',
        resultSeq: arrival.seq,
        turn: 1,
        turnEndSeq: closed.seq,
        attributions: ['thread:1111-aaaa'],
      },
    ])
    expect(state.seenTopics).toEqual(['thread:1111-aaaa'])
  })

  it('tells the host what it already saw, so a re-delivery anchors nothing', () => {
    const { fold, asked } = domainHarness()
    const state = fold([
      turnStart(1),
      userMessageEvent(notice('Thread: thread:1111-aaaa first')),
      turnEnd(1),
      turnStart(2),
      userMessageEvent(notice('Thread: thread:1111-aaaa again')),
      turnEnd(2),
      turnStart(3),
      userMessageEvent(notice('Thread: thread:2222-bbbb and Thread: thread:1111-aaaa')),
      turnEnd(3),
    ])
    expect(state.boundaries.map(boundary => boundary.label)).toEqual([
      'First arrival: thread:1111-aaaa',
      'First arrival: thread:2222-bbbb',
    ])
    expect(asked.at(-1)?.seenTopics).toEqual(['thread:1111-aaaa'])
    expect(state.seenTopics).toEqual(['thread:1111-aaaa', 'thread:2222-bbbb'])
  })

  it('contributes from a successful effect call with its recorded arguments and meta', () => {
    const { fold, asked } = domainHarness()
    const result = toolResult(1, 'call-msg', { meta: { kind: 'committed', threadRef: 'thread:2222-bbbb' } })
    const state = fold([
      turnStart(1),
      toolCall(1, 'call-msg', 'team_message', { action: 'start', channelRef: 'channel:c', body: 'hi' }),
      result,
      turnEnd(1),
    ])
    expect(state.boundaries).toEqual([
      {
        kind: 'team_message',
        label: 'First arrival: thread:2222-bbbb',
        resultSeq: result.seq,
        turn: 1,
        turnEndSeq: expect.any(Number),
        attributions: ['thread:2222-bbbb'],
      },
    ])
    expect(asked.at(-1)).toMatchObject({
      sessionId: SESSION,
      source: 'tool-result',
      seq: result.seq,
      turn: 1,
      name: 'team_message',
      arguments: JSON.stringify({ action: 'start', channelRef: 'channel:c', body: 'hi' }),
      meta: { kind: 'committed', threadRef: 'thread:2222-bbbb' },
    })
  })

  it('records no boundary for a failed effect call, and still consumes its open call', () => {
    const { fold } = domainHarness()
    const state = fold([
      turnStart(1),
      toolCall(1, 'call-msg', 'team_message', { action: 'start', channelRef: 'channel:c', body: 'boom' }),
      toolResult(1, 'call-msg', { isError: true, meta: { kind: 'committed', threadRef: 'thread:2222-bbbb' } }),
      turnEnd(1),
    ])
    expect(state.boundaries).toEqual([])
    expect(state.openCalls).toEqual([])
    expect(state.seenTopics).toEqual([])
  })

  it('folds a Session whose host contributes nothing without inventing anchors', () => {
    const { fold, asked } = projectionHarness()
    const state = fold([
      turnStart(1),
      userMessageEvent(notice('Thread: thread:1111-aaaa ignored')),
      toolResult(1, 'call-ghost'),
      turnEnd(1),
    ])
    expect(asked).toEqual([])
    expect(state.boundaries).toEqual([])
    expect(state.seenTopics).toEqual([])
  })
})

describe('cold fold and live fold', () => {
  /** One log exercising every transition this unit owns. */
  function fullLog(): SessionEvent[] {
    const continuation = codec.createCheckpointContinuationMessage(`context-checkpoint:${SESSION}:call-cp`)
    const queued = external('queued behind the intent')
    const arrival = notice('Thread: thread:1111-aaaa handover')
    return [
      turnStart(1),
      ...checkpointPair(1, 'call-cp', 'anchor'),
      userMessageEvent(arrival),
      userMessageEvent(continuation),
      turnEnd(1),
      turnStart(2),
      ...rolloverPair(2, 'call-r', { handoff: 'continue', relatedFiles: [{ path: 'src/index.ts', reason: 'in progress' }] }),
      inboxSpliced([queued, notice('Team Workspace participation changed')]),
      userMessageEvent(queued),
      assistantMessage(2, { interrupted: true }),
      toolCall(2, 'call-msg', 'team_message', { action: 'start', channelRef: 'channel:c', body: 'hi' }),
      toolResult(2, 'call-msg', { meta: { kind: 'committed', threadRef: 'thread:2222-bbbb' } }),
      turnEnd(2),
      turnStart(3),
      ...checkpointPair(3, 'call-cp-2', 'second anchor'),
      turnEnd(3),
    ]
  }

  it('fold the same log to exactly one state', () => {
    const log = fullLog()
    const harness = projectionHarness({ tracksCall: name => name === 'team_message', domainBoundaryOf: firstArrivalBoundary })
    const live = harness.fold(log)
    const cold = foldContextProjection(log, harness.config, harness.target)
    expect(live).toEqual(cold)
    // The log really did exercise every family: an equal-but-empty fold would
    // pass the assertion above for the wrong reason.
    expect(live.checkpoints).toHaveLength(2)
    expect(live.continuations).toHaveLength(1)
    expect(live.pending).not.toBeNull()
    expect(live.carriedCandidates).toHaveLength(1)
    expect(live.boundaries).toHaveLength(2)
    expect(live.openCalls).toEqual([])
    expect(live.lastTurnEndSeq).toBe(log.at(-1)!.seq)
  })

  it('a checkpoint delivered continuation keeps its scheduled-then-delivered shape across a refold', () => {
    const log = fullLog()
    const { config, target } = projectionHarness()
    const cold = foldContextProjection(log, config, target)
    expect(cold.continuations).toEqual([{ checkpointRef: `context-checkpoint:${SESSION}:call-cp`, deliveredSeq: expect.any(Number) }])
  })
})
