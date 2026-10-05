/**
 * The four continuity tools, as one factory.
 *
 * The spec pins the split the factory exists to hold. The engine owns the
 * argument contract a schema cannot express (a non-blank handoff, the byte cap,
 * the related-file shape, a supplied `checkpointRef`), the anti-forgery gate,
 * the `concludeTurn()` timing, the compaction range, and the render shapes. The
 * host owns mechanism and meaning: `ContinuityToolAdapter` performs every
 * effect, and `text` replaces subject-facing wording only — never a
 * safety-bearing sentence.
 *
 * Two layers reject, and the spec pins both. `defineTool`'s own `execute`
 * validates the declared arguments before the body runs (`ToolArgsError`: the
 * required handoff, the types, the related-file shape, a numeric limit), and the
 * body owns what a JSON Schema cannot express — blankness, the byte cap, the
 * file budget, and the anti-forgery gate. Either way the rejection is what the
 * model sees, the adapter is never touched, and the turn is never concluded.
 *
 * Compaction is the one tool whose unavailability is a result rather than a
 * rejection: a scope that mounts no engine is a supported composition, so the
 * model reads what happened instead of guessing.
 */
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  ToolArgsError,
  validateJsonSchemaValue,
  type JsonSchemaNode,
  type ToolDefinition,
  type ToolExecutionToken,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  MAX_COMPACT_SUMMARY_CHARS,
  MAX_HANDOFF_CHARS,
  MAX_RELATED_FILES,
  createContinuityTools,
  type CheckpointToolRequest,
  type ContinuityToolAdapter,
  type ContinuityTools,
  type RolloverToolRequest,
} from '../src/tools.ts'
import { pendingSummaryFor } from '../src/pending-summary.ts'
import type { ContextTimeline, ContextTimelineItem } from '../src/timeline.ts'
import { engineSpy, meterOf, priced } from './compaction-doubles.ts'
import { agentOn, conversation } from './session-fixture.ts'

/** The engine's own timeline, priced and annotated exactly as `readContextTimeline` returns it. */
const TIMELINE: ContextTimeline = {
  usageTokens: 120_000,
  handoffAt: 100_000,
  items: [
    {
      ref: 'context-checkpoint:alpha',
      label: 'before the extraction',
      source: 'checkpoint',
      retainedTokens: 40_000,
      discardedTokens: 80_000,
      affectedTopics: [],
      restorable: true,
    },
    {
      ref: 'team-boundary:7',
      label: 'the rollout Thread arrived',
      source: 'boundary',
      kind: 'first-arrival',
      retainedTokens: 90_000,
      discardedTokens: 30_000,
      affectedTopics: ['the rollout Thread'],
      restorable: false,
      reason: 'multiple topics entered the context by this boundary',
      sourceSessionId: SessionId('session-parent'),
    },
  ],
  incompleteFrom: { sessionId: SessionId('session-lost'), reason: 'the stored log could not be read' },
}

/** One tool execution: the body reads `callId`, hands `exec` to the adapter, and concludes the turn. */
function execution(callId = 'call-rollover', agent?: Agent): { exec: ToolRunContext; concludeTurn: ReturnType<typeof vi.fn> } {
  const concludeTurn = vi.fn()
  const exec: ToolRunContext = {
    callId: ToolCallId(callId),
    rootCallId: ToolCallId(callId),
    name: 'context_rollover',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol('execution') as unknown as ToolExecutionToken,
    deferContext: () => {},
    concludeTurn,
    ...(agent === undefined ? {} : { agent }),
  }
  return { exec, concludeTurn }
}

interface AdapterSpy {
  readonly adapter: ContinuityToolAdapter
  /** Every ref the engine asked the host to judge, in call order. */
  readonly restorableRefs: string[]
  readonly rollovers: RolloverToolRequest[]
  readonly checkpoints: CheckpointToolRequest[]
  readonly timelineReads: { readonly limit?: number }[]
  /** Every agent whose compaction scope the engine asked this host to resolve. */
  readonly compactionAgents: Agent[]
}

/** A recording adapter: it answers "yes, restorable" and returns the engine's own timeline. */
function adapterSpy(overrides: Partial<ContinuityToolAdapter> = {}): AdapterSpy {
  const restorableRefs: string[] = []
  const rollovers: RolloverToolRequest[] = []
  const checkpoints: CheckpointToolRequest[] = []
  const timelineReads: { readonly limit?: number }[] = []
  const compactionAgents: Agent[] = []
  const adapter: ContinuityToolAdapter = {
    async isRestorableRef(ref) {
      restorableRefs.push(ref)
      return true
    },
    async requestRollover(request) {
      rollovers.push(request)
      return { mode: 'fresh' }
    },
    async recordCheckpoint(request) {
      checkpoints.push(request)
      return { checkpointRef: `context-checkpoint:${request.name}`, name: request.name }
    },
    async timeline(request) {
      timelineReads.push(request)
      return TIMELINE
    },
    compactionFor(agent) {
      compactionAgents.push(agent)
      return undefined
    },
    ...overrides,
  }
  return { adapter, restorableRefs, rollovers, checkpoints, timelineReads, compactionAgents }
}

/** The canonical value one definition returned, typed by what the caller knows it declares. */
async function valueOf<T>(definition: ToolDefinition, args: unknown, exec: ToolRunContext): Promise<T> {
  return await definition.execute(args, exec) as T
}

