/**
 * The one context-pressure policy: when a subject near its budget is told to
 * prepare a handoff, and what happens at the hard limit.
 *
 * Two thresholds, one order, and no host-side re-derivation of either. Below the
 * handoff budget nothing happens. At it, one structured notice is steered into
 * the running turn — once per generation, latched by durable Session evidence
 * rather than process state, so a restart stays quiet and a rollover re-arms.
 * At the hard limit the request is forced through a reduction first and fails
 * closed unless that reduction is *proven*: the durable surface advanced, or
 * pressure measurably fell. A subject whose route capacity cannot be resolved is
 * refused rather than treated as unbounded.
 *
 * What the notice says about work in hand is the host's vocabulary (a Team
 * Member has Claims and jobs; another subject has whatever it has), and so are
 * the meter, the compaction capability, and the steer itself. What the notice
 * must say — the measured numbers, the default action, and the discipline of
 * recording durable knowledge before switching — is the engine's, because a
 * subject that loses context without those has lost work.
 *
 * The notice's `source.summary` is frozen: hosts read their own history back,
 * and a notice already in a live log has to keep decoding as one. It rides the
 * host's own producer kind — format V4 admits nothing else — and the latch
 * below recognizes both that kind and the read-time conversion of the released
 * rows written before it.
 * @module @wowyuarm/dsh-context-continuity/pressure
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { producerNoticeSource, v3RenamedSourceKind } from './message-codec.ts'
import { CONTEXT_ROLLOVER_TOOL_NAME } from './projection.ts'

/**
 * The `source.summary` of the one-shot pressure notice. Frozen: notices already
 * written into live Session logs must keep decoding as this policy's own.
 */
export const PRESSURE_NOTICE_SUMMARY = 'Context pressure: prepare a handoff'

/** The effective context budget of one subject's current route. */
export interface PressureLimits {
  /** Context tokens measured for the current generation. */
  readonly usageTokens: number
  /** At or above this the request is reduced first, or refused. */
  readonly hardLimit: number
  /** At or above this the subject is told to prepare a handoff. */
  readonly handoffAt: number
}

/**
 * One observation of a subject's durable surface, which is how the engine
 * proves a reduction happened instead of taking the capability's word for it.
 */
export interface PressureSurface {
  /** Monotone counter of the durable replacement generation. */
  readonly generation: number
  /** Measured total context tokens, or absent when no meter exists. */
  readonly tokens?: number | undefined
}

/** The reduction capability in one subject's scope, e.g. the harness compaction engine. */
export interface PressureCompaction {
  /**
   * Force one reduction now and leave the durable surface reduced. Resolves with
   * the capability's own result — `null` means there was no compactable range —
   * and rejects to report a failure after whatever progress it made.
   */
  reduce(reason: 'context-overflow', signal: AbortSignal): Promise<unknown>
}

/**
 * One subject's durable log, as the notice latch reads it. `events` may be the
 * whole log or its own slice; everything below `inheritedEventCount` belongs to
 * the generation this one continues, so it is not this generation's notice.
 */
export interface PressureLogSpan {
  readonly sessionId: string
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
}

/** What one subject has in hand, in the host's own vocabulary. */
export interface PressureInHand {
  /** Durable work the subject is holding, as labels for the notice. */
  readonly inHand: readonly string[]
  /** Background jobs still running, as labels for the notice. */
  readonly jobs: readonly string[]
}

/**
 * Everything the pressure policy needs from a host. Every member is per-subject
 * and resolved at call time: one policy serves every subject a host runs.
 */
export interface PressurePolicyHost<SubjectId> {
  /** The plugin id this notice is attributed to, so a later run recognizes its own. */
  readonly pluginId: string
  /** Effective budgets for one subject's current route; absent means unknown. */
  limitsFor(subject: SubjectId): PressureLimits | undefined | Promise<PressureLimits | undefined>
  /** The subject's durable surface right now, for proving a reduction. */
  surfaceFor(subject: SubjectId): PressureSurface
  /** The reduction capability in this subject's scope, or absent when unavailable. */
  compactionFor(subject: SubjectId): PressureCompaction | undefined
  /** The subject's durable log, for the once-per-generation notice latch. */
  logSpanFor(subject: SubjectId): PressureLogSpan
  /** What the subject has in hand, for the notice. */
  inHandFor(subject: SubjectId): PressureInHand
  /**
   * Steer one notice into the subject's running turn. The host must record it in
   * the subject's own durable log — the latch reads that evidence back, so a
   * notice that was steered but not logged is delivered again.
   */
  steer(subject: SubjectId, notice: UserMessage): void
  /** Report a blocked request with a recoverable diagnostic. */
  failedFor(subject: SubjectId, diagnostic: string): void
  /** Log one diagnostic, attributable to the subject it names. */
  log(message: string, subject: SubjectId): void
}

