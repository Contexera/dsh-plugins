/**
 * The one return-anchor policy: which point in a generation's history may be
 * entered again, and what it costs. Every surface that offers a ref asks here,
 * so a ref one surface offers is a ref `context_rollover` accepts.
 * @module @contexera/dsh-context-continuity/anchor
 */

import type { ContextProjectionHost } from './projection.ts'
import type { ContextProjectionState } from './projection-state.ts'
import type { SurfaceMeasurement } from './compaction.ts'

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
  readonly seq: number
  /** The completed turn the anchor resolved at, or `-1` while it is unresolved. */
  readonly turnEndSeq: number
  /**
   * The topics whose facts had entered this generation's context by this
   * anchor: what the retained prefix would carry, not what the anchor's own
   * boundary arrived with.
   */
  readonly topicsThrough: readonly string[]
}

/**
 * The domain nouns one anchor reason is worded in; the subject reads these
 * strings, and what a host calls its topics is the host's vocabulary.
 */
export interface AnchorReasonText {
  /** How one attributable subject of a boundary is named, e.g. `topic`, `Thread`. */
  readonly topicNoun?: string
  /** The plural of {@link AnchorReasonText.topicNoun}, e.g. `topics`, `Threads`. */
  readonly topicNounPlural?: string
}

/** What one application of the shared anchor rule needs beyond the anchor itself. */
export interface AnchorRule {
  readonly host?: ContextProjectionHost | undefined
  /** The domain nouns the topic reasons are worded in; defaults to `topic`/`topics`. */
  readonly text?: AnchorReasonText | undefined
}

/**
 * The exact cost of entering one anchor: what its seed prefix would keep,
 * priced node by node out of the source's own measurement. A share of the
 * source's total would underprice a prefix holding an oversized tool result.
 * `undefined` when the source prices nothing node by node.
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
 * resolved host boundaries, and — when asked for — its head. An unresolved
 * anchor is not a candidate. An archived generation's head is not one either,
 * because its marker ref would be ambiguous across sources.
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
      topicsThrough: topicsThrough(state, checkpoint.turnEndSeq),
    })
  }
  for (const boundary of state.boundaries) {
    if (boundary.turnEndSeq === -1) continue
    candidates.push({
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
 * Why one candidate is not a selectable return anchor, or `undefined` when it is.
 * What the anchor *is* decides before what it costs, so a boundary carrying two
 * topics never reads as a budget problem.
 */
export function anchorRejection(
  candidate: AnchorCandidate,
  retainedTokens: number | undefined,
  sourceUsage: number | undefined,
  handoffAt: number,
  rule?: AnchorRule,
): string | undefined {
  if (candidate.source === 'head') return 'the head is the current working set; returning to it discards nothing'
  if (sourceUsage === undefined) {
    return 'the source Session\'s context cost cannot be measured, so the return budget cannot be proven'
  }
  if (candidate.source === 'boundary') {
    const domain = rule?.host?.boundaryRestorableFor?.(candidate)
    if (domain !== undefined) return domain
    if (candidate.topicsThrough.length !== 1) {
      const noun = rule?.text?.topicNoun ?? 'topic'
      const nouns = rule?.text?.topicNounPlural ?? `${noun}s`
      return candidate.topicsThrough.length === 0
        ? `no single ${noun} is attributable to this boundary`
        : `multiple ${nouns} entered the context through this boundary; write a fresh handoff instead`
    }
  }
  if (retainedTokens !== undefined && retainedTokens >= handoffAt) {
    return candidate.source === 'boundary'
      ? 'retained context would not materially shrink the working set'
      : 'retained context would be at or above the handoff budget'
  }
  return undefined
}
