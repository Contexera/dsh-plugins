/**
 * The three continuity tools, as one factory.
 *
 * The spec pins the split the factory exists to hold. The engine owns the
 * argument contract a schema cannot express (a non-blank handoff, the byte cap,
 * the related-file shape, a supplied `checkpointRef`), the anti-forgery gate,
 * the `concludeTurn()` timing, and the render shapes. The host owns mechanism
 * and meaning: `ContinuityToolAdapter` performs every effect, and `text`
 * replaces subject-facing wording only — never a safety-bearing sentence.
 *
 * Two layers reject, and the spec pins both. `defineTool`'s own `execute`
 * validates the declared arguments before the body runs (`ToolArgsError`: the
 * required handoff, the types, the related-file shape, a numeric limit), and the
 * body owns what a JSON Schema cannot express — blankness, the byte cap, the
 * file budget, and the anti-forgery gate. Either way the rejection is what the
 * model sees, the adapter is never touched, and the turn is never concluded.
 */
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  ToolArgsError,
  validateJsonSchemaValue,
  type JsonSchemaNode,
  type ToolDefinition,
  type ToolExecutionToken,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  MAX_HANDOFF_CHARS,
  MAX_RELATED_FILES,
  createContinuityTools,
  type CheckpointToolRequest,
  type ContinuityToolAdapter,
  type ContinuityTools,
  type RolloverToolRequest,
} from '../src/tools.ts'
import type { ContextTimeline, ContextTimelineItem } from '../src/timeline.ts'

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
function execution(callId = 'call-rollover'): { exec: ToolRunContext; concludeTurn: ReturnType<typeof vi.fn> } {
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
}