/** The model-facing text of one definition's own render. */
function renderText(definition: ToolDefinition, value: unknown, args: unknown = {}): string {
  return definition.output.render(args, value as never)
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

/**
 * The violations of one canonical value against its own declared output schema.
 * The value crosses a lossless-JSON boundary before it is validated, so a body
 * returning `undefined`-valued keys is caught here rather than at dispatch.
 */
function outputViolations(definition: ToolDefinition, value: unknown): string[] {
  return validateJsonSchemaValue(definition.output.schema, JSON.parse(JSON.stringify(value)) as unknown)
}

/** The violations of one argument list against the definition's declared parameter schema. */
function argumentViolations(definition: ToolDefinition, args: unknown): string[] {
  return validateJsonSchemaValue(definition.parameters as unknown as JsonSchemaNode, args)
}

describe('createContinuityTools: the declared contract', () => {
  it('names the four tools the status and the rollover prose refer to', () => {
    const { adapter } = adapterSpy()
    const tools = createContinuityTools(adapter)
    expect([tools.rollover.name, tools.checkpoint.name, tools.status.name, tools.compact.name])
      .toEqual(['context_rollover', 'context_checkpoint', 'context_status', 'context_compact'])
  })

  it('declares the compaction tool without a range, because the range is the engine decision', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    // `summary` chooses what survives; which stretch is safe to replace never
    // becomes an argument, so a subject cannot aim the replacement itself.
    expect(Object.keys((tools.compact.parameters as { properties?: Record<string, unknown> }).properties ?? {}))
      .toEqual(['summary'])
    expect(argumentViolations(tools.compact, {})).toEqual([])
    expect(argumentViolations(tools.compact, { olderThan: 1 })).toEqual([])
    expect(argumentViolations(tools.compact, { summary: 'a checkpoint' })).toEqual([])
  })

  it('declares the handoff as required and accepts an undeclared root key', () => {
    const { adapter } = adapterSpy()
    const tools = createContinuityTools(adapter)
    expect(argumentViolations(tools.rollover, {})).not.toEqual([])
    expect(argumentViolations(tools.rollover, { handoff: 'h' })).toEqual([])
    expect(argumentViolations(tools.rollover, { handoff: 'h', futureHostKey: 1 })).toEqual([])
  })

  it('rejects a non-string checkpointRef and an undeclared related-file key at the boundary', () => {
    const { adapter } = adapterSpy()
    const tools = createContinuityTools(adapter)
    expect(argumentViolations(tools.rollover, { handoff: 'h', checkpointRef: 42 })).not.toEqual([])
    expect(argumentViolations(tools.rollover, {
      handoff: 'h',
      relatedFiles: [{ path: 'a.ts', reason: 'why', extra: true }],
    })).not.toEqual([])
  })

  it('leaves blankness to the body, because a JSON Schema cannot express it', () => {
    const { adapter } = adapterSpy()
    const tools = createContinuityTools(adapter)
    expect(argumentViolations(tools.rollover, { handoff: '   ' })).toEqual([])
  })
})

