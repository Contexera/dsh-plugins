import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WEIXIN_MAX_TEXT_LENGTH, createWeixinChannel } from '../src/adapters/weixin/index.ts'
import { encryptAesEcb } from '../src/adapters/weixin/crypto.ts'
import type { ChannelInbox, InboundMessage } from '../src/contracts.ts'
import { ChannelGatewayError } from '../src/errors.ts'

/** A scripted JSON reply, shaped like the fetch Response the adapter reads. */
function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) } as unknown as Response
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

interface RecordedCall {
  readonly endpoint: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
  readonly signal: AbortSignal | undefined
}

type Responder = (
  endpoint: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
) => unknown

/** An iLink stand-in: every call is recorded, every answer is scripted. */
function fakeWeixin(respond: Responder) {
  const calls: RecordedCall[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    const endpoint = url.split('/ilink/bot/')[1] ?? url
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body === undefined
      ? {}
      : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ endpoint, headers, body, signal: init?.signal ?? undefined })
    const payload = await respond(endpoint, body, init?.signal ?? undefined)
    return { ok: true, status: 200, json: () => Promise.resolve(payload) } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the adapter')
    await new Promise(resolve => { setTimeout(resolve, 1) })
  }
}

/** The first poll answers with one page; every later poll waits for stop. */
function pollOnce(page: unknown, ...rest: readonly Responder[]): Responder {
  let polls = 0
  return (endpoint, body, signal) => {
    if (endpoint !== 'getupdates') {
      const other = rest[0]
      if (other === undefined) throw new Error(`unexpected ${endpoint}`)
      return other(endpoint, body, signal)
    }
    polls += 1
    if (polls === 1) return page
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }
}

const textMessage = {
  message_id: 501,
  from_user_id: 'wxid_peer',
  to_user_id: 'bot',
  create_time_ms: 1_789_000_000_000,
  message_type: 1,
  context_token: 'ctx-token',
  item_list: [{ type: 1, text_item: { text: '你好' } }],
}

