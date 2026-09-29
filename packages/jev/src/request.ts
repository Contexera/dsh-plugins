/**
 * One call's local validation, and the wire body it becomes.
 *
 * This is the point where a caller's values turn into JSON on a socket, which
 * is why the check lives here: the vendor's answer is only as good as the
 * question, and a `score` sent as an object or a `choice` with no options comes
 * back either as a rejection or as an answer to a different question than the
 * caller meant to ask. What is checked is the documented request and nothing
 * narrower — a description may be an empty string or `null`, and a structured
 * entry is the vendor's own `EntryType` — so no rule here rejects what the
 * vendor accepts.
 * @module @wowyuarm/dsh-jev/request
 */

import type { JevChoiceQuestion, JevEntry, JevNoulCriteria, JevRequest, JevScoreQuestion, JevState } from './contracts.ts'
import { JevError } from './errors.ts'
import { isRecord } from './json.ts'

/**
 * The vendor's ceiling on the number of levels in a `score` criteria. It is an
 * API limit rather than a suggestion, so a longer scale is a request error here
 * instead of a round trip that can only fail.
 */
export const MAX_SCORE_LEVELS = 10

/** A yes/no question with the `boolean` alias resolved to the vendor's own `noul`. */
export interface JevWireNoulQuestion {
  readonly type: 'noul'
  readonly instructions: JevEntry
  readonly criteria?: JevNoulCriteria | undefined
}

/** One question as it goes on the wire: checked, and with no type alias left in it. */
export type JevWireQuestion = JevWireNoulQuestion | JevChoiceQuestion | JevScoreQuestion

/** The body of `POST {apiBase}/systemone`. */
export interface JevWireBody {
  readonly state: JevState
  /** The model to evaluate with, from configuration. */
  readonly model: string
  /** One question per id, keyed by the id its answer comes back under. */
  readonly questions: Readonly<Record<string, JevWireQuestion>>
}

/**
 * Check one call and build the request body it serializes to.
 *
 * @param request — the caller's evaluation.
 * @param model — the configured model id, sent as the body's `model`.
 * @returns the body to send.
 * @throws {JevError} `request` when the call is not the documented request.
 * Nothing has been sent when this is raised.
 */
export function buildWireBody(request: JevRequest, model: string): JevWireBody {
  return {
    state: readState(request.state),
    model,
    questions: readQuestions(request.questions),
  }
}

/** Report one malformed part of a call. Always throws. */
function fail(path: string, detail: string): never {
  throw new JevError('request', `invalid Jev request: ${path} ${detail}`)
}

/** The vendor's `EntryType`: a string, an object, an array, or `null`. */
function isEntry(value: unknown): value is JevEntry {
  if (value === null || typeof value === 'string') return true
  if (Array.isArray(value)) return true
  return typeof value === 'object'
}

/** How to name a value's type in a message, without dumping the value into a log. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`
}

/**
 * Check one entry and return it. The vendor accepts a string, an object, an
 * array or `null` wherever a question carries text, and so does this — the
 * content of an entry is the caller's to phrase.
 */
function readEntry(path: string, value: unknown): JevEntry {
  if (!isEntry(value)) fail(path, `must be a string, an object, an array, or null; got ${describe(value)}`)
  return value
}

/**
 * Check the state. It is what the questions are asked about, so an empty one
 * asks about nothing: a blank string, an empty array and an empty object are
 * all rejected. Everything else is passed through as it stands.
 */
function readState(value: unknown): JevState {
  if (typeof value === 'string') {
    if (value.trim() === '') fail('state', 'must not be blank')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length === 0) fail('state', 'must not be an empty array')
    return value
  }
  if (isRecord(value)) {
    if (Object.keys(value).length === 0) fail('state', 'must not be an empty object')
    return value
  }
  fail('state', `must be a string, an object, or an array; got ${describe(value)}`)
}

