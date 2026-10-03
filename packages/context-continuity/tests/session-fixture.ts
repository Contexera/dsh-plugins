/**
 * Live Sessions for the specs that read a context surface.
 *
 * These are real `Session.create` logs rather than hand-built event arrays: the
 * compaction selection reads the surface nodes, the derived history, and the
 * contract package's own tool-pairing balance, and only a real session folds
 * those the way production does. The recipe mirrors the Harness compaction
 * suite's own fixtures — closed turns followed by one open turn, because
 * `compactRegion` refuses to work outside a turn.
 * @module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  ToolCallId, createMessage, createSystemMessage, createToolResultMessage, createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

const MODEL = 'test-model'

/**
 * Closed user/assistant turns followed by one open turn, so the newest
 * instruction is on the surface and a compaction has an enclosing turn.
 *
 * With `system`, the log opens with a `system/message` at surface node 0, which
 * is the node no range may ever start on.
 */
export function conversation(options: { readonly turns?: number; readonly system?: string } = {}): Session {
  const turns = options.turns ?? 4
  const session = Session.create(SessionId(`conversation-${turns}-${options.system === undefined ? 'plain' : 'system'}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    if (turn === 1 && options.system !== undefined) {
      session.append('system/message', { turn, step: 1, message: createSystemMessage(options.system) }, { surfaceOp: 'append' })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/**
 * Three closed request/call/result turns, where each assistant message opens a
 * tool call and each `tool/result` is its own surface node — the shape whose
 * call/result pairs a compaction must never split.
 */
export function toolConversation(): Session {
  const session = Session.create(SessionId('tool-conversation'))
  for (let turn = 1; turn <= 3; turn += 1) {
    const callId = ToolCallId(`call-${turn}`)
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `request ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `calling ${turn}` },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
        ],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `result ${turn}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4 })
  return session
}

/**
 * The calling agent of one session. The specs hand this to the tools and to the
 * compaction mechanism, both of which read only the session off it.
 */
export function agentOn(session: Session): Agent {
  return { session } as Agent
}
