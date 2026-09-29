/**
 * The vocabulary of one Jev evaluation: what goes in, what comes back.
 *
 * These are the vendor's shapes for `POST {apiBase}/systemone`, not a local
 * invention. A question is `noul`, `choice` or `score`; answers come back under
 * the ids the caller chose. This package adds no vocabulary of its own and
 * interprets nothing: it transports questions and returns answers.
 * @module @wowyuarm/dsh-jev/contracts
 */

/**
 * The content one set of questions is evaluated against — the state of the
 * world the caller wants judged. A plain string, or structured data such as a
 * chat log or a record. Text only: pre-process images and binaries into text
 * before sending them.
 */
export type JevState = string | Readonly<Record<string, unknown>> | readonly unknown[]

/**
 * One entry the vendor accepts wherever a question carries text: `instructions`
 * and every value or level inside a `criteria`. The vendor calls this shape
 * `EntryType`, and allows a string, an object, an array, or `null` — structured
 * entries are how a question carries supporting data, a schema, or examples
 * next to its wording.
 */
export type JevEntry = string | Readonly<Record<string, unknown>> | readonly unknown[] | null

/**
 * What a `criteria` object may say about a yes and a no. Both sides are
 * optional: the vendor documents the two keys, and an entry that describes only
 * one side of the question is still transportable.
 */
export interface JevNoulCriteria {
  /** What counts as a yes. */
  readonly 'true'?: JevEntry | undefined
  /** What counts as a no. */
  readonly 'false'?: JevEntry | undefined
}

/**
 * A yes/no question. `boolean` is accepted as a compatibility alias and
 * normalized to `noul` before the request is sent, because `noul` is the type
 * the vendor documents and the one the answer comes back as.
 */
export interface JevNoulQuestion {
  readonly type: 'noul' | 'boolean'
  readonly instructions: JevEntry
  /** What a yes and a no mean, when the wording alone does not settle it. */
  readonly criteria?: JevNoulCriteria | undefined
}

/**
 * A question whose answer is one option out of a fixed set with no order
 * between the options. Use {@link JevScoreQuestion} when the answer sits on an
 * ordered scale.
 */
export interface JevChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: JevEntry
  /**
   * The options as a map: each key is an option name and each value describes
   * it. The answer's `choice` is one of these keys. An option description may
   * be `null` when the name alone is clear.
   */
  readonly criteria: Readonly<Record<string, JevEntry>>
}

/**
 * A question whose answer is a position on an ordered scale. The level
 * descriptions run from the low end to the high end, and a level's number is
 * its position — which is why `criteria` is an array and not a map: the order
 * is the scale.
 */
export interface JevScoreQuestion {
  readonly type: 'score'
  readonly instructions: JevEntry
  /** Level descriptions, low end first: one to ten levels. */
  readonly criteria: readonly JevEntry[]
}

/** One typed question, keyed by the id the caller chooses. */
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion

/** One evaluation: a state, the questions asked about it, and an optional cancellation. */
export interface JevRequest {
  /** The content to evaluate. */
  readonly state: JevState
  /** Questions keyed by the id their answers come back under; at least one. */
  readonly questions: Readonly<Record<string, JevQuestion>>
  /**
   * Cancels the call, including a retry the service is waiting out. An aborted
   * call rejects with a `cancelled` {@link JevError} and is never retried: the
   * caller's decision to stop outranks the service's judgement that a failure
   * was transient.
   */
  readonly signal?: AbortSignal | undefined
}

/** An answer to a {@link JevChoiceQuestion}: the chosen key, every key's probability, and confidence. */
export interface JevChoiceAnswer {
  readonly type: 'choice'
  /** The option with the highest probability. */
  readonly choice: string
  /** The full distribution over the options, keyed by option name; the values sum to 1. */
  readonly probabilities: Readonly<Record<string, number>>
  /** How concentrated `probabilities` is, 0 to 1. A flat distribution is low. */
  readonly confidence: number
}

/** An answer to a {@link JevNoulQuestion}: the probability that the answer is yes. */
export interface JevNoulAnswer {
  readonly type: 'noul'
  /** Probability the answer is yes, 0 to 1. Carries no `confidence` of its own. */
  readonly noul: number
}

/** An answer to a {@link JevScoreQuestion}: the position on the scale and confidence. */
export interface JevScoreAnswer {
  readonly type: 'score'
  /** Position on the level number line, which can fall between two levels. */
  readonly score: number
  /** How concentrated `probabilities` is, 0 to 1. A flat distribution is low. */
  readonly confidence: number
  /** Each level number, as a string key, mapped back to that level's description. */
  readonly legend: Readonly<Record<string, JevEntry>>
  /** Probability per level, keyed by level number as a string; the values sum to 1. */
  readonly probabilities: Readonly<Record<string, number>>
}

/**
 * One answer, discriminated by `type`. Answers are passed through exactly as
 * the vendor sent them: the service validates that the envelope carries an
 * `answers` map of objects, and does not check the members declared here. A
 * decision that turns on a value being present and well-formed — a probability
 * that must exist before a threshold is applied — is the consumer's to make.
 */
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer

/**
 * The vendor's response, passed through unmodified. `model` and `usage` are
 * kept because both are load-bearing for a caller: `model` reports the
 * versioned id that actually answered, which is what makes a pinned `model`
 * configuration verifiable, and `usage` carries the call's cost.
 */
export interface JevResult {
  /** The versioned model id that answered, e.g. `jev-1.13.0`. */
  readonly model: string
  /** One answer per requested question id. */
  readonly answers: Readonly<Record<string, JevAnswer>>
  /**
   * The vendor's usage record, unmodified. The vendor's own examples carry
   * `input_tokens` and `output_tokens`; another route may report more, such as
   * a `cost`. Absent when the vendor sends none: this is accounting, so a
   * missing record is not a protocol failure.
   */
  readonly usage: Readonly<Record<string, unknown>> | undefined
}
