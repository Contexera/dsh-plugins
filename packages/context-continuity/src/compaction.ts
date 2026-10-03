/**
 * In-place compaction: the mechanism behind `context_compact`.
 *
 * The Harness compaction engine replaces one surface span with a summary once a
 * caller names the span (`CompactionEngine.compactRegion`). Choosing the span is
 * this module's job, and the choice is the whole safety story:
 *
 * - a leading `system/message` is never inside the range;
 * - the newest `user/message` and everything after it stay verbatim, so a
 *   compaction can never swallow the instruction that asked for it;
 * - neither edge splits an assistant tool call from its result — the contract
 *   package's own pairing helpers decide that, never a rule of ours;
 * - the recent tail is priced through the scope's meter when the scope has one,
 *   so a scope without a meter still compacts, just less.
 *
 * Bounds taken from message roles are conservative, never exact: an empty
 * message projects to no message at all, so the derived history is never longer
 * than the surface node list, and a role-derived index is read as a node bound
 * in the direction that compacts less.
 *
 * The engine keeps the transaction. It revalidates both edges, takes the durable
 * compaction lock, summarizes, replaces the span on the surface, and leaves the
 * log append-only; a failure there keeps the original surface, which is why
 * nothing here has to be undone.
 * @module @wowyuarm/dsh-context-continuity/compaction
 */

import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { CompactionAgentContext, CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'

/** How much of the most recent surface a compaction keeps verbatim by default. */
export const DEFAULT_COMPACT_RETAIN_TOKENS = 32 * 1024

/** One priced surface node. */
export interface SurfaceNodePrice {
  /** Durable sequence number of the surface node. */
  readonly seq: SessionSeq
  /** Request-pressure tokens this node costs on the routed model. */
  readonly tokens: number
}

/** One measurement of a subject's current surface. */
export interface SurfaceMeasurement {
  /** Current request-and-response pressure of the context. */
  readonly totalTokens: number
  /** Current surface nodes, head to tail. */
  readonly nodes: readonly SurfaceNodePrice[]
}

/**
 * Prices one Session's current surface. This is structurally the Harness token
 * meter, named here so the engine can ask for a number without depending on the
 * meter package, and so a scope without a meter is a supported case rather than
 * a failure.
 */
export interface SurfaceMeter {
  measure(session: Session): SurfaceMeasurement | undefined
}

/**
 * The compaction capability in one scope, e.g. the Harness compaction engine
 * behind `ctx.compaction`. The narrow shape states what this module uses: the
 * engine decides everything else (validation, locking, summarization, commit).
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
 * Resolving it is the host's job: which composition supplies a compaction
 * engine, and behind which service realm, is host addressing the engine cannot
 * derive. The meter and the retention budget are optional — without them the
 * tool still compacts, keeping the newest instruction and everything after it.
 */
export interface ContextCompactionScope {
  readonly engine: SubjectCompaction
  /** Present when this scope can also price its surface. */
  readonly meter?: SurfaceMeter | undefined
  /** Recent-surface budget kept verbatim; {@link DEFAULT_COMPACT_RETAIN_TOKENS} when absent. */
  readonly retainTokens?: number | undefined
}

/** One inclusive span of current surface positions, in surface order. */
export interface CompactionRange {
  readonly start: SessionSeq
  readonly end: SessionSeq
}

/** What one selection decided: a span to compact, or why there is none. */
export type CompactionSelection =
  | { readonly kind: 'range'; readonly range: CompactionRange }
  | { readonly kind: 'none'; readonly reason: string }

/** What one compaction attempt did, or why it did nothing. */
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

/** How many system messages the derived history opens with. */
function leadingSystemMessages(messages: readonly Message[]): number {
  let count = 0
  while (count < messages.length && messages[count]?.role === 'system') count += 1
  return count
}

/** The index of the newest user message in the derived history, when there is one. */
function newestUserMessageIndex(messages: readonly Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return undefined
}

/**
 * The meter's node prices, or undefined when they no longer describe the
 * current surface. A stale measurement is not a failure: it only costs the
 * retention budget, and every structural bound still holds without it.
 */
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
 * why nothing may be.
 *
 * The bounds are applied in this order: price the recent tail from the scope's
 * meter, pull the trailing cut back to the newest user message, then retreat it
 * to a cut the pairing helpers accept. Every step only shrinks the candidate
 * range, so a bound this module cannot read exactly can never widen it.
 */
export function selectCompactionRange(
  session: Session,
  meter: SurfaceMeter | undefined,
  retainTokens: number,
): CompactionSelection {
  const nodes = session.surface.nodes
  if (nodes.length === 0) return { kind: 'none', reason: 'this context has no surface yet' }

  const messages = session.deriveMessages()
  // The range never starts on a `system/message`. Node types are not readable
  // without the deprecated synchronous event readers, so the bound comes from
  // the derived history: the leading system messages are the first ones, and
  // every node that projects to no message at all sits before the node its own
  // message names. Skipping both kinds is safe — an empty node has nothing to
  // summarize — and the bound is exact whenever no node projects to nothing.
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
  // The leading cut is balanced by construction — it follows a system message,
  // an empty node, or the start of the surface — and the engine rejects an
  // unbalanced range anyway. Checking here turns that rejection into our own
  // reason instead of an exception.
  if (!toolPairingBalancedBefore(session, nodes[head]!)) {
    return { kind: 'none', reason: 'no safe cut keeps every tool call together with its result' }
  }
  return { kind: 'range', range: { start: nodes[head]!, end: nodes[end]! } }
}

/**
 * Compact one older stretch of the subject's context in place.
 *
 * Resolves with what was replaced, or with why nothing was; a rejection comes
 * from the engine and means the surface was left as it was. The span never
 * covers the newest instruction or anything after it, and never covers a
 * leading `system/message`.
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
