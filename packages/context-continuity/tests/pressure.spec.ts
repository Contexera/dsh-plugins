/**
 * The context-pressure policy: when a subject is told to prepare a handoff, and
 * what happens at the hard limit.
 *
 * The spec pins the decision order (below the budget / at the budget / at the
 * limit), the once-per-generation latch and its *durable* evidence — including
 * that an inherited notice belongs to the generation it came from — the
 * fail-closed proof a reduction has to earn, the one-retry overflow sequence,
 * and the notice's substance. The host owns mechanism and vocabulary: the meter,
 * the reduction capability, the steer, and what "in hand" is called.
 */
import { describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ContextPressurePolicy,
  PRESSURE_NOTICE_SUMMARY,
  contextPressureNoticeText,
  type PressureCompaction,
  type PressureInHand,
  type PressureLimits,
  type PressureLogSpan,
  type PressureSurface,
} from '../src/pressure.ts'
import { OTHER_PLUGIN_ID, PLUGIN_ID, V3_RENAMED_KIND } from './test-producer.ts'

const BUDGETS: PressureLimits = { usageTokens: 100_000, hardLimit: 256_000, handoffAt: 200_000 }

/**
 * One `user/message` event carrying a notice under `kind`, at a known seq. The
 * default is the producer's own id, which is what this policy writes now; a row
 * released before format V4 reaches the fold as `plugin:<producer>` instead.
 */
function noticeEvent(seq: number, kind: string = PLUGIN_ID, summary = PRESSURE_NOTICE_SUMMARY): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 0,
    data: { source: { kind, form: 'notice', summary } },
  } as unknown as SessionEvent
}

/** One durable queued insert: delivered for this generation, not yet surfaced. */
function splicedEvent(seq: number, pluginId = PLUGIN_ID): SessionEvent {
  return {
    type: 'agent/inbox/spliced',
    seq: SessionSeq(seq),
    time: 0,
    data: {
      inserted: [{ source: { kind: pluginId, form: 'notice', summary: PRESSURE_NOTICE_SUMMARY } }],
      target: 'next-turn',
    },
  } as unknown as SessionEvent
}

/** One event that carries no notice at all. */
function plainEvent(seq: number): SessionEvent {
  return { type: 'tool/result', seq: SessionSeq(seq), time: 0, data: {} } as unknown as SessionEvent
}

/** One subject's durable log, numbered by position as the Session contract requires. */
function span(sessionId: string, inheritedEventCount: number, ...events: readonly SessionEvent[]): PressureLogSpan {
  return { sessionId, inheritedEventCount, events }
}

/**
 * A host that exposes exactly what the policy reads, records every effect it
 * asks for, and — like a real host — records a steered notice in the subject's
 * own durable log, which is the evidence the latch reads back.
 */
class FakeHost {
  readonly pluginId = PLUGIN_ID
  limits: PressureLimits | undefined = BUDGETS
  surface: PressureSurface = { generation: 0, tokens: 50_000 }
  compaction: PressureCompaction | undefined = undefined
  log: PressureLogSpan = span('session-1', 0)
  inHand: PressureInHand = { inHand: [], jobs: [] }
  readonly steered: UserMessage[] = []
  readonly failures: string[] = []
  readonly logs: { readonly message: string; readonly subject: string }[] = []
  readonly reductions: string[] = []
  spanReads = 0
  generations = 0

  limitsFor(): PressureLimits | undefined {
    return this.limits
  }

  surfaceFor(): PressureSurface {
    return this.surface
  }

  compactionFor(): PressureCompaction | undefined {
    return this.compaction
  }

  logSpanFor(): PressureLogSpan {
    this.spanReads += 1
    return this.log
  }

  inHandFor(): PressureInHand {
    return this.inHand
  }

