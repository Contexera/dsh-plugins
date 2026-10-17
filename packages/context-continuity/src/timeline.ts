/**
 * The continuity timeline: a subject's lineage read as one bounded, priced list
 * of return anchors. The walk starts at the current generation, follows
 * `header.parentSession` through the archived ancestors, and folds every source
 * with the same projection unit. An unmeasurable source prices as unknown, never
 * as zero.
 * @module @contexera/dsh-context-continuity/timeline
 */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { anchorCandidates, anchorRejection, retainedPrice, type AnchorCandidate, type AnchorReasonText, type AnchorSourceKind } from './anchor.ts'
import { foldContextProjection, type ContextProjectionConfig } from './projection.ts'
import type { ContextProjectionState } from './projection-state.ts'
import type { SurfaceMeasurement } from './compaction.ts'
import type { StoredSessionReadResult } from './stored-session-reader.ts'

export const DEFAULT_TIMELINE_ANCESTORS = 8

export const DEFAULT_TIMELINE_LIMIT = 12

/**
 * One generation in a subject's lineage: its durable log plus the identity the
 * fold keys on.
 */
export interface ContextTimelineSource {
  readonly sessionId: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

export type ContextTimelineSourceKind = AnchorSourceKind

/**
 * One priced return anchor. A non-restorable item is still returned with its
 * reason, because that is what the subject needs to choose a different one.
 */
export interface ContextTimelineItem {
  readonly ref: string
  /** Model-facing label: the recorded checkpoint name or the host's boundary label. */
  readonly label: string
  readonly source: ContextTimelineSourceKind
  /** The host's boundary kind, for `boundary` items — engine-opaque domain vocabulary. */
  readonly kind?: string
  /** Tokens a return would retain (the prefix through this anchor), in the source's own measurement. */
  readonly retainedTokens?: number
  /** Tokens a return would discard (the suffix after this anchor). */
  readonly discardedTokens?: number
  /** The topics a return would keep: those attributed to boundaries resolved by this anchor. */
  readonly affectedTopics: readonly string[]
  /** Whether `context_rollover` accepts this ref as a seed target. */
  readonly restorable: boolean
  /** Why this anchor is not selectable, when it is not. */
  readonly reason?: string
  /** The Session the anchor lives in; absent when it is the current generation. */
  readonly sourceSessionId?: SessionId
}

/**
 * The measured shape of a subject's work set, as the host's token meter
 * apportions it. A heuristic, never a durable fact.
 *
 * `toolsTokens` prices the tool schemas this subject was offered, not the output
 * of its tool calls: a tool result is a message and counts in `messagesTokens`.
 */
export interface ContextComposition {
  readonly systemTokens: number
  readonly toolsTokens: number
  readonly messagesTokens: number
}

/**
 * What an in-place compaction would do if it started now. Display only: the
 * compaction picks its own range and revalidates it.
 */
export interface ContextCompactible {
  /** Roughly how many tokens a compaction started now could replace; `0` when no stretch is safe. */
  readonly compactibleTokens: number
  /** Roughly how many of the newest tokens stay verbatim. */
  readonly retainedTailTokens: number
}

/** One subject's bounded structural timeline. */
export interface ContextTimeline {
  /** The current generation's measured usage, the basis every price was computed against. */
  readonly usageTokens: number
  /** The budget above which a retained context is no longer worth returning to. */
  readonly handoffAt: number
  /** The subject's hard limit, echoed back for display; the engine prices nothing against it. */
  readonly hardLimit?: number
  /** The work set's measured composition, when the host can price one. */
  readonly composition?: ContextComposition
  /** What a compaction started now could replace, when the host can price one. */
  readonly compactible?: ContextCompactible
  /** Newest first, deduplicated across generations, truncated at the requested limit. */
  readonly items: readonly ContextTimelineItem[]
  /** The unreadable ancestor that ended the walk early, when one did. */
  readonly incompleteFrom?: { readonly sessionId: SessionId; readonly reason: string }
}

/** Everything one timeline read needs; the engine supplies all policy, the host all mechanism. */
export interface ContextTimelineRequest {
  /** The generation the subject lives in now. */
  readonly current: ContextTimelineSource
  /** The fold configuration shared by every source. */
  readonly config: ContextProjectionConfig
  /** Reads one archived ancestor's stored log. */
  readonly readAncestor: (sessionId: SessionId) => Promise<StoredSessionReadResult>
  /**
   * One source's replayed measurement, in that source's own tokens and node by
   * node. Omit when no meter exists: every candidate then reports that its
   * budget cannot be proven, rather than being priced as free.
   */
  readonly measureSource?: (source: ContextTimelineSource) => SurfaceMeasurement | undefined | Promise<SurfaceMeasurement | undefined>
  /** The current generation's measured usage; the head prices against it. */
  readonly currentUsageTokens: number
  /** The retained-context budget above which a return target stops being worth selecting. */
  readonly handoffAt: number
  /** The subject's hard limit, echoed into {@link ContextTimeline.hardLimit} for display. */
  readonly hardLimit?: number
  /** How many items to return; defaults to {@link DEFAULT_TIMELINE_LIMIT}. */
  readonly limit?: number
  /** How many archived ancestors to follow; defaults to {@link DEFAULT_TIMELINE_ANCESTORS}. */
  readonly maxAncestors?: number
  /** The domain nouns the anchor reasons are worded in; omitted uses `topic`/`topics`. */
  readonly anchorText?: AnchorReasonText
}

function usableMeasurement(metered: SurfaceMeasurement | undefined): SurfaceMeasurement | undefined {
  if (metered === undefined || !Array.isArray(metered.nodes) || metered.nodes.length === 0) return undefined
  return metered
}

function itemFor(
  candidate: AnchorCandidate,
  state: ContextProjectionState,
  source: ContextTimelineSource,
  isCurrent: boolean,
  measurement: SurfaceMeasurement | undefined,
  request: ContextTimelineRequest,
): ContextTimelineItem {
  const retainedTokens = candidate.source === 'head'
    ? request.currentUsageTokens
    : retainedPrice(measurement, candidate.turnEndSeq)
  const discardedTokens = candidate.source === 'head'
    ? 0
    : retainedTokens === undefined
      ? undefined
      : isCurrent
        ? Math.max(0, request.currentUsageTokens - retainedTokens)
        : request.currentUsageTokens
  const reason = anchorRejection(candidate, retainedTokens, measurement?.totalTokens, request.handoffAt, {
    host: request.config.host,
    text: request.anchorText,
  })
  return {
    ref: candidate.ref,
    label: candidate.label,
    source: candidate.source,
    ...(candidate.kind === undefined ? {} : { kind: candidate.kind }),
    ...(retainedTokens === undefined ? {} : { retainedTokens }),
    ...(discardedTokens === undefined ? {} : { discardedTokens }),
    affectedTopics: candidate.topicsThrough,
    restorable: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    ...(isCurrent ? {} : { sourceSessionId: source.sessionId }),
  }
}

/**
 * Walk one subject's lineage and return its bounded, priced timeline. Items stay
 * in lineage order, newest generation first: seqs are per-Session, so they could
 * never order two generations against each other.
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
    const measurement = usableMeasurement(measured)
    for (const candidate of anchorCandidates(state, request.config.host, isCurrent).slice(0, limit)) {
      if (seen.has(candidate.ref)) continue
      seen.add(candidate.ref)
      items.push(itemFor(candidate, state, source, isCurrent, measurement, request))
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
