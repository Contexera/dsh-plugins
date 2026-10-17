/**
 * dsh-jev: Jev (TypeSafe System One) as one Cordis service.
 *
 * The plugin registers {@link Jev} as `ctx.jev`, and that is its whole surface:
 * one call, `ctx.jev.decide({ state, questions })`, which returns the vendor's
 * answers.
 * @module @contexera/dsh-jev
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  DEFAULT_API_BASE,
  DEFAULT_API_KEY_ENV,
  DEFAULT_ATTEMPTS,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_MODEL,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  Jev,
  type JevConfig,
} from './service.ts'

export const name = 'dsh-jev'

export type JevPluginConfig = Omit<JevConfig, 'transport'>

export const Config: Schema<JevPluginConfig> = Schema.object({
  apiBase: Schema.string().description(`Endpoint base; the call goes to this plus /systemone. Default: ${DEFAULT_API_BASE}`),
  model: Schema.string().description(`Model id sent with every call. Default: ${DEFAULT_MODEL} — a pinned version, not an alias.`),
  apiKey: Schema.string().role('secret').description('The API key itself. Prefer apiKeyEnv, which keeps the secret out of this file.'),
  apiKeyEnv: Schema.string().description(`Environment variable holding the API key. Default: ${DEFAULT_API_KEY_ENV}`),
  timeoutMs: Schema.natural().description(`How long one attempt may take, in milliseconds. Default: ${String(DEFAULT_TIMEOUT_MS)}`),
  attempts: Schema.natural().description(`How many attempts one call may take, the first included. Default: ${String(DEFAULT_ATTEMPTS)}`),
  retryDelayMs: Schema.natural().description(`Wait before the second attempt, in milliseconds; it doubles per further attempt. Default: ${String(DEFAULT_RETRY_DELAY_MS)}`),
  maxRetryDelayMs: Schema.natural().description(`Longest wait between attempts, in milliseconds. Default: ${String(DEFAULT_MAX_RETRY_DELAY_MS)}`),
})

export function apply(ctx: Context, config: JevPluginConfig): void {
  ctx.plugin(Jev, config)
}

export * from './contracts.ts'
export * from './errors.ts'
export * from './transport.ts'
export * from './service.ts'
