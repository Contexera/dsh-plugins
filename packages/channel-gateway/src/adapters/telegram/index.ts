/**
 * Telegram: a long-polling channel adapter over the Bot API.
 *
 * It normalizes updates into {@link InboundMessage} and sends {@link
 * OutboundMessage} back. Commands, conversation-to-session mapping, streaming
 * and reply policy are implemented above it, from `channel/inbound`. The
 * transport is adapted from `dsh-telegram-channel` (MIT), reduced to the Bot
 * API calls this adapter needs.
 * @module @contexera/dsh-channel-gateway/telegram
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  Channel,
  ChannelActor,
  ChannelAttachment,
  ChannelCapabilities,
  ChannelInbox,
  ChannelPlace,
  ChannelPlaceKind,
  ChannelSendResult,
  ChannelVisibility,
  InboundMessage,
  OutboundMessage,
  ResolvedAttachment,
} from '../../contracts.ts'
import { ChannelGatewayError, errorText } from '../../errors.ts'
import type {} from '../../gateway.ts'
// `FormData` here is deliberately the gateway's own, shadowing the global one:
// it has to be the same undici build as the fetch, or the multipart body is not
// recognized and the upload arrives empty. See `adapters/http.ts`.
import { delay, FormData, proxyAwareFetch, withRetry } from '../http.ts'
import { silentLog, type AdapterLog } from '../log.ts'
import { splitTelegramHtml } from './markdown.ts'
import { splitText } from '../text.ts'

/** Telegram's own limit for one message's text. */
export const TELEGRAM_MAX_TEXT_LENGTH = 4096

/** Ceiling for the opening connect's exponential backoff, so a long outage settles into a steady retry. */
const CONNECT_MAX_DELAY_MS = 30_000

interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

interface TelegramChat {
  id: number
  type: string
  title?: string
}

interface TelegramPhotoSize {
  file_id: string
  file_size?: number
}

