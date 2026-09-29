import { describe, expect, it } from 'vitest'
import { JevError } from '../src/errors.ts'
import { buildWireBody } from '../src/request.ts'

/** Run a call and return the failure it raised. */
function failure(run: () => unknown): JevError {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof JevError) return error
    throw error
  }
  throw new Error('expected the call to be rejected')
}

describe('buildWireBody', () => {
  it('carries the state, the model, and each question under the id the caller chose', () => {
    const body = buildWireBody(
      {
        state: 'the user has not written for six hours',
        questions: {
          speak: { type: 'noul', instructions: 'should the assistant say something?', criteria: { true: 'say it', false: 'stay quiet' } },
        },
      },
      'jev-1.13.0',
    )

    expect(body).toEqual({
      state: 'the user has not written for six hours',
      model: 'jev-1.13.0',
      questions: {
        speak: { type: 'noul', instructions: 'should the assistant say something?', criteria: { true: 'say it', false: 'stay quiet' } },
      },
    })
  })

  it('normalizes the boolean alias, so the wire only ever carries the documented type', () => {
    const body = buildWireBody({ state: 'x', questions: { speak: { type: 'boolean', instructions: 'speak?' } } }, 'm')

    expect(body.questions['speak']?.type).toBe('noul')
  })

  it('passes structured entries through: an entry may be a string, an object, an array or null', () => {
    const body = buildWireBody(
      {
        state: { turns: 3, topics: ['weather'] },
        questions: {
          score: {
            type: 'score',
            instructions: { text: 'how urgent is this?', locale: 'en' },
            criteria: ['nothing', { level: 1 }, null],
          },
        },
      },
      'm',
    )

    expect(body.state).toEqual({ turns: 3, topics: ['weather'] })
    expect(body.questions['score']).toEqual({
      type: 'score',
      instructions: { text: 'how urgent is this?', locale: 'en' },
      criteria: ['nothing', { level: 1 }, null],
    })
  })

  it('rejects a call that asks no question', () => {
    const error = failure(() => buildWireBody({ state: 'x', questions: {} }, 'm'))

    expect(error.kind).toBe('request')
    expect(error.message).toContain('at least one question')
  })

  it('rejects an empty state, which asks the questions about nothing', () => {
    expect(failure(() => buildWireBody({ state: '   ', questions: { q: { type: 'noul', instructions: 'x' } } }, 'm')).message)
      .toContain('state must not be blank')
    expect(failure(() => buildWireBody({ state: {}, questions: { q: { type: 'noul', instructions: 'x' } } }, 'm')).message)
      .toContain('state must not be an empty object')
  })

  it('rejects a message that is not a question map', () => {
    const error = failure(() => buildWireBody({ state: 'x', questions: [] as never }, 'm'))

    expect(error.kind).toBe('request')
    expect(error.message).toContain('questions must be a map of questions; got an array')
  })

  it('rejects a choice question whose criteria is not the option map', () => {
    const error = failure(() =>
      buildWireBody({ state: 'x', questions: { tone: { type: 'choice', instructions: 'tone?', criteria: ['calm'] as never } } }, 'm'),
    )

    expect(error.message).toContain('questions["tone"].criteria must be the option map; got an array')
  })

  it('rejects a choice question that offers no option to choose', () => {
    const error = failure(() => buildWireBody({ state: 'x', questions: { tone: { type: 'choice', instructions: 'tone?', criteria: {} } } }, 'm'))

    expect(error.message).toContain('must offer at least one option')
  })

  it('rejects a score question whose criteria is a map, which is the shape the vendor documents for choice', () => {
    const error = failure(() =>
      buildWireBody(
        { state: 'x', questions: { urgency: { type: 'score', instructions: 'how urgent?', criteria: { low: 'nothing' } as never } } },
        'm',
      ),
    )

    expect(error.message).toContain('questions["urgency"].criteria must be an array of level descriptions; got an object')
  })

  it('accepts the vendor\'s ten-level ceiling and rejects an eleventh level', () => {
    const levels = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
    const body = buildWireBody({ state: 'x', questions: { urgency: { type: 'score', instructions: 'how urgent?', criteria: levels } } }, 'm')

    expect(body.questions['urgency']).toMatchObject({ criteria: levels })
    const error = failure(() =>
      buildWireBody({ state: 'x', questions: { urgency: { type: 'score', instructions: 'how urgent?', criteria: [...levels, '10'] } } }, 'm'),
    )
    expect(error.message).toContain('must not describe more than 10 levels; got 11')
  })

  it('rejects an entry that is neither a string, an object, an array nor null', () => {
    const error = failure(() =>
      buildWireBody({ state: 'x', questions: { tone: { type: 'choice', instructions: 'tone?', criteria: { calm: 7 as never } } } }, 'm'),
    )

    expect(error.message).toContain('questions["tone"].criteria["calm"] must be a string, an object, an array, or null; got a number')
  })

  it('rejects a question with no instructions', () => {
    const error = failure(() => buildWireBody({ state: 'x', questions: { speak: { type: 'noul' } as never } }, 'm'))

    expect(error.message).toContain('questions["speak"].instructions must be a string, an object, an array, or null; got undefined')
  })

  it('rejects a question type the vendor does not document', () => {
    const error = failure(() => buildWireBody({ state: 'x', questions: { speak: { type: 'likert', instructions: 'x' } as never } }, 'm'))

    expect(error.kind).toBe('request')
    expect(error.message).toContain('questions["speak"].type must be "noul", "choice", or "score" (or the alias "boolean"); got a string')
  })

  it('rejects a noul criteria that describes the two answers as something other than an object', () => {
    const error = failure(() =>
      buildWireBody({ state: 'x', questions: { speak: { type: 'noul', instructions: 'x', criteria: 'yes or no' as never } } }, 'm'),
    )

    expect(error.message).toContain('must be an object with optional "true" and "false" entries; got a string')
  })
})
