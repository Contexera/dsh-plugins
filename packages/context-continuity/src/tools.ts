/**
 * The model-facing continuity tools, as one factory: `context_rollover`,
 * `context_checkpoint`, `context_status`, and `context_compact`.
 *
 * These tools are the product surface, not an accessory: a subject manages its
 * own context through them and nothing else. Two halves, split by what is
 * universal and what is domain:
 *
 * - **The engine owns the contract and the safety.** Argument shape (non-blank
 *   handoff, the byte cap, the related-file list, a supplied `checkpointRef`),
 *   the anti-forgery gate, the `concludeTurn()` timing, the compaction range,
 *   and the render shapes. A host customizes prose; it never customizes safety,
 *   and a fabricated `checkpointRef` is a model-visible error rather than a
 *   silent fresh rollover.
 * - **The host owns mechanism and meaning.** {@link ContinuityToolAdapter}
 *   resolves the calling execution to its subject, asks whether a ref is
 *   restorable, performs the transition, records the checkpoint, reads the
 *   timeline, and names the compaction capability of the calling agent's scope.
 *   {@link ContinuityToolText} is the subject-facing vocabulary.
 *
 * The rollover and checkpoint tools are *thin*: they validate, hand the durable
 * intent to the adapter, and let the successful result be the fact. Every
 * lifecycle effect — the generation swap, the successor Session, the carried
 * input — happens after the result is durably appended, which is what makes a
 * half-done rollover recoverable from the log.
 * @module @wowyuarm/dsh-context-continuity/tools
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { compactContextRange, type ContextCompactionScope } from './compaction.ts'
import { brief } from './context-ref.ts'
import type { ContextCompactible, ContextComposition, ContextTimeline } from './timeline.ts'

/** The handoff byte budget; larger handoffs are rejected before they reach the log. */
export const MAX_HANDOFF_CHARS = 32 * 1024

/** How many related files one handoff may name. */
export const MAX_RELATED_FILES = 32

/** The in-place compaction tool, named where the pressure notice can cite it. */
export const CONTEXT_COMPACT_TOOL_NAME = 'context_compact'

/**
 * The status tool, named where a host's prose can cite it. It is the timeline
 * read plus the two priced facts a subject needs in order to decide what to do
 * with its context, so a host that owns the model-facing copy names this one.
 */
export const CONTEXT_STATUS_TOOL_NAME = 'context_status'

/** One related file the handoff asks the next generation to look at first. */
export interface RelatedFileRequest {
  readonly path: string
  readonly reason: string
}

/** The validated rollover intent the engine hands to its host. */
export interface RolloverToolRequest {
  readonly handoff: string
  /** Present only when the model cited a restorable anchor. */
  readonly checkpointRef?: string
  readonly relatedFiles: readonly RelatedFileRequest[]
}

/** The validated checkpoint request; `callId` is what the durable ref derives from. */
export interface CheckpointToolRequest {
  readonly name: string
  readonly callId: string
}

/** What the host must do for the tools, and everything the engine will not guess. */
export interface ContinuityToolAdapter {
  /**
   * Whether one `checkpointRef` is an anchor this subject actually recorded and
   * a timeline offered. The engine decides what to do with the answer — reject
   * as a model-visible error when `false` — so the anti-forgery rule holds for
   * every host. The verdict must agree with the timeline's own `restorable`
   * flag: one policy, two readers.
   */
  isRestorableRef(checkpointRef: string, exec: ToolRunContext): Promise<boolean>
  /**
   * Hand one validated rollover intent to the subject's lifecycle. Resolving
   * means the intent is durable (the swap itself follows at the idle boundary);
   * rejecting leaves the previous generation running, and the rejection is what
   * the model sees.
   */
  requestRollover(request: RolloverToolRequest, exec: ToolRunContext): Promise<{ readonly mode: string }>
  /** Record one checkpoint through the host's binding and running-turn fencing. */
  recordCheckpoint(request: CheckpointToolRequest, exec: ToolRunContext): Promise<{ readonly checkpointRef: string; readonly name: string }>
  /** Read the subject's bounded timeline: the anchors, usage and budgets behind `context_status`. */
  timeline(request: { readonly limit?: number }, exec: ToolRunContext): Promise<ContextTimeline>
  /**
   * The compaction capability in one calling agent's scope, or absent when this
   * composition mounts no compaction engine for it.
   *
   * The engine resolves no service of its own here: which composition supplies a
   * compaction engine, and behind which service realm, is the host's own
   * addressing. A returning `undefined` is a supported answer — the tool reports
   * "not available in this scope", never a failure, and never a silent no-op.
   */
  compactionFor(agent: Agent): ContextCompactionScope | undefined
}

