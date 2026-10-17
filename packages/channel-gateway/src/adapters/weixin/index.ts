/**
 * Weixin: a long-polling channel adapter over the WeChat iLink bot protocol.
 *
 * It normalizes `getupdates` messages into {@link InboundMessage} and sends
 * `sendmessage` requests back. The protocol shape follows the public iLink
 * endpoints as implemented by `openclaw-weixin` (MIT) and `nanobot` (MIT); the
 * code here is this package's own.
 *
 * Two transport facts a consumer needs: a reply carries the inbound message's
 * `context_token`, which WeChat expires server-side after roughly two minutes,
 * and this adapter refreshes a stale one before sending; media travels both
 * ways through the iLink CDN — an inbound attachment comes back through
 * `resolveAttachment`, an outbound one goes up from its `data` — a path that
 * follows the reference protocol and is not yet verified against a live account.
 * @module @contexera/dsh-channel-gateway/weixin
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
import {
  assertFetchableAttachmentUrl,
  deriveAttachmentRefSecret,
  openAttachmentRef,
  tryMintAttachmentRef,
  type WeixinMediaRef,
} from './attachment-ref.ts'

export const WEIXIN_MAX_TEXT_LENGTH = 2048

export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** Where iLink stores encrypted media; a download reads it, an upload writes it. */
export const WEIXIN_DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** iLink business codes worth naming; anything else is reported as it came. */
const ERRCODE_STALE_TOKEN = -14

/** `message_type` of a message this bot itself produced. */
const MESSAGE_TYPE_BOT = 2
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

interface GetConfigResponse {
  context_token?: string
}

/** The `getuploadurl` reply: where to PUT the encrypted bytes. */
interface GetUploadUrlResponse {
  upload_full_url?: string
  upload_param?: string
}

