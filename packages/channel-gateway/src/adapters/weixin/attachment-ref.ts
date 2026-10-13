/**
 * The authenticated handle the weixin adapter mints for one inbound media item.
 *
 * An attachment's `ref` crosses into consumer code, so the adapter cannot
 * assume it comes back unmodified: a caller that can reach
 * `Channel.resolveAttachment` can hand it any string. The ref therefore carries
 * a MAC over its own descriptor, and {@link openAttachmentRef} verifies version,
 * MAC, field bounds and kind before anything is fetched. The MAC key is derived
 * from the bot token unless a deployment configures its own secret.
 *
 * The descriptor stays the adapter's private business: it never leaves this
 * module in decoded form, and every rejection is a {@link ChannelGatewayError}
 * whose message names no URL, key or file name.
 * @module @contexera/dsh-channel-gateway/weixin/attachment-ref
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { ChannelAttachment } from '../../contracts.ts'
import { ChannelGatewayError } from '../../errors.ts'

/** Bumped only when the descriptor's meaning changes; a ref from another version then stops verifying. */
export const WEIXIN_ATTACHMENT_REF_VERSION = 1

/**
 * Ceilings on every field a ref may carry. They bound the work one ref can
 * cause before its MAC is even checked, and keep a ref from being usable as a
 * bulk transport: a descriptor only ever holds a locator, a key and a name.
 */
export const WEIXIN_REF_MAX_LENGTH = 8192
export const WEIXIN_REF_MAX_URL_LENGTH = 2048
export const WEIXIN_REF_MAX_QUERY_LENGTH = 2048
export const WEIXIN_REF_MAX_KEY_LENGTH = 512
export const WEIXIN_REF_MAX_NAME_LENGTH = 255

const KINDS: readonly ChannelAttachment['kind'][] = ['image', 'audio', 'video', 'file']
const DESCRIPTOR_KEYS: readonly string[] = ['k', 'u', 'e', 'a', 'h', 'n']

/**
 * What a later `resolveAttachment` needs to fetch and decrypt one inbound media
 * item. Short keys keep the ref compact: `k` kind, `u` full url, `e`
 * encrypt_query_param, `a` media aes key (base64), `h` item aes key (hex),
 * `n` file name.
 */
export interface WeixinMediaRef {
  k: ChannelAttachment['kind']
  u?: string
  e?: string
  a?: string
  h?: string
  n?: string
}

/** The wire shape of one ref: a version, the descriptor, and its MAC. */
interface WeixinAttachmentRefEnvelope {
  v: number
  d: WeixinMediaRef
  m: string
}

/**
 * A descriptor this module will not mint or accept. Internal: callers see
 * either a minted string or a {@link ChannelGatewayError}, never this.
 */
class RefDescriptorError extends Error {}

/**
 * The MAC key for refs. Derived from the bot token by default, so a deployment
 * needs no extra configuration; a token rotation then invalidates the refs
 * minted under the old token, which is the safe direction. A deployment that
 * rotates tokens often and needs refs to outlive one configures a stable
 * secret instead.
 */
export function deriveAttachmentRefSecret(token: string): Buffer {
  return createHash('sha256')
    .update(`dsh-channel-gateway/weixin/attachment-ref/v${String(WEIXIN_ATTACHMENT_REF_VERSION)}\u0000${token}`, 'utf8')
    .digest()
}

/**
 * Keep only the known fields, dropping empty ones, and reject anything a minted
 * ref never carries. Rejecting unknown keys is what keeps the MAC's input
 * identical to the descriptor a later read sees.
 */
function normalizeDescriptor(input: unknown): WeixinMediaRef {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RefDescriptorError('descriptor is not an object')
  }
  const record = input as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!DESCRIPTOR_KEYS.includes(key)) throw new RefDescriptorError(`descriptor carries an unknown field ("${key}")`)
  }
  const kind = record.k
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    throw new RefDescriptorError('descriptor names no kind this channel carries')
  }
  const bounded = (key: string, max: number): string | undefined => {
    const value = record[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new RefDescriptorError(`descriptor field "${key}" is not a string`)
    if (value === '') return undefined
    if (value.length > max) throw new RefDescriptorError(`descriptor field "${key}" exceeds ${String(max)} characters`)
    return value
  }
  const descriptor: WeixinMediaRef = { k: kind as ChannelAttachment['kind'] }
  const url = bounded('u', WEIXIN_REF_MAX_URL_LENGTH)
  const query = bounded('e', WEIXIN_REF_MAX_QUERY_LENGTH)
  const mediaKey = bounded('a', WEIXIN_REF_MAX_KEY_LENGTH)
  const itemKey = bounded('h', WEIXIN_REF_MAX_KEY_LENGTH)
  const name = bounded('n', WEIXIN_REF_MAX_NAME_LENGTH)
  if (url !== undefined) descriptor.u = url
  if (query !== undefined) descriptor.e = query
  if (mediaKey !== undefined) descriptor.a = mediaKey
  if (itemKey !== undefined) descriptor.h = itemKey
  if (name !== undefined) descriptor.n = name
  return descriptor
}

