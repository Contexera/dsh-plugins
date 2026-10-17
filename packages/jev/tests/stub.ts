import type { JevWireBody } from '../src/request.ts'
import type { JevTransport, JevTransportRequest, JevTransportResponse } from '../src/transport.ts'

/** One attempt a stub transport answered, with its body parsed back for assertions. */
export interface RecordedAttempt {
  readonly request: JevTransportRequest
  readonly body: JevWireBody
}

/** A scripted transport, and the attempts it answered. */
export interface StubTransport {
  /** The seam to inject as `transport`. */
  readonly transport: JevTransport
  /** Every attempt, in order. */
  readonly attempts: RecordedAttempt[]
  /** How many attempts have been made so far. */
  readonly count: () => number
}

export function stubTransport(
  respond: (attempt: number, request: JevTransportRequest) => JevTransportResponse | Promise<JevTransportResponse>,
): StubTransport {
  const attempts: RecordedAttempt[] = []
  const transport: JevTransport = async (request) => {
    attempts.push({ request, body: JSON.parse(request.body) as JevWireBody })
    return await respond(attempts.length, request)
  }
  return { transport, attempts, count: () => attempts.length }
}

export function stallingTransport(): JevTransport {
  return request =>
    new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => { reject(new Error('the attempt was aborted')) }, { once: true })
    })
}

/** One transport response carrying `payload` as its JSON body. */
export function answer(
  status: number,
  payload: unknown,
  headers: Readonly<Record<string, string>> = {},
): JevTransportResponse {
  return { status, headers, body: JSON.stringify(payload) }
}

/** A 200 carrying one answer to the question id `speak`, the vendor's envelope around it. */
export function vendorAnswer(answerBody: Readonly<Record<string, unknown>>): JevTransportResponse {
  return answer(200, { model: 'jev-1.13.0', answers: { speak: answerBody }, usage: { input_tokens: 12, output_tokens: 3 } })
}