interface TelegramFileRef {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

interface TelegramMessage {
  message_id: number
  date: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
  /** Media captions arrive here, not in `text`. */
  caption?: string
  photo?: TelegramPhotoSize[]
  document?: TelegramFileRef
  audio?: TelegramFileRef
  voice?: TelegramFileRef
  video?: TelegramFileRef
  reply_to_message?: { message_id: number }
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

/** What `getFile` returns: the relative path a download reads from. */
interface TelegramFile {
  file_id: string
  file_path?: string
  file_size?: number
}

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

/**
 * A failure the Bot API reported in its own envelope, carrying enough to decide
 * whether a send should try again: HTTP 5xx and error code 429 are transient,
 * and 429 comes with the `retry_after` the API wants honoured. A `fetch` that
 * throws is a transport failure and stays a plain {@link Error}, also transient.
 */
class TelegramApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: number | undefined,
    readonly retryAfterSec: number | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

/**
 * Whether a failure is transient — a transport error, a 5xx, or a 429 rate
 * limit — rather than a rejection the API means (a bad token, some other 4xx).
 * Both the send retry and the opening connect retry the transient ones and give
 * up on the rest.
 */
function isTransientTelegramError(error: unknown): boolean {
  return !(error instanceof TelegramApiError) || error.status >= 500 || error.errorCode === 429
}

/** A send retries transport failures and rate limits, but not a real rejection. */
function telegramSendRetries(retryDelayMs: number, log: AdapterLog): Parameters<typeof withRetry>[1] {
  return {
    retries: 3,
    baseDelayMs: retryDelayMs,
    isRetryable: isTransientTelegramError,
    retryAfterMs: (error: unknown): number | undefined =>
      error instanceof TelegramApiError && error.retryAfterSec !== undefined ? error.retryAfterSec * 1000 : undefined,
    onRetry: (error: unknown, waitMs: number): void => {
      log.error(`telegram: send failed, retrying in ${String(waitMs)}ms: ${errorText(error)}`)
    },
  }
}

/** How one telegram channel is built; the plugin row supplies it. */
export interface TelegramChannelOptions {
  readonly token: string
  /** Injected for tests; defaults to a proxy-aware global fetch. */
  readonly fetch?: typeof fetch
  readonly apiBaseUrl?: string
  readonly pollingTimeoutSec?: number
  /** How long to wait after a failed poll before polling again. */
  readonly retryDelayMs?: number
  /** Client-side ceiling for one long poll, over the server's own hold. */
  readonly pollWatchdogMs?: number
  readonly log?: AdapterLog
}

/** The route scheme this adapter mints and is the only layer to parse. */
const ROUTE_PREFIX = 'chat:'

function routeOf(chatId: number): string {
  return `${ROUTE_PREFIX}${String(chatId)}`
}

function chatIdOf(route: string): number {
  const match = /^chat:(-?\d+)$/.exec(route)
  if (match === null || match[1] === undefined) {
    throw new ChannelGatewayError(`telegram route "${route}" was not minted by the telegram channel`)
  }
  return Number(match[1])
}

/** One message's attachments, as far as the Bot API already carries them. */
function attachmentsOf(message: TelegramMessage): readonly ChannelAttachment[] {
  const found: ChannelAttachment[] = []
  const photo = message.photo?.at(-1)
  if (photo !== undefined) {
    found.push({
      kind: 'image',
      ref: photo.file_id,
      ...(photo.file_size === undefined ? {} : { size: photo.file_size }),
    })
  }
  const files: readonly (readonly [ChannelAttachment['kind'], TelegramFileRef | undefined])[] = [
    ['file', message.document],
    ['audio', message.audio ?? message.voice],
    ['video', message.video],
  ]
  for (const [kind, file] of files) {
    if (file === undefined) continue
    found.push({
      kind,
      ref: file.file_id,
      ...(file.file_name === undefined ? {} : { name: file.file_name }),
      ...(file.mime_type === undefined ? {} : { mimeType: file.mime_type }),
      ...(file.file_size === undefined ? {} : { size: file.file_size }),
    })
  }
  return found
}

/**
 * Build the telegram channel. The gateway registers it; `start` begins polling
 * and `stop` ends it. Every provider call is one HTTP request, so a test can
 * inject `fetch` and drive the whole adapter without a network.
 */
export function createTelegramChannel(options: TelegramChannelOptions): Channel {
  const { token } = options
  if (token === '') throw new ChannelGatewayError('the telegram channel needs a bot token')
  const fetchImpl = options.fetch ?? proxyAwareFetch()
  const apiBaseUrl = options.apiBaseUrl ?? 'https://api.telegram.org'
  const pollingTimeoutSec = options.pollingTimeoutSec ?? 30
  const retryDelayMs = options.retryDelayMs ?? 3000
  // A long poll should return by the server-held `pollingTimeoutSec`; if the
  // socket wedges it never does, so a client ceiling above that aborts and
  // restarts the poll rather than letting the loop hang forever.
  const pollWatchdogMs = options.pollWatchdogMs ?? (pollingTimeoutSec + 15) * 1000
  const log = options.log ?? silentLog
  const sendPolicy = telegramSendRetries(500, log)

  let running = false
  let abort: AbortController | undefined
  let loop: Promise<void> | undefined

  /** Redact the token from anything a failure may quote back. */
  function redact(message: string): string {
    return message.split(token).join('***')
  }

  async function call<T>(method: string, body?: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = { method: 'POST' }
    if (body instanceof FormData) {
      // Let fetch set the multipart content-type with its boundary.
      init.body = body
    } else if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    if (signal !== undefined) init.signal = signal
    let response: Response
    try {
      response = await fetchImpl(`${apiBaseUrl}/bot${token}/${method}`, init)
    } catch (error: unknown) {
      throw new Error(redact(`telegram ${method} failed: ${errorText(error)}`))
    }
    const payload = (await response.json().catch(() => undefined)) as TelegramResponse<T> | undefined
    if (payload === undefined || payload.ok !== true || payload.result === undefined) {
      const description = payload?.description ?? `HTTP ${String(response.status)}`
      throw new TelegramApiError(
        response.status,
        payload?.error_code,
        payload?.parameters?.retry_after,
        redact(`telegram ${method} was rejected: ${description}`),
      )
    }
    return payload.result
  }

  /** One update as the contract reads it, or nothing when it carries no sender. */
  function normalize(message: TelegramMessage): InboundMessage | undefined {
    const from = message.from
    // Channel posts arrive with no sender, so there is no actor to report and
    // no authorization to ask; the gateway does not invent one.
    if (from === undefined) return undefined

    const displayName = [from.first_name, from.last_name]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' ')
    const actor: ChannelActor = {
      id: String(from.id),
      ...(displayName === '' ? {} : { displayName }),
      ...(from.is_bot === true ? { isBot: true } : {}),
    }

    const kind: ChannelPlaceKind = message.chat.type === 'private'
      ? 'direct'
      : message.chat.type === 'channel' ? 'channel' : 'group'
    const place: ChannelPlace = {
      route: routeOf(message.chat.id),
      kind,
      ...(message.chat.title === undefined ? {} : { title: message.chat.title }),
    }
    const visibility: ChannelVisibility = kind === 'direct' ? 'private' : 'group'

    const attachments = attachmentsOf(message)
    const replyTo = message.reply_to_message?.message_id
    return {
      channel: 'telegram',
      providerMessageId: String(message.message_id),
      actor,
      place,
      visibility,
      text: message.text ?? message.caption ?? '',
      ...(attachments.length === 0 ? {} : { attachments }),
      timestamp: new Date(message.date * 1000).toISOString(),
      ...(replyTo === undefined ? {} : { replyTo: String(replyTo) }),
      raw: message,
    }
  }

