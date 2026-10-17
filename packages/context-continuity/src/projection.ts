/**
 * The context-continuity projection: the pure fold that derives a Session's
 * continuity state from its durable events. `apply` never mutates, and an event
 * this unit does not care about returns the same state reference: an unchanged
 * reference is what tells the framework to do no downstream work.
 * @module @contexera/dsh-context-continuity/projection
 */

import { z } from 'zod'
import type { SessionEvent, SessionHeader, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { isDroppedNotice, type ContextContinuityHost } from './host.ts'
import type { ContextMessageCodec } from './message-codec.ts'
import type { AnchorCandidate } from './anchor.ts'
import type {
  CarriedCandidate,
  ContextCheckpointEntry,
  ContextProjectionState,
  DomainBoundary,
  PendingRolloverIntent,
} from './projection-state.ts'

export const CONTEXT_CONTINUITY_PROJECTION_KEY = 'contextContinuity'

export const CONTEXT_ROLLOVER_TOOL_NAME = 'context_rollover'

export const CONTEXT_CHECKPOINT_TOOL_NAME = 'context_checkpoint'

/**
 * The domain contribution for one event the engine could anchor on. The host
 * returns one only when the event is worth returning to.
 */
export type DomainBoundaryInput = {
  readonly sessionId: string
  readonly seq: number
  /** Turn the event landed in; -1 when the event carries no turn. */
  readonly turn: number
  /** Topics whose first anchor already landed in this Session. */
  readonly seenTopics: readonly string[]
} & (
  | { readonly source: 'user-message'; readonly message: UserMessage }
  | { readonly source: 'tool-result'; readonly name: string; readonly arguments: string; readonly meta: unknown }
)

export interface DomainBoundaryContribution {
  /** Host-defined anchor kind, e.g. `team_message`, `loom_delivery`. */
  readonly kind: string
  readonly label: string
  /** Domain topics this boundary belongs to; recorded as seen once it lands. */
  readonly topics: readonly string[]
}

/**
 * Everything the fold asks of a host: its durable ref naming, its judgement of
 * ephemeral notices, and its own timeline anchors.
 */
export interface ContextProjectionHost extends Pick<ContextContinuityHost<never>, 'isEphemeralNotice'> {
  /**
   * The durable, collision-resistant ref of one checkpoint, derived from the
   * recording Session and the successful call id: two Sessions repeating one
   * provider call id must produce two distinct refs.
   */
  checkpointRefFor(sessionId: string, toolCallId: string): string
  /**
   * The durable ref of one host boundary at one anchoring seq. Consecutive
   * generations repeat event seqs, so the Session identity must be part of the
   * key.
   */
  boundaryRefFor(sessionId: string, seq: number): string
  /** Whether one open tool call is this host's own effect call. */
  tracksCall?(name: string, raw: string): boolean
  domainBoundaryOf?(input: DomainBoundaryInput): DomainBoundaryContribution | undefined
  /**
   * Why one of this host's own boundaries may not be entered again, or
   * `undefined` when it may: which of the host's boundary kinds close a context
   * rather than open a topic.
   */
  boundaryRestorableFor?(candidate: AnchorCandidate): string | undefined
}

export interface ContextProjectionConfig {
  /** The codec recognizing this engine's own handoff and continuation envelopes. */
  readonly codec: ContextMessageCodec
  readonly host: ContextProjectionHost
  /** Overrides the engine's own tool names, e.g. a legacy alias a host still folds. */
  readonly rolloverToolNames?: readonly string[]
  readonly checkpointToolName?: string
}

/**
 * The Session one fold covers. Its identity keys every derived ref, and the
 * inherited cut is the prefix length a seeded Session repeated from its ancestor.
 */
export interface ContextFoldTarget {
  readonly sessionId: string
  /** Omit for a Session whose log inherited no prefix. */
  readonly inheritedEventCount?: number
}

const relatedFileSchema = z.object({ path: z.string().min(1), reason: z.string() }).strict()
const openCallSchema = z.object({ callId: z.string().min(1), name: z.string(), arguments: z.string() }).strict()
const checkpointEntrySchema = z.object({
  checkpointRef: z.string().min(1),
  name: z.string(),
  resultSeq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  turnEndSeq: z.number().int(),
}).strict()
const pendingIntentSchema = z.object({
  handoff: z.string(),
  checkpointRef: z.string().min(1).optional(),
  relatedFiles: z.array(relatedFileSchema),
  toolCallId: z.string().min(1),
  resultSeq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  turnEndSeq: z.number().int(),
}).strict()
const carriedCandidateSchema = z.object({
  messageId: z.string().min(1),
  surfacedTurn: z.number().int(),
  consumed: z.boolean(),
}).strict()
const domainBoundarySchema = z.object({
  kind: z.string().min(1),
  label: z.string(),
  resultSeq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  turnEndSeq: z.number().int(),
  attributions: z.array(z.string()),
}).strict()

/**
 * The persisted-state contract. The framework validates a cached state with this
 * before seeding a fold from it, so a row written by an older shape is
 * discarded.
 */
export const contextProjectionStateSchema: z.ZodType<ContextProjectionState> = z.object({
  sessionId: z.string().min(1),
  inheritedEventCount: z.number().int().nonnegative(),
  checkpoints: z.array(checkpointEntrySchema),
  pending: pendingIntentSchema.nullable(),
  continuations: z.array(z.object({ checkpointRef: z.string().min(1), deliveredSeq: z.number().int() }).strict()),
  carriedCandidates: z.array(carriedCandidateSchema),
  lastTurn: z.number().int().nonnegative(),
  openCalls: z.array(openCallSchema),
  boundaries: z.array(domainBoundarySchema),
  seenTopics: z.array(z.string()),
  lastTurnEndSeq: z.number().int(),
}).strict()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextContinuity: ContextProjectionState
  }
}

