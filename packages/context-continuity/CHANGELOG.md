# @wowyuarm/dsh-context-continuity

## 0.1.6

### Patch Changes

- [中文](#cn-v0-1-6) | [English](#en-v0-1-6)
  
  <h3 id="cn-v0-1-6">中文</h3>
  
  适配 DeepSeek Harness `0.2.0-rc.1`。
  
  **改了什么**
  
  - **DSH 线整条搬到 `0.2.0-rc.1`**：七个 `@deepseek-ai/dsh-*` peer 现在声明 `>=0.2.0-rc.1 <0.2.1`，开发依赖钉在 `0.2.0-rc.1` —— 声明的那条线就是测试实跑的那条线。`@deepseek-ai/cordis` 仍是 `^4.0.1`，`dsh-session-query` 仍是可选 peer。
  - **不再跨世代解析**：引擎只声明这一条线，所以装在同一世代的宿主上时，会话包用宿主自己那一份，而不是把另一世代的 peer 拷贝嵌进安装树。
  - **npm 元数据指向 monorepo**：`repository` 现在指向 `wowyuarm/dsh-plugins` 的 `packages/context-continuity`。
  
  **兼容性**
  
  `src/` 与导出一个字节没动，宿主侧不用改代码。宿主仍停在 `0.1.7-rc.x` 时，npm 会报 peer 冲突告警，引擎作为依赖仍可安装。
  
  **验证**
  
  本地：`check:peers`、typecheck、boundaries、214/214 测试（7 个文件）、build 全绿，全部跑在钉住的 `0.2.0-rc.1` 上。
  
  ```
  npm i @wowyuarm/dsh-context-continuity@0.1.6
  ```
  
  <h3 id="en-v0-1-6">English</h3>
  
  Adapts to DeepSeek Harness `0.2.0-rc.1`.
  
  **What changed**
  
  - **The DSH line moved as a whole to `0.2.0-rc.1`**: the seven `@deepseek-ai/dsh-*` peers now declare `>=0.2.0-rc.1 <0.2.1`, pinned in devDependencies to `0.2.0-rc.1` — the line the tests actually run against. `@deepseek-ai/cordis` stays `^4.0.1` and `dsh-session-query` stays an optional peer.
  - **No more cross-generation resolution**: the engine declares this one line, so on a host of the same generation the session packages come from the host's own copy instead of another generation's peer copy nested inside the install tree.
  - **npm metadata points at the monorepo**: `repository` now points at `packages/context-continuity` of `wowyuarm/dsh-plugins`.
  
  **Compatibility**
  
  `src/` and the exports are untouched, so hosts need no code change. A host still on `0.1.7-rc.x` sees npm peer-conflict warnings; the engine still installs as a dependency.
  
  **Verification**
  
  Local: `check:peers`, typecheck, boundaries, 214/214 tests (7 files), and build all green, run against the pinned `0.2.0-rc.1`.
  
  ```
  npm i @wowyuarm/dsh-context-continuity@0.1.6
  ```
