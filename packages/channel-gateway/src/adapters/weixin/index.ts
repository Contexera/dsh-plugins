/**
 * Weixin: a long-polling channel adapter over the WeChat iLink bot protocol.
 *
 * It normalizes `getupdates` messages into {@link InboundMessage} and sends
 * `sendmessage` requests back; commands, session mapping and reply policy are
 * implemented above it, from `channel/inbound`. The protocol shape follows the
 * public iLink endpoints as implemented by `openclaw-weixin` (MIT) and
 * `nanobot` (MIT); the code here is this package's own.
 *
 * Two transport facts a consumer needs: a reply carries the inbound message's
 * `context_token`, which WeChat expires server-side after roughly two minutes,
 * and this adapter refreshes a stale one before sending; media travels both
 * ways through the iLink CDN — an inbound attachment comes back through
 * `resolveAttachment`, an outbound one goes up from its `data` — a path that
 * follows the reference protocol and is not yet verified against a live account.
 * @module @wowyuarm/dsh-channel-gateway/weixin
 */

import { readFileSync } from 'node:fs'
import { createHash, randomBytes, randomInt } from 'node:crypto'
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
import { delay, proxyAwareFetch, withRetry } from '../http.ts'
import { silentLog, type AdapterLog } from '../log.ts'
import { splitText } from '../text.ts'
import { splitWeixinMarkdown } from './markdown.ts'
import { decryptAesEcb, encryptAesEcb } from './crypto.ts'

/** This adapter's own split threshold; a longer text becomes several messages. */
export const WEIXIN_MAX_TEXT_LENGTH = 2048

/** The public iLink bot endpoint family. */
export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** Where iLink stores encrypted media; a download reads it, an upload writes it. */
export const WEIXIN_DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** iLink business codes worth naming; anything else is reported as it came. */
const ERRCODE_CONTEXT_RESTRICTED = -2
const ERRCODE_INVALID_ARGUMENT = -3
const ERRCODE_STALE_TOKEN = -14

/** `message_type` of a message this bot itself produced. */
const MESSAGE_TYPE_BOT = 2
/** `message_state` of a finished message; `item.type` of a text item. */
const MESSAGE_STATE_FINISH = 2
const ITEM_TYPE_TEXT = 1

/** `item.type` values, by media kind, for outbound media items. */
const ITEM_TYPE_IMAGE = 2
const ITEM_TYPE_VOICE = 3
const ITEM_TYPE_FILE = 4
const ITEM_TYPE_VIDEO = 5

/** `media_type` values `getuploadurl` expects, by media kind. */
const UPLOAD_MEDIA_IMAGE = 1
const UPLOAD_MEDIA_VIDEO = 2
const UPLOAD_MEDIA_FILE = 3
const UPLOAD_MEDIA_VOICE = 4

const ROUTE_PREFIX = 'wx:'

/**
 * How long a context token is trusted before a send refreshes it. iLink expires
 * a token server-side after a short idle window (about two minutes), so a reply
 * to a long agent turn would otherwise be sent against a dead token and lost.
 */
const CONTEXT_TOKEN_MAX_AGE_MS = 80_000

/** One failure the iLink API reported in its own envelope. */
export class WeixinApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly errcode: number,
    message: string,
  ) {
    super(message)
    this.name = 'WeixinApiError'
  }
}

interface WeixinMedia {
  url?: string
  mid_size?: number
  file_name?: string
  len?: string
  /** The hex AES key some items carry beside `media` (images use it first). */
  aeskey?: string
  /** Where the encrypted bytes live and the key to open them. */
  media?: {
    full_url?: string
    encrypt_query_param?: string
    aes_key?: string
  }
}

interface WeixinItem {
  type?: number
  msg_id?: string
  text_item?: { text?: string }
  image_item?: WeixinMedia
  voice_item?: WeixinMedia & { text?: string; playtime?: number }
  file_item?: WeixinMedia
  video_item?: WeixinMedia
}

interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  group_id?: string
  session_id?: string
  message_type?: number
  item_list?: WeixinItem[]
  context_token?: string
}

interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

/** The `getconfig` reply, read only for the fresh context token it may carry. */
interface GetConfigResponse {
  context_token?: string
}

/** The `getuploadurl` reply: where to PUT the encrypted bytes. */
interface GetUploadUrlResponse {
  upload_full_url?: string
  upload_param?: string
}