/** Subject-facing wording a host may override; the engine's defaults are domain-neutral. */
export interface ContinuityToolText {
  /** How the subject is addressed, e.g. `Team Member`, `Individual`, `agent`. */
  readonly subjectNoun?: string
  /** What a handoff must cover, spliced into the rollover description. */
  readonly rolloverChecklist?: string
  /** When burying an anchor is worth it, spliced into the checkpoint description. */
  readonly checkpointGuidance?: string
  /**
   * What a rollover carries forward automatically, so the handoff need not
   * repeat it. The engine's default states the one universal truth — the
   * subject stays the same identity across the switch — and a host names its
   * own durable channels (a persistent memory file, a domain ledger, an
   * injected role) so the model writes only the irreducible delta instead of
   * re-deriving what a fresh generation already receives on its own.
   */
  readonly carriedContext?: string
  /**
   * Domain guidance spliced into the timeline description: what a host's
   * boundaries mean and how its rows read. The engine keeps the structural
   * contract and the anti-forgery/return rules; this only adds the host's own
   * glossary. Empty by default.
   */
  readonly timelineGuidance?: string
  /** How one attributable subject of a boundary is named, e.g. `topic`, `Thread`. */
  readonly topicNoun?: string
  /** The plural of {@link ContinuityToolText.topicNoun}, e.g. `topics`, `Threads`. */
  readonly topicNounPlural?: string
}

/**
 * The tools, ready to register. A host mounts the ones its composition can
 * serve: the compaction tool answers for itself when its scope has no engine,
 * while the retrieval tools are a separate factory a host mounts or not.
 */
export interface ContinuityTools {
  readonly rollover: ToolDefinition
  readonly checkpoint: ToolDefinition
  readonly status: ToolDefinition
  readonly compact: ToolDefinition
}

const DEFAULT_TEXT: Required<Omit<ContinuityToolText, 'carriedContext'>> = {
  subjectNoun: 'agent',
  rolloverChecklist: 'the current objective and the atomic action in flight; facts and evidence not already recorded elsewhere; unresolved conflicts; current external side effects and their verification state (files, git, jobs, browser state, remote calls); one explicit next step',
  checkpointGuidance: 'Record one before a noisy or risky phase — a broad refactor, an experiment whose value is unproven — when returning to the current completed state may later be useful.',
  timelineGuidance: '',
  topicNoun: 'topic',
  topicNounPlural: 'topics',
}

/**
 * What a rollover carries forward when a host names nothing more: only the one
 * fact true for every subject — it stays the same identity — so a handoff that
 * re-states who it is and its standing role is wasting the very context it is
 * trying to preserve. A host with a durable memory file or a domain ledger
 * extends this with those channels.
 */
function defaultCarriedContext(subjectNoun: string): string {
  return `You remain the same ${subjectNoun} across a rollover: your identity and standing role carry forward automatically — do not restate them.`
}

/**
 * The rollover intent's own contract, worded as the model must read it. Two
 * sentences are not host knobs: the anti-forgery sentence (a synthesized ref is
 * the one input that could silently produce a context the subject never had),
 * and the delta framing — the handoff is what a fresh generation could not
 * reconstruct on its own, not a full state dump that repeats what carries
 * forward.
 */
