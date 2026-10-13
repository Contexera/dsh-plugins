---
'@contexera/dsh-channel-gateway': patch
---

Authenticate weixin attachment refs before fetching them.

An attachment's `ref` was decoded and its URL passed straight to `fetch()`, so
any caller that could reach `resolveAttachment` could compose a ref pointing at
an arbitrary address. A ref is now `base64url({ v, d, m })` — a version, the
descriptor, and an HMAC over the descriptor's canonical JSON — and
`resolveAttachment` verifies version, field bounds, MAC and the attachment's
`kind` before any network access. A locator must be `https:` on a host from the
new `attachmentHosts` allowlist (default: the configured CDN host plus the iLink
CDN), downloads carry an `AbortSignal` and stop at `maxAttachmentBytes`
(default 32 MiB), and every rejection is a `ChannelGatewayError` that names no
URL, token or AES key.

The MAC key derives from the bot token, so a token rotation invalidates refs
minted under the old one; the new `attachmentRefSecret` pins a stable key when
refs must outlive a rotation. An item whose descriptor cannot be represented
within the bounds is reported with no `ref` rather than failing the message it
arrived in.
