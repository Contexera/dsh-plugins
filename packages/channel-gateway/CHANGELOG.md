# @contexera/dsh-channel-gateway

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
