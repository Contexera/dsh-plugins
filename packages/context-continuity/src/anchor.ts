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
 * @module @wowyuarm/dsh-context-continuity/anchor
 */

import type { ContextProjectionHost } from './projection.ts'
import type { ContextProjectionState } from './projection-state.ts'

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
  /** The boundary's own topics; empty for checkpoints and the head. */
  readonly attributions: readonly string[]
}

/**
 * Monotonic anchor-share estimate of a seed's retained cost, priced in the
 * SOURCE Session's own measurement: the fraction of the source log the seed
 * prefix covers, scaled to the source's replayed token count. The anchor
 * position is exact and the share grows monotonically toward the source's head,
 * so a large ancestor's anchor prices at the ancestor's real size even inside a
 * small current generation.
 */
export function retainedEstimate(sourceUsageTokens: number, sourceLength: number, anchorTurnEndSeq: number): number {
  if (sourceLength <= 0) return sourceUsageTokens
  const share = Math.min(1, Math.max(0, (anchorTurnEndSeq + 1) / sourceLength))
  return Math.round(sourceUsageTokens * share)
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
      attributions: [],
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
      attributions: boundary.attributions,
    })
  }
  if (includeHead && state.lastTurnEndSeq !== -1) {
    candidates.push({
      ref: `head:${state.lastTurnEndSeq}`,
      label: 'current head',
      source: 'head',
      seq: state.lastTurnEndSeq,
      turnEndSeq: state.lastTurnEndSeq,
      attributions: [],
    })
  }
  return candidates.sort((a, b) => b.turnEndSeq - a.turnEndSeq || b.seq - a.seq)
}

/**
 * Why one candidate is not a selectable return anchor, or `undefined` when it
 * is. The order is deliberate: what the anchor *is* decides before what it
 * costs, so a multi-topic boundary never reads as a budget problem.
 */
export function anchorRejection(
  candidate: AnchorCandidate,
  retainedTokens: number,
  sourceUsage: number | undefined,
  handoffAt: number,
): string | undefined {
  if (candidate.source === 'head') return 'the head is the current working set; returning to it discards nothing'
  if (sourceUsage === undefined) {
    // Never price an unknown as zero, and never let an unprovable budget look
    // like an available target.
    return 'the source Session\'s context cost cannot be measured, so the return budget cannot be proven'
  }
  if (candidate.source === 'boundary' && candidate.attributions.length !== 1) {
    return candidate.attributions.length === 0
      ? 'no single topic is attributable to this boundary'
      : 'multiple topics entered the context through this boundary; write a fresh handoff instead'
  }
  if (retainedTokens >= handoffAt) {
    return candidate.source === 'boundary'
      ? 'retained context would not materially shrink the working set'
      : 'retained context would be at or above the handoff budget'
  }
  return undefined
}