/**
 * What a later `resolveAttachment` needs to fetch and decrypt one inbound media
 * item, packed into the attachment's opaque `ref`. Short keys keep the ref
 * compact: `k` kind, `u` full url, `e` encrypt_query_param, `a` media aes key
 * (base64), `h` item aes key (hex), `n` file name.
 */
interface WeixinMediaRef {
  k: ChannelAttachment['kind']
  u?: string
  e?: string
  a?: string
  h?: string
  n?: string
}

/** How one weixin channel is built; the plugin row supplies it. */
export interface WeixinChannelOptions {
  readonly token: string
  /** Injected for tests; defaults to a proxy-aware global fetch. */
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  /** Where encrypted media is fetched and uploaded; defaults to the iLink CDN. */
  readonly cdnBaseUrl?: string
  /** Long-poll timeout for the first request, before the server suggests one. */
  readonly pollTimeoutSec?: number
  readonly retryDelayMs?: number
  /** The `iLink-App-Id` this account is registered under, when it needs one. */
  readonly appId?: string
  readonly appClientVersion?: number
  /** An optional `SKRouteTag` header. */
  readonly routeTag?: string
  readonly log?: AdapterLog
}

/** This package's own version, for the protocol's `base_info`. */
function bundleVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function encodePart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/**
 * The route this adapter mints: the peer, plus the context token a reply must
 * quote. Both are opaque to every other layer — a consumer stores the route it
 * saw and hands it back, which is what lets the short-lived token travel
 * without the contract having to grow a field for it.
 */
function routeOf(userId: string, contextToken: string): string {
  return `${ROUTE_PREFIX}${encodePart(userId)}.${encodePart(contextToken)}`
}

function parseRoute(route: string): { userId: string; contextToken: string } {
  const invalid = (): never => {
    throw new ChannelGatewayError(`weixin route "${route}" was not minted by the weixin channel`)
  }
  if (!route.startsWith(ROUTE_PREFIX)) return invalid()
  const [user, token, ...rest] = route.slice(ROUTE_PREFIX.length).split('.')
  if (user === undefined || token === undefined || rest.length > 0) return invalid()
  try {
    return {
      userId: Buffer.from(user, 'base64url').toString('utf8'),
      contextToken: Buffer.from(token, 'base64url').toString('utf8'),
    }
  } catch {
    return invalid()
  }
}

/**
 * Pack what a later download needs into the attachment's opaque `ref`, or
 * nothing when the item carries no locator to fetch from. The key and locator
 * travel in the ref so `resolveAttachment` can work from the attachment alone.
 */
function mediaRefOf(kind: ChannelAttachment['kind'], value: WeixinMedia): string | undefined {
  const fullUrl = value.media?.full_url?.trim() ?? ''
  const encParam = value.media?.encrypt_query_param ?? ''
  if (fullUrl === '' && encParam === '') return undefined
  const ref: WeixinMediaRef = { k: kind }
  if (fullUrl !== '') ref.u = fullUrl
  if (encParam !== '') ref.e = encParam
  if (value.media?.aes_key !== undefined && value.media.aes_key !== '') ref.a = value.media.aes_key
  if (value.aeskey !== undefined && value.aeskey !== '') ref.h = value.aeskey
  if (value.file_name !== undefined && value.file_name !== '') ref.n = value.file_name
  return Buffer.from(JSON.stringify(ref), 'utf8').toString('base64url')
}

/** Media an inbound item carried, with the handle a download later reads. */
function attachmentsOf(items: readonly WeixinItem[]): readonly ChannelAttachment[] {
  const found: ChannelAttachment[] = []
  for (const item of items) {
    const media: readonly (readonly [ChannelAttachment['kind'], WeixinMedia | undefined])[] = [
      ['image', item.image_item],
      ['audio', item.voice_item],
      ['file', item.file_item],
      ['video', item.video_item],
    ]
    for (const [kind, value] of media) {
      if (value === undefined) continue
      const size = value.mid_size ?? (value.len === undefined ? undefined : Number(value.len))
      const ref = mediaRefOf(kind, value)
      found.push({
        kind,
        ...(value.file_name === undefined ? {} : { name: value.file_name }),
        ...(size === undefined || !Number.isFinite(size) ? {} : { size }),
        ...(ref === undefined ? {} : { ref }),
      })
    }
  }
  return found
}

