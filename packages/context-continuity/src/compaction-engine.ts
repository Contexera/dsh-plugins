/**
 * The continuity engine's compaction backend: the shipped engine with the
 * checkpoint template replaced. The summarization call is re-issued rather than
 * delegated, because the base appends its own directive and a model follows the
 * last one; that sequence is restated here and must track Harness releases.
 * @module @contexera/dsh-context-continuity/compaction-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmError, contentHasImage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, RequestMessage, ReasoningEffortId, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import { DEFAULT_COMPACTION_TEMPLATE } from './compaction-template.ts'
import { pendingSummaryFor } from './pending-summary.ts'

/**
 * The replayed conversation surface this engine condenses. Mirrors the backend's
 * `SummarizationInput`, which is not an exported subpath of the published
 * package.
 */
export interface ContinuitySummarizationInput {
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[] | undefined
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
}

export type ContinuitySummaryResult = {
  readonly summary: ContentBlock[]
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly usage?: TokenUsage
} & (
  | { readonly rawOutput: ContentBlock[]; readonly llmStreamCall: true }
  | { readonly rawOutput?: ContentBlock[]; readonly llmStreamCall?: never }
)

interface SummarizationTarget {
  readonly provider: string
  readonly model: string
  /**
   * The effort the conversation itself was running. An adapter resolves effort as
   * `options.reasoningEffort ?? profile.reasoning` and refuses an unsupported
   * level instead of clamping, so a call that names none can fail closed on a
   * model the conversation itself was using successfully.
   */
  readonly reasoningEffort?: ReasoningEffortId | undefined
}

/**
 * The shipped compaction backend, summarizing through this package's template.
 * Mount it wherever a host would mount `@deepseek-ai/dsh-compaction-basic`: the
 * engine is a Cordis service under the same name, so a composition mounts
 * exactly one of the two.
 *
 * The wording is a field rather than a config key because Cordis validates a
 * plugin's config against the inherited `Config` schema. A host overrides it in
 * a subclass:
 *
 * ```ts
 * class HouseStyle extends ContinuityCompactionEngine {
 *   protected override readonly template = '...'
 * }
 * ```
 */
export class ContinuityCompactionEngine extends BasicCompactionEngine {
  /** The checkpoint instruction, sent as the final user message of the summarization call. */
  protected readonly template: string = DEFAULT_COMPACTION_TEMPLATE

  /**
   * Summarize the replayed region under this engine's template, or hand back the
   * summary the subject wrote for this attempt. A subject-authored summary is
   * returned unmarked, with no `ctx.llm.stream()` call identified.
   */
  protected override async summarize(
    input: ContinuitySummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<ContinuitySummaryResult> {
    const target = summarizationTarget(this.config, agent)
    const authored = pendingSummaryFor(agent.session)
    if (authored !== undefined) {
      return {
        summary: [{ type: 'text', text: authored }],
        provider: target.provider,
        model: target.model,
      }
    }
    const assembler = new BlockAssembler()
    const messages: RequestMessage[] = [
      ...input.messages,
      { role: 'user', content: [{ type: 'text', text: this.template }] },
    ]
    const options: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: this.config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)

    const failure = finishError(assembler.finish)
    if (failure !== undefined) throw failure

    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    if (!summary.some(block => block.text.trim().length > 0)) {
      throw new Error('summarization produced no text summary content')
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens: this.config.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }
}

function summarizationTarget(config: ResolvedConfig, agent: Agent): SummarizationTarget {
  if (config.summarizationProvider.length > 0) {
    return { provider: config.summarizationProvider, model: config.summarizationModel }
  }
  const routed = agent.session.requestHeader()?.config
  if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
    const chosen = agent.session.requestHeader()?.adapterDefaults?.reasoningEffort === true
      ? undefined
      : routed.reasoningEffort
    return {
      provider: routed.provider,
      model: routed.model,
      ...(chosen === undefined ? {} : { reasoningEffort: chosen }),
    }
  }
  const { provider, model, reasoningEffort } = agent.options
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
    return {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
  }
  throw new Error(
    'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
  )
}

function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}

/**
 * The default export is what a preset can mount by name: the loader takes a
 * module's default export, and a namespace object is not a plugin shape.
 */
export default ContinuityCompactionEngine
