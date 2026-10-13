/**
 * Parsing of a 2xx response into the declared result.
 *
 * Everything here is about the envelope: that the body is the documented JSON
 * object, that it carries the model id that answered, and that it carries one
 * object per question that was asked, each tagged with that question's type. An
 * envelope that fails any of those is a `protocol` failure rather than a
 * partial answer, because a caller that reads `answers["tone"]` must never find
 * it missing.
 *
 * The members each answer declares are checked as well, so the types
 * {@link JevAnswer} promises hold at runtime and a consumer can apply a
 * threshold to a probability without re-deriving the vendor's protocol. Fields
 * the vendor adds beyond the declaration are kept rather than rejected: a
 * passthrough provider must not refuse an answer the vendor considers valid,
 * and an extra field is not a malformed one.
 * @module @contexera/dsh-jev/response
 */

import type {
  JevAnswer,
  JevChoiceAnswer,
  JevNoulAnswer,
  JevResult,
  JevScoreAnswer,
} from './contracts.ts'
import { JevError, snippet } from './errors.ts'
import { isRecord } from './json.ts'
import type { JevWireQuestion } from './request.ts'

/** The answer types the vendor documents: one per question type, and no others. */
const ANSWER_TYPES = new Set<string>(['noul', 'choice', 'score'])

/**
 * Parse one response body and check its envelope.
 *
 * @param body — the response body, as text.
 * @param questions — the questions that were sent, keyed as the caller keyed them.
 * @param redactMessage — applied to any excerpt of `body` that a message carries, so a body that echoes a credential cannot put it in a log.
 * @returns the vendor's result: the model id that answered, one answer per question, and the usage record when the vendor sent one.
 * @throws {JevError} `protocol` when the body is not the documented response.
 */
export function parseResponse(
  body: string,
  questions: Readonly<Record<string, JevWireQuestion>>,
  redactMessage: (text: string) => string,
): JevResult {
  const payload = readJson(body, redactMessage)
  const model = payload.model
  if (typeof model !== 'string' || model.trim() === '') fail('the response carries no model id')
  const rawAnswers = payload.answers
  if (!isRecord(rawAnswers)) fail('the response carries no answers object')

  const answers: Record<string, JevAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = rawAnswers[id]
    if (!isAnswer(answer)) fail(`the response has no answer object for question "${id}"`)
    if (answer.type !== question.type) {
      fail(`answer "${id}" is a "${answer.type}" answer to a "${question.type}" question`)
    }
    answers[id] = checkAnswerMembers(id, answer)
  }

  let usage: Readonly<Record<string, unknown>> | undefined
  if (payload.usage !== undefined) {
    if (!isRecord(payload.usage)) fail('the response\'s "usage" is not an object')
    usage = payload.usage
  }
  return { model, answers, usage }
}

/** Report one part of a response that is not the documented one. Always throws. */
function fail(detail: string): never {
  throw new JevError('protocol', detail)
}

/**
 * Parse the body as a JSON object, reporting the body itself when it is not
 * one: a 2xx that is not JSON is usually a proxy's error page, and its first
 * words are what identifies it.
 */
function readJson(body: string, redactMessage: (text: string) => string): Readonly<Record<string, unknown>> {
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch (error: unknown) {
    const message = redactMessage(`the response body is not JSON: ${snippet(body)}`)
    throw new JevError('protocol', message, { cause: error })
  }
  if (!isRecord(payload)) {
    throw new JevError('protocol', redactMessage(`the response is not a JSON object: ${snippet(body)}`))
  }
  return payload
}

/**
 * Claim the declared answer type for one response member.
 *
 * The check is object-ness plus a documented `type` tag, so this decides which
 * member validator runs; {@link checkAnswerMembers} is what makes the declared
 * members hold.
 */
function isAnswer(value: unknown): value is JevAnswer {
  return isRecord(value) && typeof value.type === 'string' && ANSWER_TYPES.has(value.type)
}

/** A finite number, which is what a probability, score or confidence has to be. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A probability: a finite number inside `0..1`. */
function isProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

/** A map of names to probabilities, as every distribution this vendor sends is. */
function checkProbabilityMap(id: string, type: string, value: unknown, member: string): void {
  if (!isRecord(value)) {
    fail(`answer "${id}" (${type}) carries no "${member}" object`)
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!isProbability(entry)) {
      fail(`answer "${id}" (${type}) has a non-probability for "${member}.${key}" — expected a finite number in 0..1`)
    }
  }
}

/**
 * Check the members {@link JevAnswer} declares for one answer, and return it
 * unchanged. Unknown members are kept: only the fields this package promises to
 * a consumer are verified, so a vendor that adds one does not break a call.
 *
 * Every message opens with the answer id and its type, because the caller's next
 * move is to look at that question's answer.
 */
function checkAnswerMembers(id: string, answer: JevAnswer): JevAnswer {
  switch (answer.type) {
    case 'noul': {
      const candidate = answer as JevNoulAnswer & Record<string, unknown>
      if (!isProbability(candidate.noul)) {
        fail(`answer "${id}" (noul) carries no usable "noul" — expected a finite number in 0..1`)
      }
      return answer
    }
    case 'choice': {
      const candidate = answer as JevChoiceAnswer & Record<string, unknown>
      if (typeof candidate.choice !== 'string') {
        fail(`answer "${id}" (choice) carries no "choice" string`)
      }
      checkProbabilityMap(id, 'choice', candidate.probabilities, 'probabilities')
      if (!isProbability(candidate.confidence)) {
        fail(`answer "${id}" (choice) carries no usable "confidence" — expected a finite number in 0..1`)
      }
      return answer
    }
    case 'score': {
      const candidate = answer as JevScoreAnswer & Record<string, unknown>
      if (!isFiniteNumber(candidate.score)) {
        fail(`answer "${id}" (score) carries no usable "score" — expected a finite number`)
      }
      if (!isProbability(candidate.confidence)) {
        fail(`answer "${id}" (score) carries no usable "confidence" — expected a finite number in 0..1`)
      }
      if (!isRecord(candidate.legend)) {
        fail(`answer "${id}" (score) carries no "legend" object`)
      }
      checkProbabilityMap(id, 'score', candidate.probabilities, 'probabilities')
      return answer
    }
  }
}
