/**
 * The continuity timeline: one subject's lineage walked as a bounded, priced
 * list of return anchors.
 *
 * The spec pins what the engine owns and what it refuses to own. It owns the
 * walk (current generation, then archived ancestors through the read seam), the
 * dedupe, the per-source pricing, and the shared restorable-anchor rule. It
 * owns no measurement and no domain vocabulary: an unmeasurable source fails
 * closed instead of pricing as free, a boundary is judged by the host's own
 * `attributions`, and an unreadable ancestor truncates the walk loudly.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ToolCallId,
  createToolResultMessage,
  createUserMessage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { ContextMessageCodec, producerNoticeSource } from '../src/message-codec.ts'
import {
  CONTEXT_CHECKPOINT_TOOL_NAME,
  CONTEXT_ROLLOVER_TOOL_NAME,
  type ContextProjectionConfig,
  type ContextProjectionHost,
  type DomainBoundaryContribution,
  type DomainBoundaryInput,
} from '../src/projection.ts'
import {
  readContextTimeline,
  type ContextTimeline,
  type ContextTimelineItem,
  type ContextTimelineRequest,
  type ContextTimelineSource,
} from '../src/timeline.ts'
import type { StoredSessionInspection, StoredSessionReadResult } from '../src/stored-session-reader.ts'
import { PLUGIN_ID } from './test-producer.ts'

const CURRENT = SessionId('session-current')
const PARENT = SessionId('session-parent')
const GRANDPARENT = SessionId('session-grandparent')

const codec = new ContextMessageCodec({
  pluginId: PLUGIN_ID,
  handoffIntro: 'A context handoff opens this generation.',
  handoffVerifyNote: 'Nothing external was rolled back.',
})

/**
 * Event builders omit `seq`; `log(...)` stamps each event with its position,
 * which is the Session's own `seq = log.length` contract and therefore the unit
 * a fork-inherited prefix is counted in.
 */
function turnStart(turn: number): SessionEvent {
  return { type: 'turn/start', time: 0, data: { turn } } as unknown as SessionEvent
}

function turnEnd(turn: number): SessionEvent {
  return { type: 'turn/end', time: 0, data: { turn, reason: { kind: 'completed' } } } as unknown as SessionEvent
}

function toolCall(turn: number, callId: string, name: string, args: unknown): SessionEvent {
  return {
    type: 'tool/call',
    time: 0,
    data: { turn, step: 1, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) },
  } as unknown as SessionEvent
}

function toolResult(turn: number, callId: string): SessionEvent {
  return {
    type: 'tool/result',
    time: 0,
    data: {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId(callId),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    },
  } as unknown as SessionEvent
}

function notice(text: string): SessionEvent {
  return { type: 'user/message', time: 0, data: noticeMessage(text) } as unknown as SessionEvent
}

function noticeMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: producerNoticeSource(PLUGIN_ID, text) })
}

/** One log numbered by position. */
function log(...events: readonly SessionEvent[]): readonly SessionEvent[] {
  return events.map((event, index) => ({ ...event, seq: SessionSeq(index) }) as SessionEvent)
}

/** A checkpoint recorded and concluded in one turn. */
function checkpoint(turn: number, callId: string, name: string): readonly SessionEvent[] {
  return [
    toolCall(turn, callId, CONTEXT_CHECKPOINT_TOOL_NAME, { name }),
    toolResult(turn, callId),
    turnEnd(turn),
  ]
}

/** A successful rollover call, whose intent a seeded successor must never adopt. */
function rollover(turn: number, callId: string, handoff: string): readonly SessionEvent[] {
  return [
    toolCall(turn, callId, CONTEXT_ROLLOVER_TOOL_NAME, { handoff }),
    toolResult(turn, callId),
    turnEnd(turn),
  ]
}