/** Subject-facing wording a host may override; the notice's substance is not a knob. */
export interface PressureNoticeText {
  /** The label naming durable work in hand, e.g. `Active Claims`. */
  readonly inHandLabel?: string
  /** The label naming background jobs, e.g. `Owner jobs`. */
  readonly jobsLabel?: string
  /** The rollover tool a subject should call, when a host renamed it. */
  readonly rolloverToolName?: string
}

/** What one pre-step policy call decided. */
export type PressureStepDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'notice' }
  | { readonly kind: 'reject' }

const DEFAULT_TEXT: Required<PressureNoticeText> = {
  inHandLabel: 'Work in hand',
  jobsLabel: 'Background jobs',
  rolloverToolName: CONTEXT_ROLLOVER_TOOL_NAME,
}

const CONTINUE: PressureStepDecision = Object.freeze({ kind: 'continue' })
const NOTICE: PressureStepDecision = Object.freeze({ kind: 'notice' })
const REJECT: PressureStepDecision = Object.freeze({ kind: 'reject' })

/** One error as a readable sentence: the message when there is one, the value otherwise. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The notice one subject near its handoff budget receives: the measured numbers,
 * what it is holding, and the default action. Deliberately short — it competes
 * with the work for the very context it is warning about.
 */
export function contextPressureNoticeText(
  input: {
    readonly usageTokens: number
    readonly handoffAt: number
    readonly hardLimit: number
    readonly inHand: readonly string[]
    readonly jobs: readonly string[]
  },
  text: PressureNoticeText = {},
): string {
  const wording: Required<PressureNoticeText> = {
    inHandLabel: text.inHandLabel ?? DEFAULT_TEXT.inHandLabel,
    jobsLabel: text.jobsLabel ?? DEFAULT_TEXT.jobsLabel,
    rolloverToolName: text.rolloverToolName ?? DEFAULT_TEXT.rolloverToolName,
  }
  const inHand = input.inHand.length === 0 ? 'none' : input.inHand.join(', ')
  const jobs = input.jobs.length === 0 ? 'none' : `${input.jobs.length} running (collect or stop them before switching)`
  return [
    `Context pressure: ${input.usageTokens} tokens measured; the handoff budget is ${input.handoffAt} and the hard limit is ${input.hardLimit}.`,
    `${wording.inHandLabel}: ${inHand}. ${wording.jobsLabel}: ${jobs}.`,
    `Finish the current atomic action, then call ${wording.rolloverToolName} with a handoff covering your objective, the action in flight, and external side effects and their verification state — write only what a fresh generation could not reconstruct on its own, and a fresh context is the default path. Record anything durable in your private memory/notes first.`,
  ].join(' ')
}

/**
 * Whether one message is this policy's own one-shot notice. It is attributed
 * under the host's own producer kind, and the format's read-time conversion of
 * this producer's released V3 rows renames that kind to `plugin:<id>`; both
 * identities are this policy's own, matched by exact equality — a `plugin:`
 * prefix test would claim another producer's notices as its own evidence.
 */
function isPressureNotice(pluginId: string, message: unknown): boolean {
  const source = (message as { readonly source?: { readonly kind?: unknown; readonly summary?: unknown } } | undefined)?.source
  if (source?.summary !== PRESSURE_NOTICE_SUMMARY) return false
  return source.kind === pluginId || source.kind === v3RenamedSourceKind(pluginId)
}

/** Whether one own-span event already carries the notice: surfaced, or queued in a durable splice. */
function noticeInEvent(pluginId: string, event: SessionEvent): boolean {
  if (event.type === 'user/message') return isPressureNotice(pluginId, event.data)
  if (event.type === 'agent/inbox/spliced') return event.data.inserted.some(message => isPressureNotice(pluginId, message))
  return false
}