function rolloverDescription(text: Required<ContinuityToolText>): string {
  return `context_rollover: end this context generation and continue as the same ${text.subjectNoun} in a new one. Without checkpointRef the context starts fresh and empty, seeded only by your handoff — the default, cheapest path at context pressure, and the right choice for ordinary generation changes and pressure-driven handoffs. Omit checkpointRef unless you are deliberately returning to a restorable anchor you just selected from a context_status result: supply a checkpointRef only when that status listed it as restorable and you are citing its exact ref — never synthesize, guess, or reconstruct one; a fabricated ref rejects as a model-visible error. ${text.carriedContext} Write the handoff as the live working state a fresh generation could not reconstruct on its own, as one prose string covering: ${text.rolloverChecklist}. A context change never rolls back any external effect — describe current state so the next generation can re-verify. Record anything worth keeping in your private memory/notes first. Collect or stop your background jobs before calling: a rollover is refused while jobs this ${text.subjectNoun} owns are still running.`
}

function checkpointDescription(text: Required<ContinuityToolText>): string {
  return `context_checkpoint: record a named checkpoint at the end of the current turn — an opaque, private, restorable anchor for this ${text.subjectNoun}'s context lineage. ${text.checkpointGuidance} The checkpoint resolves only when this turn completes; the host continues work in the next turn automatically. A checkpoint never snapshots files, git, jobs, or any external state: returning to one (via context_rollover with its checkpointRef) resumes the conversation prefix and nothing else. Checkpoints are private context structure, not shared facts, and are never visible to other subjects.`
}

/**
 * What the status tool is for, worded the way the model must read it. The
 * sentence that decides whether the tool is ever used is the one naming when to
 * call it: a tool the model believes it may only open when it has already
 * decided to return somewhere stays invisible exactly when a look at the status
 * would have told it what to do. So the trigger is a situation — a boundary, a
 * long gap, not knowing where you stand — and not an intention, while the
 * safety sentences about citing a ref stay with it.
 */
function statusDescription(text: Required<ContinuityToolText>): string {
  const guidance = text.timelineGuidance === '' ? '' : ` ${text.timelineGuidance}`
  return `context_status: read where this ${text.subjectNoun}'s context stands before deciding what to do with it — tokens used against the handoff budget and the hard limit, the composition of the work set, how much is compactible now and how much of the recent tail stays verbatim, and the anchors in this ${text.subjectNoun}'s context lineage with which ones are restorable. The anchors are the structural timeline: the named checkpoints recorded, the boundaries the host contributed (a fact that entered your context and is worth returning to), and the current head — across the current generation and its archived ancestors.${guidance} Every row carries approximate retained/discarded token estimates and the ${text.topicNounPlural} whose facts entered your context by that anchor. An anchor is a selectable default exactly when it resolved at a completed turn and is attributable to exactly one ${text.topicNoun}; an anchor that is not selectable states its reason. Call it at a boundary, after a long gap, or when you are unsure where you stand. Structural only: no transcript content. A fresh context_rollover (no checkpointRef) never requires reading this status first — call it directly; cite a checkpointRef only when this status listed that exact ref as restorable.`
}

/**
 * What the compaction tool is for, worded the way the model must read it. Three
 * facts are not negotiable in any host's rewrite: the replacement is of what the
 * subject sees rather than of what was recorded, it never switches generation,
 * and the result states what happened instead of implying success.
 */
function compactDescription(): string {
  return 'context_compact: shorten this context generation in place. One stretch of older history behind you is replaced by a summary; your most recent work stays verbatim. The log is append-only — the summary replaces what you see, not what was recorded. Call it right after you close a piece of work and this context has grown large. It never switches generation and never returns to an anchor: use context_rollover for those. The result names the stretch that was replaced and what it cost, or says there was nothing safe to compact; a failure says so and reports whether this context changed.'
}

/**
 * What the model reads back. The replaced count and price come from the engine's
 * own accounting, and the measured total is stated only when the scope can
 * measure one — a number this tool cannot verify is worse than no number.
 */