  async function sendAttachment(chatId: number, attachment: ChannelAttachment): Promise<number> {
    const method = attachment.kind === 'image'
      ? 'sendPhoto'
      : attachment.kind === 'video' ? 'sendVideo' : attachment.kind === 'audio' ? 'sendAudio' : 'sendDocument'
    const field = attachment.kind === 'image'
      ? 'photo'
      : attachment.kind === 'video' ? 'video' : attachment.kind === 'audio' ? 'audio' : 'document'
    if (attachment.data !== undefined) {
      // Upload local bytes as multipart, so the caller can send content it holds
      // rather than only a url or a file the provider already hosts.
      const form = new FormData()
      form.append('chat_id', String(chatId))
      const blob = new Blob([attachment.data], attachment.mimeType === undefined ? {} : { type: attachment.mimeType })
      form.append(field, blob, attachment.name ?? `${attachment.kind}.bin`)
      const uploaded = await withRetry(() => call<TelegramMessage>(method, form), sendPolicy)
      return uploaded.message_id
    }
    const handle = attachment.url ?? attachment.ref
    if (handle === undefined) {
      throw new ChannelGatewayError(
        `telegram cannot send a ${attachment.kind} attachment without data, a url, or a ref`,
      )
    }
    const sent = await withRetry(() => call<TelegramMessage>(method, { chat_id: chatId, [field]: handle }), sendPolicy)
    return sent.message_id
  }

