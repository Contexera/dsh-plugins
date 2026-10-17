'@contexera/dsh-channel-gateway': patch
---

Close three defects and drop dead code.

`renderTelegramHtml` interpolated a link target into an `href` attribute
unescaped, so a URL containing a double quote closed the attribute and
injected one of its own. The target is now percent-encoded before it reaches
the template.

`splitText` looped forever on a non-positive limit, because the guard that
advanced the cursor was also the one that read the limit. It now raises
`ChannelGatewayError`.

`errorText` returned `[object Object]` for a circular error, because the
`JSON.stringify` fallback ran only for a throwing `stringify`. It uses
`node:util`'s `inspect`.

Also removes the unexported `mintAttachmentRef`, the unused
`ERRCODE_CONTEXT_RESTRICTED` and `ERRCODE_INVALID_ARGUMENT`, the unreferenced
`DeliveredMessage`, and renames `telegramSendRetries` to
`telegramRetryPolicy`.