export function emptyContextProjectionState(target: ContextFoldTarget): ContextProjectionState {
  return {
    sessionId: target.sessionId,
    inheritedEventCount: target.inheritedEventCount ?? 0,
    checkpoints: [],
    pending: null,
    continuations: [],
    carriedCandidates: [],
    lastTurn: 0,
    openCalls: [],
    boundaries: [],
    seenTopics: [],
    lastTurnEndSeq: -1,
  }
}

interface RolloverArguments {
  readonly handoff: string
  readonly checkpointRef?: string | undefined
  readonly relatedFiles: readonly { readonly path: string; readonly reason: string }[]
}

const nonBlankString = z.string().refine(value => value.trim() !== '')

const rolloverArgumentsSchema = z.object({
  handoff: nonBlankString,
  checkpointRef: z.string().min(1).optional(),
  relatedFiles: z.array(relatedFileSchema).optional(),
}).passthrough()

const checkpointArgumentsSchema = z.object({ name: nonBlankString }).passthrough()

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function parseRolloverArguments(raw: string): RolloverArguments | undefined {
  const parsed = rolloverArgumentsSchema.safeParse(parseArguments(raw))
  if (!parsed.success) return undefined
  return {
    handoff: parsed.data.handoff,
    ...(parsed.data.checkpointRef === undefined ? {} : { checkpointRef: parsed.data.checkpointRef }),
    relatedFiles: parsed.data.relatedFiles ?? [],
  }
}

function parseCheckpointName(raw: string): string | undefined {
  const parsed = checkpointArgumentsSchema.safeParse(parseArguments(raw))
  return parsed.success ? parsed.data.name : undefined
}

