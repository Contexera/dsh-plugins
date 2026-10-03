/**
 * Choosing one span of a live context surface, and handing it to the engine.
 *
 * The selection is the whole safety story of `context_compact`, so the spec
 * pins its bounds as positions on a real surface: the range never starts on a
 * leading `system/message`, never reaches the newest instruction or anything
 * after it, shrinks — never widens — when the scope can price its own tail, and
 * retreats off any edge that would split a tool call from its result. A stale
 * measurement is not a failure: it costs the retention budget and nothing else.
 */
import { describe, expect, it } from 'vitest'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_COMPACT_RETAIN_TOKENS,
  compactContextRange,
  compactibleNow,
  selectCompactionRange,
  type CompactionSelection,
} from '../src/compaction.ts'
import { engineSpy, meterOf, priced } from './compaction-doubles.ts'
import { agentOn, conversation, toolConversation } from './session-fixture.ts'

const SIGNAL = new AbortController().signal

/** The selected span, failing the test with the engine's own reason when there is none. */
function rangeOf(selection: CompactionSelection): { readonly start: SessionSeq; readonly end: SessionSeq } {
  if (selection.kind !== 'range') throw new Error(`expected a range, got none: ${selection.reason}`)
  return selection.range
}

/** The reason no range was selected. */
function reasonOf(selection: CompactionSelection): string {
  if (selection.kind !== 'none') throw new Error('expected no range')
  return selection.reason
}

/** Where one surface sequence sits in the current surface. */
function indexOf(session: Session, seq: SessionSeq): number {
  return session.surface.nodes.indexOf(seq)
}

describe('selectCompactionRange: the bounds no range may cross', () => {
  it('never starts on a leading system message', () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    // Surface 0 is the system message; surface 1 is the first user message.
    expect(session.deriveMessages()[0]?.role).toBe('system')
    const range = rangeOf(selectCompactionRange(session, undefined, DEFAULT_COMPACT_RETAIN_TOKENS))
    expect(indexOf(session, range.start)).toBe(1)
  })

  it('never covers the newest instruction or anything after it', () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const nodes = session.surface.nodes
    const roles = session.deriveMessages().map(message => message.role)
    // Every node projects to exactly one message here, so message index and
    // surface position name the same thing — which is what makes the bound
    // readable as a position.
    expect(roles).toHaveLength(nodes.length)
    const newestInstruction = roles.lastIndexOf('user')
    const range = rangeOf(selectCompactionRange(session, undefined, DEFAULT_COMPACT_RETAIN_TOKENS))
    expect(indexOf(session, range.end)).toBe(newestInstruction - 1)
    const covered = nodes.slice(indexOf(session, range.start), indexOf(session, range.end) + 1)
    expect(covered).not.toContain(nodes[newestInstruction])
    expect(covered).not.toContain(nodes[nodes.length - 1])
  })

  it('prices the recent tail and keeps it verbatim, which only ever shrinks the range', () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const budget = DEFAULT_COMPACT_RETAIN_TOKENS
    const unpriced = rangeOf(selectCompactionRange(session, undefined, budget))
    // Ten thousand tokens per node against a 32K budget keeps the trailing four
    // nodes (40K) verbatim, so the range stops one turn earlier.
    const pricedRange = rangeOf(selectCompactionRange(session, meterOf(priced(session, 10_000)).meter, budget))
    expect(indexOf(session, pricedRange.start)).toBe(indexOf(session, unpriced.start))
    expect(indexOf(session, pricedRange.end)).toBe(indexOf(session, unpriced.end) - 2)
  })

  it('asks the meter about the very session it is pricing', () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const spy = meterOf(priced(session, 10_000))
    selectCompactionRange(session, spy.meter, DEFAULT_COMPACT_RETAIN_TOKENS)
    expect(spy.sessions).toEqual([session])
  })

  it('ignores a stale measurement instead of failing or widening the range', () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const budget = DEFAULT_COMPACT_RETAIN_TOKENS
    const fresh = priced(session, 10_000)
    const unpriced = rangeOf(selectCompactionRange(session, undefined, budget))
    expect(rangeOf(selectCompactionRange(session, meterOf(fresh).meter, budget))).not.toEqual(unpriced)
    // A shorter measurement: the surface grew after it was taken.
    expect(rangeOf(selectCompactionRange(session, meterOf({ totalTokens: 6, nodes: [] }).meter, budget))).toEqual(unpriced)
    // The same length over different nodes: the surface was rewritten under it.
    const rewired = { totalTokens: fresh.totalTokens, nodes: [...fresh.nodes].reverse() }
    expect(rangeOf(selectCompactionRange(session, meterOf(rewired).meter, budget))).toEqual(unpriced)
  })

  it('retreats off any end that would split a tool call from its result', () => {
    const session = toolConversation()
    const nodes = session.surface.nodes
    // One token per node against a budget of seven lands the cut on the
    // assistant node that opens the first call/result pair, where the trailing
    // cut is unbalanced.
    const range = rangeOf(selectCompactionRange(session, meterOf(priced(session, 1)).meter, 7))
    expect(indexOf(session, range.end)).toBe(0)
    expect(toolPairingBalancedAfter(session, nodes[1]!)).toBe(false)
    expect(toolPairingBalancedAfter(session, range.end)).toBe(true)
  })

  it('stops before the newest instruction in a tool conversation too', () => {
    const session = toolConversation()
    const nodes = session.surface.nodes
    const range = rangeOf(selectCompactionRange(session, undefined, DEFAULT_COMPACT_RETAIN_TOKENS))
    const newestInstruction = session.deriveMessages().map(message => message.role).lastIndexOf('user')
    expect(indexOf(session, range.end)).toBeLessThan(newestInstruction)
    expect(indexOf(session, range.end)).toBe(newestInstruction - 1)
    expect(toolPairingBalancedAfter(session, range.end)).toBe(true)
    expect(nodes[indexOf(session, range.end) + 1]).toBe(nodes[newestInstruction])
  })
})

