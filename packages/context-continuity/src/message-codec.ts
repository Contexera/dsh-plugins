/**
 * The durable message codec for context continuity: handoff envelopes and
 * checkpoint continuations, written and read under the producing host's own
 * kind.
 *
 * Both messages ride ordinary `UserMessage`s under the host's plugin id with
 * the `snapshot` context form. Session format V4 admits exactly that shape and
 * refuses the retired `{ kind: 'plugin', plugin: … }` wrapper at write time.
 * Released V3 history is not rewritten on disk: the format's read-time
 * conversion renames one released `plugin` source into `plugin:<producer>`,
 * dropping the `plugin` key and keeping every payload field, so the read side
 * here recognizes both identities by exact match. Everything a host reads back
 * therefore rides named {@link ContextSnapshotSection} contributions
 * distinguished by stable section names, never bespoke source members and
 * never localized body text.
 *
 * The codec is parameterized by the host's plugin id and the two subject-facing
 * prose lines. Section names are host-independent and fixed, because they are
 * read back out of durable logs written by every generation: a host that
 * changed them could not decode its own history.
 * @module @wowyuarm/dsh-context-continuity/message-codec
 */

import type { ContextSnapshotSection, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { RolloverTrigger } from './types.ts'

/** Handoff snapshot section name carrying the model-authored prose. */
export const HANDOFF_SECTION_NAME = 'HANDOFF'
/** Stable section name marking a checkpoint continuation and carrying its ref. */
export const CHECKPOINT_SECTION_NAME = 'Checkpoint'
/** Fixed text of the quiet checkpoint continuation delivered on the next turn. */
export const CHECKPOINT_CONTINUATION_TEXT = 'A context checkpoint was recorded at the end of the previous turn. Continue the work you were doing.'

/** Envelope section names; stable, because they are read back from the log. */
export const HANDOFF_PREVIOUS_SESSION = 'Previous session'
export const HANDOFF_NEW_SESSION = 'New session'
export const HANDOFF_TRIGGER = 'Trigger'
export const HANDOFF_EVENT_SEQ = 'Handoff event seq'
export const HANDOFF_CHECKPOINT = 'Continued from checkpoint'
export const HANDOFF_RELATED_FILES = 'Related files'

/**
 * One source this engine reads. The kind is matched by exact identity against
 * the producer's own id and the read-time conversion of its released rows —
 * never by a `plugin:` prefix test, which would claim another producer's
 * messages as this host's own.
 */
interface ProducerSource {
  readonly kind?: string
  readonly form?: string
  readonly sections?: readonly ContextSnapshotSection[]
}

/**
 * Format V4 requires every durable message source to carry its producer's own
 * kind, and it checks nothing else: there is no registry of producer ids, only
 * "a non-empty kind that is not the retired `plugin` wrapper". Each host
 * declares its own literal in `MessageSourceMap` in its own module, and this
 * engine is host-agnostic, so the compiler cannot match a runtime id to that
 * map — the single cast below is that one boundary. The host's own admission
 * and read-back tests pin the id it produces, so the value cannot drift
 * silently.
 */
function producerSource(
  pluginId: string,
  payload:
    | { readonly form: 'snapshot'; readonly sections: readonly ContextSnapshotSection[] }
    | { readonly form: 'notice'; readonly summary: string },
): MessageSource {
  return { kind: pluginId, ...payload } as unknown as MessageSource
}

/**
 * The source of one snapshot-form context message: the producer's own kind plus
 * the named contributions it carries.
 */
export function producerSnapshotSource(pluginId: string, sections: readonly ContextSnapshotSection[]): MessageSource {
  return producerSource(pluginId, { form: 'snapshot', sections })
}

/** The source of one notice-form context message: the producer's own kind plus its one-line account. */
export function producerNoticeSource(pluginId: string, summary: string): MessageSource {
  return producerSource(pluginId, { form: 'notice', summary })
}

/** The read-time conversion of one producer's released V3 rows, as format V4 renames them. */
export function v3RenamedSourceKind(pluginId: string): string {
  return `plugin:${pluginId}`
}

/**
 * Host-specific codec configuration. `pluginId` attributes every message and
 * is matched on read, so it is durable identity a host must keep fixed across
 * its own generations. The two prose lines are the only subject-facing text;
 * everything else is host-independent.
 */
export interface MessageCodecConfig {
  readonly pluginId: string
  /** The handoff body's opening line, naming the subject in the host's terms. */
  readonly handoffIntro: string
  /** The verify-before-relying caution line, naming what a rollover never rolls back. */
  readonly handoffVerifyNote: string
}

/** The rollover handoff envelope: model-authored prose plus verifiable host facts. */
export interface ContextHandoff {
  readonly previousSessionId: string
  readonly newSessionId: string
  readonly trigger: RolloverTrigger
  readonly handoffEventSeq: number
  readonly checkpointRef?: string
  readonly relatedFiles?: readonly string[]
  readonly sections: readonly ContextSnapshotSection[]
}

interface HandoffInput {
  readonly handoff: string
  readonly previousSessionId: string
  readonly newSessionId: string
  readonly trigger: RolloverTrigger
  readonly handoffEventSeq: number
  readonly checkpointRef?: string
  readonly relatedFiles?: readonly { readonly path: string; readonly reason?: string }[]
}

/**
 * Read the `Related files` section. The host writes the exact path array as
 * JSON, which round-trips every path a file system admits. Sections written
 * before that encoding are still read; the legacy `', '` split is a read-side
 * accommodation for old generations, never a write path.
 */
function parseRelatedFiles(text: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.every(path => typeof path === 'string' && path.length > 0)) {
      return parsed as readonly string[]
    }
  } catch {
    // Not JSON: the section predates the JSON encoding.
  }
  return text.split(', ').filter(path => path.length > 0)
}