function createStep(config: ContextProjectionConfig): (state: ContextProjectionState, event: SessionEvent) => ContextProjectionState {
  const { codec, host } = config
  const rolloverToolNames = config.rolloverToolNames ?? [CONTEXT_ROLLOVER_TOOL_NAME]
  const checkpointToolName = config.checkpointToolName ?? CONTEXT_CHECKPOINT_TOOL_NAME

  const isRolloverCall = (name: string): boolean => rolloverToolNames.includes(name)

  const withContribution = (
    state: ContextProjectionState,
    contribution: DomainBoundaryContribution,
    seq: number,
    turn: number,
  ): ContextProjectionState => {
    const boundary: DomainBoundary = {
      kind: contribution.kind,
      label: contribution.label,
      resultSeq: seq,
      turn,
      turnEndSeq: -1,
      attributions: contribution.topics,
    }
    const unseen = contribution.topics.filter(topic => !state.seenTopics.includes(topic))
    return {
      ...state,
      boundaries: [...state.boundaries, boundary],
      seenTopics: unseen.length === 0 ? state.seenTopics : [...state.seenTopics, ...unseen],
    }
  }

  const boundaryOf = (input: DomainBoundaryInput): DomainBoundaryContribution | undefined =>
    host.domainBoundaryOf?.(input)

  const applyToolResult = (
    state: ContextProjectionState,
    event: SessionEvent & { type: 'tool/result' },
  ): ContextProjectionState => {
    const message = event.data.message
    const index = state.openCalls.findIndex(call => call.callId === message.toolCallId)
    if (index === -1) return state
    const recorded = state.openCalls[index]!
    const openCalls = state.openCalls.filter(call => call.callId !== message.toolCallId)
    if (message.isError === true || event.data.error !== undefined) return { ...state, openCalls }
    const seq = event.seq
    const turn = event.data.turn
    if (isRolloverCall(recorded.name)) {
      const parsed = parseRolloverArguments(recorded.arguments)
      if (parsed === undefined) return { ...state, openCalls }
      if (state.pending !== null && state.pending.turnEndSeq === -1) return { ...state, openCalls }
      const pending: PendingRolloverIntent = {
        handoff: parsed.handoff,
        ...(parsed.checkpointRef === undefined ? {} : { checkpointRef: parsed.checkpointRef }),
        relatedFiles: parsed.relatedFiles,
        toolCallId: recorded.callId,
        resultSeq: seq,
        turn,
        turnEndSeq: -1,
      }
      return { ...state, openCalls, pending }
    }
    if (recorded.name === checkpointToolName) {
      const name = parseCheckpointName(recorded.arguments)
      if (name === undefined) return { ...state, openCalls }
      const entry: ContextCheckpointEntry = {
        checkpointRef: host.checkpointRefFor(state.sessionId, message.toolCallId),
        name,
        resultSeq: seq,
        turn,
        turnEndSeq: -1,
      }
      return { ...state, openCalls, checkpoints: [...state.checkpoints, entry] }
    }
    const contribution = boundaryOf({
      sessionId: state.sessionId,
      seq,
      turn,
      seenTopics: state.seenTopics,
      source: 'tool-result',
      name: recorded.name,
      arguments: recorded.arguments,
      meta: event.data.meta,
    })
    if (contribution === undefined) return { ...state, openCalls }
    return withContribution({ ...state, openCalls }, contribution, seq, turn)
  }

  const applyInboxSpliced = (
    state: ContextProjectionState,
    inserted: readonly UserMessage[],
  ): ContextProjectionState => {
    if (state.pending === null || inserted.length === 0) return state
    const fresh: CarriedCandidate[] = []
    for (const message of inserted) {
      if (isDroppedNotice(codec, host, message)) continue
      if (state.carriedCandidates.some(candidate => candidate.messageId === message.id)) continue
      if (fresh.some(candidate => candidate.messageId === message.id)) continue
      fresh.push({ messageId: message.id, surfacedTurn: -1, consumed: false })
    }
    if (fresh.length === 0) return state
    return { ...state, carriedCandidates: [...state.carriedCandidates, ...fresh] }
  }

  const applyUserMessage = (
    state: ContextProjectionState,
    event: SessionEvent & { type: 'user/message' },
  ): ContextProjectionState => {
    let next = state
    const surfaced = next.carriedCandidates.some(candidate => !candidate.consumed && candidate.messageId === event.data.id)
    if (surfaced) {
      next = {
        ...next,
        carriedCandidates: next.carriedCandidates.map(candidate =>
          candidate.messageId === event.data.id && !candidate.consumed
            ? { ...candidate, surfacedTurn: next.lastTurn }
            : candidate),
      }
    }
    const contribution = boundaryOf({
      sessionId: state.sessionId,
      seq: event.seq,
      turn: next.lastTurn,
      seenTopics: next.seenTopics,
      source: 'user-message',
      message: event.data,
    })
    if (contribution !== undefined) next = withContribution(next, contribution, event.seq, next.lastTurn)
    const continuationRef = codec.continuationCheckpointRefOf(event.data)
    if (continuationRef === undefined) return next
    const existing = next.continuations.find(entry => entry.checkpointRef === continuationRef)
    if (existing !== undefined) {
      if (existing.deliveredSeq !== -1) return next
      return {
        ...next,
        continuations: next.continuations.map(entry =>
          entry.checkpointRef === continuationRef ? { ...entry, deliveredSeq: event.seq } : entry),
      }
    }
    return { ...next, continuations: [...next.continuations, { checkpointRef: continuationRef, deliveredSeq: event.seq }] }
  }

  const applyAssistantMessage = (
    state: ContextProjectionState,
    event: SessionEvent & { type: 'assistant/message' },
  ): ContextProjectionState => {
    if (state.carriedCandidates.length === 0 || event.data.interrupted === true) return state
    let changed = false
    const carriedCandidates = state.carriedCandidates.map(candidate => {
      if (candidate.consumed || candidate.surfacedTurn !== event.data.turn) return candidate
      changed = true
      return { ...candidate, consumed: true }
    })
    return changed ? { ...state, carriedCandidates } : state
  }

  const applyTurnEnd = (
    state: ContextProjectionState,
    seq: SessionSeq,
    turn: number,
  ): ContextProjectionState => {
    let changed = state.lastTurnEndSeq !== seq
    const checkpoints = state.checkpoints.map(entry => {
      if (entry.turnEndSeq !== -1) return entry
      changed = true
      return { ...entry, turnEndSeq: seq }
    })
    let pending = state.pending
    if (pending !== null && pending.turnEndSeq === -1) {
      pending = { ...pending, turnEndSeq: seq }
      changed = true
    }
    const boundaries = state.boundaries.map(entry => {
      if (entry.turnEndSeq !== -1) return entry
      changed = true
      return { ...entry, turnEndSeq: seq, turn: entry.turn === -1 ? turn : entry.turn }
    })
    return changed ? { ...state, checkpoints, pending, boundaries, lastTurnEndSeq: seq } : state
  }

  return (state, event) => {
    if (event.seq < state.inheritedEventCount) return state
    switch (event.type) {
      case 'tool/call': {
        const { name, arguments: raw } = event.data
        const tracked = isRolloverCall(name) || name === checkpointToolName || host.tracksCall?.(name, raw) === true
        if (!tracked) return state
        return { ...state, openCalls: [...state.openCalls, { callId: event.data.callId, name, arguments: raw }] }
      }
      case 'tool/result':
        return applyToolResult(state, event)
      case 'turn/start':
        return event.data.turn === state.lastTurn ? state : { ...state, lastTurn: event.data.turn }
      case 'turn/end':
        return applyTurnEnd(state, event.seq, event.data.turn)
      case 'user/message':
        return applyUserMessage(state, event)
      case 'assistant/message':
        return applyAssistantMessage(state, event)
      case 'agent/inbox/spliced':
        return applyInboxSpliced(state, event.data.inserted)
      default:
        return state
    }
  }
}