describe('weixin channel', () => {
  it('normalizes a direct message and carries the context token in its route', async () => {
    const { impl, calls } = fakeWeixin(pollOnce({ get_updates_buf: 'cursor-1', msgs: [textMessage] }))
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl, retryDelayMs: 1 })
    const seen: InboundMessage[] = []
    await channel.start({ deliver: async message => { seen.push(message) } })
    await waitFor(() => seen.length > 0)
    await channel.stop()

    const message = seen[0]
    expect(message).toMatchObject({
      channel: 'weixin',
      providerMessageId: '501',
      actor: { id: 'wxid_peer' },
      place: { kind: 'direct' },
      visibility: 'private',
      text: '你好',
      timestamp: new Date(1_789_000_000_000).toISOString(),
    })
    expect(message?.place.route.startsWith('wx:')).toBe(true)
    expect(calls[0]?.headers.authorization).toBe('Bearer TOKEN')
    expect(calls[0]?.headers['x-wechat-uin']).toBeTruthy()
    expect(calls[0]?.body.get_updates_buf).toBe('')
  })

  it('sends the cursor the server handed back on the next poll', async () => {
    const { impl, calls } = fakeWeixin(pollOnce({ get_updates_buf: 'cursor-7', msgs: [] }))
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl, retryDelayMs: 1 })
    await channel.start({ deliver: async () => {} })
    await waitFor(() => calls.filter(call => call.endpoint === 'getupdates').length >= 2)
    await channel.stop()

    expect(calls[1]?.body.get_updates_buf).toBe('cursor-7')
  })

  it('skips its own messages and messages with no sender', async () => {
    const page = {
      get_updates_buf: 'c',
      msgs: [
        { ...textMessage, message_id: 600, message_type: 2 },
        { ...textMessage, message_id: 601, from_user_id: '' },
        { ...textMessage, message_id: 602, group_id: 'room-1', item_list: [{ type: 1, text_item: { text: 'hi all' } }] },
      ],
    }
    const { impl } = fakeWeixin(pollOnce(page))
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl, retryDelayMs: 1 })
    const seen: InboundMessage[] = []
    await channel.start({ deliver: async message => { seen.push(message) } })
    await waitFor(() => seen.length > 0)
    await channel.stop()

    expect(seen.map(message => message.providerMessageId)).toEqual(['602'])
    expect(seen[0]?.place.kind).toBe('group')
    expect(seen[0]?.visibility).toBe('group')
  })

  it('reports media items with a handle a later download can use', async () => {
    const page = {
      msgs: [{
        ...textMessage,
        item_list: [
          { type: 1, text_item: { text: 'see this' } },
          { type: 2, msg_id: 'm-1', image_item: { mid_size: 2048, media: { full_url: 'https://cdn.test/a', aes_key: 'AAAAAAAAAAAAAAAAAAAAAA==' } } },
          { type: 4, msg_id: 'm-2', file_item: { file_name: 'plan.pdf', len: '4096', media: { encrypt_query_param: 'ENC' } } },
        ],
      }],
    }
    const { impl } = fakeWeixin(pollOnce(page))
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl, retryDelayMs: 1 })
    const seen: InboundMessage[] = []
    await channel.start({ deliver: async message => { seen.push(message) } })
    await waitFor(() => seen.length > 0)
    await channel.stop()

    const attachments = seen[0]?.attachments ?? []
    expect(attachments.map(a => a.kind)).toEqual(['image', 'file'])
    expect(attachments[0]?.size).toBe(2048)
    expect(attachments[1]?.name).toBe('plan.pdf')
    // A media item that carries a locator gets a ref the channel can resolve.
    expect(typeof attachments[0]?.ref).toBe('string')
    expect(typeof attachments[1]?.ref).toBe('string')
    expect(channel.capabilities.attachments).toBe(true)
    expect(channel.capabilities.attachmentDownload).toBe(true)
  })

  it('stops polling when the token is stale instead of retrying forever', async () => {
    const { impl, calls } = fakeWeixin(pollOnce({ errcode: -14, errmsg: 'token expired' }))
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl, retryDelayMs: 1 })
    await channel.start({ deliver: async () => {} })
    await waitFor(() => calls.length >= 1)
    await new Promise(resolve => { setTimeout(resolve, 20) })

    expect(calls.filter(call => call.endpoint === 'getupdates')).toHaveLength(1)
    await channel.stop()
  })

  it('sends a reply that quotes the route it was handed', async () => {
    const { impl, calls } = fakeWeixin(pollOnce(
      { msgs: [textMessage] },
      () => ({}),
    ))
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl, retryDelayMs: 1 })
    const seen: InboundMessage[] = []
    const inbox: ChannelInbox = { deliver: async message => { seen.push(message) } }
    await channel.start(inbox)
    await waitFor(() => seen.length > 0)

    const result = await channel.send({
      channel: 'weixin',
      route: seen[0]?.place.route ?? '',
      text: '收到',
    })
    await channel.stop()

    const sent = calls.find(call => call.endpoint === 'sendmessage')
    expect(sent?.headers.authorization).toBe('Bearer TOKEN')
    expect(sent?.body.msg).toMatchObject({
      from_user_id: '',
      to_user_id: 'wxid_peer',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-token',
      item_list: [{ type: 1, text_item: { text: '收到' } }],
    })
    expect(result.providerMessageId.startsWith('dsh-channel-gateway:')).toBe(true)
  })

  it('splits text longer than one message', async () => {
    const { impl, calls } = fakeWeixin(pollOnce(
      { msgs: [textMessage] },
      () => ({}),
    ))
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl, retryDelayMs: 1 })
    const seen: InboundMessage[] = []
    await channel.start({ deliver: async message => { seen.push(message) } })
    await waitFor(() => seen.length > 0)

    await channel.send({
      channel: 'weixin',
      route: seen[0]?.place.route ?? '',
      text: 'y'.repeat(WEIXIN_MAX_TEXT_LENGTH + 1),
    })
    await channel.stop()

    const sends = calls.filter(call => call.endpoint === 'sendmessage')
    expect(sends).toHaveLength(2)
    const first = sends[0]?.body.msg as { item_list?: readonly { text_item?: { text?: string } }[] } | undefined
    expect(first?.item_list?.[0]?.text_item?.text).toHaveLength(WEIXIN_MAX_TEXT_LENGTH)
    // Each chunk carries its own client id, so a retry cannot duplicate one.
    const clientIds = sends.map(call => (call.body.msg as { client_id?: string }).client_id)
    expect(clientIds[0]).not.toBe(clientIds[1])
  })

  it('refreshes a stale context token via getconfig before sending', async () => {
    // A route for a user never seen inbound has no cached age, so the token is
    // treated as stale and refreshed before use.
    const userId = Buffer.from('wxid_unseen', 'utf8').toString('base64url')
    const oldToken = Buffer.from('old-token', 'utf8').toString('base64url')
    const route = `wx:${userId}.${oldToken}`
    const { impl, calls } = fakeWeixin(endpoint => (endpoint === 'getconfig' ? { context_token: 'fresh-token' } : {}))
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl })

    await channel.send({ channel: 'weixin', route, text: 'hi' })

    const getconfig = calls.find(call => call.endpoint === 'getconfig')
    expect((getconfig?.body as { context_token?: string }).context_token).toBe('old-token')
    const send = calls.find(call => call.endpoint === 'sendmessage')
    expect((send?.body.msg as { context_token?: string }).context_token).toBe('fresh-token')
  })

  it('retries a send after a transient transport failure', async () => {
    let attempts = 0
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      const endpoint = String(input).split('/ilink/bot/')[1]
      if (endpoint === 'sendmessage') {
        attempts += 1
        if (attempts === 1) throw new Error('ECONNRESET')
      }
      return { ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response
    }) as unknown as typeof fetch
    const userId = Buffer.from('wxid_x', 'utf8').toString('base64url')
    const route = `wx:${userId}.${Buffer.from('t', 'utf8').toString('base64url')}`
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl })

    const result = await channel.send({ channel: 'weixin', route, text: 'hi' })
    expect(attempts).toBe(2)
    expect(result.providerMessageId.startsWith('dsh-channel-gateway:')).toBe(true)
  })

  it('refuses a foreign route, an attachment, and an empty send', async () => {
    const { impl } = fakeWeixin(() => ({}))
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl })

    await expect(channel.send({ channel: 'weixin', route: 'telegram:chat:1', text: 'x' }))
      .rejects.toThrow(ChannelGatewayError)
    await expect(channel.send({ channel: 'weixin', route: 'wx:YQ==.', text: '', attachments: [{ kind: 'image', url: 'https://x.test/a.png' }] }))
      .rejects.toThrow(/given its bytes/)
    await expect(channel.send({ channel: 'weixin', route: 'wx:YQ==.', text: '' }))
      .rejects.toThrow(ChannelGatewayError)
  })

  it('resolves an inbound media attachment by downloading and decrypting it', async () => {
    const key = randomBytes(16)
    const plain = Buffer.from('the decoded image bytes', 'utf8')
    const encrypted = encryptAesEcb(plain, key.toString('base64'))
    const page = {
      msgs: [{
        ...textMessage,
        item_list: [
          { type: 2, msg_id: 'm-1', image_item: { media: { full_url: 'https://cdn.test/enc', aes_key: key.toString('base64') } } },
        ],
      }],
    }
    let polled = false
    const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      if (url.includes('/ilink/bot/getupdates')) {
        if (polled) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          })
        }
        polled = true
        return jsonResponse(page)
      }
      if (url === 'https://cdn.test/enc') {
        return { ok: true, status: 200, arrayBuffer: () => Promise.resolve(toArrayBuffer(encrypted)) } as unknown as Response
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl, retryDelayMs: 1, attachmentHosts: ['cdn.test'] })
    const seen: InboundMessage[] = []
    await channel.start({ deliver: async message => { seen.push(message) } })
    await waitFor(() => seen.length > 0)
    await channel.stop()

    const attachment = seen[0]?.attachments?.[0]
    expect(attachment).toBeDefined()
    const resolved = await channel.resolveAttachment?.(attachment!)
    expect(resolved && Buffer.from(resolved.bytes).equals(plain)).toBe(true)
  })

  it('uploads an image attachment and sends it as a media item', async () => {
    const route = `wx:${Buffer.from('u', 'utf8').toString('base64url')}.${Buffer.from('ctx', 'utf8').toString('base64url')}`
    let cdnBody: unknown
    let sendBody: { msg?: { item_list?: { type?: number; image_item?: { media?: { encrypt_query_param?: string } } }[] } } | undefined
    const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      if (url.includes('/ilink/bot/getconfig')) return jsonResponse({})
      if (url.includes('/ilink/bot/getuploadurl')) return jsonResponse({ upload_full_url: 'https://cdn.test/up' })
      if (url === 'https://cdn.test/up') {
        cdnBody = init?.body
        return { ok: true, status: 200, headers: new Headers({ 'x-encrypted-param': 'DL-PARAM' }) } as unknown as Response
      }
      if (url.includes('/ilink/bot/sendmessage')) {
        sendBody = JSON.parse(String(init?.body)) as typeof sendBody
        return jsonResponse({})
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch
    const channel = createWeixinChannel({ token: 'TOKEN', fetch: impl })

    const result = await channel.send({
      channel: 'weixin',
      route,
      text: '',
      attachments: [{ kind: 'image', name: 'a.jpg', data: new Uint8Array([1, 2, 3, 4, 5]) }],
    })

    expect(result.providerMessageId.startsWith('dsh-channel-gateway:')).toBe(true)
    expect(cdnBody).toBeDefined()
    const item = sendBody?.msg?.item_list?.[0]
    expect(item?.type).toBe(2)
    expect(item?.image_item?.media?.encrypt_query_param).toBe('DL-PARAM')
  })
})

