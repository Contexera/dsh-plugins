/**
 * The producer identity these specs write under, declared the way a real host
 * declares its own.
 *
 * Session format V4 admits a message source only under its producer's own kind,
 * and each producer states that literal in its own module; the format's
 * read-time conversion of released V3 history renames one to `plugin:<id>`,
 * keeping every payload field. The engine is host-agnostic and names no kind of
 * its own, so these specs play the host — and the declaration below is what
 * lets a fixture carry this identity, exactly as a host's own declaration lets
 * the engine carry it through the id it is configured with.
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

/** The host id these specs configure the engine with. */
export const PLUGIN_ID = '@example/dsh-subject-continuity'

/** Another producer's id: exact-kind matching must never claim its messages. */
export const OTHER_PLUGIN_ID = '@example/other-plugin'

/** The read-time conversion of this producer's released V3 rows. */
export const V3_RENAMED_KIND = `plugin:${PLUGIN_ID}`

/** The read-time conversion of another producer's released V3 rows. */
export const OTHER_V3_RENAMED_KIND = `plugin:${OTHER_PLUGIN_ID}`

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    [PLUGIN_ID]: { kind: typeof PLUGIN_ID } & ContextFormed
    [OTHER_PLUGIN_ID]: { kind: typeof OTHER_PLUGIN_ID } & ContextFormed
    [V3_RENAMED_KIND]: { kind: typeof V3_RENAMED_KIND } & ContextFormed
    [OTHER_V3_RENAMED_KIND]: { kind: typeof OTHER_V3_RENAMED_KIND } & ContextFormed
  }
}
