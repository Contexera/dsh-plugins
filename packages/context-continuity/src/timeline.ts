/**
 * The continuity timeline: a subject's lineage read as one bounded, priced list
 * of return anchors.
 *
 * One timeline spans many physical Sessions. The walk starts at the current
 * generation, follows `header.parentSession` through the archived ancestors, and
 * folds **every source with the same projection unit** — so an ancestor's
 * anchors are exactly the anchors its own log recorded, keyed by its own
 * Session (see {@link foldContextProjection}). Candidates are then deduplicated
 * by ref, priced against the *source's own* replayed measurement, and truncated
 * at the requested limit.
 *
 * Two things this module deliberately does not own:
 *
 * - **Measurement.** The engine is a pure library with no `ctx`, so the meter
 *   arrives as {@link ContextTimelineRequest.measureSource}. An unmeasurable
 *   source prices as unknown, never as zero: its candidates stay visible and
 *   say why they are not selectable, which is the fail-closed direction.
 * - **Domain meaning.** A boundary's `attributions` are the host's contribution
 *   (a Team Thread, a Loom continuity line); the engine only applies the shared
 *   rule — a boundary is a selectable default anchor exactly when it resolved
 *   at a completed turn and is attributable to exactly one topic.
 *
 * That rule and the pricing are not this module's private judgement: they live
 * in {@link anchor.ts} because a search hit's enrichment answers the same
 * question and must answer it identically.
 *
 * An unreadable ancestor ends the walk where it broke and is reported in
 * {@link ContextTimeline.incompleteFrom}: history is then complete through the
 * last listed generation and provably absent beyond it. It is never a
 * subject-availability fact, and the truncation is never silent.
 * @module @wowyuarm/dsh-context-continuity/timeline
 */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { anchorCandidates, anchorRejection, retainedEstimate, type AnchorCandidate, type AnchorSourceKind } from './anchor.ts'
import { foldContextProjection, type ContextProjectionConfig } from './projection.ts'
import type { ContextProjectionState } from './projection-state.ts'
import type { StoredSessionReadResult } from './stored-session-reader.ts'

/** How many archived ancestors one walk follows by default. */
export const DEFAULT_TIMELINE_ANCESTORS = 8

/** How many items one timeline returns by default. */
export const DEFAULT_TIMELINE_LIMIT = 12

/**
 * One generation in a subject's lineage: its durable log plus the identity the
 * fold keys on. A stored read spreads into it directly, so an ancestor source
 * is `{ sessionId, ...read.inspection }`.
 */