/** Check the question map. One answer comes back per id, so there has to be at least one. */
function readQuestions(value: unknown): Record<string, JevWireQuestion> {
  if (!isRecord(value)) fail('questions', `must be a map of questions; got ${describe(value)}`)
  const ids = Object.keys(value)
  if (ids.length === 0) fail('questions', 'must ask at least one question')
  const questions: Record<string, JevWireQuestion> = {}
  for (const id of ids) questions[id] = readQuestion(id, value[id])
  return questions
}

/** Check one question and normalize its type. */
function readQuestion(id: string, value: unknown): JevWireQuestion {
  const path = `questions["${id}"]`
  if (!isRecord(value)) fail(path, `must be a question object; got ${describe(value)}`)
  const instructions = readEntry(`${path}.instructions`, value.instructions)
  switch (value.type) {
    case 'noul':
    case 'boolean':
      // `boolean` is accepted as a compatibility alias and normalized here: the
      // vendor documents `noul`, so the wire never carries the alias.
      return { type: 'noul', instructions, criteria: readNoulCriteria(path, value.criteria) }
    case 'choice':
      return { type: 'choice', instructions, criteria: readChoiceCriteria(path, value.criteria) }
    case 'score':
      return { type: 'score', instructions, criteria: readScoreCriteria(path, value.criteria) }
    default:
      return unknownQuestionType(path, value.type)
  }
}

/**
 * Check a yes/no question's criteria: an object whose `true` and `false` entries
 * describe what each answer means, either side optional. The entries are copied
 * as checked, so a caller's extra keys survive to the wire.
 */
function readNoulCriteria(path: string, value: unknown): JevNoulCriteria | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    fail(`${path}.criteria`, `must be an object with optional "true" and "false" entries; got ${describe(value)}`)
  }
  const criteria: Record<string, JevEntry> = {}
  for (const [key, entry] of Object.entries(value)) {
    criteria[key] = readEntry(`${path}.criteria["${key}"]`, entry)
  }
  return criteria
}

/**
 * Check a choice question's criteria: the options as a map of option name to
 * description. It is the answer space, so it must offer at least one option —
 * a question with nothing to choose between has no answer to return.
 */
function readChoiceCriteria(path: string, value: unknown): Readonly<Record<string, JevEntry>> {
  if (!isRecord(value)) fail(`${path}.criteria`, `must be the option map; got ${describe(value)}`)
  const names = Object.keys(value)
  if (names.length === 0) fail(`${path}.criteria`, 'must offer at least one option')
  const criteria: Record<string, JevEntry> = {}
  for (const name of names) {
    criteria[name] = readEntry(`${path}.criteria["${name}"]`, value[name])
  }
  return criteria
}

/**
 * Check a score question's criteria: the levels as an ordered array, low end
 * first. A level's number is its position, so the array's order is the scale
 * and its length is the number of levels.
 *
 * The ten-level ceiling is the vendor's API limit. Its recommendation of at
 * least two levels is not enforced: one level is something the endpoint accepts,
 * so rejecting it here would be narrower than the vendor.
 */
function readScoreCriteria(path: string, value: unknown): readonly JevEntry[] {
  if (!Array.isArray(value)) fail(`${path}.criteria`, `must be an array of level descriptions; got ${describe(value)}`)
  if (value.length === 0) fail(`${path}.criteria`, 'must describe at least one level')
  if (value.length > MAX_SCORE_LEVELS) {
    fail(`${path}.criteria`, `must not describe more than ${MAX_SCORE_LEVELS} levels; got ${value.length}`)
  }
  return value.map((level, index) => readEntry(`${path}.criteria[${index}]`, level))
}

/** Report a question whose type is none of the documented ones. Always throws. */
function unknownQuestionType(path: string, type: unknown): never {
  fail(`${path}.type`, `must be "noul", "choice", or "score" (or the alias "boolean"); got ${describe(type)}`)
}
