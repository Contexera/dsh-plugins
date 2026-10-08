import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { TELEGRAM_MAX_TEXT_LENGTH, createTelegramChannel } from '../src/adapters/telegram/index.ts'
import { FormData as PairedFormData } from '../src/adapters/http.ts'
import type { ChannelInbox, InboundMessage, OutboundMessage } from '../src/contracts.ts'
import { ChannelGatewayError } from '../src/errors.ts'

interface RecordedCall {
  readonly method: string
  readonly body: Record<string, unknown> | undefined
  readonly signal: AbortSignal | undefined
}

type Responder = (
  method: string,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
) => unknown

/**
 * A Bot API stand-in: every call is recorded, every answer is scripted.
 * A responder returns the `result` value; the envelope is the fake's business.
 */
function fakeTelegram(respond: Responder) {
  const calls: RecordedCall[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    const method = url.split('/').at(-1) ?? ''
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(String(init.body)) as Record<string, unknown>
    const signal = init?.signal ?? undefined
    calls.push({ method, body, signal: signal ?? undefined })
    const result = await respond(method, body, signal ?? undefined)
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result }),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** Poll until `check` holds, or fail the test rather than hanging it. */
async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the adapter')
    await new Promise(resolve => { setTimeout(resolve, 1) })
  }
}

/** The first poll answers with these updates; every later poll waits for stop. */
function pollOnce(updates: readonly unknown[], botIdentity: Responder): Responder {
  let polls = 0
  return (method, body, signal) => {
    if (method !== 'getUpdates') return botIdentity(method, body, signal)
    polls += 1
    if (polls === 1) return updates
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }
}

const privateMessage = {
  update_id: 10,
  message: {
    message_id: 5,
    date: 1_789_000_000,
    chat: { id: 42, type: 'private' },
    from: { id: 42, first_name: 'Yu', last_name: 'Create', is_bot: false },
    text: 'hello there',
  },
}

