/**
 * Parsing of a 2xx response into the declared result.
 *
 * Every declared member is checked at runtime, so a caller can apply a threshold
 * to a probability without re-deriving the vendor's protocol. Fields the vendor
 * adds beyond the declaration are kept.
 * @module @contexera/dsh-jev/response
 */

import type { JevAnswer, JevEntry, JevResult } from './contracts.ts'
import { JevError, snippet } from './errors.ts'
import { isRecord } from './json.ts'
import type { JevWireQuestion } from './request.ts'

/** The answer types the vendor documents: one per question type, and no others. */
const ANSWER_TYPES = new Set<string>(['noul', 'choice', 'score'])

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
    answers[id] = readAnswer(id, rawAnswers[id], question.type)
  }

  let usage: Readonly<Record<string, unknown>> | undefined
  if (payload.usage !== undefined) {
    if (!isRecord(payload.usage)) fail('the response\'s "usage" is not an object')
    usage = payload.usage
  }
  return { model, answers, usage }
}

function fail(detail: string): never {
  throw new JevError('protocol', detail)
}

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

function readProbabilityMap(
  id: string,
  type: string,
  value: unknown,
  member: string,
): Readonly<Record<string, number>> {
  if (!isRecord(value)) {
    fail(`answer "${id}" (${type}) carries no "${member}" object`)
  }
  const probabilities: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isProbability(entry)) {
      fail(`answer "${id}" (${type}) has a non-probability for "${member}.${key}" — expected a finite number in 0..1`)
    }
    probabilities[key] = entry
  }
  return probabilities
}

function readAnswer(id: string, value: unknown, questionType: JevWireQuestion['type']): JevAnswer {
  if (!isRecord(value)) fail(`the response has no answer object for question "${id}"`)
  if (typeof value.type !== 'string' || !ANSWER_TYPES.has(value.type)) {
    fail(`the response has no answer object for question "${id}"`)
  }
  if (value.type !== questionType) {
    fail(`answer "${id}" is a "${value.type}" answer to a "${questionType}" question`)
  }
  switch (value.type) {
    case 'noul': {
      if (!isProbability(value.noul)) {
        fail(`answer "${id}" (noul) carries no usable "noul" — expected a finite number in 0..1`)
      }
      return { ...value, type: 'noul', noul: value.noul }
    }
    case 'choice': {
      if (typeof value.choice !== 'string') {
        fail(`answer "${id}" (choice) carries no "choice" string`)
      }
      if (!isProbability(value.confidence)) {
        fail(`answer "${id}" (choice) carries no usable "confidence" — expected a finite number in 0..1`)
      }
      return {
        ...value,
        type: 'choice',
        choice: value.choice,
        probabilities: readProbabilityMap(id, 'choice', value.probabilities, 'probabilities'),
        confidence: value.confidence,
      }
    }
    case 'score': {
      if (!isFiniteNumber(value.score)) {
        fail(`answer "${id}" (score) carries no usable "score" — expected a finite number`)
      }
      if (!isProbability(value.confidence)) {
        fail(`answer "${id}" (score) carries no usable "confidence" — expected a finite number in 0..1`)
      }
      if (!isRecord(value.legend)) {
        fail(`answer "${id}" (score) carries no "legend" object`)
      }
      return {
        ...value,
        type: 'score',
        score: value.score,
        confidence: value.confidence,
        legend: value.legend as Readonly<Record<string, JevEntry>>,
        probabilities: readProbabilityMap(id, 'score', value.probabilities, 'probabilities'),
      }
    }
  }
}
