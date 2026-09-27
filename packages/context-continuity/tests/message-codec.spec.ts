/**
 * The durable message codec: handoff envelopes and checkpoint continuations.
 *
 * These messages are read back out of Session logs written by earlier
 * generations, so the tests pin the two properties the engine depends on:
 * every field a host writes survives a round trip, and a message is recognized
 * only when this codec's own plugin identity and envelope shape produced it.
 */
import { describe, expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  CHECKPOINT_CONTINUATION_TEXT,
  CHECKPOINT_SECTION_NAME,
  ContextMessageCodec,
  HANDOFF_EVENT_SEQ,
  HANDOFF_NEW_SESSION,
  HANDOFF_PREVIOUS_SESSION,
  HANDOFF_RELATED_FILES,
  HANDOFF_SECTION_NAME,
  HANDOFF_TRIGGER,
  producerNoticeSource,
  producerSnapshotSource,
} from '../src/message-codec.ts'
import { OTHER_V3_RENAMED_KIND, PLUGIN_ID, V3_RENAMED_KIND } from './test-producer.ts'

function codec(pluginId = PLUGIN_ID): ContextMessageCodec {
  return new ContextMessageCodec({
    pluginId,
    handoffIntro: 'A context handoff opens this generation.',
    handoffVerifyNote: 'Nothing external was rolled back: verify current state before relying on it.',
  })
}

/** Build one producer snapshot message, the shape the codec writes and reads back. */
function snapshot(producer: string, sections: readonly { name: string; text: string }[], text = 'body'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: producerSnapshotSource(producer, sections),
  })
}

/**
 * Build one row as the format's read-time conversion hands this producer's
 * released rows back: the renamed kind, no `plugin` key, payload preserved.
 */
function released(sections: readonly { name: string; text: string }[], text = 'body'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: V3_RENAMED_KIND, form: 'snapshot', sections },
  })
}

/** The named sections of one valid handoff envelope. */
const ENVELOPE_SECTIONS = [
  { name: HANDOFF_SECTION_NAME, text: 'handoff' },
  { name: HANDOFF_PREVIOUS_SESSION, text: 'session-a' },
  { name: HANDOFF_NEW_SESSION, text: 'session-b' },
  { name: HANDOFF_TRIGGER, text: 'model' },
  { name: HANDOFF_EVENT_SEQ, text: '9' },
]

const FULL_INPUT = {
  handoff: 'Continue the migration from step 3.',
  previousSessionId: 'session-a',
  newSessionId: 'session-b',
  trigger: 'model' as const,
  handoffEventSeq: 42,
  checkpointRef: 'checkpoint:7',
  relatedFiles: [{ path: 'src/index.ts', reason: 'entry point' }],
}