/** The text of one message: its own text items, or the transcript voice carries. */
function textOf(items: readonly WeixinItem[]): string {
  const parts: string[] = []
  for (const item of items) {
    if (item.text_item?.text !== undefined && item.text_item.text !== '') parts.push(item.text_item.text)
    else if (item.voice_item?.text !== undefined && item.voice_item.text !== '') parts.push(item.voice_item.text)
  }
  return parts.join('\n')
}

/**
 * Build the weixin channel. The gateway registers it; `start` begins polling
 * and `stop` ends it. Every provider call is one HTTP request, so a test can
 * inject `fetch` and drive the whole adapter without a network.
 */
export function createWeixinChannel(options: WeixinChannelOptions): Channel {
  const { token } = options
  if (token === '') throw new ChannelGatewayError('the weixin channel needs an iLink bot token')
  const fetchImpl = options.fetch ?? proxyAwareFetch()
  const baseUrl = (options.baseUrl ?? WEIXIN_DEFAULT_BASE_URL).replace(/\/+$/, '')
  const cdnBaseUrl = (options.cdnBaseUrl ?? WEIXIN_DEFAULT_CDN_BASE_URL).replace(/\/+$/, '')
  const retryDelayMs = options.retryDelayMs ?? 3000
  const log = options.log ?? silentLog
  const version = bundleVersion()
  const baseInfo = { channel_version: version, bot_agent: `dsh-channel-gateway/${version}` }
  const appId = options.appId ?? ''
  const appClientVersion = options.appClientVersion ?? 1
  const routeTag = options.routeTag

  let requestTimeoutMs = (options.pollTimeoutSec ?? 35) * 1000
  let running = false
  let abort: AbortController | undefined
  let loop: Promise<void> | undefined
  // The freshest context token seen per user, and when: a send refreshes it
  // before use if it has gone stale.
  const contextTokens = new Map<string, { token: string; at: number }>()

  function redact(message: string): string {
    return message.split(token).join('***')
  }

  function headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'authorization-type': 'ilink_bot_token',
      authorization: `Bearer ${token}`,
      'ilink-app-id': appId,
      'ilink-app-clientversion': String(appClientVersion),
      // The protocol expects a fresh per-request identifier, base64 of a
      // decimal uint32.
      'x-wechat-uin': Buffer.from(String(randomInt(0, 0x1_0000_0000)), 'utf8').toString('base64'),
      ...(routeTag === undefined ? {} : { skroutetag: routeTag }),
    }
  }

  async function request<T>(endpoint: string, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<T> {
    const timeout = AbortSignal.timeout(requestTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ ...body, base_info: baseInfo }),
        signal: combined,
      })
    } catch (error: unknown) {
      throw new Error(redact(`weixin ${endpoint} failed: ${errorText(error)}`))
    }
    const payload = (await response.json().catch(() => undefined)) as (T & { errcode?: number; errmsg?: string }) | undefined
    if (payload === undefined) {
      throw new Error(redact(`weixin ${endpoint} answered nothing (HTTP ${String(response.status)})`))
    }
    // The protocol reports business failures inside a 200 response.
    if (typeof payload.errcode === 'number' && payload.errcode !== 0) {
      throw new WeixinApiError(endpoint, payload.errcode, redact(`weixin ${endpoint} rejected the request: errcode ${String(payload.errcode)}${payload.errmsg === undefined ? '' : ` (${payload.errmsg})`}`))
    }
    return payload
  }

  /** One protocol message as the contract reads it, or nothing to report. */
  function normalize(message: WeixinMessage): InboundMessage | undefined {
    // Our own sends come back through the same stream; they are not inbound.
    if (message.message_type === MESSAGE_TYPE_BOT) return undefined
    const from = message.from_user_id ?? ''
    if (from === '') return undefined
    const items = message.item_list ?? []
    const actor: ChannelActor = { id: from }
    const direct = message.group_id === undefined || message.group_id === ''
    const kind: ChannelPlaceKind = direct ? 'direct' : 'group'
    const place: ChannelPlace = { route: routeOf(from, message.context_token ?? ''), kind }
    const visibility: ChannelVisibility = direct ? 'private' : 'group'
    const attachments = attachmentsOf(items)
    const id = message.message_id === undefined ? message.seq : message.message_id
    return {
      channel: 'weixin',
      providerMessageId: String(id ?? `${from}:${String(message.create_time_ms ?? 0)}`),
      actor,
      place,
      visibility,
      text: textOf(items),
      ...(attachments.length === 0 ? {} : { attachments }),
      timestamp: new Date(message.create_time_ms ?? Date.now()).toISOString(),
      raw: message,
    }
  }

  async function poll(inbox: ChannelInbox, signal: AbortSignal): Promise<void> {
    let cursor = ''
    while (running && !signal.aborted) {
      let page: GetUpdatesResponse
      try {
        page = await request<GetUpdatesResponse>('ilink/bot/getupdates', { get_updates_buf: cursor }, signal)
      } catch (error: unknown) {
        if (!running || signal.aborted) return
        if (error instanceof WeixinApiError && error.errcode === ERRCODE_STALE_TOKEN) {
          running = false
          log.error('weixin: the bot token is stale (errcode -14); polling stops until a fresh token is configured')
          return
        }
        log.error(`weixin: getupdates failed, retrying: ${errorText(error)}`)
        await delay(retryDelayMs, signal)
        continue
      }
      if (typeof page.get_updates_buf === 'string' && page.get_updates_buf !== '') cursor = page.get_updates_buf
      if (typeof page.longpolling_timeout_ms === 'number' && page.longpolling_timeout_ms > 0) {
        // Ask for a little longer than the server said it would hold the call.
        requestTimeoutMs = page.longpolling_timeout_ms + 5000
      }
      for (const message of page.msgs ?? []) {
        const normalized = normalize(message)
        if (normalized === undefined) continue
        // Remember the token that came with this message; it is the freshest one
        // for this user, and a later send refreshes from it if it ages out.
        const fromUser = message.from_user_id ?? ''
        const token = message.context_token ?? ''
        if (fromUser !== '' && token !== '') contextTokens.set(fromUser, { token, at: Date.now() })
        inbox.deliver(normalized)
      }
    }
  }

  /**
   * The context token a send should use for `userId`: the freshest one known,
   * refreshed through `getconfig` when it has aged past its trusted window. A
   * refresh that fails leaves the caller's token in place — better a send that
   * might still work than none at all.
   */
  async function resolveContextToken(userId: string, routeToken: string): Promise<string> {
    const cached = contextTokens.get(userId)
    const token = cached?.token ?? routeToken
    if (token === '') return token
    const age = Date.now() - (cached?.at ?? 0)
    if (age < CONTEXT_TOKEN_MAX_AGE_MS) return token
    try {
      const config = await request<GetConfigResponse>('ilink/bot/getconfig', { ilink_user_id: userId, context_token: token }, undefined)
      const fresh = config.context_token ?? ''
      if (fresh !== '') {
        contextTokens.set(userId, { token: fresh, at: Date.now() })
        return fresh
      }
    } catch (error: unknown) {
      log.error(`weixin: could not refresh a stale context token, using it as is: ${errorText(error)}`)
    }
    return token
  }

  /** A send retries transport failures, but not a rejection the server means. */
  const sendRetry = {
    retries: 3,
    baseDelayMs: 500,
    isRetryable: (error: unknown): boolean => !(error instanceof WeixinApiError),
    onRetry: (error: unknown, waitMs: number): void => {
      log.error(`weixin: send failed, retrying in ${String(waitMs)}ms: ${errorText(error)}`)
    },
  }

  /** Send one message whose items are already built (text or media). */
  async function sendItems(userId: string, contextToken: string, clientId: string, itemList: readonly unknown[]): Promise<void> {
    await withRetry(() => request('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: userId,
        client_id: clientId,
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: itemList,
        ...(contextToken === '' ? {} : { context_token: contextToken }),
      },
    }, undefined), sendRetry)
  }

  /** The upload/item shapes iLink expects for one attachment kind. */
  function mediaKindMapping(kind: ChannelAttachment['kind']): { uploadType: number; itemType: number; itemKey: string } {
    switch (kind) {
      case 'image': return { uploadType: UPLOAD_MEDIA_IMAGE, itemType: ITEM_TYPE_IMAGE, itemKey: 'image_item' }
      case 'video': return { uploadType: UPLOAD_MEDIA_VIDEO, itemType: ITEM_TYPE_VIDEO, itemKey: 'video_item' }
      case 'audio': return { uploadType: UPLOAD_MEDIA_VOICE, itemType: ITEM_TYPE_VOICE, itemKey: 'voice_item' }
      default: return { uploadType: UPLOAD_MEDIA_FILE, itemType: ITEM_TYPE_FILE, itemKey: 'file_item' }
    }
  }

  /**
   * Upload one attachment's bytes to the iLink CDN and send it: ask for an
   * upload URL, AES-encrypt and PUT the bytes, then send a media item that
   * points at what the CDN stored. The caller supplies the bytes; this adapter
   * owns the encryption the CDN requires.
   */
  async function uploadMedia(userId: string, contextToken: string, clientId: string, attachment: ChannelAttachment): Promise<void> {
    if (attachment.data === undefined) {
      throw new ChannelGatewayError(`weixin can only send a ${attachment.kind} attachment given its bytes; a url or ref is not enough`)
    }
    const raw = Buffer.from(attachment.data)
    const rawMd5 = createHash('md5').update(raw).digest('hex')
    const { uploadType, itemType, itemKey } = mediaKindMapping(attachment.kind)
    const aesKeyRaw = randomBytes(16)
    const aesKeyHex = aesKeyRaw.toString('hex')
    // PKCS7 always adds 1..16 bytes, rounding the ciphertext up to a block.
    const paddedSize = Math.ceil((raw.length + 1) / 16) * 16
    const fileKey = randomBytes(16).toString('hex')

    const upload = await request<GetUploadUrlResponse>('ilink/bot/getuploadurl', {
      filekey: fileKey,
      media_type: uploadType,
      to_user_id: userId,
      rawsize: raw.length,
      rawfilemd5: rawMd5,
      filesize: paddedSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
    }, undefined)
    const uploadFullUrl = upload.upload_full_url?.trim() ?? ''
    const uploadParam = upload.upload_param ?? ''
    if (uploadFullUrl === '' && uploadParam === '') {
      throw new ChannelGatewayError('weixin getuploadurl returned no upload url')
    }

    const encrypted = encryptAesEcb(raw, aesKeyRaw.toString('base64'))
    const cdnUploadUrl = uploadFullUrl !== ''
      ? uploadFullUrl
      : `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`
    let cdnResponse: Response
    try {
      cdnResponse = await fetchImpl(cdnUploadUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: encrypted,
      })
    } catch (error: unknown) {
      throw new Error(redact(`weixin media upload failed: ${errorText(error)}`))
    }
    if (!cdnResponse.ok) {
      throw new ChannelGatewayError(`weixin media upload was rejected: HTTP ${String(cdnResponse.status)}`)
    }
    const downloadParam = cdnResponse.headers.get('x-encrypted-param') ?? ''
    if (downloadParam === '') {
      throw new ChannelGatewayError('weixin media upload response carried no x-encrypted-param header')
    }

    // The CDN download key is the hex key's ASCII bytes, base64-encoded.
    const cdnAesKeyB64 = Buffer.from(aesKeyHex, 'utf8').toString('base64')
    const mediaItem: Record<string, unknown> = {
      media: { encrypt_query_param: downloadParam, aes_key: cdnAesKeyB64, encrypt_type: 1 },
    }
    if (itemType === ITEM_TYPE_IMAGE) mediaItem.mid_size = paddedSize
    else if (itemType === ITEM_TYPE_VIDEO) mediaItem.video_size = paddedSize
    else if (itemType === ITEM_TYPE_FILE) {
      mediaItem.file_name = attachment.name ?? 'file'
      mediaItem.len = String(raw.length)
    }
    await sendItems(userId, contextToken, clientId, [{ type: itemType, [itemKey]: mediaItem }])
  }

  /** Fetch and decrypt the bytes behind an inbound media attachment. */
  async function resolveAttachment(attachment: ChannelAttachment): Promise<ResolvedAttachment> {
    if (attachment.ref === undefined) {
      throw new ChannelGatewayError('weixin cannot resolve an attachment without a ref')
    }
    let descriptor: WeixinMediaRef
    try {
      descriptor = JSON.parse(Buffer.from(attachment.ref, 'base64url').toString('utf8')) as WeixinMediaRef
    } catch {
      throw new ChannelGatewayError('weixin attachment ref is not one this channel minted')
    }
    const candidates: string[] = []
    if (descriptor.u !== undefined && descriptor.u !== '') candidates.push(descriptor.u)
    if (descriptor.e !== undefined && descriptor.e !== '') {
      candidates.push(`${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(descriptor.e)}`)
    }
    if (candidates.length === 0) {
      throw new ChannelGatewayError('weixin attachment ref carries no download locator')
    }
    // Prefer image_item.aeskey (hex) as the reference client does, then media.aes_key.
    const keyB64 = descriptor.h !== undefined && descriptor.h !== ''
      ? Buffer.from(descriptor.h, 'hex').toString('base64')
      : descriptor.a ?? ''

    let lastError: unknown
    for (const url of candidates) {
      try {
        const response = await fetchImpl(url)
        if (!response.ok) throw new ChannelGatewayError(`weixin media download was rejected: HTTP ${String(response.status)}`)
        const encrypted = Buffer.from(await response.arrayBuffer())
        const bytes = keyB64 === '' ? encrypted : decryptAesEcb(encrypted, keyB64)
        return {
          bytes: new Uint8Array(bytes),
          ...(descriptor.n === undefined ? {} : { name: descriptor.n }),
        }
      } catch (error: unknown) {
        lastError = error
      }
    }
    throw new Error(redact(`weixin media download failed: ${errorText(lastError)}`))
  }

  const capabilities: ChannelCapabilities = {
    attachments: true,
    attachmentDownload: true,
    buttons: false,
    edit: false,
    replyTo: false,
    maxTextLength: WEIXIN_MAX_TEXT_LENGTH,
  }

  return {
    name: 'weixin',
    capabilities,
    async start(inbox: ChannelInbox): Promise<void> {
      if (running) return
      running = true
      abort = new AbortController()
      log.info('weixin: polling for messages')
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
      const target = parseRoute(message.route)
      const chunks = message.format === 'markdown'
        ? splitWeixinMarkdown(message.text, WEIXIN_MAX_TEXT_LENGTH)
        : splitText(message.text, WEIXIN_MAX_TEXT_LENGTH)
      const attachments = message.attachments ?? []
      if (chunks.length === 0 && attachments.length === 0) {
        throw new ChannelGatewayError('weixin send carried neither text nor attachments')
      }
      const contextToken = await resolveContextToken(target.userId, target.contextToken)
      // The protocol answers a send with an empty body, so the id the caller
      // gets back is the delivery id this adapter minted. Each part carries its
      // own client id, so a retried part is idempotent rather than a duplicate.
      const deliveryId = `dsh-channel-gateway:${String(Date.now())}-${randomBytes(4).toString('hex')}`
      let part = 0
      for (const chunk of chunks) {
        await sendItems(target.userId, contextToken, `${deliveryId}.${String(part)}`, [{ type: ITEM_TYPE_TEXT, text_item: { text: chunk } }])
        part += 1
      }
      for (const attachment of attachments) {
        await uploadMedia(target.userId, contextToken, `${deliveryId}.${String(part)}`, attachment)
        part += 1
      }
      return { providerMessageId: deliveryId }
    },
    resolveAttachment,
  }
}