describe('selectCompactionRange: when nothing may be compacted', () => {
  it('says so on a surface that has no nodes yet', () => {
    const session = Session.create(SessionId('empty'))
    expect(reasonOf(selectCompactionRange(session, undefined, DEFAULT_COMPACT_RETAIN_TOKENS)))
      .toBe('this context has no surface yet')
  })

  it('says the recent tail already keeps the whole context verbatim', () => {
    const session = conversation({ turns: 4 })
    const selection = selectCompactionRange(session, meterOf(priced(session, 10_000)).meter, 1_000_000)
    expect(reasonOf(selection)).toBe('the recent tail already keeps this whole context verbatim')
  })

  it('says there is nothing older than the newest instruction', () => {
    const session = conversation({ turns: 1, system: 'You are a test agent.' })
    expect(reasonOf(selectCompactionRange(session, undefined, DEFAULT_COMPACT_RETAIN_TOKENS)))
      .toBe('this context has nothing older than its newest instruction')
  })
})

describe('compactibleNow: the price a status read reports', () => {
  it('prices the span the compaction would take, and the recent tail it keeps', () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const scope = { engine: engineSpy().engine, meter: meterOf(priced(session, 10_000)).meter }
    // Nine nodes at ten thousand each against the default 32K retention budget:
    // the walk keeps nodes 5-8 verbatim, so nodes 1-4 are what a compaction
    // started now would replace. The system head is in neither number.
    expect(compactibleNow(session, scope)).toEqual({ compactibleTokens: 40_000, retainedTailTokens: 40_000 })
  })

  it('prices the very span the engine is handed', async () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const engine = engineSpy()
    const scope = { engine: engine.engine, meter: meterOf(priced(session, 10_000)).meter }
    const price = compactibleNow(session, scope)
    await compactContextRange(scope, agentOn(session), SIGNAL)
    const span = engine.calls[0]!
    expect(price?.compactibleTokens).toBe((indexOf(session, span.end) - indexOf(session, span.start) + 1) * 10_000)
  })

  it('honours the scope\'s own retention budget rather than a fixed one', () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const scope = { engine: engineSpy().engine, meter: meterOf(priced(session, 10_000)).meter, retainTokens: 10_000 }
    // One node covers the smaller budget, and the newest instruction pulls the
    // trailing cut back one more node: nodes 7-8 stay verbatim.
    expect(compactibleNow(session, scope)).toEqual({ compactibleTokens: 60_000, retainedTailTokens: 20_000 })
  })

  it('reports nothing to compact when the selection finds nothing safe', () => {
    const session = conversation({ turns: 1, system: 'You are a test agent.' })
    const scope = { engine: engineSpy().engine, meter: meterOf(priced(session, 10_000)).meter }
    // Three nodes and a 32K budget: the whole surface stays, so nothing is
    // compactible — a priced zero, not an unknown.
    expect(compactibleNow(session, scope)).toEqual({ compactibleTokens: 0, retainedTailTokens: 30_000 })
  })

  it('answers nothing, rather than zero, when this scope cannot price its surface', () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    expect(compactibleNow(session, { engine: engineSpy().engine })).toBeUndefined()
    // A stale measurement is the same fact: the nodes it names are not the ones
    // this surface holds, so they price nothing.
    const fresh = priced(session, 10_000)
    const stale = meterOf({ totalTokens: fresh.totalTokens, nodes: fresh.nodes.slice(1) }).meter
    expect(compactibleNow(session, { engine: engineSpy().engine, meter: stale })).toBeUndefined()
  })
})