  /** Fetch and return the bytes behind an inbound attachment's file_id. */
  async function resolveAttachment(attachment: ChannelAttachment): Promise<ResolvedAttachment> {
    const fileId = attachment.ref
    if (fileId === undefined) {
      throw new ChannelGatewayError('telegram cannot resolve an attachment without a file_id ref')
    }
    const file = await withRetry(() => call<TelegramFile>('getFile', { file_id: fileId }), sendPolicy)
    if (file.file_path === undefined) {
      throw new ChannelGatewayError(`telegram getFile returned no file_path for ${fileId}`)
    }
    let response: Response
    try {
      // The download endpoint is the file host, not the bot method host, and
      // the path already encodes the file; this is a plain GET of the bytes.
      response = await fetchImpl(`${apiBaseUrl}/file/bot${token}/${file.file_path}`)
    } catch (error: unknown) {
      throw new Error(redact(`telegram file download failed: ${errorText(error)}`))
    }
    if (!response.ok) {
      throw new ChannelGatewayError(redact(`telegram file download was rejected: HTTP ${String(response.status)}`))
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const name = attachment.name ?? file.file_path.split('/').at(-1)
    return {
      bytes,
      ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
      ...(name === undefined ? {} : { name }),
    }
  }

  /**
   * Open the channel: fetch the bot identity, retrying while the failure is
   * transient (a proxy not yet up at boot, a blip, a 5xx/429) so a momentarily
   * unreachable API delays the start instead of killing the channel for good. A
   * real rejection — a bad token — is not transient and is thrown, failing the
   * start as it should. Returns undefined if stopped before it connected.
   */
  async function connect(signal: AbortSignal): Promise<TelegramUser | undefined> {
    for (let attempt = 0; running && !signal.aborted; attempt += 1) {
      try {
        return await call<TelegramUser>('getMe', undefined, signal)
      } catch (error: unknown) {
        if (!running || signal.aborted) return undefined
        if (!isTransientTelegramError(error)) throw error
        const waitMs = Math.min(retryDelayMs * 2 ** attempt, CONNECT_MAX_DELAY_MS)
        log.error(`telegram: getMe failed, retrying in ${String(waitMs)}ms: ${errorText(error)}`)
        await delay(waitMs, signal)
      }
    }
    return undefined
  }

  async function poll(inbox: ChannelInbox, signal: AbortSignal): Promise<void> {
    let offset: number | undefined
    while (running && !signal.aborted) {
      let updates: TelegramUpdate[]
      // Abort a poll that outlives the watchdog: the stop signal, or a timeout
      // over the server hold, whichever fires first.
      const watchdog = AbortSignal.timeout(pollWatchdogMs)
      const pollSignal = AbortSignal.any([signal, watchdog])
      try {
        updates = await call<TelegramUpdate[]>('getUpdates', {
          timeout: pollingTimeoutSec,
          allowed_updates: ['message'],
          ...(offset === undefined ? {} : { offset }),
        }, pollSignal)
      } catch (error: unknown) {
        if (!running || signal.aborted) return
        if (watchdog.aborted) {
          log.info('telegram: a poll outran the watchdog and was restarted')
          continue
        }
        log.error(`telegram: getUpdates failed, retrying: ${errorText(error)}`)
        await delay(retryDelayMs, signal)
        continue
      }
      for (const update of updates) {
        // Advance past every update the provider handed over, whether or not it
        // carried a message this adapter can normalize: re-reading it forever
        // would block everything behind it.
        offset = update.update_id + 1
        const message = update.message
        if (message === undefined) continue
        const normalized = normalize(message)
        if (normalized !== undefined) inbox.deliver(normalized)
      }
    }
  }

  const capabilities: ChannelCapabilities = {
    attachments: true,
    attachmentDownload: true,
    buttons: false,
    edit: false,
    replyTo: true,
    maxTextLength: TELEGRAM_MAX_TEXT_LENGTH,
  }

  return {
    name: 'telegram',
    capabilities,
    async start(inbox: ChannelInbox): Promise<void> {
      if (running) return
      running = true
      abort = new AbortController()
      // Retry the opening getMe the way the poll loop retries getUpdates: a boot
      // where the API is briefly unreachable should delay the start, not leave
      // the channel failed and offline until a manual restart.
      let me: TelegramUser | undefined
      try {
        me = await connect(abort.signal)
      } catch (error: unknown) {
        running = false
        throw error
      }
      if (me === undefined) {
        running = false
        return
      }
      log.info(`telegram: receiving as @${me.username ?? String(me.id)}`)
      loop = poll(inbox, abort.signal)
    },
    async stop(): Promise<void> {
      if (!running) return
      running = false
      abort?.abort()
      await loop
      loop = undefined
      abort = undefined
    },
    async send(message: OutboundMessage): Promise<ChannelSendResult> {
      const chatId = chatIdOf(message.route)
      let last: number | undefined
      let textId: number | undefined
      const markdown = message.format === 'markdown'
      const chunks = markdown
        ? splitTelegramHtml(message.text, TELEGRAM_MAX_TEXT_LENGTH)
        : splitText(message.text, TELEGRAM_MAX_TEXT_LENGTH)
      for (const [index, chunk] of chunks.entries()) {
        const body: Record<string, unknown> = { chat_id: chatId, text: chunk }
        if (markdown) body.parse_mode = 'HTML'
        if (index === 0 && message.replyTo !== undefined) body.reply_to_message_id = Number(message.replyTo)
        const sent = await withRetry(() => call<TelegramMessage>('sendMessage', body), sendPolicy)
        last = sent.message_id
        textId = sent.message_id
      }
      const attachments = message.attachments ?? []
      for (const [index, attachment] of attachments.entries()) {
        try {
          last = await sendAttachment(chatId, attachment)
        } catch (error: unknown) {
          // Text cannot be taken back once sent, so a bare failure would read as
          // "nothing arrived" and invite a resend that duplicates what the chat
          // already shows. This is a transport failure rather than the caller's
          // mistake, so it stays a plain Error with the original as its cause;
          // the message is what tells the caller only the attachment is left to
          // send. With no text delivered, the original error says it all.
          if (textId === undefined) throw error
          throw new Error(
            `telegram delivered the text as message ${String(textId)}, then attachment `
            + `${String(index + 1)} of ${String(attachments.length)} failed: ${errorText(error)}`,
            { cause: error },
          )
        }
      }
      if (last === undefined) {
        throw new ChannelGatewayError('telegram send carried neither text nor attachments')
      }
      return { providerMessageId: String(last) }
    },
    resolveAttachment,
  }
}

/** The telegram plugin row's own configuration. */
export interface TelegramPluginConfig {
  /** Bot token; falls back to `DSH_TELEGRAM_TOKEN`. */
  readonly token?: string
  readonly apiBaseUrl?: string
  readonly pollingTimeoutSec?: number
}

export const name = 'dsh-channel-gateway-telegram'
export const inject = ['channels']

export const Config: Schema<TelegramPluginConfig> = Schema.object({
  token: Schema.string().default(''),
  apiBaseUrl: Schema.string().default('https://api.telegram.org'),
  pollingTimeoutSec: Schema.number().default(30),
})

export function apply(ctx: Context, config: TelegramPluginConfig): void {
  const configured = config.token ?? ''
  const token = configured !== '' ? configured : (process.env.DSH_TELEGRAM_TOKEN ?? '')
  const logger = ctx.logger('channel-gateway-telegram')
  if (token === '') {
    logger.error('no bot token: set config.token or DSH_TELEGRAM_TOKEN; the telegram channel is not registered')
    return
  }
  const channel = createTelegramChannel({
    token,
    apiBaseUrl: config.apiBaseUrl ?? 'https://api.telegram.org',
    pollingTimeoutSec: config.pollingTimeoutSec ?? 30,
    log: { info: message => logger.info(message), error: message => logger.error(message) },
  })
  ctx.effect(() => {
    const unregister = ctx.channels.register(channel)
    return () => { unregister() }
  }, 'channel-gateway.telegram')
}
