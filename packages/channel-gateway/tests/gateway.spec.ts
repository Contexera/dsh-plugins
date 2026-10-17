import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { allowlistAuth } from '../src/auth.ts'
import type { Channel, ChannelInboundSink, ChannelInbox, InboundMessage } from '../src/contracts.ts'
import { ChannelGatewayError } from '../src/errors.ts'
import { ChannelGateway } from '../src/gateway.ts'

const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

interface TestChannelOptions {
  readonly failStart?: boolean
}

function testChannel(name: string, options: TestChannelOptions = {}) {
  const inboxes: ChannelInbox[] = []
  const sent: string[] = []
  let stops = 0
  const channel: Channel = {
    name,
    capabilities: { attachments: false, attachmentDownload: false, buttons: false, edit: false, replyTo: false, maxTextLength: 100 },
    start(inbox) {
      if (options.failStart === true) return Promise.reject(new Error('no transport'))
      inboxes.push(inbox)
      return Promise.resolve()
    },
    stop() {
      stops += 1
      return Promise.resolve()
    },
    send(message) {
      sent.push(message.text)
      return Promise.resolve({ providerMessageId: `${name}:1` })
    },
  }
  return {
    channel,
    firstInbox: () => inboxes[0],
    sent,
    stops: () => stops,
  }
}

async function mount(allow: readonly string[] = []): Promise<{ ctx: Context; seen: InboundMessage[] }> {
  const ctx = new Context()
  const seen: InboundMessage[] = []
  ctx.on('channel/inbound', message => { seen.push(message) })
  ctx.plugin(ChannelGateway, { auth: allowlistAuth(allow) })
  await settle()
  return { ctx, seen }
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'test',
    providerMessageId: '1',
    actor: { id: '42' },
    place: { route: 'chat:42', kind: 'direct' },
    visibility: 'private',
    text: 'hello',
    timestamp: '2026-09-22T15:00:00.000Z',
    ...overrides,
  }
}

describe('ChannelGateway', () => {
  it('starts a registered channel and announces an authorized message', async () => {
    const { ctx, seen } = await mount(['test:42'])
    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()

    expect(ctx.channels.channels.map(entry => entry.name)).toEqual(['test'])
    registered.firstInbox()?.deliver(inbound())
    await settle()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.providerMessageId).toBe('1')
  })

  it('drops a message from an actor the policy refuses', async () => {
    const { ctx, seen } = await mount(['test:7'])
    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()

    registered.firstInbox()?.deliver(inbound())
    await settle()

    expect(seen).toEqual([])
  })

  it('drops a message a policy refuses asynchronously', async () => {
    const ctx = new Context()
    const seen: InboundMessage[] = []
    ctx.on('channel/inbound', message => { seen.push(message) })
    ctx.plugin(ChannelGateway, { auth: { authorize: () => Promise.resolve(false) } })
    await settle()

    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()
    registered.firstInbox()?.deliver(inbound())
    await settle()

    expect(seen).toEqual([])
  })

  it('drops a message when the policy itself fails', async () => {
    const ctx = new Context()
    const seen: InboundMessage[] = []
    ctx.on('channel/inbound', message => { seen.push(message) })
    ctx.plugin(ChannelGateway, { auth: { authorize: () => { throw new Error('policy is broken') } } })
    await settle()

    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()
    registered.firstInbox()?.deliver(inbound())
    await settle()

    expect(seen).toEqual([])
  })

  it('refuses a duplicate channel name', async () => {
    const { ctx } = await mount()
    ctx.channels.register(testChannel('test').channel)
    await settle()

    expect(() => ctx.channels.register(testChannel('test').channel)).toThrow(ChannelGatewayError)
  })

  it('refuses a message a channel reports under another channel name', async () => {
    const { ctx, seen } = await mount(['*'])
    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()

    registered.firstInbox()?.deliver(inbound({ channel: 'other' }))
    await settle()

    expect(seen).toEqual([])
  })

  it('sends through the channel the message names', async () => {
    const { ctx } = await mount()
    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()

    const result = await ctx.channels.send({ channel: 'test', route: 'chat:42', text: 'out' })
    expect(result.providerMessageId).toBe('test:1')
    expect(registered.sent).toEqual(['out'])
  })

  it('refuses to send through a channel that is not registered', async () => {
    const { ctx } = await mount()
    await expect(ctx.channels.send({ channel: 'absent', route: 'chat:1', text: 'out' }))
      .rejects.toThrow(ChannelGatewayError)
  })

  it('unregisters a channel whose start failed, so it is not addressable', async () => {
    const { ctx } = await mount()
    ctx.channels.register(testChannel('test', { failStart: true }).channel)
    await settle()

    expect(ctx.channels.channels).toEqual([])
    await expect(ctx.channels.send({ channel: 'test', route: 'chat:1', text: 'out' }))
      .rejects.toThrow(ChannelGatewayError)
  })

  it('stops a channel once when its registration is disposed', async () => {
    const { ctx } = await mount()
    const registered = testChannel('test')
    const dispose = ctx.channels.register(registered.channel)
    await settle()

    dispose()
    dispose()
    await settle()

    expect(registered.stops()).toBe(1)
    expect(ctx.channels.channels).toEqual([])
  })

  it('resolves an attachment through the channel that reported it', async () => {
    const { ctx } = await mount()
    const bytes = new Uint8Array([9, 8, 7])
    const base = testChannel('withMedia')
    const channel: Channel = {
      ...base.channel,
      resolveAttachment: () => Promise.resolve({ bytes, mimeType: 'image/png' }),
    }
    ctx.channels.register(channel)
    await settle()

    const resolved = await ctx.channels.resolveAttachment('withMedia', { kind: 'image', ref: 'r' })
    expect(resolved.bytes).toBe(bytes)
    expect(resolved.mimeType).toBe('image/png')
  })

  it('refuses to resolve for an unknown or unsupporting channel', async () => {
    const { ctx } = await mount()
    const registered = testChannel('plain')
    ctx.channels.register(registered.channel)
    await settle()

    await expect(ctx.channels.resolveAttachment('missing', { kind: 'image', ref: 'r' }))
      .rejects.toThrow(ChannelGatewayError)
    await expect(ctx.channels.resolveAttachment('plain', { kind: 'image', ref: 'r' }))
      .rejects.toThrow(ChannelGatewayError)
  })
})