function renderCompaction(value: {
  readonly status: string
  readonly replaced?: number | undefined
  readonly replacedTokens?: number | undefined
  readonly usageTokens?: number | undefined
  readonly reason?: string | undefined
}): string {
  if (value.status === 'compacted') {
    const usage = value.usageTokens === undefined ? '' : `; this context is now about ${value.usageTokens} tokens`
    return `Compacted: replaced ${value.replaced ?? 0} earlier messages (about ${value.replacedTokens ?? 0} tokens) with a summary. Recent work kept verbatim${usage}.`
  }
  if (value.status === 'nothing') {
    return `Nothing safe to compact: ${value.reason ?? 'no reason given'}. This context is unchanged.`
  }
  return `Compaction is not available in this scope: ${value.reason ?? 'no reason given'}. This context is unchanged.`
}

/** One non-blank string the model supplied, or a rejection naming what was wrong. */
function requireNonBlank(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message)
  return value
}

/**
 * The related files one rollover call named, validated entry by entry: the
 * Harness schema rejects at the execute boundary, and this body adds what a
 * schema cannot express — a blank path or reason must never enter the handoff
 * envelope as an empty field.
 */
function relatedFilesOf(input: unknown): readonly RelatedFileRequest[] {
  if (!Array.isArray(input)) return []
  if (input.length > MAX_RELATED_FILES) throw new Error(`context_rollover accepts at most ${MAX_RELATED_FILES} related files`)
  const files: RelatedFileRequest[] = []
  for (const [index, entry] of input.entries()) {
    if (typeof entry !== 'object' || entry === null) throw new Error(`context_rollover relatedFiles[${index}] must be an object with path and reason`)
    const candidate = entry as { readonly path?: unknown; readonly reason?: unknown }
    files.push({
      path: requireNonBlank(candidate.path, `context_rollover relatedFiles[${index}].path must be a non-empty string`),
      reason: requireNonBlank(candidate.reason, `context_rollover relatedFiles[${index}].reason must be a non-empty string`),
    })
  }
  return files
}

/**
 * One timeline item as the output schema declares it — structurally the engine's
 * own {@link ContextTimelineItem}, with the host boundary kind and the reason
 * left open because the schema types them as plain strings.
 */
interface TimelineRenderItem {
  readonly ref: string
  readonly label: string
  readonly source: string
  readonly kind?: string | undefined
  readonly retainedTokens: number
  readonly discardedTokens: number
  readonly affectedTopics: readonly string[]
  readonly restorable: boolean
  readonly reason?: string | undefined
}

/**
 * A token count with thousands separators: the status line is the one place a
 * subject compares three six-digit numbers, and unseparated digits there are a
 * reading cost with no upside.
 */
