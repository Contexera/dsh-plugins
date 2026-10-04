/**
 * Context continuity: a subject's context lived as one continuous timeline
 * across many physical Session generations.
 *
 * A subject rolls forward into a fresh generation (`context_rollover`), returns
 * to a recorded anchor (`context_checkpoint` + rollover), reads where its
 * context stands (`context_status`), shortens the generation it is in without
 * leaving it (`context_compact`), recalls what it has forgotten
 * (`context_search` + `context_read`), and is told to prepare a handoff before
 * its context runs out (the context-pressure policy) — physically many Session
 * files, one continuous context in the subject's understanding. The engine owns
 * these mechanics generically; a host binds them to its own subject and domain
 * through {@link ContextContinuityHost} and {@link ContextSearchAdapter}.
 * @module @wowyuarm/dsh-context-continuity
 */

export type {
  ContextSubject,
  RolloverTrigger,
  RelatedFile,
  TransitionPlan,
  RolloverIdentity,
} from './types.ts'

export type {
  ContextCheckpointEntry,
  PendingRolloverIntent,
  ContinuationDeliveryState,
  CarriedCandidate,
  DomainBoundary,
  ContextProjectionState,
} from './projection-state.ts'
export { continuationDelivered } from './projection-state.ts'

export type { SubjectResolver, ContextContinuityHost } from './host.ts'
export { isDroppedNotice } from './host.ts'

export {
  CONTEXT_CONTINUITY_PROJECTION_KEY,
  CONTEXT_CHECKPOINT_TOOL_NAME,
  CONTEXT_ROLLOVER_TOOL_NAME,
  contextProjectionStateSchema,
  emptyContextProjectionState,
  foldContextProjection,
  createContextProjectionDefinition,
} from './projection.ts'
export type {
  ContextFoldTarget,
  ContextProjectionConfig,
  ContextProjectionHost,
  DomainBoundaryContribution,
  DomainBoundaryInput,
} from './projection.ts'

export { ContextContinuityCoordinator } from './coordinator.ts'

export {
  DEFAULT_TIMELINE_ANCESTORS,
  DEFAULT_TIMELINE_LIMIT,
  readContextTimeline,
} from './timeline.ts'
export type {
  ContextComposition,
  ContextCompactible,
  ContextTimeline,
  ContextTimelineItem,
  ContextTimelineRequest,
  ContextTimelineSource,
  ContextTimelineSourceKind,
} from './timeline.ts'

export {
  CONTEXT_COMPACT_TOOL_NAME,
  CONTEXT_STATUS_TOOL_NAME,
  MAX_HANDOFF_CHARS,
  MAX_RELATED_FILES,
  createContinuityTools,
} from './tools.ts'
export type {
  CheckpointToolRequest,
  ContinuityToolAdapter,
  ContinuityToolText,
  ContinuityTools,
  RelatedFileRequest,
  RolloverToolRequest,
} from './tools.ts'

export {
  DEFAULT_COMPACT_RETAIN_TOKENS,
  compactContextRange,
  compactibleNow,
  selectCompactionRange,
} from './compaction.ts'
export type {
  CompactionAttempt,
  CompactionRange,
  CompactionSelection,
  ContextCompactionScope,
  SubjectCompaction,
  SurfaceMeasurement,
  SurfaceMeter,
  SurfaceNodePrice,
} from './compaction.ts'

export {
  CONTEXT_SEARCH_RESULT_LIMIT,
  CONTEXT_READ_BEFORE,
  CONTEXT_READ_AFTER,
  CONTEXT_READ_EVENT_CHARS,
  readContextHit,
  searchContext,
} from './search.ts'
export type {
  ContextHitAnchor,
  ContextHitGeneration,
  ContextReadEvent,
  ContextReadRequest,
  ContextReadResult,
  ContextSearchAdapter,
  ContextSearchDrops,
  ContextSearchHit,
  ContextSearchPort,
  ContextSearchRequest,
  ContextSearchResult,
  ContextSearchScope,
  SearchScopeOption,
  SearchScopeProvider,
} from './search.ts'

export { CONTEXT_REF_PREFIX, contextRefFor, parseContextRef } from './context-ref.ts'
export type { ContextRefTarget } from './context-ref.ts'

export { createSearchTools } from './search-tools.ts'
export type { ContextSearchTools, SearchToolText } from './search-tools.ts'

export {
  ContextMessageCodec,
  HANDOFF_SECTION_NAME,
  CHECKPOINT_SECTION_NAME,
  CHECKPOINT_CONTINUATION_TEXT,
  HANDOFF_PREVIOUS_SESSION,
  HANDOFF_NEW_SESSION,
  HANDOFF_TRIGGER,
  HANDOFF_EVENT_SEQ,
  HANDOFF_CHECKPOINT,
  HANDOFF_RELATED_FILES,
} from './message-codec.ts'
export type { MessageCodecConfig, ContextHandoff } from './message-codec.ts'

export {
  StoredSessionReader,
  StoredSessionReadError,
  classifyStoredSessionFailure,
  sessionFailureOf,
} from './stored-session-reader.ts'
export type {
  StoredSessionFailureKind,
  StoredSessionFailure,
  StoredSessionInspection,
  StoredSessionReadResult,
} from './stored-session-reader.ts'

export {
  DEFAULT_GATE_IDLE_MS,
  DEFAULT_GATE_JUDGE_TIMEOUT_MS,
  DEFAULT_GATE_TOKENS,
  PRESSURE_NOTICE_SUMMARY,
  ROLLOVER_INSTRUCTION_SUMMARY,
  ContextPressurePolicy,
  contextPressureNoticeText,
  rolloverInstructionText,
} from './pressure.ts'
export type {
  PressureCompaction,
  PressureGate,
  PressureInHand,
  PressureJudgement,
  PressureLimits,
  PressureLogSpan,
  PressureNoticeText,
  PressurePolicyHost,
  PressureRelatedness,
  PressureStepDecision,
  PressureSurface,
} from './pressure.ts'
