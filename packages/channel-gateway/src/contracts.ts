/**
 * The channel contract: the shape every transport normalizes to.
 *
 * This is a public API other plugins depend on, so it stays small, stable and
 * versionable: a field enters it only when a consumer needs it, never
 * speculatively. Deduplication, durable acceptance, actor identity beyond the
 * provider's id, session routing and visibility rules are implemented by a
 * consumer listening to `channel/inbound`, or by the code that calls
 * {@link OutboundMessage} sends.
 * @module @wowyuarm/dsh-channel-gateway/contracts
 */

/** Who sent one message, as the provider identifies them. */
export interface ChannelActor {
  /** Provider-stable sender id within its channel; the only identity compared. */
  readonly id: string
  /** Human-readable name when the provider gives one; never an identity. */
  readonly displayName?: string
  /** Whether the provider itself marks the sender as a bot. */
  readonly isBot?: boolean
}

/** The shape of the conversation a message arrived in. */
export type ChannelPlaceKind = 'direct' | 'group' | 'channel'

/**
 * Where a message arrived: an opaque destination, plus what kind of place it is.
 *
 * `route` is the only destination an outbound send accepts. The channel mints
 * it and no other layer parses or composes it, so an address scheme stays the
 * channel's private business: a consumer stores the route it saw and hands it
 * back verbatim.
 */
export interface ChannelPlace {
  /** Opaque, channel-minted destination; pass it back as {@link OutboundMessage.route}. */
  readonly route: string
  readonly kind: ChannelPlaceKind
  /** Provider-supplied title (group or channel name); never an identity. */
  readonly title?: string
}

/**
 * Who can see the exchange: only the actor, or everyone in the place.
 *
 * Both channels in this package derive it from the conversation they received,
 * but it stays a field of its own because a consumer routes on "was this said
 * to me privately or in front of others", which is not the same question as
 * what kind of place it is.
 */
export type ChannelVisibility = 'private' | 'group'

/** What an attachment is, as far as this gateway will carry it. */
export type ChannelAttachmentKind = 'image' | 'audio' | 'video' | 'file'

/**
 * One attachment. The gateway never fetches, uploads, or inspects one: it
 * carries the provider's own handle so a consumer can decide what to do.
 */
export interface ChannelAttachment {
  readonly kind: ChannelAttachmentKind
  readonly name?: string
  readonly mimeType?: string
  readonly size?: number
  /** Provider-hosted URL, when the provider offers one that needs no credentials. */
  readonly url?: string
  /** Channel-local handle for a later fetch; opaque to every other layer. */
  readonly ref?: string
  /**
   * Raw bytes to upload when sending. The channel puts them on the wire; the
   * caller does not host or link them. Inbound attachments never carry this:
   * to read inbound content, call {@link Channel.resolveAttachment}.
   */
  readonly data?: Uint8Array
}

/**
 * The content behind an inbound {@link ChannelAttachment}, once a channel has
 * fetched (and, where the provider encrypts them, decrypted) it. Bytes rather
 * than a URL or a path: a provider URL may embed the bot's own credential, and
 * where the bytes live afterwards is the caller's decision, not the gateway's.
 */
export interface ResolvedAttachment {
  readonly bytes: Uint8Array
  readonly mimeType?: string
  readonly name?: string
}

/** One normalized inbound message. */
export interface InboundMessage {
  /** The registered channel's name, e.g. `telegram`. */
  readonly channel: string
  /** The provider's stable message id; a consumer keys deduplication on it. */
  readonly providerMessageId: string
  readonly actor: ChannelActor
  readonly place: ChannelPlace
  readonly visibility: ChannelVisibility
  /** The message text, or `''` when the provider carried none. */
  readonly text: string
  readonly attachments?: readonly ChannelAttachment[]
  /** ISO 8601 UTC instant the provider recorded for the message. */
  readonly timestamp: string
  /** The provider message id this message answers, when it answers one. */
  readonly replyTo?: string
  /** The provider payload the channel normalized, untouched. */
  readonly raw?: unknown
}

/** How an outbound text should be rendered by the channel that carries it. */
export type OutboundTextFormat = 'plain' | 'markdown'

/** One normalized outbound message. */
export interface OutboundMessage {
  /** The registered channel to send through. */
  readonly channel: string
  /** A {@link ChannelPlace.route} copied from an inbound message. */
  readonly route: string
  readonly text: string
  readonly attachments?: readonly ChannelAttachment[]
  /** The provider message id to answer, when answering one. */
  readonly replyTo?: string
  /**
   * How to render {@link OutboundMessage.text}. `markdown` asks the channel to
   * render it into whatever that provider displays formatted text as (Telegram
   * HTML, sanitized WeChat Markdown, ...). Omitted means `plain`: the text is
   * sent verbatim, so a consumer that has not opted in sees no transformation.
   */
  readonly format?: OutboundTextFormat
}

/** What one send produced. */
export interface ChannelSendResult {
  /** The provider's id for the message this send created. */
  readonly providerMessageId: string
}

/** What a channel can do, so a consumer reads it instead of guessing. */
export interface ChannelCapabilities {
  readonly attachments: boolean
  /** Whether {@link Channel.resolveAttachment} can fetch an inbound attachment. */
  readonly attachmentDownload: boolean
  readonly buttons: boolean
  readonly edit: boolean
  readonly replyTo: boolean
  /** Longest text one message may carry; a channel splits anything longer. */
  readonly maxTextLength: number
}

/** The gateway's half of a channel's life, handed over at start. */
export interface ChannelInbox {
  /**
   * Report one normalized inbound message. Authorization and the
   * `channel/inbound` event happen behind this call, so a channel never
   * decides who may speak.
   */
  deliver(message: InboundMessage): void
}

/** One transport adapter, as the gateway sees it. */
export interface Channel {
  /** Unique within a gateway; every message it carries names this value. */
  readonly name: string
  readonly capabilities: ChannelCapabilities
  /**
   * Begin receiving, reporting inbound messages through `inbox.deliver`.
   * Resolving means "receiving has started", not "receiving has finished"; a
   * channel that polls runs until {@link Channel.stop}. A rejection is reported
   * as a failed start, and the channel is unregistered.
   */
  start(inbox: ChannelInbox): Promise<void>
  /** Stop receiving and release resources; safe after a failed start. */
  stop(): Promise<void>
  /** Send one message. The route must be one this channel minted. */
  send(message: OutboundMessage): Promise<ChannelSendResult>
  /**
   * Fetch the content behind an inbound attachment's handle. Present only when
   * {@link ChannelCapabilities.attachmentDownload} is true; the argument is an
   * attachment this channel reported inbound, whose `ref` it minted.
   */
  resolveAttachment?(attachment: ChannelAttachment): Promise<ResolvedAttachment>
}

/** What the gateway knows about one registered channel. */
export interface RegisteredChannel {
  readonly name: string
  readonly capabilities: ChannelCapabilities
}

/** One message a channel hands over, with the channel that owns it. */
export interface DeliveredMessage {
  readonly channel: string
  readonly message: InboundMessage
}