function separated(tokens: number): string {
  return String(Math.round(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * A token count rounded to thousands, for the lines that are estimates by
 * nature. Small counts stay exact rather than reading as `~0K`.
 */
function approxTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : `${Math.round(tokens)}`
}

/**
 * Whether two rows would render the same line except for their anchor digest.
 * A subject's context routinely accumulates runs of these — one boundary per
 * fact that entered it, all attributable to the same several topics, all
 * non-restorable for the same reason — and printing each one spells the same
 * label, sizes, topics and reason once per row while saying nothing new.
 *
 * Only non-restorable rows may collapse: a restorable row's line is where the
 * ref a rollover must cite is spelled out, so those are never merged.
 */
function sameRowButForAnchor(a: TimelineRenderItem, b: TimelineRenderItem): boolean {
  return !a.restorable && !b.restorable
    && a.label === b.label
    && a.source === b.source
    && a.kind === b.kind
    && a.reason === b.reason
    && a.retainedTokens === b.retainedTokens
    && a.discardedTokens === b.discardedTokens
    && a.affectedTopics.join('\u0000') === b.affectedTopics.join('\u0000')
}

/**
 * The status result, spelled the way the model must read it: the three budget
 * numbers first, then the work set's composition and the anchor count, then one
 * row per anchor — a restorable anchor spells out the ref the rollover call has
 * to cite, and a non-restorable one states its reason and quotes its own anchor
 * as an identifier that is explicitly not selectable, because a reader has to be
 * able to name the row it is being told it cannot return to.
 *
 * Rows that differ only by their anchor share one line and list every anchor
 * they cover, so the naming guarantee above holds for the run as a whole. What
 * a reader loses is nothing: those rows are the same fact repeated.
 *
 * The two priced blocks are rendered only when the host supplied them: a host
 * with no meter, or a scope with no compaction engine, says nothing rather than
 * showing a zero it cannot prove.
 */
function renderTimeline(value: {
  readonly usageTokens: number
  readonly handoffAt: number
  readonly hardLimit?: number | undefined
  readonly composition?: ContextComposition | undefined
  readonly compactible?: ContextCompactible | undefined
  readonly items: readonly TimelineRenderItem[]
  readonly incompleteFrom?: { readonly sessionId: string; readonly reason: string } | undefined
}, topicNounPlural: string): ContentBlock[] {
  const hardLimit = value.hardLimit === undefined ? '' : ` / ${separated(value.hardLimit)} hard limit`
  const lines = [`Context: ${separated(value.usageTokens)} / ${separated(value.handoffAt)} handoff${hardLimit}`]
  if (value.composition !== undefined) {
    const { systemTokens, toolsTokens, messagesTokens } = value.composition
    lines.push(`Composition (heuristic): system ~${approxTokens(systemTokens)} · tools ~${approxTokens(toolsTokens)} · messages ~${approxTokens(messagesTokens)}`)
  }
  const restorable = value.items.filter(item => item.restorable).length
  lines.push(`Anchors: ${value.items.length} rows · ${restorable} restorable`)
  for (let index = 0; index < value.items.length;) {
    const item = value.items[index]!
    let end = index + 1
    while (end < value.items.length && sameRowButForAnchor(item, value.items[end]!)) end += 1
    const run = value.items.slice(index, end)
    const topics = item.affectedTopics.length === 0 ? `no ${topicNounPlural}` : `${topicNounPlural} ${item.affectedTopics.join(', ')}`
    const kind = item.kind === undefined ? '' : ` — ${item.kind}`
    const head = run.length === 1
      ? item.label
      : `${run.length} identical rows: ${item.label}`
    const verdict = item.restorable
      ? `restorable — ref: ${item.ref}`
      : `not restorable — ${item.reason ?? 'no reason given'} (anchor${run.length === 1 ? '' : 's'}: ${run.map(row => brief(row.ref)).join(', ')} — not selectable)`
    lines.push(`- ${head} [source: ${item.source}${kind}] (retained ~${item.retainedTokens}, discarded ~${item.discardedTokens}; ${topics}) — ${verdict}`)
    index = end
  }
  if (value.incompleteFrom !== undefined) {
    lines.push(`History incomplete: the lineage walk stopped at Session ${value.incompleteFrom.sessionId} (${value.incompleteFrom.reason}); ancestors before it could not be read and are not reflected above.`)
  }
  if (value.compactible !== undefined) {
    const { compactibleTokens, retainedTailTokens } = value.compactible
    lines.push(compactibleTokens > 0
      ? `Compact now: about ${approxTokens(compactibleTokens)} compactible; keeps the last ~${approxTokens(retainedTailTokens)} verbatim`
      : `Compact now: nothing safe to compact here; the last ~${approxTokens(retainedTailTokens)} stays verbatim`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Build the four continuity tools for one host.
 *
 * The adapter is the host's half: it resolves the calling execution to its
 * subject and performs the effects. `text` only replaces subject-facing
 * wording — the safety-bearing sentences stay in the engine.
 */
export function createContinuityTools(adapter: ContinuityToolAdapter, text: ContinuityToolText = {}): ContinuityTools {
  const wording: Required<ContinuityToolText> = {
    subjectNoun: text.subjectNoun ?? DEFAULT_TEXT.subjectNoun,
    rolloverChecklist: text.rolloverChecklist ?? DEFAULT_TEXT.rolloverChecklist,
    checkpointGuidance: text.checkpointGuidance ?? DEFAULT_TEXT.checkpointGuidance,
    carriedContext: text.carriedContext ?? defaultCarriedContext(text.subjectNoun ?? DEFAULT_TEXT.subjectNoun),
    timelineGuidance: text.timelineGuidance ?? DEFAULT_TEXT.timelineGuidance,
    topicNoun: text.topicNoun ?? DEFAULT_TEXT.topicNoun,
    topicNounPlural: text.topicNounPlural ?? DEFAULT_TEXT.topicNounPlural,
  }

  const rollover = defineTool({
    name: 'context_rollover',
    description: rolloverDescription(wording),
    parameters: {
      handoff: { type: 'string', required: true, description: `Prose handoff for the next context generation — the live working state it could not reconstruct on its own: ${wording.rolloverChecklist}.` },
      checkpointRef: { type: 'string', description: 'Optional. Omit for the default fresh rollover — ordinary generation changes and pressure-driven handoffs must not supply this. Provide it only to resume from a restorable anchor you just selected in a context_status result, citing that exact ref; never synthesize or guess a ref.' },
      relatedFiles: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, reason: { type: 'string', required: true } } }, description: 'Workspace paths the next generation should look at first, each with one reason.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', required: true }, status: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Context rollover scheduled (${value.mode}). Finish this turn; the host switches you to the next context generation afterward.` }],
    },
    async execute(args, exec) {
      const handoff = typeof args.handoff === 'string' ? args.handoff : ''
      if (handoff.trim() === '') throw new Error('context_rollover requires a non-empty handoff')
      if (handoff.length > MAX_HANDOFF_CHARS) throw new Error(`context_rollover handoff exceeds ${MAX_HANDOFF_CHARS} characters`)
      const relatedFiles = relatedFilesOf(args.relatedFiles)
      // The declared schema rejects a wrong type but cannot express "non-blank":
      // a blank string would otherwise read as absent, and an absent ref means
      // "fresh" — not what the model asked for.
      const supplied = Object.hasOwn(args, 'checkpointRef') ? (args as { readonly checkpointRef?: unknown }).checkpointRef : undefined
      if (supplied !== undefined && (typeof supplied !== 'string' || supplied.trim() === '')) {
        throw new Error('context_rollover checkpointRef must be a non-empty string when supplied')
      }
      const checkpointRef = typeof supplied === 'string' ? supplied.trim() : undefined
      if (checkpointRef !== undefined && !await adapter.isRestorableRef(checkpointRef, exec)) {
        throw new Error(`context_rollover checkpointRef ${checkpointRef} is not a restorable anchor this ${wording.subjectNoun} recorded; cite a ref a context_status listed as restorable, or omit checkpointRef for a fresh generation`)
      }
      const outcome = await adapter.requestRollover({
        handoff,
        ...(checkpointRef === undefined ? {} : { checkpointRef }),
        relatedFiles,
      }, exec)
      // The intent is durable; closing the turn here is what lets the swap land
      // at the idle boundary in model order.
      exec.concludeTurn()
      return { mode: outcome.mode, status: 'scheduled' }
    },
  })

  const checkpoint = defineTool({
    name: 'context_checkpoint',
    description: checkpointDescription(wording),
    parameters: {
      name: { type: 'string', required: true, description: 'Short semantic label for this checkpoint, shown in context_status.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { checkpointRef: { type: 'string', required: true }, name: { type: 'string', required: true } } },
      // The ref is the selection surface for `context_rollover`: rendering only
      // the name would leave the model with no legitimate way to cite the anchor
      // it just recorded, and renders are the only channel results reach it.
      render: (_args, value) => [{ type: 'text', text: `Checkpoint recorded: ${value.name} (ref: ${value.checkpointRef}). Work continues in the next turn; the host will continue automatically.` }],
    },
    async execute(args, exec) {
      const name = requireNonBlank(args.name, 'context_checkpoint requires a non-empty name')
      const outcome = await adapter.recordCheckpoint({ name, callId: exec.callId }, exec)
      exec.concludeTurn()
      return { checkpointRef: outcome.checkpointRef, name: outcome.name }
    },
  })

  const status = defineTool({
    name: CONTEXT_STATUS_TOOL_NAME,
    description: statusDescription(wording),
    parameters: {
      limit: { type: 'number', description: 'Maximum number of items to return (default 12, at most 24).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        usageTokens: { type: 'number', required: true },
        handoffAt: { type: 'number', required: true },
        hardLimit: { type: 'number' },
        composition: { type: 'object', additionalProperties: false, properties: {
          systemTokens: { type: 'number', required: true },
          toolsTokens: { type: 'number', required: true },
          messagesTokens: { type: 'number', required: true },
        } },
        compactible: { type: 'object', additionalProperties: false, properties: {
          compactibleTokens: { type: 'number', required: true },
          retainedTailTokens: { type: 'number', required: true },
        } },
        items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          ref: { type: 'string', required: true },
          label: { type: 'string', required: true },
          source: { type: 'string', required: true },
          kind: { type: 'string' },
          retainedTokens: { type: 'number', required: true },
          discardedTokens: { type: 'number', required: true },
          affectedTopics: { type: 'array', required: true, items: { type: 'string' } },
          restorable: { type: 'boolean', required: true },
          reason: { type: 'string' },
          sourceSessionId: { type: 'string' },
        } } },
        incompleteFrom: { type: 'object', additionalProperties: false, properties: {
          sessionId: { type: 'string', required: true },
          reason: { type: 'string', required: true },
        } },
      } },
      // The item list is the whole decision surface: without each anchor's ref,
      // label, size estimates, topics and restorable verdict, the model cannot
      // pick a ref for `context_rollover`.
      render: (_args, value) => renderTimeline(value, wording.topicNounPlural),
    },
    async execute(args, exec) {
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      const result = await adapter.timeline({ ...(limit === undefined ? {} : { limit }) }, exec)
      // The host result is deeply immutable; the tool output contract carries
      // plain mutable arrays, so re-shape without changing any meaning.
      return {
        usageTokens: result.usageTokens,
        handoffAt: result.handoffAt,
        ...(result.hardLimit === undefined ? {} : { hardLimit: result.hardLimit }),
        ...(result.composition === undefined ? {} : { composition: { ...result.composition } }),
        ...(result.compactible === undefined ? {} : { compactible: { ...result.compactible } }),
        items: result.items.map(item => ({ ...item, affectedTopics: [...item.affectedTopics] })),
        ...(result.incompleteFrom === undefined ? {} : { incompleteFrom: result.incompleteFrom }),
      }
    },
  })

  const compact = defineTool({
    name: CONTEXT_COMPACT_TOOL_NAME,
    description: compactDescription(),
    // No arguments in this version: the subject says "shorten this context", and
    // how much of it is safe to replace is the engine's own decision.
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', required: true },
        replaced: { type: 'number' },
        replacedTokens: { type: 'number' },
        usageTokens: { type: 'number' },
        reason: { type: 'string' },
      } },
      render: (_args, value) => [{ type: 'text', text: renderCompaction(value) }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        return { status: 'unavailable', reason: 'this call carries no agent, so it has no context to shorten' }
      }
      const scope = adapter.compactionFor(agent)
      if (scope === undefined) {
        return { status: 'unavailable', reason: 'this agent scope mounts no compaction engine' }
      }
      // The durable surface is the only witness that can tell a failed
      // transaction from one that already replaced part of its span, so the
      // failure text claims "unchanged" only where that witness agrees.
      const generation = agent.session.surface.replaceGeneration
      let attempt: Awaited<ReturnType<typeof compactContextRange>>
      try {
        attempt = await compactContextRange(scope, agent, exec.signal)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const unchanged = agent.session.surface.replaceGeneration === generation
        throw new Error(`context_compact failed: ${detail}. ${unchanged
          ? 'This context is unchanged.'
          : 'A replacement may already be on this context; read this context again before deciding what to do.'}`)
      }
      if (attempt.kind === 'none') return { status: 'nothing', reason: attempt.reason }
      return {
        status: 'compacted',
        replaced: attempt.replaced,
        replacedTokens: attempt.replacedTokens,
        ...(attempt.usageTokens === undefined ? {} : { usageTokens: attempt.usageTokens }),
      }
    },
  })

  return { rollover, checkpoint, status, compact }
}
