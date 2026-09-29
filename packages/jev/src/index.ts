/**
 * dsh-jev: Jev (TypeSafe System One) as one Cordis service.
 *
 * The plugin registers {@link Jev} as `ctx.jev`, and that is its whole surface:
 * one call, `ctx.jev.decide({ state, questions })`, which returns the vendor's
 * answers. It registers no tool, because its consumer asks for a judgement
 * while the main model is not running — an after-chat pass deciding whether to
 * speak — and a tool would require waking that model to ask for a decision that
 * this call answers directly. It holds no policy either: thresholds, gating and
 * posture belong to the consumer.
 *
 * The row carries everything a deployment may vary, including where the key
 * comes from. It carries no secret: name an environment variable with
 * `apiKeyEnv` and put the key there.
 * @module @wowyuarm/dsh-jev
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Jev, type JevConfig } from './service.ts'

export const name = 'dsh-jev'

/**
 * The plugin row's configuration: the deployment-varying half of
 * {@link JevConfig}. The transport is missing on purpose — it is a code seam a
 * test injects, not something a configuration file can carry.
 */
export type JevPluginConfig = Omit<JevConfig, 'transport'>

/** The configuration a `cordis.yml` row may set, with the same defaults the service applies. */
export const Config: Schema<JevPluginConfig> = Schema.object({
  apiBase: Schema.string().description('Endpoint base; the call goes to this plus /systemone. Default: https://api.typesafe.ai/v1'),
  model: Schema.string().description('Model id sent with every call. Default: jev-1.13.0 — a pinned version, not an alias.'),
  apiKey: Schema.string().role('secret').description('The API key itself. Prefer apiKeyEnv, which keeps the secret out of this file.'),
  apiKeyEnv: Schema.string().description('Environment variable holding the API key. Default: TYPESAFE_API_KEY'),
  timeoutMs: Schema.natural().description('How long one attempt may take, in milliseconds. Default: 30000'),
  attempts: Schema.natural().description('How many attempts one call may take, the first included. Default: 3'),
  retryDelayMs: Schema.natural().description('Wait before the second attempt, in milliseconds; it doubles per further attempt. Default: 500'),
  maxRetryDelayMs: Schema.natural().description('Longest wait between attempts, in milliseconds. Default: 30000'),
})

/**
 * Register the Jev service on this context.
 *
 * @param ctx — the context the service is registered on, as `ctx.jev`.
 * @param config — the row's configuration; every field has a documented default.
 */
export function apply(ctx: Context, config: JevPluginConfig): void {
  ctx.plugin(Jev, config)
}

export * from './contracts.ts'
export * from './errors.ts'
export * from './transport.ts'
export * from './service.ts'
