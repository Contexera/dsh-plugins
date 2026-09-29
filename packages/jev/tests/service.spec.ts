import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { JevRequest } from '../src/contracts.ts'
import { JevError } from '../src/errors.ts'
import { Jev, type JevConfig } from '../src/service.ts'
import type { JevTransport } from '../src/transport.ts'
import { answer, stallingTransport, stubTransport, vendorAnswer } from './stub.ts'

const REQUEST: JevRequest = {
  state: 'the user has been quiet for six hours',
  questions: { speak: { type: 'noul', instructions: 'should the assistant say something?' } },
}

/** Let a plugin's loading settle, as the service is registered by an async fiber. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** Mount the service on its own context, with a key and the given seams. */
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

describe('Jev.decide', () => {
  it('posts the call to the vendor endpoint with the key, and returns the vendor\'s result', async () => {
    const stub = stubTransport(() => vendorAnswer({ type: 'noul', noul: 0.82 }))
    const ctx = await mount({ transport: stub.transport })

    const result = await ctx.jev.decide(REQUEST)

    expect(result).toEqual({
      model: 'jev-1.13.0',
      answers: { speak: { type: 'noul', noul: 0.82 } },
      usage: { input_tokens: 12, output_tokens: 3 },
    })
    expect(stub.count()).toBe(1)
    const attempt = stub.attempts[0]
    expect(attempt?.request.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(attempt?.request.headers['authorization']).toBe('Bearer test-key')
    expect(attempt?.request.headers['content-type']).toBe('application/json')
    expect(attempt?.body).toEqual({
      state: 'the user has been quiet for six hours',
      model: 'jev-1.13.0',
      questions: { speak: { type: 'noul', instructions: 'should the assistant say something?' } },
    })
  })

  it('sends nothing when the call is malformed', async () => {
    const stub = stubTransport(() => vendorAnswer({ type: 'noul', noul: 0.5 }))
    const ctx = await mount({ transport: stub.transport })

    const error = await rejection(ctx.jev.decide({ ...REQUEST, state: '' }))

    expect(error.kind).toBe('request')
    expect(stub.count()).toBe(0)
  })

  it('retries a status the endpoint documents as transient and answers from the next attempt', async () => {
    const stub = stubTransport(attempt => attempt === 1 ? answer(503, { error: 'unavailable' }) : vendorAnswer({ type: 'noul', noul: 0.7 }))
    const ctx = await mount({ transport: stub.transport, retryDelayMs: 1 })

    const result = await ctx.jev.decide(REQUEST)

    expect(result.answers['speak']).toEqual({ type: 'noul', noul: 0.7 })
    expect(stub.count()).toBe(2)
  })

  it('retries a transport failure and a timeout, and reports the last failure when attempts run out', async () => {
    const stub = stubTransport(attempt => {
      if (attempt === 1) throw new Error('ECONNRESET')
      return answer(500, { error: 'still broken' })
    })
    const ctx = await mount({ transport: stub.transport, attempts: 2, retryDelayMs: 1 })

    const error = await rejection(ctx.jev.decide(REQUEST))

    expect(error.kind).toBe('http')
    expect(error.status).toBe(500)
    expect(error.message).toContain('the endpoint answered 500: {"error":"still broken"}')
    expect(stub.count()).toBe(2)
  })

  it('reports a transport failure without a status when the endpoint never answered', async () => {
    const stub = stubTransport(() => { throw new Error('ECONNREFUSED') })
    const ctx = await mount({ transport: stub.transport, attempts: 1 })

    const error = await rejection(ctx.jev.decide(REQUEST))

    expect(error.kind).toBe('transport')
    expect(error.message).toContain('the request failed: ECONNREFUSED')
  })

  it('redacts the key from a message a transport failure carries back', async () => {
    const stub = stubTransport(() => { throw new Error('refused a request with Bearer test-key') })
    const ctx = await mount({ transport: stub.transport, attempts: 1 })

    const error = await rejection(ctx.jev.decide(REQUEST))

    expect(error.message).toContain('[redacted]')
    expect(error.message).not.toContain('test-key')
  })

  it('does not retry a status that is this caller\'s own mistake', async () => {
    const stub = stubTransport(() => answer(401, { error: 'bad key' }))
    const ctx = await mount({ transport: stub.transport, retryDelayMs: 1 })

    const error = await rejection(ctx.jev.decide(REQUEST))

    expect(error.kind).toBe('http')
    expect(error.status).toBe(401)
    expect(stub.count()).toBe(1)
  })

  it('reports a timeout, and retries an attempt that timed out', async () => {
    const timedOut = await mount({ transport: stallingTransport(), timeoutMs: 5, attempts: 1 })
    const timeout = await rejection(timedOut.jev.decide(REQUEST))

    expect(timeout.kind).toBe('timeout')
    expect(timeout.message).toContain('no response within 5ms')

    const stall = stallingTransport()
    let calls = 0
    const mixed: JevTransport = (request) => {
      calls += 1
      if (calls === 1) return stall(request)
      return Promise.resolve(vendorAnswer({ type: 'noul', noul: 0.6 }))
    }
    const retried = await mount({ transport: mixed, timeoutMs: 5, attempts: 2, retryDelayMs: 1 })
    const result = await retried.jev.decide(REQUEST)

    expect(result.answers['speak']).toEqual({ type: 'noul', noul: 0.6 })
    expect(calls).toBe(2)
  })

  it('never retries a cancellation, whether it lands on the attempt or on the wait between attempts', async () => {
    const duringAttempt = stubTransport((_attempt, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => { reject(new Error('the attempt was aborted')) }, { once: true })
    }))
    const first = await mount({ transport: duringAttempt.transport, attempts: 3 })
    const controller = new AbortController()
    const pending = first.jev.decide({ ...REQUEST, signal: controller.signal })
    controller.abort()

    const cancelled = await rejection(pending)

    expect(cancelled.kind).toBe('cancelled')
    expect(duringAttempt.count()).toBe(1)

    const duringWait = stubTransport(() => answer(500, { error: 'boom' }))
    const second = await mount({ transport: duringWait.transport, attempts: 3, retryDelayMs: 50 })
    const waiting = new AbortController()
    const retrying = second.jev.decide({ ...REQUEST, signal: waiting.signal })
    await settle()
    waiting.abort()

    const stopped = await rejection(retrying)

    expect(stopped.kind).toBe('cancelled')
    expect(duringWait.count()).toBe(1)
  })

  it('waits out a retry-after in seconds, and not a millisecond less', async () => {
    const stub = stubTransport(attempt => attempt === 1
      ? answer(429, { error: 'slow down' }, { 'retry-after': '2' })
      : vendorAnswer({ type: 'noul', noul: 0.9 }))
    const ctx = await mount({ transport: stub.transport, retryDelayMs: 10, maxRetryDelayMs: 60_000 })
    // Mounting settles on a real timer, so the fake clock starts once the service is up.
    vi.useFakeTimers()
    try {
      const pending = ctx.jev.decide(REQUEST)
      await vi.advanceTimersByTimeAsync(0)
      expect(stub.count()).toBe(1)
      await vi.advanceTimersByTimeAsync(1999)
      expect(stub.count()).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(stub.count()).toBe(2)
      await expect(pending).resolves.toMatchObject({ model: 'jev-1.13.0' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits out a retry-after given as an HTTP date', async () => {
    const stub = stubTransport(attempt => attempt === 1
      ? answer(429, { error: 'slow down' }, { 'retry-after': new Date(Date.parse('2026-01-01T00:00:02Z')).toUTCString() })
      : vendorAnswer({ type: 'noul', noul: 0.9 }))
    const ctx = await mount({ transport: stub.transport, retryDelayMs: 10, maxRetryDelayMs: 60_000 })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    try {
      const pending = ctx.jev.decide(REQUEST)
      await vi.advanceTimersByTimeAsync(1999)
      expect(stub.count()).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(stub.count()).toBe(2)
      await expect(pending).resolves.toMatchObject({ model: 'jev-1.13.0' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops rather than waiting longer than the caller agreed to', async () => {
    const stub = stubTransport(() => answer(429, { error: 'slow down' }, { 'retry-after': '30' }))
    const ctx = await mount({ transport: stub.transport, maxRetryDelayMs: 1000 })

    const error = await rejection(ctx.jev.decide(REQUEST))

    expect(error.kind).toBe('http')
    expect(error.status).toBe(429)
    expect(stub.count()).toBe(1)
  })
})
