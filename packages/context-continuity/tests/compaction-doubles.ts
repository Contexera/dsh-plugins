/**
 * Recording doubles for the compaction specs.
 *
 * The mechanism reads a meter and an engine through narrow ports, so the specs
 * drive it with doubles that record how it was called. They are shared rather
 * than repeated because both layers are asserted against the same ports: the
 * selection spec drives them directly, and the tool spec drives them through
 * `context_compact`.
 * @module
 */

import type { CompactionAgentContext, CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SubjectCompaction, SurfaceMeasurement, SurfaceMeter } from '../src/compaction.ts'

/** Every current surface node priced the same, as a routed meter prices text. */
export function priced(session: Session, tokensPerNode: number): SurfaceMeasurement {
  const nodes = session.surface.nodes
  return {
    totalTokens: nodes.length * tokensPerNode,
    nodes: nodes.map(seq => ({ seq, tokens: tokensPerNode })),
  }
}

export interface MeterSpy {
  readonly meter: SurfaceMeter
  /** Every session this meter was asked to price, in call order. */
  readonly sessions: Session[]
}

/** A meter answering with these measurements in order, repeating the last one. */
export function meterOf(...measurements: readonly (SurfaceMeasurement | undefined)[]): MeterSpy {
  const sessions: Session[] = []
  let asked = 0
  return {
    sessions,
    meter: {
      measure(session) {
        sessions.push(session)
        const answer = measurements[Math.min(asked, measurements.length - 1)]
        asked += 1
        return answer
      },
    },
  }
}

export interface EngineCall {
  readonly start: SessionSeq
  readonly end: SessionSeq
  /** The engine's own narrow agent context, which is what the port hands it. */
  readonly agent: CompactionAgentContext
  readonly signal: AbortSignal | undefined
}

export interface EngineSpy {
  readonly engine: SubjectCompaction
  readonly calls: EngineCall[]
}

/**
 * A recording engine. It answers with the span it was handed, or rejects with
 * the given failure after running `before` first — which is how a spec makes the
 * durable surface move before a failure, as an engine's committed progress
 * would. The mechanism reads exactly two fields of the result, so the rest is
 * not fabricated here.
 */
export function engineSpy(options: {
  readonly shadowedTokenCount?: number
  readonly fail?: string
  readonly before?: (session: Session, start: SessionSeq, end: SessionSeq) => void
} = {}): EngineSpy {
  const calls: EngineCall[] = []
  return {
    calls,
    engine: {
      async compactRegion(start, end, agent, signal) {
        calls.push({ start, end, agent, signal })
        options.before?.(agent.session, start, end)
        if (options.fail !== undefined) throw new Error(options.fail)
        return {
          shadowedSeqs: [start, end],
          shadowedTokenCount: options.shadowedTokenCount ?? 0,
        } as unknown as CompactionResult
      },
    },
  }
}