/** Whether a reduction is proven: the durable surface advanced, or pressure measurably fell. */
function reductionProven(before: PressureSurface, after: PressureSurface): boolean {
  if (after.generation > before.generation) return true
  return before.tokens !== undefined && after.tokens !== undefined && after.tokens < before.tokens
}

/** Whether the durable surface itself advanced, which is what makes a retry more than a repeat. */
function surfaceAdvanced(before: PressureSurface, after: PressureSurface): boolean {
  return after.generation > before.generation
}

/** One subject's notice latch: the fold value plus how far it has consumed the own span. */
interface NoticeLatch {
  readonly sessionId: string
  /** How many events of the current own span have been folded. */
  readonly foldedThrough: number
  /** The last event folded, by position and type, so a rewritten span is detected. */
  readonly anchor: { readonly seq: number; readonly type: string } | undefined
  readonly delivered: boolean
}

/** Whether the event a latch stopped on still occupies that position with the type it had. */
function anchorHolds(anchor: { readonly seq: number; readonly type: string } | undefined, event: SessionEvent | undefined): boolean {
  return anchor !== undefined && event !== undefined && Number(event.seq) === anchor.seq && event.type === anchor.type
}

/**
 * The one context-pressure policy of one host. It reads budgets and surfaces
 * through the host, steers the notice through the host, and owns the decision
 * order, the once-per-generation latch, and the fail-closed reduction proof.
 */
export class ContextPressurePolicy<SubjectId> {
  /**
   * Retry budget per subject for the current provider-overflow sequence.
   * Process-only by design: a restart re-earns one sequence per chain.
   */
  private readonly overflowRetries = new Map<SubjectId, number>()

  /**
   * Whether the one-shot notice already reached this subject's current
   * generation, folded incrementally per subject. Identity is the subject, so a
   * rollover replaces the entry rather than adding one, and the Session id kept
   * beside it is what stops that replacement from being read as a hit.
   */
  private readonly noticeSeen = new Map<SubjectId, NoticeLatch>()

  private disposed = false

  constructor(
    private readonly host: PressurePolicyHost<SubjectId>,
    private readonly text: PressureNoticeText = {},
  ) {}

  /**
   * Pre-step policy for one subject: below the handoff budget nothing happens;
   * at the handoff budget one structured notice per generation is steered into
   * the running turn; at the hard limit the request is forced through a
   * reduction first and refused when that cannot be proven.
   */
  async onPreStep(subject: SubjectId, signal: AbortSignal): Promise<PressureStepDecision> {
    if (this.disposed || signal.aborted) return CONTINUE
    const limits = await this.host.limitsFor(subject)
    if (limits === undefined) {
      // A missing route capacity must be explicit, never an accidental
      // unlimited policy: refuse the step with a recoverable diagnostic.
      this.host.failedFor(subject, 'context pressure policy: the routed model capacity is unknown; refusing to forward a request without a bounded context budget')
      return REJECT
    }
    const { usageTokens, hardLimit, handoffAt } = limits
    if (usageTokens >= hardLimit) return (await this.enforceHardLimit(subject, signal)) ? CONTINUE : REJECT
    if (usageTokens >= handoffAt && !this.noticeDelivered(subject)) {
      const inHand = this.host.inHandFor(subject)
      const notice = createUserMessage({
        content: [{
          type: 'text',
          text: contextPressureNoticeText({
            usageTokens,
            handoffAt,
            hardLimit,
            inHand: inHand.inHand,
            jobs: inHand.jobs,
          }, this.text),
        }],
        source: producerNoticeSource(this.host.pluginId, PRESSURE_NOTICE_SUMMARY),
      })
      try {
        this.host.steer(subject, notice)
      } catch (error) {
        this.host.log(`context pressure notice failed: ${describeFailure(error)}`, subject)
      }
      return NOTICE
    }
    return CONTINUE
  }

