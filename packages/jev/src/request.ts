/**
 * One call's local validation, and the wire body it serializes to.
 *
 * What is checked is the documented request and nothing narrower — a
 * description may be an empty string or `null`, and a structured entry is the
 * vendor's own `EntryType` — so no rule here rejects what the vendor accepts.
 * @module @contexera/dsh-jev/request
 */

import type { JevChoiceQuestion, JevEntry, JevNoulCriteria, JevRequest, JevScoreQuestion, JevState } from './contracts.ts'
import { JevError, errorText } from './errors.ts'
import { isRecord } from './json.ts'

/**
 * The vendor's ceiling on the number of levels in a `score` criteria. It is an
 * API limit rather than a suggestion, so a longer scale is a request error here
 * instead of a round trip that can only fail.
 */
export const MAX_SCORE_LEVELS = 10

export interface JevWireNoulQuestion {
  readonly type: 'noul'
  readonly instructions: JevEntry
  readonly criteria?: JevNoulCriteria | undefined
}

export type JevWireQuestion = JevWireNoulQuestion | JevChoiceQuestion | JevScoreQuestion

export interface JevWireBody {
  readonly state: JevState
  readonly model: string
  readonly questions: Readonly<Record<string, JevWireQuestion>>
}

/**
 * Check one call and build the request body it serializes to.
 *
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

/**
 * Serialize a checked body. This runs in the request stage, so an argument JSON
 * cannot represent is a `request` failure with nothing sent, rather than a
 * transport failure the service would retry.
 *
 * @throws {JevError} `request` when the body cannot be serialized.
 */
export function serializeWireBody(body: JevWireBody): string {
  try {
    return JSON.stringify(body)
  } catch (error: unknown) {
    throw new JevError('request', `invalid Jev request: the call cannot be serialized as JSON (${errorText(error)})`, { cause: error })
  }
}

function fail(path: string, detail: string): never {
  throw new JevError('request', `invalid Jev request: ${path} ${detail}`)
}

function isEntry(value: unknown): value is JevEntry {
  if (value === null || typeof value === 'string') return true
  if (Array.isArray(value)) return true
  return typeof value === 'object'
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`
}

function readEntry(path: string, value: unknown): JevEntry {
  if (!isEntry(value)) fail(path, `must be a string, an object, an array, or null; got ${describe(value)}`)
  return value
}

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

function readQuestions(value: unknown): Record<string, JevWireQuestion> {
  if (!isRecord(value)) fail('questions', `must be a map of questions; got ${describe(value)}`)
  const ids = Object.keys(value)
  if (ids.length === 0) fail('questions', 'must ask at least one question')
  const questions: Record<string, JevWireQuestion> = {}
  for (const id of ids) questions[id] = readQuestion(id, value[id])
  return questions
}

function readQuestion(id: string, value: unknown): JevWireQuestion {
  const path = `questions["${id}"]`
  if (!isRecord(value)) fail(path, `must be a question object; got ${describe(value)}`)
  const instructions = readEntry(`${path}.instructions`, value.instructions)
  switch (value.type) {
    case 'noul':
    case 'boolean':
      return { type: 'noul', instructions, criteria: readNoulCriteria(path, value.criteria) }
    case 'choice':
      return { type: 'choice', instructions, criteria: readChoiceCriteria(path, value.criteria) }
    case 'score':
      return { type: 'score', instructions, criteria: readScoreCriteria(path, value.criteria) }
    default:
      return unknownQuestionType(path, value.type)
  }
}

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

function readScoreCriteria(path: string, value: unknown): readonly JevEntry[] {
  if (!Array.isArray(value)) fail(`${path}.criteria`, `must be an array of level descriptions; got ${describe(value)}`)
  if (value.length === 0) fail(`${path}.criteria`, 'must describe at least one level')
  if (value.length > MAX_SCORE_LEVELS) {
    fail(`${path}.criteria`, `must not describe more than ${MAX_SCORE_LEVELS} levels; got ${value.length}`)
  }
  return value.map((level, index) => readEntry(`${path}.criteria[${index}]`, level))
}

function unknownQuestionType(path: string, type: unknown): never {
  fail(`${path}.type`, `must be "noul", "choice", or "score" (or the alias "boolean"); got ${describe(type)}`)
}
