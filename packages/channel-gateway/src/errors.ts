import { inspect } from 'node:util'

export class ChannelGatewayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelGatewayError'
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return inspect(error, { breakLength: Infinity, compact: true, depth: 2 })
}