  /**
   * Provider-overflow recovery: one bounded reduce-and-retry sequence per open
   * failure chain. Returns whether the request may retry once.
   */
  async onRequestError(subject: SubjectId, failure: { readonly code?: string | undefined }, signal: AbortSignal): Promise<boolean> {
    if (this.disposed || signal.aborted) return false
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return false
    const retries = this.overflowRetries.get(subject) ?? 0
    if (retries >= 1) return false
    const compaction = this.host.compactionFor(subject)
    if (compaction === undefined) return false
    const before = this.host.surfaceFor(subject)
    try {
      await compaction.reduce('context-overflow', signal)
    } catch (error) {
      // Durable reduction progress before a later failure justifies the single
      // retry; cancellation never does.
      if (!signal.aborted && surfaceAdvanced(before, this.host.surfaceFor(subject))) {
        this.overflowRetries.set(subject, retries + 1)
        return true
      }
      this.host.log(`context-overflow recovery failed: ${describeFailure(error)}`, subject)
      return false
    }
    // Only a changed durable surface makes a retry more than a repeat: the
    // provider rejected the request as it stood, so re-sending it unchanged
    // would overflow again.
    if (signal.aborted || !surfaceAdvanced(before, this.host.surfaceFor(subject))) return false
    this.overflowRetries.set(subject, retries + 1)
    return true
  }

  /** A successful assistant response ends any open overflow-recovery sequence. */
  onAssistantMessage(subject: SubjectId): void {
    this.overflowRetries.delete(subject)
  }

  dispose(): void {
    this.disposed = true
    this.overflowRetries.clear()
    this.noticeSeen.clear()
  }

  /**
   * The one-shot pressure notice is durable Session evidence, not process
   * state: a notice already surfaced as a `user/message`, or still queued in a
   * durable `agent/inbox/spliced` insert, marks the current generation as
   * already notified. A resume or restart therefore stays quiet, while a
   * rollover starts a fresh Session whose own span has no notice yet — which is
   * exactly the documented re-arm. Only the own span counts: a notice inherited
   * from the generation this one continues belongs to that generation.
   */
  private noticeDelivered(subject: SubjectId): boolean {
    const span = this.host.logSpanFor(subject)
    const own = span.events.filter(event => Number(event.seq) >= span.inheritedEventCount)
    const previous = this.noticeSeen.get(subject)
    // Resume only for the same Session's span, while it still covers what was
    // folded and the event it stopped on is still there; every other case —
    // a rollover, a shorter log, a rebuilt one — re-folds cold, which is how a
    // rollover re-arms and how a lost notice is re-delivered.
    const resumable = previous !== undefined
      && previous.sessionId === span.sessionId
      && previous.foldedThrough <= own.length
      && (previous.foldedThrough === 0 || anchorHolds(previous.anchor, own[previous.foldedThrough - 1]))
    if (resumable && previous.delivered) return true
    let delivered = resumable ? previous.delivered : false
    if (!resumable || previous.foldedThrough < own.length) {
      for (let index = resumable ? previous.foldedThrough : 0; index < own.length; index += 1) {
        if (noticeInEvent(this.host.pluginId, own[index]!)) delivered = true
      }
    }
    const last = own[own.length - 1]
    this.noticeSeen.set(subject, {
      sessionId: span.sessionId,
      foldedThrough: own.length,
      anchor: last === undefined ? undefined : { seq: Number(last.seq), type: last.type },
      delivered,
    })
    return delivered
  }

  /**
   * Force a reduction in the subject's scope and prove it advanced the durable
   * surface or measurably reduced pressure before the request may continue.
   * Background jobs are untouched — a reduction never cancels or discards them.
   * @returns whether the request may proceed.
   */
  private async enforceHardLimit(subject: SubjectId, signal: AbortSignal): Promise<boolean> {
    const compaction = this.host.compactionFor(subject)
    if (compaction === undefined) {
      this.host.failedFor(subject, 'context hard limit reached and compaction is unavailable in this scope; the request was blocked')
      return false
    }
    const before = this.host.surfaceFor(subject)
    let result: unknown
    try {
      result = await compaction.reduce('context-overflow', signal)
    } catch (error) {
      this.host.failedFor(subject, `context hard limit compaction failed: ${describeFailure(error)}; the request was blocked`)
      return false
    }
    if (signal.aborted) return false
    if (!reductionProven(before, this.host.surfaceFor(subject))) {
      // No-op or unchanged surface: fail closed rather than knowingly submit
      // over the subject's limit.
      this.host.failedFor(subject, result === null
        ? 'context hard limit reached and no compactable range exists; the request was blocked'
        : 'context hard limit compaction produced no measurable reduction; the request was blocked')
      return false
    }
    return true
  }
}