function sectionText(sections: readonly ContextSnapshotSection[], name: string): string | undefined {
  return sections.find(section => section.name === name)?.text
}

/**
 * The one place that builds and recognizes context-continuity messages. A host
 * constructs it once with its own plugin identity and prose; callers never
 * match on body text.
 */
export class ContextMessageCodec {
  constructor(private readonly config: MessageCodecConfig) {}

  /** The plugin id every message this codec writes is attributed to. */
  get pluginId(): string {
    return this.config.pluginId
  }

  /** Build the first model-facing context of one rollover generation. */
  createHandoffMessage(input: HandoffInput): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: this.handoffBody(input) }],
      source: producerSnapshotSource(this.config.pluginId, this.handoffSections(input)),
    })
  }

  /** Build the quiet follow-up that continues work after a checkpoint concluded its turn. */
  createCheckpointContinuationMessage(checkpointRef: string): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: CHECKPOINT_CONTINUATION_TEXT }],
      source: producerSnapshotSource(this.config.pluginId, [{ name: CHECKPOINT_SECTION_NAME, text: checkpointRef }]),
    })
  }

  /** This codec's own snapshot sections on one message, or undefined when another producer owns it. */
  private ownSections(message: UserMessage): readonly ContextSnapshotSection[] | undefined {
    const source: ProducerSource = message.source
    if (source.kind !== this.config.pluginId && source.kind !== v3RenamedSourceKind(this.config.pluginId)) return undefined
    if (source.form !== 'snapshot' || source.sections === undefined) return undefined
    return source.sections
  }

  /** The rollover handoff one message carries, when it is one. */
  handoffOf(message: UserMessage): ContextHandoff | undefined {
    const sections = this.ownSections(message)
    if (sections === undefined) return undefined
    const handoff = sectionText(sections, HANDOFF_SECTION_NAME)
    if (handoff === undefined) return undefined
    const previousSessionId = sectionText(sections, HANDOFF_PREVIOUS_SESSION)
    const newSessionId = sectionText(sections, HANDOFF_NEW_SESSION)
    const trigger = sectionText(sections, HANDOFF_TRIGGER)
    const handoffEventSeq = sectionText(sections, HANDOFF_EVENT_SEQ)
    if (previousSessionId === undefined || newSessionId === undefined) return undefined
    if (trigger !== 'model' && trigger !== 'pressure') return undefined
    const seq = Number(handoffEventSeq)
    if (handoffEventSeq === undefined || !Number.isSafeInteger(seq)) return undefined
    const checkpointRef = sectionText(sections, HANDOFF_CHECKPOINT)
    const relatedFiles = sectionText(sections, HANDOFF_RELATED_FILES)
    return {
      previousSessionId,
      newSessionId,
      trigger,
      handoffEventSeq: seq,
      ...(checkpointRef === undefined ? {} : { checkpointRef }),
      ...(relatedFiles === undefined ? {} : { relatedFiles: parseRelatedFiles(relatedFiles) }),
      sections,
    }
  }

  /** The checkpoint ref one continuation notice carries, when the message is one. */
  continuationCheckpointRefOf(message: UserMessage): string | undefined {
    const sections = this.ownSections(message)
    if (sections === undefined || sections.length !== 1) return undefined
    const ref = sectionText(sections, CHECKPOINT_SECTION_NAME)
    return ref === undefined || ref.length === 0 ? undefined : ref
  }

  /** Whether one user message is a rollover handoff snapshot. */
  isHandoffMessage(message: UserMessage): boolean {
    return this.handoffOf(message) !== undefined
  }

  /** Whether one user message is a checkpoint continuation, optionally for one checkpoint. */
  isCheckpointContinuationMessage(message: UserMessage, checkpointRef?: string): boolean {
    const ref = this.continuationCheckpointRefOf(message)
    return ref !== undefined && (checkpointRef === undefined || ref === checkpointRef)
  }

  /**
   * Whether one message carries a handoff or checkpoint-continuation envelope.
   * Ordinary host notices share this plugin's attribution, so callers that
   * replace rederived notices must exclude these two families explicitly.
   */
  isContextSource(message: UserMessage): boolean {
    return this.isHandoffMessage(message) || this.isCheckpointContinuationMessage(message)
  }

  private handoffSections(input: HandoffInput): readonly ContextSnapshotSection[] {
    return [
      { name: HANDOFF_SECTION_NAME, text: input.handoff },
      { name: HANDOFF_PREVIOUS_SESSION, text: input.previousSessionId },
      { name: HANDOFF_NEW_SESSION, text: input.newSessionId },
      { name: HANDOFF_TRIGGER, text: input.trigger },
      { name: HANDOFF_EVENT_SEQ, text: String(input.handoffEventSeq) },
      ...(input.checkpointRef === undefined ? [] : [{ name: HANDOFF_CHECKPOINT, text: input.checkpointRef }]),
      ...(input.relatedFiles === undefined || input.relatedFiles.length === 0
        ? []
        : [{ name: HANDOFF_RELATED_FILES, text: JSON.stringify(input.relatedFiles.map(file => file.path)) }]),
    ]
  }

  private handoffBody(input: HandoffInput): string {
    const lines = [
      this.config.handoffIntro,
      `Previous session: ${input.previousSessionId}`,
      `New session: ${input.newSessionId}`,
      `Trigger: ${input.trigger}`,
      ...(input.checkpointRef === undefined ? [] : [`Continued from checkpoint: ${input.checkpointRef}`]),
      ...(input.relatedFiles === undefined || input.relatedFiles.length === 0 ? [] : [`Related files: ${input.relatedFiles.map(file => file.path).join(', ')}`]),
      '',
      this.config.handoffVerifyNote,
      '',
      input.handoff,
    ]
    return lines.join('\n')
  }
}