describe('context_rollover: argument validation', () => {
  it.each([
    ['an empty handoff', ''],
    ['a whitespace-only handoff', '   \n  '],
  ])('rejects %s without touching the adapter', async (_label, handoff) => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await expect(tools.rollover.execute({ handoff }, exec)).rejects.toThrow('requires a non-empty handoff')
    expect(spy.rollovers).toEqual([])
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('accepts a handoff of exactly the byte cap and rejects one character more', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    await expect(tools.rollover.execute({ handoff: 'x'.repeat(MAX_HANDOFF_CHARS) }, exec)).resolves.toBeDefined()
    await expect(tools.rollover.execute({ handoff: 'x'.repeat(MAX_HANDOFF_CHARS + 1) }, exec))
      .rejects.toThrow(`exceeds ${MAX_HANDOFF_CHARS} characters`)
    expect(spy.rollovers).toHaveLength(1)
  })

  it('rejects more related files than one handoff may name', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    const files = Array.from({ length: MAX_RELATED_FILES + 1 }, (_unused, index) => ({ path: `src/${index}.ts`, reason: 'why' }))
    await expect(tools.rollover.execute({ handoff: 'h', relatedFiles: files }, exec))
      .rejects.toThrow(`at most ${MAX_RELATED_FILES} related files`)
    expect(spy.rollovers).toEqual([])
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('accepts exactly the maximum number of related files', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const files = Array.from({ length: MAX_RELATED_FILES }, (_unused, index) => ({ path: `src/${index}.ts`, reason: 'why' }))
    await tools.rollover.execute({ handoff: 'h', relatedFiles: files }, exec)
    expect(spy.rollovers[0]?.relatedFiles).toHaveLength(MAX_RELATED_FILES)
  })

  it('rejects a related file with a blank path or reason, naming its index', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await expect(tools.rollover.execute({ handoff: 'h', relatedFiles: [{ path: 'a.ts', reason: '   ' }] }, exec))
      .rejects.toThrow('relatedFiles[0].reason must be a non-empty string')
    await expect(tools.rollover.execute({ handoff: 'h', relatedFiles: [{ path: '', reason: 'why' }] }, exec))
      .rejects.toThrow('relatedFiles[0].path must be a non-empty string')
    expect(spy.rollovers).toEqual([])
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('rejects a related-file entry that is not the declared shape before the body runs', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await expect(tools.rollover.execute({ handoff: 'h', relatedFiles: ['a.ts'] }, exec)).rejects.toThrow(ToolArgsError)
    await expect(tools.rollover.execute({ handoff: 'h', relatedFiles: 'src/a.ts' }, exec)).rejects.toThrow(ToolArgsError)
    expect(spy.rollovers).toEqual([])
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('hands the handoff and the related files through verbatim', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    await tools.rollover.execute({
      handoff: '  the spacing is mine  ',
      relatedFiles: [{ path: 'src/tools.ts', reason: 'the factory' }],
    }, exec)
    expect(spy.rollovers).toEqual([{
      handoff: '  the spacing is mine  ',
      relatedFiles: [{ path: 'src/tools.ts', reason: 'the factory' }],
    }])
    expect(Object.hasOwn(spy.rollovers[0] as object, 'checkpointRef')).toBe(false)
  })

  it('rejects a blank checkpointRef instead of reading it as a fresh rollover', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await expect(tools.rollover.execute({ handoff: 'h', checkpointRef: '   ' }, exec))
      .rejects.toThrow('checkpointRef must be a non-empty string when supplied')
    expect(spy.restorableRefs).toEqual([])
    expect(spy.rollovers).toEqual([])
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('rejects a non-string checkpointRef before the body runs', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await expect(tools.rollover.execute({ handoff: 'h', checkpointRef: 42 }, exec)).rejects.toThrow(ToolArgsError)
    expect(spy.restorableRefs).toEqual([])
    expect(spy.rollovers).toEqual([])
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('trims a padded checkpointRef before asking the host, and passes the trimmed ref through', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    await tools.rollover.execute({ handoff: 'h', checkpointRef: '  context-checkpoint:alpha\n' }, exec)
    expect(spy.restorableRefs).toEqual(['context-checkpoint:alpha'])
    expect(spy.rollovers[0]?.checkpointRef).toBe('context-checkpoint:alpha')
  })
})

describe('context_rollover: the anti-forgery gate', () => {
  it('rejects a ref the host does not record, keeps the previous generation, and never concludes the turn', async () => {
    const spy = adapterSpy({ isRestorableRef: async () => false })
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await expect(tools.rollover.execute({ handoff: 'h', checkpointRef: 'context-checkpoint:forged' }, exec))
      .rejects.toThrow('context-checkpoint:forged is not a restorable anchor this agent recorded')
    expect(spy.rollovers).toEqual([])
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('words the rejection in the host vocabulary and points at the timeline', async () => {
    const spy = adapterSpy({ isRestorableRef: async () => false })
    const tools = createContinuityTools(spy.adapter, { subjectNoun: 'Team Member' })
    const { exec } = execution()
    await expect(tools.rollover.execute({ handoff: 'h', checkpointRef: 'context-checkpoint:forged' }, exec))
      .rejects.toThrow(/not a restorable anchor this Team Member recorded; cite a ref a context_status listed as restorable/)
  })

  it('does not consult the gate for a fresh rollover', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    await tools.rollover.execute({ handoff: 'h' }, exec)
    expect(spy.restorableRefs).toEqual([])
  })

  it('surfaces an adapter rejection and does not conclude the turn', async () => {
    const spy = adapterSpy({ requestRollover: async () => { throw new Error('a rollover is refused while owned jobs are running') } })
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await expect(tools.rollover.execute({ handoff: 'h' }, exec)).rejects.toThrow('refused while owned jobs are running')
    expect(concludeTurn).not.toHaveBeenCalled()
  })
})

describe('context_rollover: the successful result is the fact', () => {
  it('concludes the turn only after the durable intent resolved', async () => {
    const order: string[] = []
    const tools = createContinuityTools(adapterSpy({
      async requestRollover() {
        order.push('requestRollover')
        return { mode: 'checkpoint' }
      },
    }).adapter)
    const { exec, concludeTurn } = execution()
    concludeTurn.mockImplementation(() => { order.push('concludeTurn') })
    const value = await valueOf<{ mode: string; status: string }>(tools.rollover, { handoff: 'h' }, exec)
    expect(order).toEqual(['requestRollover', 'concludeTurn'])
    expect(value).toEqual({ mode: 'checkpoint', status: 'scheduled' })
  })

  it('returns a canonical value that satisfies its own output schema', async () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    const { exec } = execution()
    const value = await valueOf<unknown>(tools.rollover, { handoff: 'h' }, exec)
    expect(outputViolations(tools.rollover, value)).toEqual([])
  })
})

describe('context_checkpoint', () => {
  it('rejects a blank name without recording anything', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await expect(tools.checkpoint.execute({ name: '  ' }, exec)).rejects.toThrow('requires a non-empty name')
    expect(spy.checkpoints).toEqual([])
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('rejects a missing name before the body runs', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await expect(tools.checkpoint.execute({}, exec)).rejects.toThrow(ToolArgsError)
    expect(spy.checkpoints).toEqual([])
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('identifies the record call by its own callId and returns the durable ref', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution('call-checkpoint-9')
    const value = await valueOf<{ checkpointRef: string; name: string }>(tools.checkpoint, { name: 'before the refactor' }, exec)
    expect(spy.checkpoints).toEqual([{ name: 'before the refactor', callId: 'call-checkpoint-9' }])
    expect(value).toEqual({ checkpointRef: 'context-checkpoint:before the refactor', name: 'before the refactor' })
    expect(outputViolations(tools.checkpoint, value)).toEqual([])
    expect(concludeTurn).toHaveBeenCalledTimes(1)
  })

  it('does not conclude the turn when the host refuses to record', async () => {
    const tools = createContinuityTools(adapterSpy({
      recordCheckpoint: async () => { throw new Error('the running turn is not checkpointable') },
    }).adapter)
    const { exec, concludeTurn } = execution()
    await expect(tools.checkpoint.execute({ name: 'anchor' }, exec)).rejects.toThrow('not checkpointable')
    expect(concludeTurn).not.toHaveBeenCalled()
  })
})

describe('context_status', () => {
  it('opens at a situation rather than at an intention, and renames itself everywhere it is named', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.status.description).toContain('Call it at a boundary, after a long gap, or when you are unsure where you stand.')
    // The sentence that made the tool invisible until the model had already
    // decided to return somewhere.
    expect(tools.status.description).not.toContain('Use this tool when you specifically intend a checkpointRef return')
    expect(tools.status.description).toContain('cite a checkpointRef only when this status listed that exact ref as restorable')
    // One rename, every reference: the other tools' prose points at the tool the
    // model will actually find.
    for (const description of [tools.status.description, tools.rollover.description, tools.checkpoint.description]) {
      expect(description).not.toContain('context_timeline')
    }
    expect(JSON.stringify(tools.checkpoint.parameters)).not.toContain('context_timeline')
    expect(JSON.stringify(tools.rollover.parameters)).not.toContain('context_timeline')
  })

  it('passes a numeric limit through and omits an absent one', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    await tools.status.execute({ limit: 3 }, exec)
    await tools.status.execute({}, exec)
    expect(spy.timelineReads).toEqual([{ limit: 3 }, {}])
  })

  it('rejects a non-numeric limit before the body runs', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    await expect(tools.status.execute({ limit: '3' }, exec)).rejects.toThrow(ToolArgsError)
    expect(spy.timelineReads).toEqual([])
  })

  /** What the model must be able to pick a ref from: the engine's items, copied for the output contract. */
  const EXPECTED_ITEMS = TIMELINE.items

  it('re-shapes the host timeline into plain mutable items without changing any meaning', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await valueOf<{ usageTokens: number; handoffAt: number; items: ContextTimelineItem[]; incompleteFrom?: unknown }>(
      tools.status, {}, exec)
    expect(value.usageTokens).toBe(TIMELINE.usageTokens)
    expect(value.handoffAt).toBe(TIMELINE.handoffAt)
    expect(value.items).toEqual(EXPECTED_ITEMS)
    expect(value.items[0]).not.toBe(EXPECTED_ITEMS[0])
    expect(value.items[1]?.affectedTopics).not.toBe(EXPECTED_ITEMS[1]?.affectedTopics)
    expect(value.items[1]?.affectedTopics).toEqual(['the rollout Thread'])
    expect(value.incompleteFrom).toEqual(TIMELINE.incompleteFrom)
    expect(outputViolations(tools.status, value)).toEqual([])
  })

  it('omits incompleteFrom when the lineage was complete', async () => {
    const spy = adapterSpy({ timeline: async () => ({ usageTokens: 10, handoffAt: 20, items: [] }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await valueOf<Record<string, unknown>>(tools.status, {}, exec)
    expect(Object.hasOwn(value, 'incompleteFrom')).toBe(false)
    expect(outputViolations(tools.status, value)).toEqual([])
  })

  it('is a read: it never concludes the turn', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await tools.status.execute({}, exec)
    expect(spy.timelineReads).toHaveLength(1)
    expect(concludeTurn).not.toHaveBeenCalled()
  })
})