/** How one weixin channel is built; the plugin row supplies it. */
export interface WeixinChannelOptions {
  readonly token: string
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  readonly cdnBaseUrl?: string
  /** Long-poll timeout for the first request, before the server suggests one. */
  readonly pollTimeoutSec?: number
  readonly retryDelayMs?: number
  /** The `iLink-App-Id` this account is registered under, when it needs one. */
  readonly appId?: string
  readonly appClientVersion?: number
  /** An optional `SKRouteTag` header. */
  readonly routeTag?: string
  /**
   * Hosts an inbound attachment may be downloaded from. Defaults to the host of
   * {@link WeixinChannelOptions.cdnBaseUrl} plus the iLink CDN; a provider URL
   * pointing anywhere else is refused rather than fetched.
   */
  readonly attachmentHosts?: readonly string[]
  /**
   * A stable secret for attachment-ref MACs, when refs must outlive a token
   * rotation. Defaults to a key derived from the bot token.
   */
  readonly attachmentRefSecret?: string
  /** Ceiling on one attachment download, in bytes; a longer body is aborted. */
  readonly maxAttachmentBytes?: number
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
 * quote. Both are opaque to every other layer.
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

function mediaRefOf(kind: ChannelAttachment['kind'], value: WeixinMedia, secret: Buffer): string | undefined {
  const fullUrl = value.media?.full_url?.trim() ?? ''
  const encParam = value.media?.encrypt_query_param ?? ''
  if (fullUrl === '' && encParam === '') return undefined
  const descriptor: WeixinMediaRef = { k: kind }
  if (fullUrl !== '') descriptor.u = fullUrl
  if (encParam !== '') descriptor.e = encParam
  if (value.media?.aes_key !== undefined && value.media.aes_key !== '') descriptor.a = value.media.aes_key
  if (value.aeskey !== undefined && value.aeskey !== '') descriptor.h = value.aeskey
  if (value.file_name !== undefined && value.file_name !== '') descriptor.n = value.file_name
  return tryMintAttachmentRef(descriptor, secret)
}

function attachmentsOf(items: readonly WeixinItem[], secret: Buffer): readonly ChannelAttachment[] {
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
      const ref = mediaRefOf(kind, value, secret)
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
 * and `stop` ends it.
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
  const refSecret = deriveAttachmentRefSecret(options.attachmentRefSecret ?? token)
  const attachmentHosts: readonly string[] = (options.attachmentHosts ?? [
    ...new Set([new URL(cdnBaseUrl).hostname, new URL(WEIXIN_DEFAULT_CDN_BASE_URL).hostname]),
  ]).map(host => host.toLowerCase())
  const maxAttachmentBytes = options.maxAttachmentBytes ?? 32 * 1024 * 1024

  let requestTimeoutMs = (options.pollTimeoutSec ?? 35) * 1000
  let running = false
  let abort: AbortController | undefined
  let loop: Promise<void> | undefined
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

  function normalize(message: WeixinMessage): InboundMessage | undefined {
    if (message.message_type === MESSAGE_TYPE_BOT) return undefined
    const from = message.from_user_id ?? ''
    if (from === '') return undefined
    const items = message.item_list ?? []
    const actor: ChannelActor = { id: from }
    const direct = message.group_id === undefined || message.group_id === ''
    const kind: ChannelPlaceKind = direct ? 'direct' : 'group'
    const place: ChannelPlace = { route: routeOf(from, message.context_token ?? ''), kind }
    const visibility: ChannelVisibility = direct ? 'private' : 'group'
    const attachments = attachmentsOf(items, refSecret)
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
      const nextCursor = typeof page.get_updates_buf === 'string' && page.get_updates_buf !== ''
        ? page.get_updates_buf
        : cursor
      if (typeof page.longpolling_timeout_ms === 'number' && page.longpolling_timeout_ms > 0) {
        requestTimeoutMs = page.longpolling_timeout_ms + 5000
      }
      // This page's deliveries settle before the next `get_updates_buf` is
      // committed. The cursor is the provider's position, and iLink does not
      // replay what it has already handed over — so a page that was not accepted
      // keeps its cursor and is requested again, which is why a sink must be
      // idempotent. The tokens a page carried are still remembered: they are
      // what a later reply to that user would quote.
      let failed = false
      for (const message of page.msgs ?? []) {
        const normalized = normalize(message)
        if (normalized === undefined) continue
        const fromUser = message.from_user_id ?? ''
        const token = message.context_token ?? ''
        if (fromUser !== '' && token !== '') contextTokens.set(fromUser, { token, at: Date.now() })
        try {
          await inbox.deliver(normalized)
        } catch (error: unknown) {
          if (!running || signal.aborted) return
          log.error(`weixin: delivery failed, holding the cursor so the page is requested again: ${errorText(error)}`)
          failed = true
          break
        }
      }
      if (failed) {
        await delay(retryDelayMs, signal)
        continue
      }
      cursor = nextCursor
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

  const sendRetry = {
    retries: 3,
    baseDelayMs: 500,
    isRetryable: (error: unknown): boolean => !(error instanceof WeixinApiError),
    onRetry: (error: unknown, waitMs: number): void => {
      log.error(`weixin: send failed, retrying in ${String(waitMs)}ms: ${errorText(error)}`)
    },
  }

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

  async function uploadMedia(userId: string, contextToken: string, clientId: string, attachment: ChannelAttachment): Promise<void> {
    if (attachment.data === undefined) {
      throw new ChannelGatewayError(`weixin can only send a ${attachment.kind} attachment given its bytes; a url or ref is not enough`)
    }
    const raw = Buffer.from(attachment.data)
    const rawMd5 = createHash('md5').update(raw).digest('hex')
    const { uploadType, itemType, itemKey } = mediaKindMapping(attachment.kind)
    const aesKeyRaw = randomBytes(16)
    const aesKeyHex = aesKeyRaw.toString('hex')
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

  /**
   * Fetch and decrypt the bytes behind an inbound media attachment. Every
   * rejection before the network is a ref that did not verify — version, MAC,
   * field bounds, kind or download host — and no request is made for one.
   */
  async function resolveAttachment(attachment: ChannelAttachment): Promise<ResolvedAttachment> {
    if (attachment.ref === undefined) {
      throw new ChannelGatewayError('weixin cannot resolve an attachment without a ref')
    }
    const descriptor = openAttachmentRef(attachment.ref, refSecret, attachment.kind)
    const candidates: string[] = []
    if (descriptor.u !== undefined && descriptor.u !== '') candidates.push(descriptor.u)
    if (descriptor.e !== undefined && descriptor.e !== '') {
      candidates.push(`${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(descriptor.e)}`)
    }
    if (candidates.length === 0) {
      throw new ChannelGatewayError('weixin attachment ref carries no download locator')
    }
    // Every candidate is checked against the allowlist before the loop, so a
    // ref cannot smuggle one refused host in behind an allowed one.
    for (const url of candidates) assertFetchableAttachmentUrl(url, attachmentHosts)
    const keyB64 = descriptor.h !== undefined && descriptor.h !== ''
      ? Buffer.from(descriptor.h, 'hex').toString('base64')
      : descriptor.a ?? ''

    let lastError: unknown
    for (const url of candidates) {
      try {
        const bytes = await downloadBytes(url)
        const decrypted = keyB64 === '' ? bytes : decryptAesEcb(bytes, keyB64)
        return {
          bytes: new Uint8Array(decrypted),
          ...(descriptor.n === undefined ? {} : { name: descriptor.n }),
        }
      } catch (error: unknown) {
        lastError = error
      }
    }
    throw new Error(redact(`weixin media download failed: ${errorText(lastError)}`))
  }

  /**
   * One bounded download: it carries an AbortSignal so a stop or a timeout ends
   * it, and it stops reading at the byte ceiling instead of buffering whatever
   * the host sends.
   *
   * `redirect: 'error'` is what keeps the https-only and host-allowlist checks
   * on the locator meaningful. Those checks run once, against the URL the ref
   * names; following a redirect would apply them to the first hop only, letting
   * an allowlisted host hand the download to an internal or plaintext address.
   */
  async function downloadBytes(url: string): Promise<Buffer> {
    const timeout = AbortSignal.timeout(requestTimeoutMs)
    const signal = abort === undefined ? timeout : AbortSignal.any([abort.signal, timeout])
    const response = await fetchImpl(url, { signal, redirect: 'error' })
    if (!response.ok) throw new ChannelGatewayError(`weixin media download was rejected: HTTP ${String(response.status)}`)
    const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > maxAttachmentBytes) {
      throw new ChannelGatewayError(`weixin refuses an attachment larger than ${String(maxAttachmentBytes)} bytes`)
    }
    if (response.body === null || response.body === undefined) {
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length > maxAttachmentBytes) {
        throw new ChannelGatewayError(`weixin refuses an attachment larger than ${String(maxAttachmentBytes)} bytes`)
      }
      return body
    }
    const chunks: Buffer[] = []
    let total = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        total += value.byteLength
        if (total > maxAttachmentBytes) {
          throw new ChannelGatewayError(`weixin refuses an attachment larger than ${String(maxAttachmentBytes)} bytes`)
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    return Buffer.concat(chunks)
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