describe('handoff envelope round trip', () => {
  it('decodes every field it encoded', () => {
    const decoded = codec().handoffOf(codec().createHandoffMessage(FULL_INPUT))
    expect(decoded).toBeDefined()
    expect(decoded?.previousSessionId).toBe('session-a')
    expect(decoded?.newSessionId).toBe('session-b')
    expect(decoded?.trigger).toBe('model')
    expect(decoded?.handoffEventSeq).toBe(42)
    expect(decoded?.checkpointRef).toBe('checkpoint:7')
    expect(decoded?.relatedFiles).toEqual(['src/index.ts'])
  })

  it('keeps the model-authored prose and the verifiable facts in the body', () => {
    const message = codec().createHandoffMessage(FULL_INPUT)
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    expect(text).toContain('A context handoff opens this generation.')
    expect(text).toContain('verify current state before relying on it')
    expect(text).toContain('Previous session: session-a')
    expect(text).toContain('New session: session-b')
    expect(text).toContain('Trigger: model')
    expect(text).toContain('Continued from checkpoint: checkpoint:7')
    expect(text).toContain('Related files: src/index.ts')
    expect(text).toContain(FULL_INPUT.handoff)
  })

  it('omits optional fields rather than encoding them empty', () => {
    const message = codec().createHandoffMessage({
      handoff: 'Fresh start.',
      previousSessionId: 'session-a',
      newSessionId: 'session-b',
      trigger: 'pressure',
      handoffEventSeq: 7,
    })
    const decoded = codec().handoffOf(message)
    expect(decoded?.checkpointRef).toBeUndefined()
    expect(decoded?.relatedFiles).toBeUndefined()
    const source = message.source
    const sectionNames = source.kind === PLUGIN_ID && source.form === 'snapshot'
      ? source.sections.map(section => section.name)
      : []
    expect(sectionNames)
      .toEqual([HANDOFF_SECTION_NAME, HANDOFF_PREVIOUS_SESSION, HANDOFF_NEW_SESSION, HANDOFF_TRIGGER, HANDOFF_EVENT_SEQ])
  })

  it('round-trips a path JSON encoding admits but a comma split would not', () => {
    const decoded = codec().handoffOf(codec().createHandoffMessage({
      ...FULL_INPUT,
      relatedFiles: [{ path: 'docs/a, b.md', reason: 'comma in the name' }, { path: 'src/x.ts', reason: 'x' }],
    }))
    expect(decoded?.relatedFiles).toEqual(['docs/a, b.md', 'src/x.ts'])
  })

  it('still reads the legacy comma-separated related-files section', () => {
    const message = snapshot(PLUGIN_ID, [
      { name: HANDOFF_SECTION_NAME, text: 'handoff' },
      { name: HANDOFF_PREVIOUS_SESSION, text: 'session-a' },
      { name: HANDOFF_NEW_SESSION, text: 'session-b' },
      { name: HANDOFF_TRIGGER, text: 'model' },
      { name: HANDOFF_EVENT_SEQ, text: '9' },
      { name: HANDOFF_RELATED_FILES, text: 'src/a.ts, src/b.ts' },
    ])
    expect(codec().handoffOf(message)?.relatedFiles).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('refuses an envelope whose facts are missing or malformed', () => {
    /** The valid envelope with named sections replaced, or dropped when undefined. */
    const envelope = (overrides: Record<string, string | undefined>): UserMessage => snapshot(PLUGIN_ID,
      ENVELOPE_SECTIONS.flatMap(section => (section.name in overrides
        ? (overrides[section.name] === undefined ? [] : [{ name: section.name, text: overrides[section.name]! }])
        : [section])))
    expect(codec().handoffOf(snapshot(PLUGIN_ID, [{ name: HANDOFF_SECTION_NAME, text: 'handoff' }]))).toBeUndefined()
    expect(codec().handoffOf(envelope({ [HANDOFF_TRIGGER]: 'scheduled' }))).toBeUndefined()
    expect(codec().handoffOf(envelope({ [HANDOFF_EVENT_SEQ]: 'not-a-number' }))).toBeUndefined()
    expect(codec().handoffOf(envelope({ [HANDOFF_EVENT_SEQ]: '9.5' }))).toBeUndefined()
    expect(codec().handoffOf(envelope({ [HANDOFF_PREVIOUS_SESSION]: undefined }))).toBeUndefined()
  })
})

describe('checkpoint continuation', () => {
  it('carries one ref and the fixed continuation text', () => {
    const message = codec().createCheckpointContinuationMessage('checkpoint:3')
    expect(message.content[0]?.type === 'text' ? message.content[0].text : '').toBe(CHECKPOINT_CONTINUATION_TEXT)
    expect(codec().continuationCheckpointRefOf(message)).toBe('checkpoint:3')
    expect(codec().isCheckpointContinuationMessage(message)).toBe(true)
    expect(codec().isCheckpointContinuationMessage(message, 'checkpoint:3')).toBe(true)
    expect(codec().isCheckpointContinuationMessage(message, 'checkpoint:4')).toBe(false)
  })

  it('refuses a continuation carrying more than the one ref section', () => {
    const message = snapshot(PLUGIN_ID, [
      { name: CHECKPOINT_SECTION_NAME, text: 'checkpoint:3' },
      { name: HANDOFF_SECTION_NAME, text: 'not a continuation' },
    ])
    expect(codec().continuationCheckpointRefOf(message)).toBeUndefined()
    expect(codec().isCheckpointContinuationMessage(message)).toBe(false)
  })

  it('refuses an empty ref', () => {
    expect(codec().continuationCheckpointRefOf(snapshot(PLUGIN_ID, [{ name: CHECKPOINT_SECTION_NAME, text: '' }]))).toBeUndefined()
  })
})

describe('attribution and cross-talk', () => {
  it('writes the producer\'s own kind and never the retired plugin wrapper', () => {
    // Format V4 admits a source only under its producer's own kind, and refuses
    // `{ kind: 'plugin', plugin }` at write time: the wrapper every released
    // engine wrote would be rejected before it ever reached a log.
    const handoff = codec().createHandoffMessage(FULL_INPUT)
    expect(handoff.source.kind).toBe(PLUGIN_ID)
    expect(handoff.source).not.toHaveProperty('plugin')
    const continuation = codec().createCheckpointContinuationMessage('checkpoint:3')
    expect(continuation.source.kind).toBe(PLUGIN_ID)
    expect(continuation.source).not.toHaveProperty('plugin')
  })

  it('decodes the converted shape of its released rows, and claims no other producer\'s', () => {
    // Released V3 history is not rewritten on disk: the format's read-time
    // conversion renames one `plugin` source into `plugin:<producer>`, dropping
    // the `plugin` key and keeping every payload field, so envelopes written
    // before this line still have to decode through this same codec.
    const envelope = released(ENVELOPE_SECTIONS)
    expect(codec().isHandoffMessage(envelope)).toBe(true)
    expect(codec().handoffOf(envelope)?.previousSessionId).toBe('session-a')
    const continuation = released([{ name: CHECKPOINT_SECTION_NAME, text: 'checkpoint:3' }])
    expect(codec().continuationCheckpointRefOf(continuation)).toBe('checkpoint:3')
    // The conversion of another producer's row is still not this codec's.
    const foreign = createUserMessage({
      content: [{ type: 'text', text: 'body' }],
      source: { kind: OTHER_V3_RENAMED_KIND, form: 'snapshot', sections: ENVELOPE_SECTIONS },
    })
    expect(codec().isHandoffMessage(foreign)).toBe(false)
    expect(codec().continuationCheckpointRefOf(foreign)).toBeUndefined()
  })

  it('never recognizes another plugin\'s section names', () => {
    const foreign = snapshot('@other/plugin', ENVELOPE_SECTIONS)
    expect(codec().handoffOf(foreign)).toBeUndefined()
    expect(codec().isHandoffMessage(foreign)).toBe(false)
  })

  it('never recognizes a plain notice from the same plugin', () => {
    const notice = createUserMessage({
      content: [{ type: 'text', text: 'Team Workspace participation changed' }],
      source: producerNoticeSource(PLUGIN_ID, 'participation changed'),
    })
    expect(codec().isContextSource(notice)).toBe(false)
    expect(codec().handoffOf(notice)).toBeUndefined()
    expect(codec().continuationCheckpointRefOf(notice)).toBeUndefined()
  })

  it('keeps handoff and continuation families apart', () => {
    const handoff = codec().createHandoffMessage(FULL_INPUT)
    const continuation = codec().createCheckpointContinuationMessage('checkpoint:3')
    expect(codec().isCheckpointContinuationMessage(handoff)).toBe(false)
    expect(codec().continuationCheckpointRefOf(handoff)).toBeUndefined()
    expect(codec().isHandoffMessage(continuation)).toBe(false)
    expect(codec().isContextSource(handoff)).toBe(true)
    expect(codec().isContextSource(continuation)).toBe(true)
  })

  it('exposes the plugin identity it was configured with', () => {
    expect(codec().pluginId).toBe(PLUGIN_ID)
    expect(codec('@other/plugin').handoffOf(codec(PLUGIN_ID).createHandoffMessage(FULL_INPUT))).toBeUndefined()
  })
})