describe('context_compact: a supported composition may have no engine', () => {
  it('answers "unavailable" without an agent, and never asks the adapter', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    const value = await valueOf<Record<string, unknown>>(tools.compact, {}, exec)
    expect(value).toEqual({
      status: 'unavailable',
      reason: 'this call carries no agent, so it has no context to shorten',
    })
    expect(spy.compactionAgents).toEqual([])
    expect(concludeTurn).not.toHaveBeenCalled()
    expect(outputViolations(tools.compact, value)).toEqual([])
  })

  it('answers "unavailable" when the calling agent scope mounts no engine', async () => {
    const agent = agentOn(conversation({ turns: 4, system: 'You are a test agent.' }))
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const value = await valueOf<Record<string, unknown>>(tools.compact, {}, execution('call-compact', agent).exec)
    expect(value).toEqual({
      status: 'unavailable',
      reason: 'this agent scope mounts no compaction engine',
    })
    expect(spy.compactionAgents).toEqual([agent])
  })

  it('reports nothing safe to compact as a result, and never calls the engine', async () => {
    const session = conversation({ turns: 1, system: 'You are a test agent.' })
    const agent = agentOn(session)
    const engine = engineSpy()
    const spy = adapterSpy({ compactionFor: () => ({ engine: engine.engine }) })
    const tools = createContinuityTools(spy.adapter)
    const value = await valueOf<Record<string, unknown>>(tools.compact, {}, execution('call-compact', agent).exec)
    expect(value).toEqual({
      status: 'nothing',
      reason: 'this context has nothing older than its newest instruction',
    })
    expect(engine.calls).toEqual([])
    expect(outputViolations(tools.compact, value)).toEqual([])
  })

  it('hands the engine the span it selected and reports what came back', async () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const nodes = session.surface.nodes
    const agent = agentOn(session)
    const engine = engineSpy({ shadowedTokenCount: 512 })
    const meter = meterOf(priced(session, 10_000), { totalTokens: 9_000, nodes: [] }).meter
    const spy = adapterSpy({ compactionFor: () => ({ engine: engine.engine, meter }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution('call-compact', agent)
    const value = await valueOf<Record<string, unknown>>(tools.compact, {}, exec)
    expect(value).toEqual({ status: 'compacted', replaced: 2, replacedTokens: 512, usageTokens: 9_000 })
    expect(engine.calls).toMatchObject([{ start: nodes[1], end: nodes[4], agent, signal: exec.signal }])
    // Shortening this context keeps working in this turn: it is not a lifecycle action.
    expect(concludeTurn).not.toHaveBeenCalled()
    expect(outputViolations(tools.compact, value)).toEqual([])
  })

  it('offers a subject-written summary to the engine for the attempt, then leaves nothing behind', async () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const agent = agentOn(session)
    // The spy stands in for the engine, so reading the channel from inside the
    // call is what proves the summary is visible to whoever writes the summary.
    const seen: Array<string | undefined> = []
    const engine = engineSpy({ before: inner => seen.push(pendingSummaryFor(inner)) })
    const spy = adapterSpy({ compactionFor: () => ({ engine: engine.engine }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution('call-compact', agent)
    await valueOf<Record<string, unknown>>(tools.compact, { summary: 'MY OWN CHECKPOINT' }, exec)
    expect(seen).toEqual(['MY OWN CHECKPOINT'])
    expect(pendingSummaryFor(session)).toBeUndefined()
  })

  it('offers nothing when the summary is omitted, so the engine writes its own', async () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const seen: Array<string | undefined> = []
    const engine = engineSpy({ before: inner => seen.push(pendingSummaryFor(inner)) })
    const spy = adapterSpy({ compactionFor: () => ({ engine: engine.engine }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution('call-compact', agentOn(session))
    await valueOf<Record<string, unknown>>(tools.compact, {}, exec)
    expect(seen).toEqual([undefined])
  })

  it('leaves no summary behind when the attempt is rejected', async () => {
    // Otherwise the next automatic compaction — which nobody wrote a summary for —
    // would silently reuse this one.
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const engine = engineSpy({ fail: 'summarizer unavailable' })
    const spy = adapterSpy({ compactionFor: () => ({ engine: engine.engine }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution('call-compact', agentOn(session))
    await expect(tools.compact.execute({ summary: 'MY OWN CHECKPOINT' }, exec))
      .rejects.toThrow('context_compact failed: summarizer unavailable. This context is unchanged.')
    expect(pendingSummaryFor(session)).toBeUndefined()
  })

  it('rejects a summary larger than one compaction may install', async () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const engine = engineSpy()
    const spy = adapterSpy({ compactionFor: () => ({ engine: engine.engine }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution('call-compact', agentOn(session))
    await expect(tools.compact.execute({ summary: 'x'.repeat(MAX_COMPACT_SUMMARY_CHARS + 1) }, exec))
      .rejects.toThrow(`context_compact summary exceeds ${MAX_COMPACT_SUMMARY_CHARS} characters`)
    expect(engine.calls).toEqual([])
  })

  it('reports a failure that left this context unchanged', async () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const engine = engineSpy({ fail: 'summarizer unavailable' })
    const spy = adapterSpy({ compactionFor: () => ({ engine: engine.engine }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution('call-compact', agentOn(session))
    await expect(tools.compact.execute({}, exec))
      .rejects.toThrow('context_compact failed: summarizer unavailable. This context is unchanged.')
  })

  it('says a replacement may already be on this context when the surface moved before the failure', async () => {
    const session = conversation({ turns: 4, system: 'You are a test agent.' })
    const engine = engineSpy({
      fail: 'the commit was rejected',
      before: (target, start, end) => {
        const nodes = target.surface.nodes
        target.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'a summary of the replaced span' }],
          source: { kind: 'user' },
        }), {
          surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
          sourceEventSeqs: [...nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1)],
        })
      },
    })
    const spy = adapterSpy({ compactionFor: () => ({ engine: engine.engine }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution('call-compact', agentOn(session))
    await expect(tools.compact.execute({}, exec)).rejects.toThrow(
      'context_compact failed: the commit was rejected. A replacement may already be on this context; read this context again before deciding what to do.',
    )
    expect(session.surface.replaceGeneration).toBe(1)
  })

  it('tells the model what was replaced, what it cost, and what the context costs now', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(renderText(tools.compact, { status: 'compacted', replaced: 3, replacedTokens: 1_200, usageTokens: 40_000 }))
      .toBe('Compacted: replaced 3 earlier messages (about 1200 tokens) with a summary. Recent work kept verbatim; this context is now about 40000 tokens.')
    // A scope without a meter states what it replaced and nothing it cannot verify.
    expect(renderText(tools.compact, { status: 'compacted', replaced: 3, replacedTokens: 1_200 }))
      .toBe('Compacted: replaced 3 earlier messages (about 1200 tokens) with a summary. Recent work kept verbatim.')
    expect(renderText(tools.compact, { status: 'nothing', reason: 'the recent tail already keeps this whole context verbatim' }))
      .toBe('Nothing safe to compact: the recent tail already keeps this whole context verbatim. This context is unchanged.')
    expect(renderText(tools.compact, { status: 'unavailable', reason: 'this agent scope mounts no compaction engine' }))
      .toBe('Compaction is not available in this scope: this agent scope mounts no compaction engine. This context is unchanged.')
  })
})

describe('renders: what the model reads', () => {
  it('names the scheduled mode in the rollover result', async () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    const { exec } = execution()
    const value = await tools.rollover.execute({ handoff: 'h' }, exec)
    expect(renderText(tools.rollover, value)).toBe('Context rollover scheduled (fresh). Finish this turn; the host switches you to the next context generation afterward.')
  })

  it('gives the checkpoint result the ref the rollover call must cite', async () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    const { exec } = execution()
    const value = await tools.checkpoint.execute({ name: 'anchor' }, exec)
    expect(renderText(tools.checkpoint, value))
      .toBe('Checkpoint recorded: anchor (ref: context-checkpoint:anchor). Work continues in the next turn; the host will continue automatically.')
  })

  it('spells out every anchor, its price, its topics, and its verdict', async () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    const { exec } = execution()
    const value = await tools.status.execute({}, exec)
    expect(renderText(tools.status, value)).toBe([
      'Context: 120,000 / 100,000 handoff',
      'Anchors: 2 rows · 1 restorable',
      '- before the extraction [source: checkpoint] (retained ~40000, discarded ~80000; no topics) — restorable — ref: context-checkpoint:alpha',
      '- the rollout Thread arrived [source: boundary — first-arrival] (retained ~90000, discarded ~30000; topics the rollout Thread) — not restorable — multiple topics entered the context by this boundary (anchor: team-boundary:7 — not selectable)',
      'History incomplete: the lineage walk stopped at Session session-lost (the stored log could not be read); ancestors before it could not be read and are not reflected above.',
    ].join('\n'))
  })

  it('does not claim an incomplete history when the walk completed', async () => {
    const spy = adapterSpy({ timeline: async () => ({ usageTokens: 1, handoffAt: 2, items: [] }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await tools.status.execute({}, exec)
    const text = renderText(tools.status, value)
    expect(text).toBe('Context: 1 / 2 handoff\nAnchors: 0 rows · 0 restorable')
    expect(text).not.toContain('History incomplete')
  })

  it('shows the hard limit beside the handoff budget when the host supplies one', async () => {
    const spy = adapterSpy({ timeline: async () => ({ ...TIMELINE, hardLimit: 150_000 }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await tools.status.execute({}, exec)
    expect(renderText(tools.status, value).split('\n')[0])
      .toBe('Context: 120,000 / 100,000 handoff / 150,000 hard limit')
    expect(outputViolations(tools.status, value)).toEqual([])
  })

  it('prices the work set when the host supplies a composition, and says it is a heuristic', async () => {
    const composition = { systemTokens: 8_192, toolsTokens: 11_264, messagesTokens: 131_072 }
    const spy = adapterSpy({ timeline: async () => ({ ...TIMELINE, composition }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await tools.status.execute({}, exec)
    const text = renderText(tools.status, value)
    expect(text.split('\n')[1]).toBe('Composition (heuristic): system ~8K · tools ~11K · messages ~131K')
    expect(outputViolations(tools.status, value)).toEqual([])
    expect((value as { readonly composition?: unknown }).composition).toEqual(composition)
  })

  it('says nothing it cannot price: no composition or compaction line without host data', async () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    const { exec } = execution()
    const value = await tools.status.execute({}, exec)
    const text = renderText(tools.status, value)
    expect(text).not.toContain('Composition')
    expect(text).not.toContain('Compact now')
    expect(Object.hasOwn(value as object, 'composition')).toBe(false)
    expect(Object.hasOwn(value as object, 'compactible')).toBe(false)
    expect(outputViolations(tools.status, value)).toEqual([])
  })

  it('reports what a compaction started now would replace, and what it keeps verbatim', async () => {
    const spy = adapterSpy({ timeline: async () => ({ ...TIMELINE, compactible: { compactibleTokens: 118_000, retainedTailTokens: 32_768 } }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await tools.status.execute({}, exec)
    expect(renderText(tools.status, value).split('\n').at(-1))
      .toBe('Compact now: about 118K compactible; keeps the last ~33K verbatim')
    expect(outputViolations(tools.status, value)).toEqual([])
  })

  it('reports a priced context with nothing safe to compact as nothing, not as a broken number', async () => {
    const spy = adapterSpy({ timeline: async () => ({ ...TIMELINE, compactible: { compactibleTokens: 0, retainedTailTokens: 120_000 } }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await tools.status.execute({}, exec)
    expect(renderText(tools.status, value).split('\n').at(-1))
      .toBe('Compact now: nothing safe to compact here; the last ~120K stays verbatim')
  })

  it('quotes a non-restorable anchor as an identifier that is not a citable ref', async () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    const { exec } = execution()
    const value = await tools.status.execute({}, exec)
    const row = renderText(tools.status, value).split('\n').find(line => line.includes('not restorable')) ?? ''
    // The row has to be nameable, and its shape has to keep saying the anchor is
    // not a selection surface: the citable `ref:` form is for restorable rows.
    expect(row).toContain('anchor: team-boundary:7')
    expect(row).toContain('not selectable')
    expect(row).not.toContain('ref:')
  })

  it('gives a run of rows that differ only by their anchor one line and every anchor', async () => {
    // A subject's context accumulates one boundary per fact that entered it, and
    // in a multi-topic context those rows are identical but for their digest.
    // Repeating the label, sizes, topics and reason once per row is length with
    // no content; the anchors themselves still have to be nameable.
    const repeated = (seq: number): ContextTimeline['items'][number] => ({
      ref: `team-boundary:${seq}`,
      label: 'Team message',
      source: 'boundary',
      kind: 'team-boundary',
      retainedTokens: 72_046,
      discardedTokens: 26_993,
      affectedTopics: ['thread:a', 'thread:b'],
      restorable: false,
      reason: 'multiple topics entered the context by this boundary',
    })
    const spy = adapterSpy({
      timeline: async () => ({
        usageTokens: 99_039,
        handoffAt: 200_000,
        items: [repeated(1), repeated(2), repeated(3)],
      }),
    })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await tools.status.execute({}, exec)
    const lines = renderText(tools.status, value).split('\n')
    expect(lines.filter(line => line.includes('Team message'))).toHaveLength(1)
    expect(lines).toContain('- 3 identical rows: Team message [source: boundary — team-boundary] (retained ~72046, discarded ~26993; topics thread:a, thread:b) — not restorable — multiple topics entered the context by this boundary (anchors: team-boundary:1, team-boundary:2, team-boundary:3 — not selectable)')
    expect(lines).not.toContain(expect.stringContaining('ref:'))
  })

  it('keeps a restorable row on its own line, however alike its neighbours are', async () => {
    // The ref a rollover has to cite is the one thing that may never be merged
    // away, so a run of alike rows is cut around every restorable one.
    const row = (ref: string, restorable: boolean): ContextTimeline['items'][number] => ({
      ref,
      label: 'Team message',
      source: 'boundary',
      retainedTokens: 10,
      discardedTokens: 20,
      affectedTopics: ['thread:a'],
      restorable,
      ...(restorable ? {} : { reason: 'multiple topics entered the context by this boundary' }),
    })
    const spy = adapterSpy({
      timeline: async () => ({ usageTokens: 1, handoffAt: 2, items: [row('team-boundary:1', false), row('context-checkpoint:keep', true), row('team-boundary:2', false)] }),
    })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const lines = renderText(tools.status, await tools.status.execute({}, exec)).split('\n')
    expect(lines).toHaveLength(5)
    expect(lines[3]).toContain('restorable — ref: context-checkpoint:keep')
    expect(lines.filter(line => line.includes('identical rows'))).toHaveLength(0)
  })
})

describe('text: a host rewords, it never weakens safety', () => {
  const CUSTOM = {
    subjectNoun: 'Team Member',
    rolloverChecklist: 'the current objective, in your own words',
    checkpointGuidance: 'Record one before a broad refactor.',
  }

  it.each([
    ['the default vocabulary', undefined],
    ['a host vocabulary', CUSTOM],
  ])('keeps the safety sentences under %s', (_label, text) => {
    const tools = createContinuityTools(adapterSpy().adapter, text)
    expect(tools.rollover.description).toContain('never synthesize, guess, or reconstruct one')
    expect(tools.rollover.description).toContain('A context change never rolls back any external effect')
    expect(tools.rollover.description).toContain('Collect or stop your background jobs before calling')
    expect(tools.checkpoint.description).toContain('A checkpoint never snapshots files, git, jobs, or any external state')
    expect(tools.checkpoint.description).toContain('Checkpoints are private context structure, not shared facts, and are never visible to other subjects.')
    expect(tools.status.description).toContain('Structural only: no transcript content.')
    expect(tools.compact.description).toContain('The log is append-only')
    expect(tools.compact.description).toContain('It never switches generation and never returns to an anchor')
    // Authorship is what separates this tool from a checkpoint return, so the
    // description has to name both modes: the subject writes the replacement, and
    // the engine writes it when the subject has no chance to.
    expect(tools.compact.description).toContain('Pass `summary` to write that replacement yourself')
    expect(tools.compact.description).toContain('omit it and the engine writes one from that stretch instead')
  })

  it('splices host prose into the descriptions it belongs to', () => {
    const tools = createContinuityTools(adapterSpy().adapter, CUSTOM)
    expect(tools.rollover.description).toContain('continue as the same Team Member in a new one')
    expect(tools.rollover.description).toContain('covering: the current objective, in your own words.')
    expect(tools.checkpoint.description).toContain('Record one before a broad refactor.')
    // The timeline now speaks the host's subject vocabulary too; only the
    // domain glossary (timelineGuidance) and the topic noun are separate knobs.
    expect(tools.status.description).toContain("this Team Member's context lineage")
  })

  it('lets a host that owns no background work drop the jobs promise', () => {
    // The engine has no job concept and never refuses a rollover over one, so the
    // sentence is a host guarantee. A host enforcing none must be able to remove
    // it rather than leave the model reading a refusal that cannot happen.
    const tools = createContinuityTools(adapterSpy().adapter, { jobsNote: '' })
    expect(tools.rollover.description).not.toContain('background jobs')
    expect(tools.rollover.description).not.toContain('is refused while jobs')
    // Everything else the rollover description carries survives the drop.
    expect(tools.rollover.description).toContain('A context change never rolls back any external effect')
  })

  it('takes a host jobs sentence without making it carry its own spacing', () => {
    const tools = createContinuityTools(adapterSpy().adapter, { jobsNote: 'Stop the build first.' })
    expect(tools.rollover.description).toContain('first. Stop the build first.')
    expect(tools.rollover.description).not.toContain('  ')
    // A blank note reads as no note: whitespace is not a sentence.
    const blank = createContinuityTools(adapterSpy().adapter, { jobsNote: '   ' })
    expect(blank.rollover.description).not.toContain('is refused while jobs')
    expect(blank.rollover.description).not.toContain('  ')
  })

  it('defaults to a domain-neutral vocabulary', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.rollover.description).toContain('continue as the same agent in a new one')
    expect(tools.rollover.description).toContain('jobs this agent owns')
    expect(tools.checkpoint.description).toContain('restorable anchor for this agent\'s context lineage')
  })

  it('keeps the jobs sentence byte-identical for the host that already relies on it', () => {
    // The Agent Team enforces this refusal and passes no jobsNote, so its
    // published prompt text has to survive the knob being introduced verbatim —
    // the sentence only became configurable, it did not change.
    const tools = createContinuityTools(adapterSpy().adapter, { subjectNoun: 'Team Member' })
    expect(tools.rollover.description).toContain(
      ' Record anything worth keeping in your private memory/notes first. Collect or stop your background jobs before calling: a rollover is refused while jobs this Team Member owns are still running.',
    )
  })

  it('keeps the declared parameter descriptions in the host vocabulary', () => {
    const tools = createContinuityTools(adapterSpy().adapter, CUSTOM)
    expect(JSON.stringify(tools.rollover.parameters)).toContain('the current objective, in your own words')
  })
})

describe('text: the delta framing and the carried-context declaration', () => {
  it('tells the model the handoff is what a fresh generation could not reconstruct', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.rollover.description).toContain('the live working state a fresh generation could not reconstruct on its own')
    expect(tools.rollover.description).toContain('do not restate them')
  })

  it('defaults carried context to the one universal truth: the subject stays the same identity', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.rollover.description).toContain('You remain the same agent across a rollover')
    const asMember = createContinuityTools(adapterSpy().adapter, { subjectNoun: 'Team Member' })
    expect(asMember.rollover.description).toContain('You remain the same Team Member across a rollover')
  })

  it('lets a host name its own durable channels in place of the default', () => {
    const carriedContext = 'Your @handle, role, private memory.md, and the Team ledger carry across a rollover — do not restate them.'
    const tools = createContinuityTools(adapterSpy().adapter, { carriedContext })
    expect(tools.rollover.description).toContain(carriedContext)
    expect(tools.rollover.description).not.toContain('You remain the same agent across a rollover')
  })
})

describe('text: the checkpoint trigger is the state being left, not the risk ahead', () => {
  // A checkpoint is cheap and buys an option, so the guidance has to cover the
  // whole family of "I might want this context back" — a long dig whose value is
  // its conclusion is the common case, and a risky refactor is one instance of
  // it. Anchoring the guidance on risk alone is what left the move unused.
  it('asks whether this context is one the subject might want back', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.checkpoint.description).toContain('one you might want back')
    expect(tools.checkpoint.description).toContain('the value will be the conclusion rather than the trail')
    expect(tools.checkpoint.description).not.toContain('noisy or risky phase')
  })

  it('says the option is cheap and the judgement stays the subject\'s', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.checkpoint.description).toContain('most checkpoints are never returned to')
    expect(tools.checkpoint.description).toContain('whether a return is worth making stays your judgement')
  })
})

describe('text: what a checkpointRef return does, which the arguments never reveal', () => {
  // The rollover description used to say only how to cite a ref safely. Nothing
  // in the tool's arguments reveals that the prefix returns word for word AND
  // the handoff is still written on top of it, so a model reading only the
  // argument docs cannot tell this move from discarding the recent work.
  it('states the shape: a verbatim prefix plus the handoff, not a discard', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.rollover.description).toContain('word for word')
    expect(tools.rollover.description).toContain('your handoff is still written and still delivered on top of it')
    expect(tools.rollover.description).toContain('you keep the base and drop the trail')
  })

  it('names the situation it is for: the value sits before the stretch being dropped', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.rollover.description).toContain('worth keeping is what came BEFORE some stretch')
    expect(tools.rollover.description).toContain('worth only the few sentences you can state')
  })

  it('says neither move deletes anything', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.rollover.description).toContain('Neither move deletes anything')
    expect(tools.rollover.description).toContain('replaces what you see rather than what was recorded')
  })

  it('keeps the checkpoint description agreeing about what comes back', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.checkpoint.description).toContain('reopens the conversation prefix through that turn, word for word')
    expect(tools.checkpoint.description).toContain('carries your handoff on top of it')
    expect(tools.checkpoint.description).toContain('nothing else about the world comes back with you')
  })
})