  steer(_subject: string, notice: UserMessage): void {
    this.steered.push(notice)
    this.log = span(this.log.sessionId, this.log.inheritedEventCount, ...this.log.events, {
      type: 'user/message',
      seq: SessionSeq(this.log.events.length),
      time: 0,
      data: notice,
    } as unknown as SessionEvent)
  }

  failedFor(_subject: string, diagnostic: string): void {
    this.failures.push(diagnostic)
  }

  warn(message: string, subject: string): void {
    this.logs.push({ message, subject })
  }

  /** One generation swap: a fresh Session whose own span is empty. */
  nextGeneration(): void {
    this.generations += 1
    this.log = span(`session-1-generation-${this.generations}`, 0)
  }

  /** One scripted reduction: what the capability does to the surface, and how it ends. */
  script(behavior: 'advance' | 'reduce' | 'noop' | 'no-range' | 'throw' | 'throw-after-advance'): FakeHost {
    this.compaction = {
      reduce: async (reason) => {
        this.reductions.push(reason)
        if (behavior === 'throw') throw new Error('engine failure')
        if (behavior === 'advance') {
          this.surface = { ...this.surface, generation: this.surface.generation + 1 }
          return null
        }
        if (behavior === 'reduce') {
          this.surface = { ...this.surface, tokens: (this.surface.tokens ?? 0) - 5_000 }
          return { summary: 'reduced' }
        }
        if (behavior === 'throw-after-advance') {
          this.surface = { ...this.surface, generation: this.surface.generation + 1 }
          throw new Error('summary failed after prune')
        }
        return behavior === 'no-range' ? null : { summary: 'nothing compactable' }
      },
    }
    return this
  }
}