describe('compactContextRange: the engine gets a span, or nothing happens', () => {
  it('hands the engine the selected span and reports what came back', async () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const nodes = session.surface.nodes
    const agent = agentOn(session)
    const engine = engineSpy({ shadowedTokenCount: 512 })
    const spy = meterOf(priced(session, 10_000), { totalTokens: 9_000, nodes: [] })
    const attempt = await compactContextRange({ engine: engine.engine, meter: spy.meter }, agent, SIGNAL)

    expect(attempt).toEqual({
      kind: 'compacted',
      range: { start: nodes[1], end: nodes[4] },
      replaced: 2,
      replacedTokens: 512,
      usageTokens: 9_000,
    })
    expect(engine.calls).toEqual([{ start: nodes[1], end: nodes[4], agent, signal: SIGNAL }])
    // The total is the meter's answer after the replacement, not before it.
    expect(spy.sessions).toEqual([session, session])
  })

  it('applies the default retention budget when the scope names none', async () => {
    expect(DEFAULT_COMPACT_RETAIN_TOKENS).toBe(32 * 1024)
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const nodes = session.surface.nodes
    const engine = engineSpy()
    const attempt = await compactContextRange(
      { engine: engine.engine, meter: meterOf(priced(session, 10_000)).meter },
      agentOn(session),
      SIGNAL,
    )
    expect(attempt).toMatchObject({ kind: 'compacted', range: { start: nodes[1], end: nodes[4] } })
  })

  it('reports no total when the scope cannot measure one', async () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const attempt = await compactContextRange({ engine: engineSpy().engine }, agentOn(session), SIGNAL)
    expect(attempt.kind).toBe('compacted')
    expect(Object.hasOwn(attempt, 'usageTokens')).toBe(false)
  })

  it('never touches the engine when no range is safe', async () => {
    const session = conversation({ turns: 1, system: 'You are a test agent.' })
    const engine = engineSpy()
    const attempt = await compactContextRange({ engine: engine.engine }, agentOn(session), SIGNAL)
    expect(attempt).toEqual({
      kind: 'none',
      reason: 'this context has nothing older than its newest instruction',
    })
    expect(engine.calls).toEqual([])
  })

  it('lets the engine own a failure: the mechanism never swallows one', async () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const engine = engineSpy({ fail: 'summarizer unavailable' })
    await expect(compactContextRange({ engine: engine.engine }, agentOn(session), SIGNAL))
      .rejects.toThrow('summarizer unavailable')
    expect(engine.calls).toHaveLength(1)
  })
})