/**
 * Cold-fold one immutable event log into its continuity state, with exactly the
 * transition the live unit uses.
 */
export function foldContextProjection(
  events: readonly SessionEvent[],
  config: ContextProjectionConfig,
  target: ContextFoldTarget,
): ContextProjectionState {
  const step = createStep(config)
  let state = emptyContextProjectionState(target)
  for (const event of events) state = step(state, event)
  return state
}

/**
 * The host-only projection unit for one subject's Sessions. No wire view is
 * published: the state is read through `ctx.sessionProjections.stateOf(session,
 * key)`.
 *
 * Register it once per host: the framework keeps one unit per projection key and
 * drives it for every Session, so the definition closes over no Session
 * identity. `init` records the header's id and its fork-inherited prefix length
 * in the state.
 */
export function createContextProjectionDefinition(
  config: ContextProjectionConfig,
): ProjectionDefinition<typeof CONTEXT_CONTINUITY_PROJECTION_KEY, ContextProjectionState> {
  const step = createStep(config)
  return {
    key: CONTEXT_CONTINUITY_PROJECTION_KEY,
    stateVersion: 2,
    stateSchema: contextProjectionStateSchema,
    init: (header: SessionHeader, inheritedEventCount: SessionLogOffset): ContextProjectionState =>
      emptyContextProjectionState({ sessionId: header.id, inheritedEventCount: Number(inheritedEventCount) }),
    apply: (state, event) => step(state, event),
  }
}