/** One policy over a fresh host, wired to the host's own log sink. */
function policyFor(host: FakeHost): ContextPressurePolicy<string> {
  const policy = new ContextPressurePolicy<string>({
    pluginId: host.pluginId,
    limitsFor: () => host.limitsFor(),
    surfaceFor: () => host.surfaceFor(),
    compactionFor: () => host.compactionFor(),
    logSpanFor: () => host.logSpanFor(),
    inHandFor: () => host.inHandFor(),
    steer: (subject, notice) => { host.steer(subject, notice) },
    failedFor: (subject, diagnostic) => { host.failedFor(subject, diagnostic) },
    log: (message, subject) => { host.warn(message, subject) },
  })
  return policy
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function noticeText(notice: UserMessage): string {
  return notice.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

describe('the pressure ladder: budget, notice, limit', () => {
  it('below the handoff budget decides nothing and touches no effect', async () => {
    const host = new FakeHost().script('advance')
    host.limits = { usageTokens: 150_000, hardLimit: 256_000, handoffAt: 200_000 }
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('continue')
    expect(host.steered).toEqual([])
    expect(host.reductions).toEqual([])
    expect(host.failures).toEqual([])
  })

  it('at the handoff budget steers one structured notice carrying the measured numbers', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 210_000, hardLimit: 256_000, handoffAt: 200_000 }
    host.inHand = { inHand: ['claim:a (unify forms)'], jobs: ['build'] }
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('notice')
    expect(host.steered).toHaveLength(1)
    const notice = host.steered[0]!
    // The notice is attributed under the host's own producer kind: format V4
    // refuses the retired `{ kind: 'plugin', plugin }` wrapper at write time.
    expect(notice.source).toMatchObject({ kind: PLUGIN_ID, form: 'notice', summary: PRESSURE_NOTICE_SUMMARY })
    expect(notice.source).not.toHaveProperty('plugin')
    const text = noticeText(notice)
    expect(text).toContain('210000')
    expect(text).toContain('200000')
    expect(text).toContain('256000')
    expect(text).toContain('claim:a (unify forms)')
    expect(text).toContain('1 running')
    expect(host.reductions).toEqual([])
  })

  it('the delivered notice latches the generation, so later steps stay quiet', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }
    const policy = policyFor(host)
    expect((await policy.onPreStep('subject-1', signal())).kind).toBe('notice')
    expect((await policy.onPreStep('subject-1', signal())).kind).toBe('continue')
    expect(host.steered).toHaveLength(1)
  })

  it('a fresh generation re-arms the notice', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }
    const policy = policyFor(host)
    await policy.onPreStep('subject-1', signal())
    host.nextGeneration()
    expect((await policy.onPreStep('subject-1', signal())).kind).toBe('notice')
    expect(host.steered).toHaveLength(2)
  })

  it('a restart over the same log stays quiet: the latch is durable evidence, not process state', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }
    await policyFor(host).onPreStep('subject-1', signal())
    expect(host.steered).toHaveLength(1)
    const restarted = policyFor(host)
    expect((await restarted.onPreStep('subject-1', signal())).kind).toBe('continue')
    expect(host.steered).toHaveLength(1)
    host.nextGeneration()
    expect((await restarted.onPreStep('subject-1', signal())).kind).toBe('notice')
  })

  it('a notice still queued in a durable splice already counts as delivered', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }
    host.log = span('session-1', 0, plainEvent(0), splicedEvent(1))
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('continue')
    expect(host.steered).toEqual([])
  })

  it('an inherited notice belongs to the generation it came from, so this one still gets told', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }
    // The seeded prefix carries the ancestor's notice; only seq >= 3 is this
    // generation's own span.
    host.log = span('session-2', 3, noticeEvent(0), noticeEvent(1), noticeEvent(2), plainEvent(3))
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('notice')
    expect(host.steered).toHaveLength(1)
  })

  it('only this policy\'s own notice latches: another plugin\'s notice, or another summary, is not evidence', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }
    host.log = span('session-1', 0, noticeEvent(0, OTHER_PLUGIN_ID), noticeEvent(1, PLUGIN_ID, 'Some other notice'))
    expect((await policyFor(host).onPreStep('subject-1', signal())).kind).toBe('notice')
    expect(host.steered).toHaveLength(1)
  })

  it('a notice written before format V4 still latches through its converted kind', async () => {
    // Released rows are not rewritten on disk: the format's read-time conversion
    // renames one `plugin` source into `plugin:<producer>`, so a Session whose
    // own span already carries a released notice must stay quiet rather than
    // deliver the same notice a second time.
    const host = new FakeHost()
    host.limits = { usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }
    host.log = span('session-1', 0, noticeEvent(0, V3_RENAMED_KIND))
    expect((await policyFor(host).onPreStep('subject-1', signal())).kind).toBe('continue')
    expect(host.steered).toHaveLength(0)
  })

  it('the latch resumes over an appended span without folding it again', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }
    const policy = policyFor(host)
    await policy.onPreStep('subject-1', signal())
    const readsAfterNotice = host.spanReads
    host.log = span('session-1', 0, ...host.log.events, plainEvent(host.log.events.length))
    expect((await policy.onPreStep('subject-1', signal())).kind).toBe('continue')
    expect(host.steered).toHaveLength(1)
    expect(host.spanReads).toBeGreaterThan(readsAfterNotice)
  })

  it('a log rewritten under the latch is folded cold, so a lost notice is re-delivered', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }
    const policy = policyFor(host)
    await policy.onPreStep('subject-1', signal())
    // The second step is what latches *on* the recorded notice: the latch then
    // holds `delivered` plus the event it stopped on.
    expect((await policy.onPreStep('subject-1', signal())).kind).toBe('continue')
    // The same log, at the same length, rewritten in place: the event the latch
    // stopped on is gone, so it must re-fold cold instead of trusting its value.
    host.log = span('session-1', 0, plainEvent(0))
    expect((await policy.onPreStep('subject-1', signal())).kind).toBe('notice')
    expect(host.steered).toHaveLength(2)
  })

  it('at the hard limit the request is reduced first, and never merely noticed', async () => {
    const host = new FakeHost().script('advance')
    host.limits = { usageTokens: 256_000, hardLimit: 256_000, handoffAt: 200_000 }
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('continue')
    expect(host.reductions).toEqual(['context-overflow'])
    expect(host.surface.generation).toBe(1)
    expect(host.steered).toEqual([])
    expect(host.failures).toEqual([])
  })

  it('a reduction that measurably lowers pressure is proven even without a new generation', async () => {
    const host = new FakeHost().script('reduce')
    host.limits = { usageTokens: 300_000, hardLimit: 256_000, handoffAt: 200_000 }
    host.surface = { generation: 4, tokens: 300_000 }
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('continue')
    expect(host.failures).toEqual([])
  })

  it('a reduction that proves nothing fails closed and blocks the request', async () => {
    const host = new FakeHost().script('noop')
    host.limits = { usageTokens: 256_000, hardLimit: 256_000, handoffAt: 200_000 }
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('reject')
    expect(host.reductions).toEqual(['context-overflow'])
    expect(host.failures).toHaveLength(1)
    expect(host.failures[0]).toContain('no measurable reduction')
    expect(host.failures[0]).toContain('blocked')
  })

  it('a reduction with no compactable range reports that, not a silent block', async () => {
    const host = new FakeHost().script('no-range')
    host.limits = { usageTokens: 256_000, hardLimit: 256_000, handoffAt: 200_000 }
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('reject')
    expect(host.failures[0]).toContain('no compactable range exists')
  })

  it('a reduction that throws fails closed with a recoverable diagnostic', async () => {
    const host = new FakeHost().script('throw')
    host.limits = { usageTokens: 256_000, hardLimit: 256_000, handoffAt: 200_000 }
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('reject')
    expect(host.failures[0]).toContain('engine failure')
    expect(host.failures[0]).toContain('blocked')
  })

  it('a hard limit with no reduction capability blocks instead of submitting over the limit', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 256_000, hardLimit: 256_000, handoffAt: 200_000 }
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('reject')
    expect(host.reductions).toEqual([])
    expect(host.failures[0]).toContain('compaction is unavailable')
  })

  it('an unresolvable route capacity is refused, never read as unlimited', async () => {
    const host = new FakeHost()
    host.limits = undefined
    const decision = await policyFor(host).onPreStep('subject-1', signal())
    expect(decision.kind).toBe('reject')
    expect(host.failures).toHaveLength(1)
    expect(host.failures[0]).toContain('unknown')
    expect(host.steered).toEqual([])
  })

  it('an aborted signal decides nothing at all', async () => {
    const host = new FakeHost().script('advance')
    host.limits = { usageTokens: 300_000, hardLimit: 256_000, handoffAt: 200_000 }
    const controller = new AbortController()
    controller.abort()
    expect((await policyFor(host).onPreStep('subject-1', controller.signal)).kind).toBe('continue')
    expect(host.steered).toEqual([])
    expect(host.reductions).toEqual([])
  })

  it('a disposed policy stops deciding', async () => {
    const host = new FakeHost()
    host.limits = { usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }
    const policy = policyFor(host)
    policy.dispose()
    expect((await policy.onPreStep('subject-1', signal())).kind).toBe('continue')
    expect(host.steered).toEqual([])
  })
})

