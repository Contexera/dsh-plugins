import { describe, expect, it } from 'vitest'
import { fetchTransport } from '../src/transport.ts'

describe('fetchTransport', () => {
  it('reads a response into its status, lowercased header names, and text body', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      new Response('{"model":"jev-1.13.0"}', { status: 201, headers: { 'Retry-After': '3', 'Content-Type': 'application/json' } })
    try {
      const response = await fetchTransport({
        url: 'https://example.test/v1/systemone',
        headers: { authorization: 'Bearer k' },
        body: '{}',
        signal: new AbortController().signal,
      })

      expect(response.status).toBe(201)
      expect(response.headers['retry-after']).toBe('3')
      expect(response.body).toBe('{"model":"jev-1.13.0"}')
    } finally {
      globalThis.fetch = original
    }
  })

  it('resolves a non-2xx response, because only the service decides what a status means', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response('slow down', { status: 429 })
    try {
      const response = await fetchTransport({
        url: 'https://example.test/v1/systemone',
        headers: {},
        body: '{}',
        signal: new AbortController().signal,
      })

      expect(response.status).toBe(429)
      expect(response.body).toBe('slow down')
    } finally {
      globalThis.fetch = original
    }
  })
})
