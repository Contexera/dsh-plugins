/**
 * In-place compaction: choosing the surface span a compaction may replace. A
 * leading `system/message` is never inside the range, and the newest
 * `user/message` and everything after it stay verbatim, so a compaction can
 * never swallow the instruction that asked for it.
 * @module @contexera/dsh-context-continuity/compaction
 */

import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { CompactionAgentContext, CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContextCompactible } from './timeline.ts'

export const DEFAULT_COMPACT_RETAIN_TOKENS = 32 * 1024

export interface SurfaceNodePrice {
  readonly seq: SessionSeq
  /** Request-pressure tokens this node costs on the routed model. */
  readonly tokens: number
}

export interface SurfaceMeasurement {
  /** Current request-and-response pressure of the context. */
  readonly totalTokens: number
  /** Current surface nodes, head to tail. */
  readonly nodes: readonly SurfaceNodePrice[]
}

/**
 * Prices one Session's current surface. Structurally the Harness token meter,
 * named here so the engine can ask for a number without depending on the meter
 * package; a scope without a meter is a supported case.
 */
export interface SurfaceMeter {
  measure(session: Session): SurfaceMeasurement | undefined
}

/**
 * The compaction capability in one scope, e.g. the Harness compaction engine
 * behind `ctx.compaction`.
 */
export interface SubjectCompaction {
  /**
   * Replace one inclusive span of current surface positions with a summary.
   * Positions are surface positions, not numeric seq order. Rejects when the
   * span is missing, reversed, unbalanced, or already being compacted, and
   * leaves the surface as it was in every failing case.
   */
  compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>
}

/**
 * The compaction capability a host resolved for one calling agent's scope.
 * Resolving it is the host's job. The meter and the retention budget are
 * optional; without them the tool still compacts, keeping the newest
 * instruction and everything after it.
 */
export interface ContextCompactionScope {
  readonly engine: SubjectCompaction
  /** Present when this scope can also price its surface. */
  readonly meter?: SurfaceMeter | undefined
  /** Recent-surface budget kept verbatim; {@link DEFAULT_COMPACT_RETAIN_TOKENS} when absent. */
  readonly retainTokens?: number | undefined
}

export interface CompactionRange {
  readonly start: SessionSeq
  readonly end: SessionSeq
}

export type CompactionSelection =
  | { readonly kind: 'range'; readonly range: CompactionRange }
  | { readonly kind: 'none'; readonly reason: string }

export type CompactionAttempt =
  | {
    readonly kind: 'compacted'
    readonly range: CompactionRange
    /** How many surface nodes the summary replaced. */
    readonly replaced: number
    /** The engine's own estimate of the replaced content's size, in tokens. */
    readonly replacedTokens: number
    /** Measured context pressure after the replacement, when the scope has a meter. */
    readonly usageTokens?: number | undefined
  }
  | { readonly kind: 'none'; readonly reason: string }

function leadingSystemMessages(messages: readonly Message[]): number {
  let count = 0
  while (count < messages.length && messages[count]?.role === 'system') count += 1
  return count
}

function newestUserMessageIndex(messages: readonly Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return undefined
}

function pricedNodes(session: Session, meter: SurfaceMeter | undefined): readonly SurfaceNodePrice[] | undefined {
  if (meter === undefined) return undefined
  const priced = meter.measure(session)?.nodes
  if (priced === undefined) return undefined
  const surface = session.surface.nodes
  if (priced.length !== surface.length) return undefined
  for (let index = 0; index < surface.length; index += 1) {
    if (priced[index]?.seq !== surface[index]) return undefined
  }
  return priced
}

/**
 * The largest older stretch of the current surface that may be compacted now, or
 * why nothing may be. Every bound only shrinks the candidate range.
 */
export function selectCompactionRange(
  session: Session,
  meter: SurfaceMeter | undefined,
  retainTokens: number,
): CompactionSelection {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return { kind: 'none', reason: 'this context has no surface yet' }

  const messages = session.deriveMessages()
  const head = leadingSystemMessages(messages) + (nodes.length - messages.length)
  const instruction = newestUserMessageIndex(messages)

  let cut = nodes.length
  const priced = pricedNodes(session, meter)
  if (priced !== undefined && retainTokens > 0) {
    let retained = 0
    for (let index = priced.length - 1; index >= 0; index -= 1) {
      retained += priced[index]?.tokens ?? 0
      cut = index
      if (retained >= retainTokens) break
    }
  }
  const retainedFrom = cut
  if (instruction !== undefined && instruction < cut) cut = instruction

  let end = cut - 1
  while (end >= head && !toolPairingBalancedAfter(session, nodes[end]!)) end -= 1

  if (end < head) {
    return {
      kind: 'none',
      reason: retainedFrom <= head
        ? 'the recent tail already keeps this whole context verbatim'
        : 'this context has nothing older than its newest instruction',
    }
  }
  if (!toolPairingBalancedBefore(session, nodes[head]!)) {
    return { kind: 'none', reason: 'no safe cut keeps every tool call together with its result' }
  }
  return { kind: 'range', range: { start: nodes[head]!, end: nodes[end]! } }
}

/**
 * What a compaction started now would replace, and what it would keep verbatim.
 * Absent, rather than zero, when this scope cannot price its surface.
 */
export function compactibleNow(session: Session, scope: ContextCompactionScope): ContextCompactible | undefined {
  const meter = scope.meter
  if (meter === undefined) return undefined
  const priced = pricedNodes(session, meter)
  if (priced === undefined) return undefined
  const total = priced.reduce((sum, node) => sum + node.tokens, 0)
  const selection = selectCompactionRange(session, meter, scope.retainTokens ?? DEFAULT_COMPACT_RETAIN_TOKENS)
  if (selection.kind === 'none') return { compactibleTokens: 0, retainedTailTokens: total }

  const nodes = session.surface.nodes
  const start = nodes.indexOf(selection.range.start)
  const end = nodes.indexOf(selection.range.end)
  if (start < 0 || end < start) return undefined
  return {
    compactibleTokens: priced.slice(start, end + 1).reduce((sum, node) => sum + node.tokens, 0),
    retainedTailTokens: priced.slice(end + 1).reduce((sum, node) => sum + node.tokens, 0),
  }
}

/**
 * Compact one older stretch of the subject's context in place. Resolves with what
 * was replaced, or with why nothing was; a rejection comes from the engine and
 * means the surface was left as it was.
 */
export async function compactContextRange(
  scope: ContextCompactionScope,
  agent: Agent,
  signal: AbortSignal,
): Promise<CompactionAttempt> {
  const session = agent.session
  const selection = selectCompactionRange(session, scope.meter, scope.retainTokens ?? DEFAULT_COMPACT_RETAIN_TOKENS)
  if (selection.kind === 'none') return selection

  const result = await scope.engine.compactRegion(selection.range.start, selection.range.end, agent, signal)
  const usageTokens = scope.meter?.measure(session)?.totalTokens
  return {
    kind: 'compacted',
    range: selection.range,
    replaced: result.shadowedSeqs.length,
    replacedTokens: result.shadowedTokenCount,
    ...(usageTokens === undefined ? {} : { usageTokens }),
  }
}