describe('provider overflow: one bounded reduce-and-retry per sequence', () => {
  it('compacts and retries once; a second overflow in the same sequence falls through', async () => {
    const host = new FakeHost().script('advance')
    const policy = policyFor(host)
    expect(await policy.onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())).toBe(true)
    expect(host.reductions).toEqual(['context-overflow'])
    expect(await policy.onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())).toBe(false)
    expect(host.reductions).toHaveLength(1)
  })

  it('a successful assistant response re-arms the sequence', async () => {
    const host = new FakeHost().script('advance')
    const policy = policyFor(host)
    await policy.onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())
    await policy.onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())
    policy.onAssistantMessage('subject-1')
    expect(await policy.onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())).toBe(true)
    expect(host.reductions).toHaveLength(2)
  })

  it('another failure code is not recovery material', async () => {
    const host = new FakeHost().script('advance')
    expect(await policyFor(host).onRequestError('subject-1', { code: 'SOMETHING_ELSE' }, signal())).toBe(false)
    expect(host.reductions).toEqual([])
  })

  it('a reduction that fails after durable progress still earns the single retry', async () => {
    const host = new FakeHost().script('throw-after-advance')
    expect(await policyFor(host).onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())).toBe(true)
  })

  it('a reduction that fails without progress logs the failure and does not retry', async () => {
    const host = new FakeHost().script('throw')
    expect(await policyFor(host).onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())).toBe(false)
    expect(host.logs).toHaveLength(1)
    expect(host.logs[0]!.message).toContain('engine failure')
    expect(host.logs[0]!.subject).toBe('subject-1')
  })

  it('a reduction that leaves the durable surface unchanged is not retried', async () => {
    const host = new FakeHost().script('noop')
    expect(await policyFor(host).onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())).toBe(false)
    expect(host.logs).toEqual([])
  })

  it('overflow without a reduction capability falls through to the host', async () => {
    const host = new FakeHost()
    expect(await policyFor(host).onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())).toBe(false)
  })

  it('an aborted signal never reduces, even when the surface would advance', async () => {
    const host = new FakeHost().script('advance')
    const controller = new AbortController()
    controller.abort()
    expect(await policyFor(host).onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, controller.signal)).toBe(false)
    expect(host.reductions).toEqual([])
  })

  it('the retry budget is per subject, so one subject\'s overflow does not spend another\'s', async () => {
    const host = new FakeHost().script('advance')
    const policy = policyFor(host)
    expect(await policy.onRequestError('subject-1', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())).toBe(true)
    expect(await policy.onRequestError('subject-2', { code: CONTEXT_WINDOW_EXCEEDED_CODE }, signal())).toBe(true)
    expect(host.reductions).toEqual(['context-overflow', 'context-overflow'])
  })
})