function textOf(message: UserMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/**
 * This spec's domain judgement: a Thread is a topic, only a first arrival
 * anchors, and a handoff boundary carries no attribution at all — the host's
 * own vocabulary, delivered as a plain contribution.
 */
function boundaryOf(input: DomainBoundaryInput): DomainBoundaryContribution | undefined {
  if (input.source !== 'user-message') return undefined
  const text = textOf(input.message)
  if (text.includes('HANDOFF')) return { kind: 'handoff', label: 'context handoff', topics: [] }
  const threads = [...text.matchAll(/Thread: (thread:[0-9a-z-]+)/g)].map(match => match[1]!)
  const fresh = threads.filter(topic => !input.seenTopics.includes(topic))
  return fresh.length === 0 ? undefined : { kind: 'team_message', label: `First arrival: ${fresh.join(', ')}`, topics: fresh }
}

const config: ContextProjectionConfig = {
  codec,
  host: {
    checkpointRefFor: (sessionId, toolCallId) => `context-checkpoint:${sessionId}:${toolCallId}`,
    boundaryRefFor: (sessionId, seq) => `team-boundary:${sessionId}:${seq}`,
    isEphemeralNotice: () => false,
    domainBoundaryOf: boundaryOf,
  } satisfies ContextProjectionHost,
}

function sourceOf(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  options: { readonly parent?: SessionId; readonly inheritedEventCount?: number } = {},
): ContextTimelineSource {
  return {
    sessionId,
    header: {
      id: sessionId,
      ...(options.parent === undefined ? {} : { parentSession: options.parent }),
    } as SessionHeader,
    inheritedEventCount: SessionLogOffset(options.inheritedEventCount ?? 0),
    events,
  }
}

function inspectionOf(sessionId: SessionId, events: readonly SessionEvent[], parent?: SessionId): StoredSessionInspection {
  return {
    header: { id: sessionId, ...(parent === undefined ? {} : { parentSession: parent }) } as SessionHeader,
    inheritedEventCount: SessionLogOffset(0),
    events,
  }
}

/** The reader a current-generation-only timeline never needs to call. */
const noAncestors = async (sessionId: SessionId): Promise<StoredSessionReadResult> => {
  throw new Error(`unexpected ancestor read: ${sessionId}`)
}

/** One request over the current generation with spec defaults filled in. */
function requestOf(overrides: Partial<ContextTimelineRequest> & Pick<ContextTimelineRequest, 'current'>): ContextTimelineRequest {
  return {
    config,
    readAncestor: noAncestors,
    measureSource: () => 700,
    currentUsageTokens: 1000,
    handoffAt: 200_000,
    ...overrides,
  }
}

function itemOf(timeline: ContextTimeline, source: string): ContextTimelineItem | undefined {
  return timeline.items.find(item => item.source === source)
}

describe('the current generation', () => {
  /** One checkpoint (turn 1) and one Thread arrival boundary (turn 2), in a 7-event log. */
  const events = log(
    turnStart(1),
    ...checkpoint(1, 'call-cp', 'anchor'),
    turnStart(2),
    notice('Thread: thread:aaaa-1111 arrival'),
    turnEnd(2),
  )

  it('lists resolved anchors newest first, priced in the source\'s own measurement', async () => {
    const timeline = await readContextTimeline(requestOf({ current: sourceOf(CURRENT, events) }))

    // Per-source seqs: the boundary resolved at the last turn end (6), the
    // checkpoint at turn 1's (3); the head is the newest of all.
    expect(timeline.items.map(item => [item.source, item.ref])).toEqual([
      ['head', 'head:6'],
      ['boundary', `team-boundary:${CURRENT}:5`],
      ['checkpoint', `context-checkpoint:${CURRENT}:call-cp`],
    ])
    expect(timeline.items.map(item => item.label)).toEqual([
      'current head',
      'First arrival: thread:aaaa-1111',
      'anchor',
    ])
    // The source measures 700 tokens over 7 events: the boundary's anchor
    // covers 7/7 of it, the turn-1 checkpoint 4/7, and the head is the current
    // working set itself.
    expect(timeline.items.map(item => [item.retainedTokens, item.discardedTokens])).toEqual([
      [1000, 0],
      [700, 300],
      [400, 600],
    ])
    expect(timeline.items.map(item => item.restorable)).toEqual([false, true, true])
    expect(timeline.items[0]?.reason).toBe('the head is the current working set; returning to it discards nothing')
    expect(timeline.usageTokens).toBe(1000)
    expect(timeline.handoffAt).toBe(200_000)
    expect(timeline.incompleteFrom).toBeUndefined()
  })

  it('echoes the host\'s hard limit when it supplies one, and omits it when it does not', async () => {
    const bounded = await readContextTimeline(requestOf({ current: sourceOf(CURRENT, events), hardLimit: 500_000 }))
    expect(bounded.hardLimit).toBe(500_000)

    const unbounded = await readContextTimeline(requestOf({ current: sourceOf(CURRENT, events) }))
    expect(Object.hasOwn(unbounded, 'hardLimit')).toBe(false)
  })

  it('carries the topics that entered context by each anchor, and the host boundary kind verbatim', async () => {
    const timeline = await readContextTimeline(requestOf({ current: sourceOf(CURRENT, events) }))
    expect(timeline.items.map(item => item.affectedTopics)).toEqual([
      ['thread:aaaa-1111'],
      ['thread:aaaa-1111'],
      [],
    ])
    expect(itemOf(timeline, 'boundary')?.kind).toBe('team_message')
    expect(itemOf(timeline, 'checkpoint')?.kind).toBeUndefined()
    expect(timeline.items.every(item => item.sourceSessionId === undefined)).toBe(true)
  })

  it('never offers an anchor whose turn has not ended', async () => {
    const unresolved = log(turnStart(1), toolCall(1, 'call-open', CONTEXT_CHECKPOINT_TOOL_NAME, { name: 'unresolved' }), toolResult(1, 'call-open'))
    const timeline = await readContextTimeline(requestOf({ current: sourceOf(CURRENT, unresolved) }))
    // No resolved anchor and no completed turn: nothing is a return target.
    expect(timeline.items).toEqual([])
  })

  it('truncates at the limit, newest first', async () => {
    const one = await readContextTimeline(requestOf({ current: sourceOf(CURRENT, events), limit: 1 }))
    expect(one.items.map(item => item.ref)).toEqual(['head:6'])

    const two = await readContextTimeline(requestOf({ current: sourceOf(CURRENT, events), limit: 2 }))
    expect(two.items.map(item => item.ref)).toEqual(['head:6', `team-boundary:${CURRENT}:5`])
  })
})

describe('pricing honesty', () => {
  const events = log(turnStart(1), ...checkpoint(1, 'call-cp', 'anchor'))

  it('fails closed on an unmeasurable source instead of pricing it as free', async () => {
    const timeline = await readContextTimeline(requestOf({
      current: sourceOf(CURRENT, events),
      measureSource: () => undefined,
    }))
    expect(timeline.items.map(item => [item.source, item.restorable])).toEqual([
      ['head', false],
      ['checkpoint', false],
    ])
    expect(timeline.items[1]?.reason).toBe('the source Session\'s context cost cannot be measured, so the return budget cannot be proven')
    // The unknown is never rendered as a zero-cost target either.
    expect(timeline.items[1]?.retainedTokens).toBe(0)
    expect(timeline.items[1]?.discardedTokens).toBe(1000)
  })

  it('rejects a target whose retained context is at or above the handoff budget', async () => {
    const timeline = await readContextTimeline(requestOf({
      current: sourceOf(CURRENT, log(
        turnStart(1),
        ...checkpoint(1, 'call-cp', 'anchor'),
        turnStart(2),
        notice('Thread: thread:aaaa-1111 arrival'),
        turnEnd(2),
      )),
      handoffAt: 400,
    }))
    // The checkpoint retains exactly the budget (400), the boundary retains 700.
    expect(itemOf(timeline, 'checkpoint')).toMatchObject({
      restorable: false,
      reason: 'retained context would be at or above the handoff budget',
    })
    expect(itemOf(timeline, 'boundary')).toMatchObject({
      restorable: false,
      reason: 'retained context would not materially shrink the working set',
    })
  })
})

describe('boundary attribution', () => {
  async function boundaryItem(text: string): Promise<ContextTimelineItem | undefined> {
    const timeline = await readContextTimeline(requestOf({
      current: sourceOf(CURRENT, log(turnStart(1), notice(text), turnEnd(1))),
    }))
    return itemOf(timeline, 'boundary')
  }

  it('makes a boundary selectable exactly when one topic is attributable to it', async () => {
    expect(await boundaryItem('Thread: thread:aaaa-1111 arrival')).toMatchObject({ restorable: true })
    expect((await boundaryItem('Thread: thread:aaaa-1111 arrival'))?.reason).toBeUndefined()

    expect(await boundaryItem('HANDOFF boundary with no attribution')).toMatchObject({
      restorable: false,
      reason: 'no single topic is attributable to this boundary',
    })

    expect(await boundaryItem('Thread: thread:aaaa-1111 and Thread: thread:bbbb-2222')).toMatchObject({
      restorable: false,
      reason: 'multiple topics entered the context through this boundary; write a fresh handoff instead',
    })
  })

  it('judges what the boundary is before what it costs', async () => {
    // A multi-topic boundary over budget still reports its attribution, so the
    // reason names the real obstacle rather than a budget side effect.
    const timeline = await readContextTimeline(requestOf({
      current: sourceOf(CURRENT, log(
        turnStart(1),
        notice('Thread: thread:aaaa-1111 and Thread: thread:bbbb-2222'),
        turnEnd(1),
      )),
      handoffAt: 1,
    }))
    expect(itemOf(timeline, 'boundary')?.reason).toBe('multiple topics entered the context through this boundary; write a fresh handoff instead')
  })
})

describe('the lineage walk', () => {
  // The two generations differ in length on purpose: were an ancestor's head
  // ever offered, it would carry its own marker ref instead of colliding with
  // the current generation's and hiding behind the dedupe.
  const currentEvents = log(turnStart(1), ...checkpoint(1, 'call-own', 'child anchor'), turnStart(2), turnEnd(2))
  const parentEvents = log(turnStart(1), ...checkpoint(1, 'call-own', 'parent anchor'))

  it('keys every ref to the generation that recorded it, and prices each in its own measurement', async () => {
    const timeline = await readContextTimeline(requestOf({
      current: sourceOf(CURRENT, currentEvents, { parent: PARENT }),
      readAncestor: async sessionId => ({ ok: true, inspection: inspectionOf(sessionId, parentEvents) }),
      measureSource: source => (source.sessionId === CURRENT ? 100 : 10_000),
    }))

    // The same call id in two generations yields two distinct refs — the child
    // never re-keys its ancestor's record.
    expect(timeline.items.map(item => item.ref)).toEqual([
      'head:5',
      `context-checkpoint:${CURRENT}:call-own`,
      `context-checkpoint:${PARENT}:call-own`,
    ])
    // Items stay in lineage order, newest generation first: seqs are
    // per-Session, so they can never order two sources against each other.
    expect(timeline.items.map(item => item.sourceSessionId)).toEqual([undefined, undefined, PARENT])
    // A small current generation never shrinks a large ancestor's real cost,
    // and returning into an ancestor replaces this whole generation.
    expect(timeline.items.map(item => [item.retainedTokens, item.discardedTokens])).toEqual([
      [1000, 0],
      [67, 933],
      [10_000, 1000],
    ])
    // An archived generation has no "current head": that is exactly what it is not.
    expect(timeline.items.filter(item => item.source === 'head')).toHaveLength(1)
  })

  it('stops at an unreadable ancestor and reports where the lineage broke', async () => {
    const timeline = await readContextTimeline(requestOf({
      current: sourceOf(CURRENT, currentEvents, { parent: PARENT }),
      readAncestor: async sessionId => ({
        ok: false,
        failure: { kind: 'corrupt', sessionId, detail: 'corrupt session log' },
      }),
    }))
    expect(timeline.incompleteFrom).toEqual({ sessionId: PARENT, reason: 'corrupt: corrupt session log' })
    // History is complete through the last listed source, and the truncation is
    // never silent.
    expect(timeline.items.map(item => item.ref)).toEqual(['head:5', `context-checkpoint:${CURRENT}:call-own`])
  })

  it('bounds the walk at the requested depth', async () => {
    const readAncestor = vi.fn(async (sessionId: SessionId): Promise<StoredSessionReadResult> => ({
      ok: true,
      inspection: inspectionOf(sessionId, parentEvents, GRANDPARENT),
    }))
    const timeline = await readContextTimeline(requestOf({
      current: sourceOf(CURRENT, currentEvents, { parent: PARENT }),
      readAncestor,
      maxAncestors: 1,
    }))
    expect(readAncestor).toHaveBeenCalledTimes(1)
    expect(readAncestor).toHaveBeenCalledWith(PARENT)
    expect(timeline.items.map(item => item.sourceSessionId)).toEqual([undefined, undefined, PARENT])
    expect(timeline.incompleteFrom).toBeUndefined()
  })

  it('folds a seeded generation from its own span only', async () => {
    const prefix = [turnStart(1), ...checkpoint(1, 'call-ancestor', 'ancestor anchor'), turnStart(2), ...rollover(2, 'call-roll', 'the handoff that opened this generation')]
    const own = [turnStart(3), ...checkpoint(3, 'call-own', 'own anchor')]
    const events = log(...prefix, ...own)
    const timeline = await readContextTimeline(requestOf({
      current: sourceOf(CURRENT, events, { inheritedEventCount: prefix.length }),
    }))
    // The ancestor's checkpoint is not re-keyed under this Session, and its
    // completed rollover intent is not this generation's pending swap.
    expect(timeline.items.map(item => item.ref)).toEqual([
      `head:${events.length - 1}`,
      `context-checkpoint:${CURRENT}:call-own`,
    ])
  })

  it('reads no ancestor when the current generation has no parent', async () => {
    const readAncestor = vi.fn(noAncestors)
    const timeline = await readContextTimeline(requestOf({
      current: sourceOf(CURRENT, currentEvents),
      readAncestor,
    }))
    expect(readAncestor).not.toHaveBeenCalled()
    expect(timeline.items).toHaveLength(2)
  })

  it('never lists one generation\'s anchors twice, even when the lineage repeats it', async () => {
    // A header chain that points back at itself: the walk stays bounded, and
    // the ref dedupe is what keeps the repeated generation from being listed
    // again — refs are the identity, so a replay is not a second anchor.
    const timeline = await readContextTimeline(requestOf({
      current: sourceOf(CURRENT, currentEvents, { parent: PARENT }),
      readAncestor: async sessionId => ({ ok: true, inspection: inspectionOf(sessionId, parentEvents, PARENT) }),
      maxAncestors: 3,
    }))
    expect(timeline.items.map(item => item.ref)).toEqual([
      'head:5',
      `context-checkpoint:${CURRENT}:call-own`,
      `context-checkpoint:${PARENT}:call-own`,
    ])
  })
})
