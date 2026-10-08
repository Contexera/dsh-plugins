# @contexera/dsh-channel-gateway

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
