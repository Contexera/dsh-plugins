/**
 * The continuity engine's compaction backend: the shipped engine with the
 * checkpoint template replaced.
 *
 * {@link DEFAULT_COMPACTION_TEMPLATE} states what a summary must preserve, but
 * stating it is not the same as being obeyed: summaries are written by whichever
 * engine a host mounts, and the shipped engine writes them from a template aimed
 * at a general coding session. Mounting this class instead is what makes the
 * template take effect, because it is the class that owns the summarization
 * call.
 *
 * Only `summarize()` differs from the base. Selection, retention, pricing, the
 * compaction lock, trigger policy and the replacement transaction are all
 * inherited unchanged — a subclass that changed those would be a different
 * backend, not a different template.
 *
 * The call is re-issued here rather than delegated. The base appends its own
 * directive to whatever input it is handed, so calling `super.summarize()` with
 * the Team template already appended would send both directives, and a model
 * follows the last one — the stock template would win silently. Re-issuing the
 * call is therefore not duplication for its own sake; it is the only way for
 * this template to be the final instruction. The cost is that the shape of that
 * auxiliary call is restated here, so a change to the base's summarization
 * sequence has to be mirrored. That coupling is the price of owning the wording,
 * and it is why this module is the one place in this package that knows a
 * concrete Harness backend.
 *
 * A host that mounts the shipped `@deepseek-ai/dsh-compaction-basic` row instead
 * keeps the shipped template. That stays a supported composition: nothing in
 * this package requires its own engine to be mounted.
 * @module @wowyuarm/dsh-context-continuity/compaction-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmError, contentHasImage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, RequestMessage, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import { DEFAULT_COMPACTION_TEMPLATE } from './compaction-template.ts'
import { pendingSummaryFor } from './pending-summary.ts'

/**
 * The replayed conversation surface this engine condenses. Mirrors
 * `SummarizationInput` from the backend: the base hands its own instance to the
 * overridden method, and this package must not import that type's module path
 * (it is not an exported subpath of the published package).
 */
export interface ContinuitySummarizationInput {
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[] | undefined
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
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

/** What the summarization call is routed to. */
interface SummarizationTarget {
  readonly provider: string
  readonly model: string
}

/**
 * The shipped compaction backend, summarizing through this package's template.
 *
 * Mount it wherever a host would mount `@deepseek-ai/dsh-compaction-basic`. The
 * engine is a Cordis service under the same name (`compaction`), so a
 * composition mounts exactly one of the two.
 *
 * The wording is a field rather than a config key on purpose. Cordis validates a
 * plugin's config against the `Config` schema it inherits, so a template key
 * would have to be added to the backend's schema — which this package cannot do
 * without taking a dependency on the schema library purely for that. A host that
 * wants different wording overrides the field in a subclass instead, which needs
 * no schema and no new dependency:
 *
 * ```ts
 * class HouseStyle extends ContinuityCompactionEngine {
 *   protected override readonly template = '...'
 * }
 * ```
 */
export class ContinuityCompactionEngine extends BasicCompactionEngine {
  /**
   * The checkpoint instruction, sent as the final user message of the
   * summarization call. A whole template rather than a section list, because the
   * section skeleton is the part worth tuning.
   */
  protected readonly template: string = DEFAULT_COMPACTION_TEMPLATE

  /**
   * Summarize the replayed region under this engine's template, or hand back the
   * summary the subject wrote for this attempt.
   *
   * A subject-authored summary is returned as an **unmarked** result: the backend
   * types allow a summarizer that identifies no `ctx.llm.stream()` call, which is
   * exactly what this is, and the transaction records it as such rather than
   * claiming a call that never happened. The routed target is still reported,
   * because that is the route the subject was working on when it wrote the text.
   *
   * The routed target is resolved exactly as the base resolves it — configured
   * summarization fields first, then the conversation's own last routed target,
   * then the agent's options — so a subject whose route differs from the
   * deployment default still summarizes on the model it is actually running.
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

/**
 * Where the summarization call goes: the configured fields when the deployment
 * set both, otherwise the conversation's own last routed target, otherwise the
 * agent's configured pair. Mirrors the base's order, because a summary routed
 * somewhere other than the conversation it condenses would price and cache
 * differently from the request it stands in for.
 */
function summarizationTarget(config: ResolvedConfig, agent: Agent): SummarizationTarget {
  if (config.summarizationProvider.length > 0) {
    return { provider: config.summarizationProvider, model: config.summarizationModel }
  }
  const routed = agent.session.requestHeader()?.config
  if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model }
  }
  const { provider, model } = agent.options
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
    return { provider, model }
  }
  throw new Error(
    'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
  )
}

/** Map a terminal summarization finish to its fail-closed error. */
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

/** Reject visual output and keep only text before the replacement is framed. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