describe('the notice text', () => {
  it('carries the numbers, what is in hand, the default action, and the memory discipline', () => {
    const text = contextPressureNoticeText({
      usageTokens: 210_000,
      handoffAt: 200_000,
      hardLimit: 256_000,
      inHand: ['claim:a (unify forms)'],
      jobs: ['build', 'watch'],
    })
    expect(text).toContain('210000')
    expect(text).toContain('200000')
    expect(text).toContain('256000')
    expect(text).toContain('Work in hand: claim:a (unify forms).')
    expect(text).toContain('Background jobs: 2 running (collect or stop them before switching).')
    expect(text).toContain('context_rollover')
    expect(text).toContain('private memory/notes')
    expect(text.length).toBeLessThan(1200)
  })

  it('says "none" rather than going silent about an empty subject', () => {
    const text = contextPressureNoticeText({ usageTokens: 1, handoffAt: 1, hardLimit: 2, inHand: [], jobs: [] })
    expect(text).toContain('Work in hand: none.')
    expect(text).toContain('Background jobs: none.')
  })

  it('host wording replaces the vocabulary, never the substance', () => {
    const text = contextPressureNoticeText(
      { usageTokens: 1, handoffAt: 1, hardLimit: 2, inHand: ['claim:x'], jobs: [] },
      { inHandLabel: 'Active Claims', jobsLabel: 'Owner jobs', rolloverToolName: 'new_context' },
    )
    expect(text).toContain('Active Claims: claim:x.')
    expect(text).toContain('Owner jobs: none.')
    expect(text).toContain('new_context')
    expect(text).toContain('a fresh context is the default path')
    expect(text).toContain('external side effects')
    expect(text).not.toContain('Work in hand')
  })

  it('the notice summary is frozen to the value already written into live logs', () => {
    expect(PRESSURE_NOTICE_SUMMARY).toBe('Context pressure: prepare a handoff')
  })
})