export interface ContextTimelineSource {
  readonly sessionId: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

/** Which structural source produced one timeline item. */
export type ContextTimelineSourceKind = AnchorSourceKind

/**
 * One priced return anchor. A non-restorable item is still returned — with its
 * reason — because "why this anchor cannot be returned to" is exactly what the
 * subject needs in order to choose a different one.
 */
export interface ContextTimelineItem {
  /** Durable selection ref: the checkpoint ref, the host's boundary ref, or the head marker. */
  readonly ref: string
  /** Model-facing label: the recorded checkpoint name or the host's boundary label. */
  readonly label: string
  readonly source: ContextTimelineSourceKind
  /** The host's boundary kind, for `boundary` items — engine-opaque domain vocabulary. */
  readonly kind?: string
  /** Tokens a return would retain (the prefix through this anchor), in the source's own measurement. */
  readonly retainedTokens: number
  /** Tokens a return would discard (the suffix after this anchor). */
  readonly discardedTokens: number
  /**
   * Topics whose facts had entered this generation's context by this anchor:
   * what the host attributed to the boundaries resolved by then. Display only —
   * the restorable rule below reads a boundary's own attributions.
   */
  readonly affectedTopics: readonly string[]
  /** Whether `context_rollover` accepts this ref as a seed target. */
  readonly restorable: boolean
  /** Why this anchor is not selectable, when it is not. */
  readonly reason?: string
  /** The Session the anchor lives in; absent when it is the current generation. */
  readonly sourceSessionId?: SessionId
}

/** One subject's bounded structural timeline. */
export interface ContextTimeline {
  /** The current generation's measured usage, the basis every price was computed against. */
  readonly usageTokens: number
  /** The budget above which a retained context is no longer worth returning to. */
  readonly handoffAt: number
  /**
   * The subject's hard limit, echoed back for display. Like `handoffAt` it is
   * the host's own number: the engine prices nothing against it and only lets a
   * reader see where the handoff budget sits relative to the wall.
   */
  readonly hardLimit?: number
  /** Newest first, deduplicated across generations, truncated at the requested limit. */
  readonly items: readonly ContextTimelineItem[]
  /** The unreadable ancestor that ended the walk early, when one did. */
  readonly incompleteFrom?: { readonly sessionId: SessionId; readonly reason: string }
}

/** Everything one timeline read needs; the engine supplies all policy, the host all mechanism. */
export interface ContextTimelineRequest {
  /** The generation the subject lives in now. */
  readonly current: ContextTimelineSource
  /** The fold configuration shared by every source — the same one the registered unit uses. */
  readonly config: ContextProjectionConfig
  /** Reads one archived ancestor's stored log; the host wraps its own stored-Session reader. */
  readonly readAncestor: (sessionId: SessionId) => Promise<StoredSessionReadResult>
  /**
   * One source's replayed token measurement, in that source's own tokens. Omit
   * when no meter exists: every candidate then reports that its budget cannot
   * be proven, rather than being priced as free.
   */
  readonly measureSource?: (source: ContextTimelineSource) => number | undefined | Promise<number | undefined>
  /** The current generation's measured usage; the head prices against it. */
  readonly currentUsageTokens: number
  /** The retained-context budget above which a return target stops being worth selecting. */
  readonly handoffAt: number
  /**
   * The subject's hard limit, echoed into {@link ContextTimeline.hardLimit} for
   * display. Omit when the host has no such limit to show.
   */
  readonly hardLimit?: number
  /** How many items to return; defaults to {@link DEFAULT_TIMELINE_LIMIT}. */
  readonly limit?: number
  /** How many archived ancestors to follow; defaults to {@link DEFAULT_TIMELINE_ANCESTORS}. */
  readonly maxAncestors?: number
}

/** The topics the host had attributed to boundaries resolved by one anchor, order-stable and deduplicated. */
function topicsThrough(state: ContextProjectionState, turnEndSeq: number): readonly string[] {
  const topics: string[] = []
  for (const boundary of state.boundaries) {
    if (boundary.turnEndSeq === -1 || boundary.turnEndSeq > turnEndSeq) continue
    for (const topic of boundary.attributions) if (!topics.includes(topic)) topics.push(topic)
  }
  return topics
}

/** Price and annotate one candidate of one source; nothing here mutates the fold. */
function itemFor(
  candidate: AnchorCandidate,
  state: ContextProjectionState,
  source: ContextTimelineSource,
  isCurrent: boolean,
  sourceUsage: number | undefined,
  request: ContextTimelineRequest,
): ContextTimelineItem {
  const retainedTokens = candidate.source === 'head'
    ? request.currentUsageTokens
    : retainedEstimate(sourceUsage ?? 0, source.events.length, candidate.turnEndSeq)
  // Returning inside the current generation replaces its suffix; returning to
  // an ancestor replaces this whole generation (an approximation: the
  // ancestor's own suffix is not part of it). Both numbers say so honestly.
  const discardedTokens = candidate.source === 'head'
    ? 0
    : isCurrent
      ? Math.max(0, request.currentUsageTokens - retainedTokens)
      : request.currentUsageTokens
  const reason = anchorRejection(candidate, retainedTokens, sourceUsage, request.handoffAt)
  return {
    ref: candidate.ref,
    label: candidate.label,
    source: candidate.source,
    ...(candidate.kind === undefined ? {} : { kind: candidate.kind }),
    retainedTokens,
    discardedTokens,
    affectedTopics: topicsThrough(state, candidate.turnEndSeq),
    restorable: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    ...(isCurrent ? {} : { sourceSessionId: source.sessionId }),
  }
}

/**
 * Walk one subject's lineage and return its bounded, priced timeline. Sources
 * are folded with the caller's {@link ContextProjectionConfig}, so a seeded
 * generation contributes only its own span and every ref stays keyed to the
 * generation that recorded it.
 *
 * Items stay in lineage order, newest generation first: seqs are per-Session,
 * so they could never order two generations against each other, and the newest
 * generation is the one the subject is living in.
 */
export async function readContextTimeline(request: ContextTimelineRequest): Promise<ContextTimeline> {
  const limit = Math.max(1, Math.trunc(request.limit ?? DEFAULT_TIMELINE_LIMIT))
  const maxAncestors = Math.max(0, Math.trunc(request.maxAncestors ?? DEFAULT_TIMELINE_ANCESTORS))
  const items: ContextTimelineItem[] = []
  const seen = new Set<string>()
  let incompleteFrom: { readonly sessionId: SessionId; readonly reason: string } | undefined

  let source = request.current
  let isCurrent = true
  let ancestorsWalked = 0
  for (;;) {
    const state = foldContextProjection(source.events, request.config, {
      sessionId: source.sessionId,
      inheritedEventCount: Number(source.inheritedEventCount),
    })
    const measured = request.measureSource === undefined ? undefined : await request.measureSource(source)
    const sourceUsage = typeof measured === 'number' && Number.isFinite(measured) ? measured : undefined
    for (const candidate of anchorCandidates(state, request.config.host, isCurrent).slice(0, limit)) {
      if (seen.has(candidate.ref)) continue
      seen.add(candidate.ref)
      items.push(itemFor(candidate, state, source, isCurrent, sourceUsage, request))
      if (items.length >= limit) break
    }
    if (items.length >= limit) break

    const parentSessionId = source.header.parentSession
    if (parentSessionId === undefined || ancestorsWalked >= maxAncestors) break
    const read = await request.readAncestor(parentSessionId)
    if (!read.ok) {
      incompleteFrom = { sessionId: parentSessionId, reason: `${read.failure.kind}: ${read.failure.detail}` }
      break
    }
    source = { sessionId: parentSessionId, ...read.inspection }
    ancestorsWalked += 1
    isCurrent = false
  }

  return {
    usageTokens: request.currentUsageTokens,
    handoffAt: request.handoffAt,
    ...(request.hardLimit === undefined ? {} : { hardLimit: request.hardLimit }),
    items,
    ...(incompleteFrom === undefined ? {} : { incompleteFrom }),
  }
}
