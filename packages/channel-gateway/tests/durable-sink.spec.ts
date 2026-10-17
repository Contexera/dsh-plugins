import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { createTelegramChannel } from '../src/adapters/telegram/index.ts'
import { allowlistAuth } from '../src/auth.ts'
import type { ChannelInboundSink, InboundMessage } from '../src/contracts.ts'
import { ChannelGateway } from '../src/gateway.ts'

function durableStore() {
  const records = new Map<string, InboundMessage>()
  let failNext = false
  let writes = 0
  const sink: ChannelInboundSink = {
    async accept(message) {
      writes += 1
      if (failNext) {
        failNext = false
        throw new Error('the store is unavailable')
      }
      records.set(`${message.channel}\u0000${message.providerMessageId}`, message)
    },
  }
  return {
    sink,
    records,
    writes: () => writes,
    failNextAcceptance: () => { failNext = true },
  }
}

function botApi(updates: readonly Record<string, unknown>[]) {
  let resends = 0
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const method = String(input).split('/').at(-1) ?? ''
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    const value = ((): unknown => {
      if (method === 'getMe') return { id: 1, username: 'the-bot' }
      const offset = body?.['offset']
      const remaining = typeof offset === 'number'
        ? updates.filter(entry => Number(entry['update_id']) >= offset)
        : updates
      if (remaining.length === 0 || resends >= 6) return undefined
      resends += 1
      return remaining
    })()
    if (value === undefined) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
    }
    return { ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: value }) } as unknown as Response
  }) as unknown as typeof fetch
  return impl
}

const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the adapter')
    await new Promise(resolve => { setTimeout(resolve, 1) })
  }
}

function update(id: number, updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: id,
      date: 1_789_000_000 + id,
      chat: { id: 42, type: 'private' },
      from: { id: 42, first_name: 'Yu', is_bot: false },
      text: `message ${id}`,
    },
  }
}

async function mounted(
  updates: readonly Record<string, unknown>[],
  allow: readonly string[],
  sink: ChannelInboundSink,
) {
  const ctx = new Context()
  const announced: InboundMessage[] = []
  ctx.on('channel/inbound', message => { announced.push(message) })
  ctx.plugin(ChannelGateway, { auth: allowlistAuth(allow) })
  await settle()

  ctx.channels.registerInboundSink(sink)
  ctx.channels.register(createTelegramChannel({ token: 'T', fetch: botApi(updates), retryDelayMs: 1 }))
  await settle()
  return { ctx, announced }
}

describe('a durable sink behind a real adapter', () => {
  it('accepts a message once, and announces it once, when nothing fails', async () => {
    const store = durableStore()
    const { announced } = await mounted([update(1, 10)], ['telegram:42'], store.sink)

    await waitFor(() => announced.length === 1)

    expect(store.writes()).toBe(1)
    expect([...store.records.keys()]).toEqual(['telegram\u00001'])
    expect(announced.map(message => message.providerMessageId)).toEqual(['1'])
  })

  it('produces one durable record from a page the provider handed over twice', async () => {
    const store = durableStore()
    store.failNextAcceptance()
    const { announced } = await mounted([update(1, 10)], ['telegram:42'], store.sink)

    await waitFor(() => announced.length === 1)

    expect(store.writes()).toBeGreaterThanOrEqual(2)
    expect(store.records.size).toBe(1)
    expect(announced.map(message => message.providerMessageId)).toEqual(['1'])
  })

  it('does not let a refused message hold the page behind it', async () => {
    const store = durableStore()
    const stranger = {
      update_id: 10,
      message: { ...update(1, 10).message, from: { id: 999, first_name: 'Nobody', is_bot: false } },
    }
    const { announced } = await mounted([stranger, update(2, 11)], ['telegram:42'], store.sink)

    await waitFor(() => announced.length === 1)

    expect(store.writes()).toBe(1)
    expect([...store.records.keys()]).toEqual(['telegram\u00002'])
    expect(announced.map(message => message.providerMessageId)).toEqual(['2'])
  })
})
