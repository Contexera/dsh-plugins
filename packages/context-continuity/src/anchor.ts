/**
 * The one return-anchor policy: which point in a generation's history may be
 * entered again, and what it costs.
 *
 * Three readers ask that question — the timeline read, a search hit's
 * enrichment, and the rollover executed later against mutable guards — and they
 * must never answer it differently: a ref one surface offers has to be a ref
 * `context_rollover` accepts. Everything here is a read-only evaluation of a
 * generation that has already been folded; nothing mutates a fold, measures a
 * source, or performs an effect.
 *
 * Two rules are deliberately separated. What an anchor *is* decides before what
 * it *costs*, so a boundary that entered the context through several topics
 * never reads as a budget problem; and an unmeasurable source is never priced
 * as free, because "the budget cannot be proven" is exactly the state in which
 * a return must not be offered.
 * @module @contexera/dsh-context-continuity/anchor
 */

import type { ContextProjectionHost } from './projection.ts'
import type { ContextProjectionState } from './projection-state.ts'
import type { SurfaceMeasurement } from './compaction.ts'

/** Which structural source produced one anchor. */
export type AnchorSourceKind = 'checkpoint' | 'boundary' | 'head'

/** One structural anchor inside one generation's folded state. */
export interface AnchorCandidate {
  /** Durable selection ref: the checkpoint ref, the host's boundary ref, or the head marker. */
  readonly ref: string
  /** Model-facing label: the recorded checkpoint name or the host's boundary label. */
  readonly label: string
  readonly source: AnchorSourceKind
  /** The host's boundary kind, for `boundary` candidates — engine-opaque domain vocabulary. */
  readonly kind?: string
  /** The seq the anchor's own event occupies. */
  readonly seq: number
  /** The completed turn the anchor resolved at, or `-1` while it is unresolved. */
  readonly turnEndSeq: number
  /**
   * The topics whose facts had entered this generation's context by this
   * anchor — what the retained prefix would carry, not what the anchor's own
   * boundary arrived with. A return target whose prefix holds a second topic's
   * facts is a seed that would have to hand off two things.
   */
  readonly topicsThrough: readonly string[]
}

/**
 * The exact cost of entering one anchor: what its seed prefix would keep,
 * priced node by node out of the source's own measurement.
 *
 * An estimate over the log's shape is not good enough here, and the number is
 * not decorative: it is what decides whether a return is offered at all. The
 * nodes are the model-visible ones, so the sum is what the successor would
 * actually pay for the prefix — whereas a share of the source's total can
 * underprice a prefix that holds an oversized tool result and misreport an
 * anchor past the budget as affordable. `undefined` when the source prices
 * nothing node by node: an unmeasurable prefix is never a cheap one.
 */
export function retainedPrice(
  measurement: SurfaceMeasurement | undefined,
  anchorTurnEndSeq: number,
): number | undefined {
  if (measurement === undefined || measurement.nodes.length === 0) return undefined
  let tokens = 0
  for (const node of measurement.nodes) if (Number(node.seq) <= anchorTurnEndSeq) tokens += node.tokens
  return tokens
}

/** The topics the host attributed to boundaries resolved by one anchor, order-stable and deduplicated. */
function topicsThrough(state: ContextProjectionState, turnEndSeq: number): readonly string[] {
  const topics: string[] = []
  for (const boundary of state.boundaries) {
    if (boundary.turnEndSeq === -1 || boundary.turnEndSeq > turnEndSeq) continue
    for (const topic of boundary.attributions) if (!topics.includes(topic)) topics.push(topic)
  }
  return topics
}

/**
 * The structural anchors of one generation, newest first: resolved checkpoints,
 * resolved host boundaries, and — when asked for — its head.
 *
 * An unresolved anchor is not a candidate: a return target must be a turn the
 * log proved completed. An archived generation's head is not one either: "the
 * current working set" is precisely what that generation is not, and its marker
 * ref would be ambiguous across sources. Callers that only need to know whether
 * a prefix *exists* still see every candidate; truncating a list for display is
 * their own decision.
 */
export function anchorCandidates(
  state: ContextProjectionState,
  host: ContextProjectionHost,
  includeHead: boolean,
): readonly AnchorCandidate[] {
  const candidates: AnchorCandidate[] = []
  for (const checkpoint of state.checkpoints) {
    if (checkpoint.turnEndSeq === -1) continue
    candidates.push({
      ref: checkpoint.checkpointRef,
      label: checkpoint.name,
      source: 'checkpoint',
      seq: checkpoint.resultSeq,
      turnEndSeq: checkpoint.turnEndSeq,
      topicsThrough: [],
    })
  }
  for (const boundary of state.boundaries) {
    if (boundary.turnEndSeq === -1) continue
    candidates.push({
      // The fold stores no boundary ref: it is derived here, from the source's
      // own identity and the anchoring seq, which is what keeps two
      // generations' identical seqs from colliding.
      ref: host.boundaryRefFor(state.sessionId, boundary.resultSeq),
      label: boundary.label,
      source: 'boundary',
      kind: boundary.kind,
      seq: boundary.resultSeq,
      turnEndSeq: boundary.turnEndSeq,
      topicsThrough: topicsThrough(state, boundary.turnEndSeq),
    })
  }
  if (includeHead && state.lastTurnEndSeq !== -1) {
    candidates.push({
      ref: `head:${state.lastTurnEndSeq}`,
      label: 'current head',
      source: 'head',
      seq: state.lastTurnEndSeq,
      turnEndSeq: state.lastTurnEndSeq,
      topicsThrough: topicsThrough(state, state.lastTurnEndSeq),
    })
  }
  return candidates.sort((a, b) => b.turnEndSeq - a.turnEndSeq || b.seq - a.seq)
}

/**
 * Why one candidate is not a selectable return anchor, or `undefined` when it
 * is. The order is deliberate: what the anchor *is* decides before what it
 * costs, so a boundary carrying two topics never reads as a budget problem.
 *
 * The topic rule reads the anchor's retained prefix rather than the boundary's
 * own attributions, because that is what a return would carry: a boundary may
 * be the first place one topic's facts surfaced while an earlier boundary
 * already carried another's, and unwinding to it hands a successor a context
 * holding both. Every surface that offers a return anchor asks here, so the
 * timeline cannot offer a ref the rollover guard refuses; and the host's own
 * rule is asked between the shared ones, because only it can say which of its
 * boundary kinds closed a context instead of opening a topic.
 */
export function anchorRejection(
  candidate: AnchorCandidate,
  retainedTokens: number,
  sourceUsage: number | undefined,
  handoffAt: number,
  host?: ContextProjectionHost,
): string | undefined {
  if (candidate.source === 'head') return 'the head is the current working set; returning to it discards nothing'
  if (sourceUsage === undefined) {
    // Never price an unknown as zero, and never let an unprovable budget look
    // like an available target.
    return 'the source Session\'s context cost cannot be measured, so the return budget cannot be proven'
  }
  if (candidate.source === 'boundary') {
    const domain = host?.boundaryRestorableFor?.(candidate)
    if (domain !== undefined) return domain
    if (candidate.topicsThrough.length !== 1) {
      return candidate.topicsThrough.length === 0
        ? 'no single topic is attributable to this boundary'
        : 'multiple topics entered the context through this boundary; write a fresh handoff instead'
    }
  }
  if (retainedTokens >= handoffAt) {
    return candidate.source === 'boundary'
      ? 'retained context would not materially shrink the working set'
      : 'retained context would be at or above the handoff budget'
  }
  return undefined
}
