# @contexera/dsh-channel-gateway

## 0.2.0

### Minor Changes

- [中文](#cn-v0-2-0) | [English](#en-v0-2-0)

  <h3 id="cn-v0-2-0">中文</h3>

  **改了什么**

  - 新增可靠入站接收接缝 `ChannelInboundSink`：`accept(message)` 返回的 promise 只在消息被持久接受后才 settle。用 `ctx.channels.registerInboundSink(sink)` 注册，最多一个，注册第二个抛 `ChannelGatewayError`。注册后网关在广播 `channel/inbound` 前先 await `accept`，拒绝会传播给投递中的适配器，适配器随即不动自己的游标，由提供方再次投递该消息。因归属或授权被拒的消息仍 resolve——重读只会被拒第二次。
  - `ChannelInbox.deliver` 返回 `Promise<void>`（原为 `void`），Telegram 适配器与 weixin 适配器都会等一页投递完成后再推进各自的 `getUpdates` offset / `get_updates_buf` 游标。部分失败的一页会被整页重投，因此 sink 必须幂等，并自行负责 `(channel, providerMessageId)` 去重——网关不保存去重状态。
  - **修复 weixin 附件 ref 的鉴权**：ref 此前只是解码后把 URL 直接交给 `fetch()`，任何能触达 `resolveAttachment` 的调用方都能构造一个指向任意地址的 ref。现在 ref 是 `base64url({ v, d, m })`（版本、描述符、描述符规范化 JSON 的 HMAC），`resolveAttachment` 在任何网络访问前校验版本、字段边界、MAC 与附件 `kind`；定位符必须是 `https:` 且主机落在新的 `attachmentHosts` 白名单内（默认：配置的 CDN 主机 + iLink CDN）。这些校验覆盖整个下载过程（拒绝跟随重定向），下载带 `AbortSignal` 并在 `maxAttachmentBytes`（默认 32 MiB）处停止，任何拒绝都是不包含 URL、token 或 AES 密钥的 `ChannelGatewayError`。
  - MAC 密钥由 bot token 派生，故轮换 token 会让旧 ref 失效；新增 `attachmentRefSecret` 可在 ref 需要跨轮换存活时固定密钥。描述符无法在边界内表达时，该条以「无 ref」上报，而不是让整条消息失败——包括逐字段都在界内、但编出的 ref 超过频道可打开长度的情况。
  - 三个包的架构文档现在随 npm tarball 一起发布：README 链接的 `docs/` 此前不在 `files` 里，装包的人点进去是空路径。新增 `pnpm check:pack` 门禁按 `npm publish` 的方式打包并检查 README 与文档里的每个链接，CI 在 `pnpm -r build` 后运行，`pnpm release` 在 `changeset publish` 前运行。

  **兼容性**

  - 公开契约基本不变：`send()` 签名、`ChannelSendResult`、路由与配置键都不动；`ChannelInbox.deliver` 的返回类型由 `void` 变为 `Promise<void>`，`await` 它即可，不 await 也不会出错。
  - 不注册 sink 时行为完全不变：`channel/inbound` 仍是尽力而为的通知。
  - 附件 `ref` 的格式变了：旧 ref 一律被拒（这是修复本身），需要重新取一次附件列表。轮换过 bot token 的部署若要让旧 ref 继续有效，需配置 `attachmentRefSecret`。
  - 本包不声明 DSH peer，这条关系不变。

  **验证**

  - 本地：`pnpm -r typecheck`、`pnpm -r test`（8 个文件 / 99 条测试）、`pnpm -r build` 全过，`check:peers` 与 `check:pack` 通过。

  ```sh
  npm i @contexera/dsh-channel-gateway@0.2.0
  ```

  <h3 id="en-v0-2-0">English</h3>

  **What changed**

  - Added `ChannelInboundSink`, a reliable inbound acceptance seam: the promise `accept(message)` returns settles only once the message is durably accepted. Register at most one with `ctx.channels.registerInboundSink(sink)`; a second throws `ChannelGatewayError`. With a sink registered the gateway awaits `accept` before announcing `channel/inbound`, and a rejection propagates to the delivering adapter, which then leaves its cursor alone so the provider hands the message over again. A message refused by ownership or authorization still resolves, since re-reading it would only be refused again.
  - `ChannelInbox.deliver` returns `Promise<void>` (was `void`), and both the Telegram and weixin adapters await a page's deliveries before advancing the `getUpdates` offset or the `get_updates_buf` cursor. A partially failed page is handed over again, so a sink must be idempotent and owns `(channel, providerMessageId)` deduplication — the gateway keeps no dedupe state.
  - **Fixed the authentication of weixin attachment refs**: a ref was merely decoded and its URL passed straight to `fetch()`, so any caller that could reach `resolveAttachment` could compose a ref pointing at an arbitrary address. A ref is now `base64url({ v, d, m })` — a version, the descriptor, and an HMAC over the descriptor's canonical JSON — and `resolveAttachment` verifies version, field bounds, MAC and the attachment's `kind` before any network access. A locator must be `https:` on a host from the new `attachmentHosts` allowlist (default: the configured CDN host plus the iLink CDN). Those checks hold for the whole download because it refuses to follow a redirect, downloads carry an `AbortSignal` and stop at `maxAttachmentBytes` (default 32 MiB), and every rejection is a `ChannelGatewayError` naming no URL, token or AES key.
  - The MAC key derives from the bot token, so a token rotation invalidates refs minted under the old one; the new `attachmentRefSecret` pins a stable key when refs must outlive a rotation. An item whose descriptor cannot be represented within the bounds is reported with no `ref` rather than failing the message it arrived in — including when a descriptor passes every per-field bound but encodes to a ref longer than the channel will open.
  - All three packages now ship their architecture documents in the npm tarball: the `docs/` pages every README links were not in `files`, so an installed reader followed a link to a path that did not exist. The new `pnpm check:pack` gate packs each package the way `npm publish` would and checks every link in a README or document; CI runs it after `pnpm -r build` and `pnpm release` runs it before `changeset publish`.

  **Compatibility**

  - The public contract is largely unchanged: `send()`'s signature, `ChannelSendResult`, routes and configuration keys all stay as they are; `ChannelInbox.deliver`'s return type moves from `void` to `Promise<void>`, which is safe to await and safe not to.
  - With no sink registered, behavior is unchanged: `channel/inbound` remains a best-effort notification.
  - The attachment `ref` format changed: old refs are refused (that is the fix), so fetch an attachment listing once more. A deployment that rotated its bot token and needs old refs to keep working sets `attachmentRefSecret`.
  - This package declares no DSH peers; that relationship is unchanged.

  **Verification**

  - Local: `pnpm -r typecheck`, `pnpm -r test` (8 files / 99 tests) and `pnpm -r build` pass, and `check:peers` and `check:pack` hold.

## 0.1.6

### Patch Changes

- [中文](#cn-v0-1-6) | [English](#en-v0-1-6)

  <h3 id="cn-v0-1-6">中文</h3>

  **改了什么**

  - 修掉一个让**所有配了代理的部署**都发不出附件的缺陷：适配器用运行时全局的 `FormData` 拼 multipart 体，却用本包自己那份 `undici` 的 fetch 发出去。两者不是同一个 undici 构建时，fetch 不认这个体、把它当成普通字符串发出——真正到 Telegram 的请求体是 17 字节的 `[object FormData]`，API 于是回 `there is no document in the request`。`adapters/http.ts` 现在导出与 fetch 配对的那个 `FormData`，telegram 适配器用它构造 multipart；`proxyAwareFetch()` 也**恒定**返回本包那份 fetch，不再按有没有代理变量在两种 fetch 之间切换。
  - 附件失败时不再只抛一个裸的传输错误：正文已经进了会话、收不回来，重发整条就是重复。新错误会说明正文已作为哪条消息送达、第几个附件失败，调用方只需补发附件；正文没发出去时仍是原始错误。

  **兼容性**

  - 公开契约不变：`send()` 的签名、`ChannelSendResult`、路由与配置键都不动。
  - 新增导出 `FormData`（`adapters/http.ts`），只增不改。
  - 附件失败时的错误**类型**从 `ChannelGatewayError` 改为普通 `Error`（保留原错误为 `cause`）。`ChannelGatewayError` 按文档语义是「调用方的错」，而正文已送达属于传输失败；按类型分支处理的调用方需要跟着改。

  **验证**

  - 本地：`pnpm -r typecheck`、`pnpm -r test`（7 个文件 / 68 条测试）全过。
  - 新增两条测试用**真实 undici fetch 打真实 HTTP server**，有无代理两种情况都断言线上字节是 `multipart/form-data` 且含 `name="document"`、`filename="a.txt"`、原始字节，并显式断言**不含** `[object FormData]`；把 `src/` 退回修改前，这两条按预期失败。

  ```sh
  npm i @contexera/dsh-channel-gateway@0.1.6
  ```

  <h3 id="en-v0-1-6">English</h3>

  **What changed**

  - Fixed a defect that stopped **every proxied deployment** from sending attachments: the adapter built its multipart body with the runtime's global `FormData` but sent it through this package's own `undici` fetch. When those are two different undici builds the fetch does not recognize the body and sends it as a plain string — the request that actually reached Telegram was a 17-byte `[object FormData]`, so the API answered `there is no document in the request`. `adapters/http.ts` now exports the `FormData` that pairs with the fetch and the telegram adapter builds multipart bodies with it; `proxyAwareFetch()` also always returns this package's fetch instead of switching between two fetches depending on whether a proxy variable is set.
  - A failed attachment no longer surfaces as a bare transport error: the text is already in the chat and cannot be taken back, so resending the whole message would duplicate it. The error now names the message the text was delivered as and which attachment failed, so a caller resends only the attachment. With no text delivered, the original error stands.

  **Compatibility**

  - The public contract is unchanged: `send()`'s signature, `ChannelSendResult`, routes and configuration keys all stay as they are.
  - Adds a `FormData` export (`adapters/http.ts`) — additive only.
  - The error **type** for a failed attachment changes from `ChannelGatewayError` to a plain `Error` (original kept as `cause`). `ChannelGatewayError` means "the caller's mistake" by its documented contract, while text-already-delivered is a transport failure; a caller branching on the type needs to follow.

  **Verification**

  - Local: `pnpm -r typecheck` and `pnpm -r test` (7 files / 68 tests) pass.
  - Two new tests drive a **real undici fetch against a real HTTP server** and assert the bytes on the wire: with and without a proxy configured the body must be `multipart/form-data` carrying `name="document"`, `filename="a.txt"` and the original bytes, and must explicitly **not** contain `[object FormData]`. Reverting `src/` to its previous state makes both fail as expected.

  ```sh
  npm i @contexera/dsh-channel-gateway@0.1.6
  ```

## 0.1.5

### Patch Changes

- [中文](#cn-v0-1-5) | [English](#en-v0-1-5)

  <h3 id="cn-v0-1-5">中文</h3>

  **改了什么**

  - 包名迁到 `@contexera/dsh-channel-gateway`；`@wowyuarm/dsh-channel-gateway` 停在 0.1.4，已标记废弃并指向新名。
  - 服务行自己的 `id`（`channel-gateway`）与配置键不变。按名字挂 adapter 的 profile 要把那几行的 `name:` 换成新名，子路径的形态不变：`@contexera/dsh-channel-gateway/telegram`、`@contexera/dsh-channel-gateway/weixin`。

  **兼容性**

  - 本包不声明 DSH peer，这条关系不变。
  - 没有数据迁移：适配器配置、会话与投递关系都不改形状。

  **验证**

  - 本地：`pnpm -r typecheck`、`pnpm -r test`（7 个文件 / 66 条测试）、`pnpm -r build` 全过，`check:peers` 通过。

  ```sh
  npm i @contexera/dsh-channel-gateway@0.1.5
  ```

  <h3 id="en-v0-1-5">English</h3>

  **What changed**

  - The package publishes as `@contexera/dsh-channel-gateway`; `@wowyuarm/dsh-channel-gateway` stays at 0.1.4 and is deprecated in favour of it.
  - The service row's own id (`channel-gateway`) and its configuration keys do not change. A profile that mounts adapters by name updates those `name:` lines to the new name; the subpaths keep their shape: `@contexera/dsh-channel-gateway/telegram`, `@contexera/dsh-channel-gateway/weixin`.

  **Compatibility**

  - This package declares no DSH peers; that relationship is unchanged.
  - Nothing migrates: adapter configuration, sessions and delivery relationships keep their shape.

  **Verification**

  - Local: `pnpm -r typecheck`, `pnpm -r test` (7 files / 66 tests) and `pnpm -r build` pass, and `check:peers` holds.

  ```sh
  npm i @contexera/dsh-channel-gateway@0.1.5
  ```

## 0.1.4

### Patch Changes

- Point the package repository metadata at the `dsh-plugins` monorepo, including the package directory.