/** JSON of the normalized descriptor: one canonical byte string per descriptor. */
function canonicalDescriptor(descriptor: WeixinMediaRef): string {
  return JSON.stringify(descriptor)
}

function macOf(canonical: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url')
}

/**
 * Mint the opaque ref one inbound media item is handed out with. Throws when
 * the descriptor could not be represented; the inbound path uses
 * {@link tryMintAttachmentRef} instead so a hostile provider payload cannot
 * fail message normalization.
 */
export function mintAttachmentRef(descriptor: WeixinMediaRef, secret: Buffer): string {
  const normalized = normalizeDescriptor(descriptor)
  const envelope: WeixinAttachmentRefEnvelope = {
    v: WEIXIN_ATTACHMENT_REF_VERSION,
    d: normalized,
    m: macOf(canonicalDescriptor(normalized), secret),
  }
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')
}

/**
 * Mint a ref, or nothing when the descriptor is one this channel cannot
 * represent. Provider fields arrive unbounded, so an item whose locator is
 * longer than a ref may carry is reported without a download handle rather than
 * breaking the message it arrived in.
 */
export function tryMintAttachmentRef(descriptor: WeixinMediaRef, secret: Buffer): string | undefined {
  try {
    return mintAttachmentRef(descriptor, secret)
  } catch (error: unknown) {
    if (error instanceof RefDescriptorError) return undefined
    throw error
  }
}

/** The one rejection a ref that did not verify gets, whatever part of it failed. */
function notMinted(): never {
  throw new ChannelGatewayError('weixin attachment ref is not one this channel minted')
}

/**
 * Verify one ref and return its descriptor, or throw without touching the
 * network. The caller-supplied `kind` is compared against the signed one, so a
 * ref minted for an image cannot be replayed as a file.
 */
export function openAttachmentRef(ref: string, secret: Buffer, kind: ChannelAttachment['kind']): WeixinMediaRef {
  if (ref.length > WEIXIN_REF_MAX_LENGTH) {
    throw new ChannelGatewayError(`weixin attachment ref exceeds ${String(WEIXIN_REF_MAX_LENGTH)} characters`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'))
  } catch {
    return notMinted()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return notMinted()
  const envelope = parsed as Record<string, unknown>
  if (Object.keys(envelope).length !== 3 || !('v' in envelope) || !('d' in envelope) || !('m' in envelope)) return notMinted()
  if (envelope.v !== WEIXIN_ATTACHMENT_REF_VERSION) {
    throw new ChannelGatewayError('weixin attachment ref was minted by another version of this channel')
  }
  if (typeof envelope.m !== 'string') return notMinted()
  // Bounds are checked before the MAC so a forged ref cannot make this compare
  // an unbounded input; the MAC then runs over exactly the accepted fields.
  let descriptor: WeixinMediaRef
  try {
    descriptor = normalizeDescriptor(envelope.d)
  } catch (error: unknown) {
    if (error instanceof RefDescriptorError) return notMinted()
    throw error
  }
  const expected = Buffer.from(macOf(canonicalDescriptor(descriptor), secret), 'utf8')
  const claimed = Buffer.from(envelope.m, 'utf8')
  if (expected.length !== claimed.length || !timingSafeEqual(expected, claimed)) return notMinted()
  if (descriptor.k !== kind) {
    throw new ChannelGatewayError('weixin attachment ref was minted for a different attachment kind')
  }
  return descriptor
}

/**
 * The one policy a download URL must satisfy: `https:`, and a host the channel
 * was configured to fetch from. The message never repeats the URL, because a
 * provider URL may embed the bot's own credential.
 */
export function assertFetchableAttachmentUrl(url: string, allowedHosts: readonly string[]): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ChannelGatewayError('weixin attachment ref carries no usable download locator')
  }
  if (parsed.protocol !== 'https:') {
    throw new ChannelGatewayError(`weixin refuses to download over ${parsed.protocol} — only https is fetched`)
  }
  const host = parsed.hostname.toLowerCase()
  if (!allowedHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) {
    throw new ChannelGatewayError('weixin refuses to download from a host this channel is not configured for')
  }
}