describe('ChannelGateway inbound sink', () => {
  function recordingSink() {
    const accepted: InboundMessage[] = []
    let mode: 'ok' | 'reject' | 'stall' = 'ok'
    let release: (() => void) | undefined
    const sink: ChannelInboundSink = {
      accept(message) {
        accepted.push(message)
        if (mode === 'reject') return Promise.reject(new Error('the store is full'))
        if (mode === 'stall') return new Promise<void>(resolve => { release = resolve })
        return Promise.resolve()
      },
    }
    return {
      sink,
      accepted,
      fail: () => { mode = 'reject' },
      stall: () => { mode = 'stall' },
      release: () => { release?.() },
    }
  }

  it('refuses a second sink while one is registered', async () => {
    const { ctx } = await mount(['*'])
    ctx.channels.registerInboundSink(recordingSink().sink)

    expect(() => ctx.channels.registerInboundSink(recordingSink().sink)).toThrow(ChannelGatewayError)
  })

  it('accepts a new sink once the previous one is unregistered', async () => {
    const { ctx } = await mount(['*'])
    const stop = ctx.channels.registerInboundSink(recordingSink().sink)
    stop()

    expect(() => ctx.channels.registerInboundSink(recordingSink().sink)).not.toThrow()
  })

  it('settles deliver only after the sink accepted', async () => {
    const { ctx, seen } = await mount(['*'])
    const sink = recordingSink()
    sink.stall()
    ctx.channels.registerInboundSink(sink.sink)
    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()

    let settled = false
    const delivered = registered.firstInbox()?.deliver(inbound()).then(() => { settled = true })
    await settle()

    expect(sink.accepted.map(message => message.providerMessageId)).toEqual(['1'])
    expect(settled).toBe(false)
    expect(seen).toEqual([])

    sink.release()
    await delivered
    expect(settled).toBe(true)
    expect(seen.map(message => message.providerMessageId)).toEqual(['1'])
  })

  it('announces nothing when the sink rejects, and reports the rejection to the adapter', async () => {
    const { ctx, seen } = await mount(['*'])
    const sink = recordingSink()
    sink.fail()
    ctx.channels.registerInboundSink(sink.sink)
    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()

    await expect(registered.firstInbox()?.deliver(inbound())).rejects.toThrow('the store is full')
    expect(seen).toEqual([])
  })

  it('keeps announcing without a sink, so an existing consumer is unaffected', async () => {
    const { ctx, seen } = await mount(['*'])
    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()

    await registered.firstInbox()?.deliver(inbound())

    expect(seen.map(message => message.providerMessageId)).toEqual(['1'])
  })

  it('stops announcing once the sink is unregistered again', async () => {
    const { ctx, seen } = await mount(['*'])
    const sink = recordingSink()
    const stop = ctx.channels.registerInboundSink(sink.sink)
    stop()
    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()

    await registered.firstInbox()?.deliver(inbound())

    expect(sink.accepted).toEqual([])
    expect(seen.map(message => message.providerMessageId)).toEqual(['1'])
  })

  it('does not reach the sink for a message that fails ownership or authorization', async () => {
    const { ctx, seen } = await mount(['test:42'])
    const sink = recordingSink()
    ctx.channels.registerInboundSink(sink.sink)
    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()

    await registered.firstInbox()?.deliver(inbound({ channel: 'other' }))
    await registered.firstInbox()?.deliver(inbound({ actor: { id: '7' } }))

    expect(sink.accepted).toEqual([])
    expect(seen).toEqual([])
  })

  it('reports a failure in the authorization policy as a drop, not a sink failure', async () => {
    const ctx = new Context()
    const sink = recordingSink()
    ctx.plugin(ChannelGateway, { auth: { authorize: () => { throw new Error('policy is broken') } } })
    await settle()
    ctx.channels.registerInboundSink(sink.sink)
    const registered = testChannel('test')
    ctx.channels.register(registered.channel)
    await settle()

    await registered.firstInbox()?.deliver(inbound())

    expect(sink.accepted).toEqual([])
  })
})