describe('text: the timeline vocabulary a domain-rich host needs', () => {
  it('splices host timeline guidance while keeping the structural contract', () => {
    const timelineGuidance = 'Team boundaries render as `Team message`, `Team task claim change`, or `First arrival: <refs>`.'
    const tools = createContinuityTools(adapterSpy().adapter, { timelineGuidance })
    expect(tools.status.description).toContain(timelineGuidance)
    expect(tools.status.description).toContain('Structural only: no transcript content.')
  })

  it('names the attributable subject in the host vocabulary, in both the description and the render', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter, { topicNoun: 'Thread', topicNounPlural: 'Threads' })
    expect(tools.status.description).toContain('attributable to exactly one Thread')
    expect(tools.status.description).toContain('the Threads whose facts entered your context')
    const { exec } = execution()
    const value = await tools.status.execute({}, exec)
    const text = renderText(tools.status, value)
    expect(text).toContain('no Threads')
    expect(text).toContain('Threads the rollout Thread')
    expect(text).not.toContain('no topics')
  })

  it('defaults the attributable-subject vocabulary to `topic`', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.status.description).toContain('attributable to exactly one topic')
  })
})

describe('createContinuityTools: one factory, four independent tools', () => {
  it('builds each tool from the same adapter without sharing mutable state', async () => {
    const spy = adapterSpy()
    const tools: ContinuityTools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    await tools.rollover.execute({ handoff: 'h' }, exec)
    await tools.checkpoint.execute({ name: 'anchor' }, exec)
    await tools.status.execute({}, exec)
    // This execution carries no agent, so the factory answers for itself rather
    // than reaching through the adapter for anything.
    expect(await tools.compact.execute({}, exec)).toMatchObject({ status: 'unavailable' })
    expect(spy.rollovers).toHaveLength(1)
    expect(spy.checkpoints).toHaveLength(1)
    expect(spy.timelineReads).toHaveLength(1)
    expect(spy.compactionAgents).toEqual([])
    expect(exec.concludeTurn).toHaveBeenCalledTimes(2)
  })
})
