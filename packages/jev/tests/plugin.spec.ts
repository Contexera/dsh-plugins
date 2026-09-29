import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Config, apply, name } from '../src/index.ts'
import { JevError } from '../src/errors.ts'
import { Jev } from '../src/service.ts'
import { stubTransport, vendorAnswer } from './stub.ts'

/** Let a plugin's loading settle, as the service is registered by an async fiber. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('the dsh-jev plugin', () => {
  it('registers the service as ctx.jev, and removes it when the plugin is disposed', async () => {
    const stub = stubTransport(() => vendorAnswer({ type: 'noul', noul: 0.8 }))
    const ctx = new Context()
    const fiber = ctx.plugin(Jev, { apiKey: 'test-key', transport: stub.transport })
    await fiber

    await expect(ctx.jev.decide({ state: 'x', questions: { speak: { type: 'noul', instructions: 'speak?' } } }))
      .resolves.toMatchObject({ model: 'jev-1.13.0' })

    await fiber.dispose()

    expect(ctx.jev).toBeUndefined()
  })

  it('mounts the service through apply, which is the row a configuration file names', async () => {
    const ctx = new Context()

    apply(ctx, { apiKey: 'test-key' })
    await settle()

    expect(typeof ctx.jev.decide).toBe('function')
    expect(name).toBe('dsh-jev')
  })

  it('registers nothing when the configuration is unusable, rather than a service that could never answer', () => {
    const ctx = new Context()

    expect(() => new Jev(ctx, { apiKeyEnv: 'JEV_TEST_KEY_ABSENT' })).toThrow(JevError)
    expect(ctx.jev).toBeUndefined()
  })
})

describe('the plugin configuration schema', () => {
  it('accepts the documented fields and leaves the rest to the service defaults', () => {
    const config = Config({ model: 'jev-1.13.0', attempts: 2, apiKeyEnv: 'TYPESAFE_API_KEY' })

    expect(config.attempts).toBe(2)
    expect(config.model).toBe('jev-1.13.0')
    expect(config.timeoutMs).toBeUndefined()
  })

  it('rejects a value the service would refuse, at the row rather than at the first call', () => {
    expect(() => Config({ attempts: -1 })).toThrow()
    // A configuration file is untyped at runtime, so a wrong type reaches here as a string.
    expect(() => Config({ timeoutMs: 'soon' as never })).toThrow()
  })
})
