import { describe, expect, it } from 'vitest'
import { JevError } from '../src/errors.ts'
import type { JevWireQuestion } from '../src/request.ts'
import { parseResponse } from '../src/response.ts'

const QUESTIONS: Readonly<Record<string, JevWireQuestion>> = {
  speak: { type: 'noul', instructions: 'should the assistant say something?' },
}

/** Parse a body with a redactor that marks the one secret these tests plant. */
function parse(body: string, questions: Readonly<Record<string, JevWireQuestion>> = QUESTIONS) {
  return parseResponse(body, questions, text => text.split('sk-secret').join('[redacted]'))
}

/** Run a parse and return the failure it raised. */
function failure(body: string, questions: Readonly<Record<string, JevWireQuestion>> = QUESTIONS): JevError {
  try {
    parse(body, questions)
  } catch (error: unknown) {
    if (error instanceof JevError) return error
    throw error
  }
  throw new Error('expected the response to be rejected')
}

describe('parseResponse', () => {
  it('returns the model that answered, one answer per question, and the usage record', () => {
    const result = parse(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: { speak: { type: 'noul', noul: 0.82 } },
        usage: { input_tokens: 120, output_tokens: 4 },
      }),
    )

    expect(result).toEqual({
      model: 'jev-1.13.0',
      answers: { speak: { type: 'noul', noul: 0.82 } },
      usage: { input_tokens: 120, output_tokens: 4 },
    })
  })

  it('reports no usage record when the vendor sent none, which is accounting rather than protocol', () => {
    const result = parse(JSON.stringify({ model: 'jev-1.13.0', answers: { speak: { type: 'noul', noul: 0.5 } } }))

    expect(result.usage).toBeUndefined()
  })

  it('passes an answer through as the vendor sent it, members and all', () => {
    const score: Readonly<Record<string, JevWireQuestion>> = {
      urgency: { type: 'score', instructions: 'how urgent?', criteria: ['nothing', 'later', 'now'] },
    }
    const result = parse(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          urgency: { type: 'score', score: 1.5, confidence: 0.4, legend: { 0: 'nothing', 1: 'later', 2: 'now' }, probabilities: { 0: 0.2, 1: 0.4, 2: 0.4 } },
        },
      }),
      score,
    )

    expect(result.answers['urgency']).toMatchObject({ score: 1.5, legend: { 0: 'nothing' } })
  })

  it('rejects a body that is not JSON, and shows which body it was', () => {
    const error = failure('<html>502 Bad Gateway</html>')

    expect(error.kind).toBe('protocol')
    expect(error.message).toContain('the response body is not JSON: <html>502 Bad Gateway</html>')
  })

  it('rejects a JSON body that is not an object', () => {
    expect(failure('[]').message).toContain('the response is not a JSON object: []')
  })

  it('rejects a response without a model id, which is what makes the pinned model verifiable', () => {
    expect(failure(JSON.stringify({ answers: { speak: { type: 'noul', noul: 0.5 } } })).message)
      .toContain('carries no model id')
  })

  it('rejects a response that has no answer for a question that was asked', () => {
    const error = failure(JSON.stringify({ model: 'jev-1.13.0', answers: {} }))

    expect(error.kind).toBe('protocol')
    expect(error.message).toContain('no answer object for question "speak"')
  })

  it('rejects an answer whose type is not the one that was asked for', () => {
    const error = failure(JSON.stringify({ model: 'jev-1.13.0', answers: { speak: { type: 'choice', choice: 'yes' } } }))

    expect(error.message).toContain('answer "speak" is a "choice" answer to a "noul" question')
  })

  it('rejects an answer that is not an object', () => {
    expect(failure(JSON.stringify({ model: 'jev-1.13.0', answers: { speak: 0.8 } })).message)
      .toContain('no answer object for question "speak"')
  })

  it('rejects an answer with a type the vendor does not document', () => {
    expect(failure(JSON.stringify({ model: 'jev-1.13.0', answers: { speak: { type: 'likert', value: 1 } } })).message)
      .toContain('no answer object for question "speak"')
  })

  it('rejects a usage record that is not an object', () => {
    expect(failure(JSON.stringify({ model: 'jev-1.13.0', answers: { speak: { type: 'noul', noul: 0.5 } }, usage: 3 })).message)
      .toContain('"usage" is not an object')
  })

  it('redacts a body it quotes back, so a response that echoes a credential cannot put it in a log', () => {
    const error = failure('{"echo":"sk-secret"} not json')

    expect(error.message).toContain('[redacted]')
    expect(error.message).not.toContain('sk-secret')
  })
})