/** A recording adapter: it answers "yes, restorable" and returns the engine's own timeline. */
function adapterSpy(overrides: Partial<ContinuityToolAdapter> = {}): AdapterSpy {
  const restorableRefs: string[] = []
  const rollovers: RolloverToolRequest[] = []
  const checkpoints: CheckpointToolRequest[] = []
  const timelineReads: { readonly limit?: number }[] = []
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
    ...overrides,
  }
  return { adapter, restorableRefs, rollovers, checkpoints, timelineReads }
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
  it('names the three tools the timeline and the rollover prose refer to', () => {
    const { adapter } = adapterSpy()
    const tools = createContinuityTools(adapter)
    expect([tools.rollover.name, tools.checkpoint.name, tools.timeline.name])
      .toEqual(['context_rollover', 'context_checkpoint', 'context_timeline'])
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
      .rejects.toThrow(/not a restorable anchor this Team Member recorded; cite a ref a context_timeline listed as restorable/)
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

describe('context_timeline', () => {
  it('passes a numeric limit through and omits an absent one', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    await tools.timeline.execute({ limit: 3 }, exec)
    await tools.timeline.execute({}, exec)
    expect(spy.timelineReads).toEqual([{ limit: 3 }, {}])
  })

  it('rejects a non-numeric limit before the body runs', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    await expect(tools.timeline.execute({ limit: '3' }, exec)).rejects.toThrow(ToolArgsError)
    expect(spy.timelineReads).toEqual([])
  })

  /** What the model must be able to pick a ref from: the engine's items, copied for the output contract. */
  const EXPECTED_ITEMS = TIMELINE.items

  it('re-shapes the host timeline into plain mutable items without changing any meaning', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await valueOf<{ usageTokens: number; handoffAt: number; items: ContextTimelineItem[]; incompleteFrom?: unknown }>(
      tools.timeline, {}, exec)
    expect(value.usageTokens).toBe(TIMELINE.usageTokens)
    expect(value.handoffAt).toBe(TIMELINE.handoffAt)
    expect(value.items).toEqual(EXPECTED_ITEMS)
    expect(value.items[0]).not.toBe(EXPECTED_ITEMS[0])
    expect(value.items[1]?.affectedTopics).not.toBe(EXPECTED_ITEMS[1]?.affectedTopics)
    expect(value.items[1]?.affectedTopics).toEqual(['the rollout Thread'])
    expect(value.incompleteFrom).toEqual(TIMELINE.incompleteFrom)
    expect(outputViolations(tools.timeline, value)).toEqual([])
  })

  it('omits incompleteFrom when the lineage was complete', async () => {
    const spy = adapterSpy({ timeline: async () => ({ usageTokens: 10, handoffAt: 20, items: [] }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await valueOf<Record<string, unknown>>(tools.timeline, {}, exec)
    expect(Object.hasOwn(value, 'incompleteFrom')).toBe(false)
    expect(outputViolations(tools.timeline, value)).toEqual([])
  })

  it('is a read: it never concludes the turn', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter)
    const { exec, concludeTurn } = execution()
    await tools.timeline.execute({}, exec)
    expect(spy.timelineReads).toHaveLength(1)
    expect(concludeTurn).not.toHaveBeenCalled()
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
    const value = await tools.timeline.execute({}, exec)
    expect(renderText(tools.timeline, value)).toBe([
      'Context timeline: 120000 tokens used (handoff at 100000). 2 item(s):',
      '- before the extraction [source: checkpoint] (retained ~40000, discarded ~80000; no topics) — restorable — ref: context-checkpoint:alpha',
      '- the rollout Thread arrived [source: boundary — first-arrival] (retained ~90000, discarded ~30000; topics the rollout Thread) — not restorable — multiple topics entered the context by this boundary (anchor: team-boundary:7 — not selectable)',
      'History incomplete: the lineage walk stopped at Session session-lost (the stored log could not be read); ancestors before it could not be read and are not reflected above.',
    ].join('\n'))
  })

  it('does not claim an incomplete history when the walk completed', async () => {
    const spy = adapterSpy({ timeline: async () => ({ usageTokens: 1, handoffAt: 2, items: [] }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await tools.timeline.execute({}, exec)
    const text = renderText(tools.timeline, value)
    expect(text).toBe('Context timeline: 1 tokens used (handoff at 2). 0 item(s):')
    expect(text).not.toContain('History incomplete')
  })

  it('shows the hard limit beside the handoff budget when the host supplies one', async () => {
    const spy = adapterSpy({ timeline: async () => ({ ...TIMELINE, hardLimit: 150_000 }) })
    const tools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    const value = await tools.timeline.execute({}, exec)
    expect(renderText(tools.timeline, value).split('\n')[0])
      .toBe('Context timeline: 120000 tokens used (handoff at 100000, hard limit 150000). 2 item(s):')
    expect(outputViolations(tools.timeline, value)).toEqual([])
  })

  it('quotes a non-restorable anchor as an identifier that is not a citable ref', async () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    const { exec } = execution()
    const value = await tools.timeline.execute({}, exec)
    const row = renderText(tools.timeline, value).split('\n').find(line => line.includes('not restorable')) ?? ''
    // The row has to be nameable, and its shape has to keep saying the anchor is
    // not a selection surface: the citable `ref:` form is for restorable rows.
    expect(row).toContain('anchor: team-boundary:7')
    expect(row).toContain('not selectable')
    expect(row).not.toContain('ref:')
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
    expect(tools.timeline.description).toContain('Structural only: no transcript content.')
  })

  it('splices host prose into the descriptions it belongs to', () => {
    const tools = createContinuityTools(adapterSpy().adapter, CUSTOM)
    expect(tools.rollover.description).toContain('continue as the same Team Member in a new one')
    expect(tools.rollover.description).toContain('covering: the current objective, in your own words.')
    expect(tools.checkpoint.description).toContain('Record one before a broad refactor.')
    // The timeline now speaks the host's subject vocabulary too; only the
    // domain glossary (timelineGuidance) and the topic noun are separate knobs.
    expect(tools.timeline.description).toContain("this Team Member's context lineage")
  })

  it('defaults to a domain-neutral vocabulary', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.rollover.description).toContain('continue as the same agent in a new one')
    expect(tools.rollover.description).toContain('jobs this agent owns')
    expect(tools.checkpoint.description).toContain('restorable anchor for this agent\'s context lineage')
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

describe('text: the timeline vocabulary a domain-rich host needs', () => {
  it('splices host timeline guidance while keeping the structural contract', () => {
    const timelineGuidance = 'Team boundaries render as `Team message`, `Team task claim change`, or `First arrival: <refs>`.'
    const tools = createContinuityTools(adapterSpy().adapter, { timelineGuidance })
    expect(tools.timeline.description).toContain(timelineGuidance)
    expect(tools.timeline.description).toContain('Structural only: no transcript content.')
  })

  it('names the attributable subject in the host vocabulary, in both the description and the render', async () => {
    const spy = adapterSpy()
    const tools = createContinuityTools(spy.adapter, { topicNoun: 'Thread', topicNounPlural: 'Threads' })
    expect(tools.timeline.description).toContain('attributable to exactly one Thread')
    expect(tools.timeline.description).toContain('the Threads whose facts entered your context')
    const { exec } = execution()
    const value = await tools.timeline.execute({}, exec)
    const text = renderText(tools.timeline, value)
    expect(text).toContain('no Threads')
    expect(text).toContain('Threads the rollout Thread')
    expect(text).not.toContain('no topics')
  })

  it('defaults the attributable-subject vocabulary to `topic`', () => {
    const tools = createContinuityTools(adapterSpy().adapter)
    expect(tools.timeline.description).toContain('attributable to exactly one topic')
  })
})

describe('createContinuityTools: one factory, three independent tools', () => {
  it('builds each tool from the same adapter without sharing mutable state', async () => {
    const spy = adapterSpy()
    const tools: ContinuityTools = createContinuityTools(spy.adapter)
    const { exec } = execution()
    await tools.rollover.execute({ handoff: 'h' }, exec)
    await tools.checkpoint.execute({ name: 'anchor' }, exec)
    await tools.timeline.execute({}, exec)
    expect(spy.rollovers).toHaveLength(1)
    expect(spy.checkpoints).toHaveLength(1)
    expect(spy.timelineReads).toHaveLength(1)
    expect(exec.concludeTurn).toHaveBeenCalledTimes(2)
  })
})
