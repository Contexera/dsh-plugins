import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { JevRequest } from '../src/contracts.ts'
import { JevError } from '../src/errors.ts'
import type { JevWireQuestion } from '../src/request.ts'
import { parseResponse } from '../src/response.ts'
import { Jev, type JevConfig } from '../src/service.ts'
import { stubTransport, vendorAnswer } from './stub.ts'

/** The one request the service-level case drives, matching the questions below. */
const REQUEST: JevRequest = {
  state: 'the user has been quiet for six hours',
  questions: { speak: { type: 'noul', instructions: 'should the assistant say something?' } },
}

/** Let a plugin's loading settle, as the service is registered by an async fiber. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** Mount the service on its own context, as the service's own tests do. */
async function mount(config: JevConfig): Promise<Context> {
  const ctx = new Context()
  ctx.plugin(Jev, { apiKey: 'test-key', ...config })
  await settle()
  return ctx
}

/** Run a call and return the failure it raised. */
async function rejection(run: Promise<unknown>): Promise<JevError> {
  try {
    await run
  } catch (error: unknown) {
    if (error instanceof JevError) return error
    throw error
  }
  throw new Error('expected the call to fail')
}

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

describe('parseResponse answer member validation', () => {
  const NOUL: Readonly<Record<string, JevWireQuestion>> = {
    speak: { type: 'noul', instructions: 'should the assistant say something?' },
  }
  const CHOICE: Readonly<Record<string, JevWireQuestion>> = {
    tone: { type: 'choice', instructions: 'which tone?', criteria: { warm: 'warm', terse: null } },
  }
  const SCORE: Readonly<Record<string, JevWireQuestion>> = {
    urgency: { type: 'score', instructions: 'how urgent?', criteria: ['nothing', 'later', 'now'] },
  }

  /** Parse one answer for one question kind; the outcome rather than a throw. */
  function outcome(
    answerBody: unknown,
    questions: Readonly<Record<string, JevWireQuestion>>,
  ): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: JevError } {
    const id = Object.keys(questions)[0]!
    const text = JSON.stringify({ model: 'jev-1.13.0', answers: { [id]: answerBody } })
    try {
      return { ok: true, value: parse(text, questions).answers[id] }
    } catch (error: unknown) {
      if (error instanceof JevError) return { ok: false, error }
      throw error
    }
  }

  /** Assert one answer is refused as protocol, naming the answer and the member. */
  const expectProtocol = (
    answerBody: unknown,
    questions: Readonly<Record<string, JevWireQuestion>>,
    fragment: string,
  ): void => {
    const result = outcome(answerBody, questions)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('protocol')
    expect(result.error.message).toContain(fragment)
  }

  it('accepts every documented answer that carries its declared members', () => {
    expect(outcome({ type: 'noul', noul: 0.82 }, NOUL).ok).toBe(true)
    expect(outcome({ type: 'choice', choice: 'warm', probabilities: { warm: 0.7, terse: 0.3 }, confidence: 0.4 }, CHOICE).ok).toBe(true)
    expect(outcome({
      type: 'score', score: 1.5, confidence: 0.4,
      legend: { 0: 'nothing', 1: 'later', 2: 'now' }, probabilities: { 0: 0.2, 1: 0.4, 2: 0.4 },
    }, SCORE).ok).toBe(true)
  })

  it.each([
    ['noul missing', { type: 'noul' }],
    ['noul not a number', { type: 'noul', noul: 'high' }],
    ['noul below 0', { type: 'noul', noul: -0.1 }],
    ['noul above 1', { type: 'noul', noul: 1.1 }],
    ['noul not finite', { type: 'noul', noul: Number.NaN }],
  ])('rejects a noul answer with %s', (_name, answerBody) => {
    expectProtocol(answerBody, NOUL, 'answer "speak" (noul)')
  })

  it.each([
    ['choice missing', { type: 'choice', probabilities: { warm: 1 }, confidence: 0.5 }],
    ['choice not a string', { type: 'choice', choice: 7, probabilities: { warm: 1 }, confidence: 0.5 }],
    ['probabilities missing', { type: 'choice', choice: 'warm', confidence: 0.5 }],
    ['probabilities not an object', { type: 'choice', choice: 'warm', probabilities: 1, confidence: 0.5 }],
    ['a probability that is not a number', { type: 'choice', choice: 'warm', probabilities: { warm: 'most' }, confidence: 0.5 }],
    ['a probability above 1', { type: 'choice', choice: 'warm', probabilities: { warm: 1.4 }, confidence: 0.5 }],
    ['a probability below 0', { type: 'choice', choice: 'warm', probabilities: { warm: -0.2 }, confidence: 0.5 }],
    ['confidence missing', { type: 'choice', choice: 'warm', probabilities: { warm: 1 } }],
    ['confidence out of range', { type: 'choice', choice: 'warm', probabilities: { warm: 1 }, confidence: 9 }],
  ])('rejects a choice answer with %s', (_name, answerBody) => {
    expectProtocol(answerBody, CHOICE, 'answer "tone" (choice)')
  })

  it.each([
    ['score missing', { type: 'score', confidence: 0.4, legend: {}, probabilities: {} }],
    ['score not a number', { type: 'score', score: 'high', confidence: 0.4, legend: {}, probabilities: {} }],
    ['score not finite', { type: 'score', score: Number.POSITIVE_INFINITY, confidence: 0.4, legend: {}, probabilities: {} }],
    ['confidence missing', { type: 'score', score: 1, legend: {}, probabilities: {} }],
    ['confidence out of range', { type: 'score', score: 1, confidence: 2, legend: {}, probabilities: {} }],
    ['legend missing', { type: 'score', score: 1, confidence: 0.4, probabilities: {} }],
    ['legend not an object', { type: 'score', score: 1, confidence: 0.4, legend: [], probabilities: {} }],
    ['probabilities missing', { type: 'score', score: 1, confidence: 0.4, legend: {} }],
    ['a probability out of range', { type: 'score', score: 1, confidence: 0.4, legend: {}, probabilities: { 0: 3 } }],
  ])('rejects a score answer with %s', (_name, answerBody) => {
    expectProtocol(answerBody, SCORE, 'answer "urgency" (score)')
  })

  it('keeps a vendor field the declaration does not mention', () => {
    const result = outcome({ type: 'noul', noul: 0.82, rationale: 'a direct question was asked', latency_ms: 12 }, NOUL)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ noul: 0.82, rationale: 'a direct question was asked', latency_ms: 12 })
  })

  it('keeps an extra nested field on a choice answer', () => {
    const result = outcome({
      type: 'choice', choice: 'warm', probabilities: { warm: 0.7, terse: 0.3 }, confidence: 0.4,
      vendor_note: { nested: true },
    }, CHOICE)

    expect(result.ok).toBe(true)
  })

  it('reports a malformed answer as protocol, which the service never retries', async () => {
    const stub = stubTransport(() => vendorAnswer({ type: 'noul', noul: 'high' }))
    const ctx = await mount({ transport: stub.transport })

    const error = await rejection(ctx.jev.decide(REQUEST))

    expect(error.kind).toBe('protocol')
    expect(stub.count()).toBe(1)
  })
})
