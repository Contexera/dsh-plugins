/**
 * The continuity compaction backend: the engine that makes the template take
 * effect.
 *
 * A template states what a summary must preserve; an engine is what obeys it.
 * These tests pin the property the class exists for — the summarization request
 * this engine issues carries this package's general template as its final
 * instruction and does **not** carry the stock coding-session template, which
 * the base class would append if `summarize()` delegated to it. That failure is
 * silent in production (the model simply follows the last directive), so it is
 * asserted here rather than left to review.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  ContinuityCompactionEngine,
  type ContinuitySummarizationInput,
} from '../src/compaction-engine.ts'
import { DEFAULT_COMPACTION_TEMPLATE } from '../src/compaction-template.ts'
import { clearPendingSummary, offerPendingSummary } from '../src/pending-summary.ts'
import { conversation } from './session-fixture.ts'

/** The body the faked summarization call returns. */
const BODY = '## Objective and Current Action\n- [x] something'

/** Exposes the protected hook the tests exercise. */
class ExposedEngine extends ContinuityCompactionEngine {
  summarizeNow(
    input: ContinuitySummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): ReturnType<ContinuityCompactionEngine['summarize']> {
    return this.summarize(input, agent, signal)
  }
}

/** A host restating the checkpoint in its own words, the documented way. */
class HouseStyleEngine extends ExposedEngine {
  protected override readonly template = 'MY OWN TEMPLATE'
}

/** A context with an LLM service, and every summarization request it received. */
function backend(Engine: typeof ExposedEngine = ExposedEngine): {
  readonly engine: ExposedEngine
  readonly requests: GenerateOptions[]
} {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  const requests: GenerateOptions[] = []
  vi.spyOn(ctx.llm, 'stream').mockImplementation(async function* (
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: BODY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: BODY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  return { engine: new Engine(ctx, { auto: false }), requests }
}

/** One routed agent over a small conversation. */
function routedAgent(): Agent {
  const session = conversation({ turns: 2 })
  return { session, options: { provider: 'p', model: 'm' } } as unknown as Agent
}

/** The text of the final message in a summarization request. */
function finalInstruction(options: GenerateOptions): string {
  const last = options.messages.at(-1)
  const block = last?.content.at(-1)
  return block?.type === 'text' ? block.text : ''
}

/** Every text block in a request, joined — used to prove the stock template is absent. */
function allText(options: GenerateOptions): string {
  return options.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** The replayed region the engine is asked to condense. */
async function summarizeOnce(Engine: typeof ExposedEngine = ExposedEngine): Promise<{
  readonly options: GenerateOptions
  readonly result: Awaited<ReturnType<ExposedEngine['summarizeNow']>>
}> {
  const { engine, requests } = backend(Engine)
  const agent = routedAgent()
  const result = await engine.summarizeNow({ messages: [] }, agent)
  const options = requests[0]
  if (options === undefined) throw new Error('the engine issued no summarization request')
  return { options, result }
}

describe('the continuity compaction engine', () => {
  it('sends this package general template as the final instruction', async () => {
    const { options } = await summarizeOnce()
    expect(finalInstruction(options)).toBe(DEFAULT_COMPACTION_TEMPLATE)
  })

  it('never sends the stock coding-session template', async () => {
    // Delegating to `super.summarize()` would append the base's own directive
    // after ours, and a model follows the last one. Both headings are unique to
    // the stock template, so either appearing means the override stopped working.
    const { options } = await summarizeOnce()
    const text = allText(options)
    expect(text).not.toContain('Primary Request and Intent')
    expect(text).not.toContain('Files and Code')
  })

  it('lets a host restate the wording by subclassing', async () => {
    // The documented extension point: no config key, because Cordis validates a
    // plugin's config against a schema this package does not own.
    const { options } = await summarizeOnce(HouseStyleEngine)
    expect(finalInstruction(options)).toBe('MY OWN TEMPLATE')
  })

  it('routes through the agent when no summarization target is configured', async () => {
    const { options } = await summarizeOnce()
    expect(options.provider).toBe('p')
    expect(options.model).toBe('m')
  })

  it('marks the call as a compaction whose prefix reuses the conversation', async () => {
    const { options, result } = await summarizeOnce()
    expect(options.purpose).toBe('compaction')
    expect(result.llmStreamCall).toBe(true)
    expect(result.summary).toEqual([{ type: 'text', text: BODY }])
  })

  it('hands back the summary the subject wrote, marked as no call at all', async () => {
    // The backend's result type admits a summarizer that identifies no
    // `ctx.llm.stream()` call. A subject-authored summary is exactly that, so the
    // record must not claim a call that never happened — and no call may be made.
    const { engine, requests } = backend()
    const agent = routedAgent()
    offerPendingSummary(agent.session, 'MY OWN CHECKPOINT')
    const result = await engine.summarizeNow({ messages: [] }, agent)
    expect(result.summary).toEqual([{ type: 'text', text: 'MY OWN CHECKPOINT' }])
    expect(result.llmStreamCall).toBeUndefined()
    expect(result.rawOutput).toBeUndefined()
    expect(requests).toEqual([])
  })

  it('still reports the route the subject was working on', async () => {
    const { engine } = backend()
    const agent = routedAgent()
    offerPendingSummary(agent.session, 'MY OWN CHECKPOINT')
    const result = await engine.summarizeNow({ messages: [] }, agent)
    expect(result.provider).toBe('p')
    expect(result.model).toBe('m')
  })

  it('falls back to the template once the offered summary is cleared', async () => {
    const { engine, requests } = backend()
    const agent = routedAgent()
    offerPendingSummary(agent.session, 'MY OWN CHECKPOINT')
    clearPendingSummary(agent.session)
    const result = await engine.summarizeNow({ messages: [] }, agent)
    expect(finalInstruction(requests[0] as GenerateOptions)).toBe(DEFAULT_COMPACTION_TEMPLATE)
    expect(result.summary).toEqual([{ type: 'text', text: BODY }])
  })
})