/**
 * The ref is the one attachment field a caller can compose, so these tests hold
 * the line the design draws: a ref the channel did not mint never reaches the
 * network, and a minted one is still bounded on the way out.
 */
describe('weixin attachment refs are authenticated before any network access', () => {
  /** A channel whose every fetch is recorded, over a controllable page. */
  async function channelWithMedia(item: unknown, options: {
    readonly attachmentHosts?: readonly string[]
    readonly maxAttachmentBytes?: number
    readonly download?: (url: string, init?: Parameters<typeof fetch>[1]) => Response
  } = {}) {
    const fetched: string[] = []
    const page = { msgs: [{ ...textMessage, item_list: [item] }] }
    let polls = 0
    const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      if (url.includes('/ilink/bot/getupdates')) {
        polls += 1
        if (polls === 1) return jsonResponse(page)
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
      }
      fetched.push(url)
      if (options.download === undefined) throw new Error(`unexpected download ${url}`)
      return options.download(url, init)
    }) as unknown as typeof fetch
    const channel = createWeixinChannel({
      token: 'TOKEN', fetch: impl, retryDelayMs: 1,
      ...(options.attachmentHosts === undefined ? {} : { attachmentHosts: options.attachmentHosts }),
      ...(options.maxAttachmentBytes === undefined ? {} : { maxAttachmentBytes: options.maxAttachmentBytes }),
    })
    const seen: InboundMessage[] = []
    await channel.start({ deliver: async message => { seen.push(message) } })
    await waitFor(() => seen.length > 0)
    await channel.stop()
    return { channel, fetched, attachment: seen[0]?.attachments?.[0] }
  }

  const imageItem = {
    type: 2,
    msg_id: 'm-sec',
    image_item: { media: { full_url: 'https://cdn.test/enc', aes_key: 'AAAAAAAAAAAAAAAAAAAAAA==' } },
  }

  it('refuses a ref a caller composed without contacting the network', async () => {
    const { channel, fetched, attachment } = await channelWithMedia(imageItem, { attachmentHosts: ['cdn.test'] })
    expect(attachment?.ref).toBeDefined()
    // A ref that is well-formed base64url of a plausible descriptor, but unsigned.
    const forged = Buffer.from(JSON.stringify({
      v: 1,
      d: { k: 'image', u: 'https://evil.test/steal' },
      m: 'not-a-real-mac',
    }), 'utf8').toString('base64url')

    await expect(channel.resolveAttachment?.({ kind: 'image', ref: forged }))
      .rejects.toThrow(/not one this channel minted/)
    await expect(channel.resolveAttachment?.({ kind: 'image', ref: 'not-base64url-json' }))
      .rejects.toThrow(ChannelGatewayError)
    await expect(channel.resolveAttachment?.({ kind: 'image' }))
      .rejects.toThrow(/without a ref/)
    expect(fetched).toEqual([])
  })

  it('refuses a tampered descriptor, a wrong kind, and a foreign version', async () => {
    const { channel, fetched, attachment } = await channelWithMedia(imageItem, { attachmentHosts: ['cdn.test'] })
    const ref = attachment!.ref!

    // Re-encode the signed envelope with the locator swapped for another host.
    const envelope = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8')) as { d: { u?: string } }
    envelope.d.u = 'https://evil.test/steal'
    const tampered = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')
    await expect(channel.resolveAttachment?.({ kind: 'image', ref: tampered }))
      .rejects.toThrow(/not one this channel minted/)

    // The signed kind is part of what the MAC covers.
    await expect(channel.resolveAttachment?.({ kind: 'file', ref }))
      .rejects.toThrow(/different attachment kind/)

    const future = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8')) as { v: number }
    future.v = 99
    await expect(channel.resolveAttachment?.({ kind: 'image', ref: Buffer.from(JSON.stringify(future), 'utf8').toString('base64url') }))
      .rejects.toThrow(/another version/)
    expect(fetched).toEqual([])
  })

  it('refuses a non-https locator and a host outside the allowlist', async () => {
    // The allowlist is enforced against the signed descriptor, so a provider
    // that hands out a plain-http or third-party URL cannot get it fetched.
    const { channel, fetched, attachment } = await channelWithMedia(
      { type: 2, msg_id: 'm-http', image_item: { media: { full_url: 'http://cdn.test/enc' } } },
      { attachmentHosts: ['cdn.test'] },
    )
    await expect(channel.resolveAttachment?.({ kind: 'image', ref: attachment!.ref! }))
      .rejects.toThrow(/only https is fetched/)
    expect(fetched).toEqual([])

    const outside = await channelWithMedia(
      { type: 2, msg_id: 'm-out', image_item: { media: { full_url: 'https://evil.test/enc' } } },
      { attachmentHosts: ['cdn.test'] },
    )
    await expect(outside.channel.resolveAttachment?.({ kind: 'image', ref: outside.attachment!.ref! }))
      .rejects.toThrow(/host this channel is not configured for/)
    expect(outside.fetched).toEqual([])
  })

  it('aborts a download that exceeds the byte ceiling', async () => {
    const oversized = new Uint8Array(4096)
    const { channel, attachment } = await channelWithMedia(imageItem, {
      attachmentHosts: ['cdn.test'],
      maxAttachmentBytes: 1024,
      download: () => ({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(toArrayBuffer(Buffer.from(oversized))) }) as unknown as Response,
    })
    await expect(channel.resolveAttachment?.({ kind: 'image', ref: attachment!.ref! }))
      .rejects.toThrow(/larger than 1024 bytes/)
  })

  it('honours a declared content-length before reading the body', async () => {
    let bodyRead = false
    const { channel, attachment } = await channelWithMedia(imageItem, {
      attachmentHosts: ['cdn.test'],
      maxAttachmentBytes: 1024,
      download: () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '999999' }),
        arrayBuffer: () => { bodyRead = true; return Promise.resolve(new ArrayBuffer(0)) },
      }) as unknown as Response,
    })
    await expect(channel.resolveAttachment?.({ kind: 'image', ref: attachment!.ref! }))
      .rejects.toThrow(/larger than 1024 bytes/)
    expect(bodyRead).toBe(false)
  })

  it('carries an AbortSignal on the download request', async () => {
    let sawSignal = false
    const { channel, attachment } = await channelWithMedia(imageItem, {
      attachmentHosts: ['cdn.test'],
      download: (_url, init) => {
        sawSignal = init?.signal !== undefined
        return { ok: true, status: 200, arrayBuffer: () => Promise.resolve(toArrayBuffer(Buffer.from('x'))) } as unknown as Response
      },
    })
    await channel.resolveAttachment?.({ kind: 'image', ref: attachment!.ref! })
    expect(sawSignal).toBe(true)
  })

  it('keeps the token and the AES key out of a rejection message', async () => {
    const { channel, attachment } = await channelWithMedia(imageItem, {
      attachmentHosts: ['cdn.test'],
      download: () => { throw new Error('socket hang up') },
    })
    const error = await channel.resolveAttachment?.({ kind: 'image', ref: attachment!.ref! }).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    )
    expect(error).toBeDefined()
    expect(error!.message).not.toContain('TOKEN')
    expect(error!.message).not.toContain('AAAAAAAAAAAAAAAAAAAAAA==')
  })

  it('mints a ref bound to its own channel token', async () => {
    const { attachment } = await channelWithMedia(imageItem, { attachmentHosts: ['cdn.test'] })
    // Same descriptor, a different token: the MAC no longer verifies.
    const other = createWeixinChannel({ token: 'OTHER', fetch: (async () => { throw new Error('no network') }) as unknown as typeof fetch })
    await expect(other.resolveAttachment?.({ kind: 'image', ref: attachment!.ref! }))
      .rejects.toThrow(/not one this channel minted/)
  })
})