describe('telegram channel', () => {
  it('normalizes a private message and advances the poll offset', async () => {
    const respond = pollOnce([privateMessage], method => {
      if (method === 'getMe') return { id: 1, username: 'the-bot' }
      throw new Error(`unexpected ${method}`)
    })
    const { impl, calls } = fakeTelegram(respond)
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl, retryDelayMs: 1 })
    const seen: InboundMessage[] = []
    const inbox: ChannelInbox = { deliver: message => { seen.push(message) } }

    await channel.start(inbox)
    await waitFor(() => seen.length > 0)
    await channel.stop()

    expect(seen[0]).toEqual({
      channel: 'telegram',
      providerMessageId: '5',
      actor: { id: '42', displayName: 'Yu Create' },
      place: { route: 'chat:42', kind: 'direct' },
      visibility: 'private',
      text: 'hello there',
      timestamp: new Date(1_789_000_000 * 1000).toISOString(),
      raw: privateMessage.message,
    })
    const polls = calls.filter(call => call.method === 'getUpdates')
    expect(polls[0]?.body).toMatchObject({ timeout: 30 })
    expect(polls[1]?.body).toMatchObject({ offset: 11 })
  })

  it('reports a group place, its title, and its attachments', async () => {
    const group = {
      update_id: 3,
      message: {
        message_id: 8,
        date: 1_789_000_001,
        chat: { id: -100, type: 'supergroup', title: 'Team' },
        from: { id: 7, first_name: 'Aster', is_bot: true },
        caption: 'look',
        photo: [{ file_id: 'small', file_size: 1 }, { file_id: 'big', file_size: 9 }],
        document: { file_id: 'doc', file_name: 'plan.pdf', mime_type: 'application/pdf', file_size: 12 },
        reply_to_message: { message_id: 4 },
      },
    }
    const { impl } = fakeTelegram(pollOnce([group], () => ({ id: 1, username: 'the-bot' })))
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl, retryDelayMs: 1 })
    const seen: InboundMessage[] = []
    await channel.start({ deliver: message => { seen.push(message) } })
    await waitFor(() => seen.length > 0)
    await channel.stop()

    const message = seen[0]
    expect(message?.place).toEqual({ route: 'chat:-100', kind: 'group', title: 'Team' })
    expect(message?.visibility).toBe('group')
    expect(message?.actor).toEqual({ id: '7', displayName: 'Aster', isBot: true })
    expect(message?.text).toBe('look')
    expect(message?.replyTo).toBe('4')
    expect(message?.attachments).toEqual([
      { kind: 'image', ref: 'big', size: 9 },
      { kind: 'file', ref: 'doc', name: 'plan.pdf', mimeType: 'application/pdf', size: 12 },
    ])
  })

  it('keeps polling past updates it cannot normalize', async () => {
    const updates = [
      { update_id: 20 },
      { update_id: 21, message: { message_id: 9, date: 1, chat: { id: 5, type: 'channel' }, text: 'no sender' } },
      { update_id: 22, message: { ...privateMessage.message, message_id: 10 } },
    ]
    const { impl, calls } = fakeTelegram(pollOnce(updates, () => ({ id: 1, username: 'the-bot' })))
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl, retryDelayMs: 1 })
    const seen: InboundMessage[] = []
    await channel.start({ deliver: message => { seen.push(message) } })
    await waitFor(() => seen.length > 0)
    await channel.stop()

    expect(seen.map(message => message.providerMessageId)).toEqual(['10'])
    const polls = calls.filter(call => call.method === 'getUpdates')
    expect(polls[1]?.body).toMatchObject({ offset: 23 })
  })

  it('splits text longer than one message and keeps replyTo on the first chunk', async () => {
    const { impl, calls } = fakeTelegram(() => ({ message_id: 7, date: 0, chat: { id: 42, type: 'private' } }))
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl })
    const text = 'x'.repeat(TELEGRAM_MAX_TEXT_LENGTH + 1)

    const result = await channel.send({ channel: 'telegram', route: 'chat:42', text, replyTo: '5' })

    const sends = calls.filter(call => call.method === 'sendMessage')
    expect(sends).toHaveLength(2)
    expect(String(sends[0]?.body?.text)).toHaveLength(TELEGRAM_MAX_TEXT_LENGTH)
    expect(sends[0]?.body).toMatchObject({ chat_id: 42, reply_to_message_id: 5 })
    expect(sends[1]?.body?.reply_to_message_id).toBeUndefined()
    expect(result.providerMessageId).toBe('7')
  })

  it('breaks a long message at a line boundary instead of mid-word', async () => {
    const { impl, calls } = fakeTelegram(() => ({ message_id: 7 }))
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl })
    const text = `${'w'.repeat(99)} `.repeat(60).trimEnd()

    await channel.send({ channel: 'telegram', route: 'chat:42', text })

    const chunks = calls.filter(call => call.method === 'sendMessage').map(call => String(call.body?.text))
    expect(chunks.join('')).toBe(text)
    expect(chunks.every(chunk => chunk.length <= TELEGRAM_MAX_TEXT_LENGTH)).toBe(true)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.endsWith(' ')).toBe(true)
  })

  it('never cuts a surrogate pair in half', async () => {
    const { impl, calls } = fakeTelegram(() => ({ message_id: 7 }))
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl })
    const text = `${'a'.repeat(TELEGRAM_MAX_TEXT_LENGTH - 1)}${'🙂'.repeat(3)}`

    await channel.send({ channel: 'telegram', route: 'chat:42', text })

    const chunks = calls.filter(call => call.method === 'sendMessage').map(call => String(call.body?.text))
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) {
      expect(/[\uD800-\uDBFF]$/u.test(chunk)).toBe(false)
      expect(/^[\uDC00-\uDFFF]/u.test(chunk)).toBe(false)
    }
  })

  it('renders markdown as HTML and sets parse_mode when format is markdown', async () => {
    const { impl, calls } = fakeTelegram(() => ({ message_id: 7, date: 0, chat: { id: 42, type: 'private' } }))
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl })

    await channel.send({ channel: 'telegram', route: 'chat:42', text: '**hi** <you>', format: 'markdown' })

    const sent = calls.find(call => call.method === 'sendMessage')
    expect(sent?.body).toMatchObject({ chat_id: 42, text: '<b>hi</b> &lt;you&gt;', parse_mode: 'HTML' })
  })

  it('sends plain text with no parse_mode by default', async () => {
    const { impl, calls } = fakeTelegram(() => ({ message_id: 7, date: 0, chat: { id: 42, type: 'private' } }))
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl })

    await channel.send({ channel: 'telegram', route: 'chat:42', text: '**hi**' })

    const sent = calls.find(call => call.method === 'sendMessage')
    expect(sent?.body?.text).toBe('**hi**')
    expect(sent?.body?.parse_mode).toBeUndefined()
  })

  it('refuses a route another channel minted', async () => {
    const { impl } = fakeTelegram(() => ({ message_id: 7 }))
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl })

    await expect(channel.send({ channel: 'telegram', route: 'weixin:someone', text: 'x' }))
      .rejects.toThrow(ChannelGatewayError)
  })

  it('sends an attachment by url or by provider ref, and refuses neither', async () => {
    const { impl, calls } = fakeTelegram(() => ({ message_id: 11, date: 0, chat: { id: 42, type: 'private' } }))
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl })

    await channel.send({ channel: 'telegram', route: 'chat:42', text: '', attachments: [{ kind: 'image', url: 'https://example.test/a.png' }] })
    expect(calls.at(-1)?.method).toBe('sendPhoto')
    expect(calls.at(-1)?.body).toMatchObject({ chat_id: 42, photo: 'https://example.test/a.png' })

    await channel.send({ channel: 'telegram', route: 'chat:42', text: '', attachments: [{ kind: 'file', ref: 'file-id' }] })
    expect(calls.at(-1)?.method).toBe('sendDocument')
    expect(calls.at(-1)?.body).toMatchObject({ document: 'file-id' })

    await expect(channel.send({ channel: 'telegram', route: 'chat:42', text: '', attachments: [{ kind: 'file' }] }))
      .rejects.toThrow(ChannelGatewayError)
    await expect(channel.send({ channel: 'telegram', route: 'chat:42', text: '' }))
      .rejects.toThrow(ChannelGatewayError)
  })

  it('redacts the token from a transport failure', async () => {
    const impl = (() => Promise.reject(new Error('connect ECONNREFUSED via https://api.telegram.org/botSECRET/getMe'))) as unknown as typeof fetch
    const logged: string[] = []
    const channel = createTelegramChannel({
      token: 'SECRET',
      fetch: impl,
      retryDelayMs: 1,
      log: { info: () => {}, error: message => { logged.push(message) } },
    })

    // A transport failure is transient: start retries rather than rejecting, and
    // the retry it logs must never quote the token back.
    void channel.start({ deliver: () => {} })
    await waitFor(() => logged.some(message => /getMe failed/.test(message)))
    await channel.stop()

    expect(logged.some(message => /bot\*\*\*\/getMe/.test(message))).toBe(true)
    expect(logged.join('\n')).not.toContain('SECRET')
  })

  it('retries a transient getMe at startup, then begins polling', async () => {
    let getMeCalls = 0
    let polls = 0
    const okResponse = (result: unknown): Response =>
      ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, result }) }) as unknown as Response
    const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const method = String(input).split('/').at(-1) ?? ''
      const signal = (init as RequestInit | undefined)?.signal ?? undefined
      if (method === 'getMe') {
        getMeCalls += 1
        // The proxy is not up yet on the first attempts.
        if (getMeCalls < 3) throw new Error('fetch failed')
        return okResponse({ id: 1, username: 'the-bot' })
      }
      if (method === 'getUpdates') {
        polls += 1
        if (polls === 1) return okResponse([privateMessage])
        // Later polls hang until stop aborts, like a real long poll with nothing to return.
        await new Promise<void>(resolve => { signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
        throw new Error('aborted')
      }
      throw new Error(`unexpected ${method}`)
    }) as unknown as typeof fetch
    const channel = createTelegramChannel({ token: 'TESTTOKEN', fetch: impl, retryDelayMs: 1 })
    const seen: InboundMessage[] = []

    await channel.start({ deliver: message => { seen.push(message) } })
    await waitFor(() => seen.length > 0)
    await channel.stop()

    // It kept trying instead of failing the channel, then delivered once connected.
    expect(getMeCalls).toBeGreaterThanOrEqual(3)
    expect(seen[0]?.text).toBe('hello there')
  })

  it('fails to start on a bad token rather than retrying', async () => {
    let getMeCalls = 0
    const impl = (async () => {
      getMeCalls += 1
      return { ok: false, status: 401, json: () => Promise.resolve({ ok: false, error_code: 401, description: 'Unauthorized' }) } as unknown as Response
    }) as unknown as typeof fetch
    const channel = createTelegramChannel({ token: 'BAD', fetch: impl, retryDelayMs: 1 })

    // A 4xx rejection is not transient: the start fails once, it does not spin.
    await expect(channel.start({ deliver: () => {} })).rejects.toThrow(/Unauthorized/)
    expect(getMeCalls).toBe(1)
  })

  it('retries a send after a transient transport failure', async () => {
    let attempts = 0
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      const method = String(input).split('/').at(-1)
      if (method === 'sendMessage') {
        attempts += 1
        if (attempts === 1) throw new Error('ECONNRESET')
      }
      return { ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: { message_id: 7 } }) } as unknown as Response
    }) as unknown as typeof fetch
    const channel = createTelegramChannel({ token: 'T', fetch: impl })

    const result = await channel.send({ channel: 'telegram', route: 'chat:42', text: 'hi' })
    expect(attempts).toBe(2)
    expect(result.providerMessageId).toBe('7')
  })

  it('does not retry a send the API rejects', async () => {
    let attempts = 0
    const impl = (async () => {
      attempts += 1
      return { ok: false, status: 400, json: () => Promise.resolve({ ok: false, error_code: 400, description: 'chat not found' }) } as unknown as Response
    }) as unknown as typeof fetch
    const channel = createTelegramChannel({ token: 'T', fetch: impl })

    await expect(channel.send({ channel: 'telegram', route: 'chat:42', text: 'hi' })).rejects.toThrow(/chat not found/)
    expect(attempts).toBe(1)
  })

  it('restarts a poll that outruns the watchdog', async () => {
    let polls = 0
    const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const method = String(input).split('/').at(-1)
      if (method === 'getMe') {
        return { ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: { id: 1, username: 'b' } }) } as unknown as Response
      }
      if (method === 'getUpdates') {
        polls += 1
        // Hang until the watchdog (or stop) aborts, mimicking a wedged socket.
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
      }
      return { ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: [] }) } as unknown as Response
    }) as unknown as typeof fetch
    const channel = createTelegramChannel({ token: 'T', fetch: impl, pollWatchdogMs: 20, pollingTimeoutSec: 0 })

    await channel.start({ deliver: () => {} })
    await waitFor(() => polls >= 2, 1000)
    await channel.stop()
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  it('resolves an inbound attachment by fetching its file bytes', async () => {
    const bytes = Buffer.from('telegram image bytes', 'utf8')
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.endsWith('/getFile')) {
        return { ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: { file_id: 'F', file_path: 'photos/x.jpg' } }) } as unknown as Response
      }
      if (url.endsWith('/file/botT/photos/x.jpg')) {
        return { ok: true, status: 200, arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) } as unknown as Response
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch
    const channel = createTelegramChannel({ token: 'T', fetch: impl })

    const resolved = await channel.resolveAttachment?.({ kind: 'image', ref: 'F' })
    expect(resolved && Buffer.from(resolved.bytes).equals(bytes)).toBe(true)
    expect(resolved?.name).toBe('x.jpg')
  })

  it('uploads local bytes as a multipart attachment', async () => {
    let uploaded: unknown
    const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      if (url.endsWith('/sendDocument')) {
        uploaded = init?.body
        return { ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: { message_id: 9 } }) } as unknown as Response
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch
    const channel = createTelegramChannel({ token: 'T', fetch: impl })

    const result = await channel.send({
      channel: 'telegram',
      route: 'chat:1',
      text: '',
      attachments: [{ kind: 'file', name: 'a.txt', data: new Uint8Array([1, 2, 3]) }],
    })

    expect(result.providerMessageId).toBe('9')
    // The paired `FormData`, not the global one: an injected fetch cannot tell
    // the two apart, so this assertion is about which class the adapter builds
    // with, and the socket-level test below is the one that catches a mismatch.
    expect(uploaded instanceof PairedFormData).toBe(true)
    const form = uploaded as InstanceType<typeof PairedFormData>
    expect(form.get('chat_id')).toBe('1')
    expect(form.get('document')).toBeInstanceOf(Blob)
  })

  it('puts a real multipart body on the wire, with and without a proxy configured', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    await withRealBotApi(async (apiBaseUrl, requests) => {
      const upload = async (): Promise<void> => {
        // No injected fetch: this drives the adapter's own transport choice.
        const channel = createTelegramChannel({ token: 'T', apiBaseUrl })
        const result = await channel.send({
          channel: 'telegram',
          route: 'chat:1',
          text: '',
          attachments: [{ kind: 'file', name: 'a.txt', data: bytes }],
        })
        expect(result.providerMessageId).toBe('9')
      }

      const noProxy = { HTTPS_PROXY: undefined, HTTP_PROXY: undefined, https_proxy: undefined, http_proxy: undefined }
      await withProxyEnv(noProxy, upload)
      // The shape every proxied deployment runs: a proxy variable is set, and
      // loopback is exempt. Pointing it at a dead port also proves the upload
      // was not proxied, so reaching the server at all is part of the assertion.
      await withProxyEnv(
        { ...noProxy, HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
        upload,
      )

      expect(requests.map(request => request.method)).toEqual(['sendDocument', 'sendDocument'])
      for (const request of requests) {
        expect(request.contentType).toContain('multipart/form-data')
        expect(request.body.includes(Buffer.from('name="document"'))).toBe(true)
        expect(request.body.includes(Buffer.from('filename="a.txt"'))).toBe(true)
        expect(request.body.includes(Buffer.from(bytes))).toBe(true)
        // What the mismatched-FormData failure looked like: a 17-byte text body.
        expect(request.body.includes(Buffer.from('[object FormData]'))).toBe(false)
      }
    })
  })

  it('reports the text it already delivered when an attachment then fails', async () => {
    const calls: string[] = []
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      const method = String(input).split('/').at(-1) ?? ''
      calls.push(method)
      if (method === 'sendMessage') {
        return { ok: true, status: 200, json: () => Promise.resolve({ ok: true, result: { message_id: 371 } }) } as unknown as Response
      }
      return {
        ok: true,
        status: 400,
        json: () => Promise.resolve({
          ok: false,
          error_code: 400,
          description: 'Bad Request: there is no document in the request',
        }),
      } as unknown as Response
    }) as unknown as typeof fetch
    const channel = createTelegramChannel({ token: 'T', fetch: impl, retryDelayMs: 1 })

    const failure: unknown = await channel.send({
      channel: 'telegram',
      route: 'chat:1',
      text: 'the reply',
      attachments: [{ kind: 'file', name: 'a.txt', data: new Uint8Array([1, 2, 3]) }],
    }).catch((error: unknown) => error)

    // The text is already in the chat, so a caller must be told not to resend it.
    expect(String(failure)).toContain('delivered the text as message 371')
    expect(String(failure)).toContain('attachment 1 of 1')
    // A rejection the provider means is not retried, so the text went out once.
    expect(calls).toEqual(['sendMessage', 'sendDocument'])
  })
})

/** One request as the server saw it, bytes and all. */
interface RecordedRequest {
  readonly method: string
  readonly contentType: string
  readonly body: Buffer
}

/**
 * A real Bot API stand-in on a real socket. The fake fetch above records the
 * body object it is handed, which cannot expose a body the transport failed to
 * encode: a `FormData` from a different undici build still looks like one. Only
 * a real fetch against a real server shows what went on the wire.
 */
async function withRealBotApi(
  run: (apiBaseUrl: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.url?.split('/').at(-1) ?? '',
        contentType: String(request.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, result: { message_id: 9 } }))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${String(port)}`, requests)
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
}

/** Set these proxy variables for one case, then put the environment back. */
async function withProxyEnv(
  vars: Readonly<Record<string, string | undefined>>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    await run()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