/** The weixin plugin row's own configuration. */
export interface WeixinPluginConfig {
  /** iLink bot token; falls back to `DSH_WEIXIN_TOKEN`. */
  token?: string
  baseUrl?: string
  cdnBaseUrl?: string
  appId?: string
  routeTag?: string
  pollTimeoutSec?: number
}

export const name = 'dsh-channel-gateway-weixin'
export const inject = ['channels']

export const Config: Schema<WeixinPluginConfig> = Schema.object({
  token: Schema.string().default(''),
  baseUrl: Schema.string().default(WEIXIN_DEFAULT_BASE_URL),
  cdnBaseUrl: Schema.string().default(WEIXIN_DEFAULT_CDN_BASE_URL),
  appId: Schema.string().default(''),
  routeTag: Schema.string().default(''),
  pollTimeoutSec: Schema.number().default(35),
})

export function apply(ctx: Context, config: WeixinPluginConfig): void {
  const configured = config.token ?? ''
  const token = configured !== '' ? configured : (process.env.DSH_WEIXIN_TOKEN ?? '')
  const logger = ctx.logger('channel-gateway-weixin')
  if (token === '') {
    logger.error('no iLink bot token: set config.token or DSH_WEIXIN_TOKEN; the weixin channel is not registered')
    return
  }
  const routeTag = config.routeTag ?? ''
  const cdnBaseUrl = config.cdnBaseUrl ?? ''
  const channel = createWeixinChannel({
    token,
    baseUrl: config.baseUrl ?? WEIXIN_DEFAULT_BASE_URL,
    ...(cdnBaseUrl === '' ? {} : { cdnBaseUrl }),
    appId: config.appId ?? '',
    pollTimeoutSec: config.pollTimeoutSec ?? 35,
    ...(routeTag === '' ? {} : { routeTag }),
    log: { info: message => logger.info(message), error: message => logger.error(message) },
  })
  ctx.effect(() => {
    const unregister = ctx.channels.register(channel)
    return () => { unregister() }
  }, 'channel-gateway.weixin')
}
