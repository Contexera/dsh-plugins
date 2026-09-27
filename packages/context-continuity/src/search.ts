/**
 * Search and read across everything a subject is authorized to remember.
 *
 * The engine owns the ladder — a bounded ranked search, then one expanded
 * neighbourhood — and every rule that makes its answers trustworthy: the
 * authorized set is host-derived and the model can only *select* inside it, a
 * hit is folded to the generation that actually recorded it, the same inherited
 * experience is never presented twice, and a return anchor is offered only from
 * the shared policy in {@link anchor.ts}. The host owns mechanism and domain:
 * which Sessions a subject may reach ({@link SearchScopeProvider}), the query
 * capability (`ctx.sessionQuery` in a Team or Harness host), the fold
 * configuration, and the token meter.
 *
 * Two absences are deliberate. There is no second index and no engine-side
 * cache of history: every answer is read from the host's own corpus. And there
 * is no cursor, page size, session id, or event-type knob on the model surface
 * — a capped answer says so and asks for a narrower query, because paging a
 * model through raw rows is the failure mode this ladder exists to avoid.
 * @module @wowyuarm/dsh-context-continuity/search
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  SessionEventMetadataFilter,
  SessionEventResultFilter,
  SessionEventSearchDocument,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionEventSurface,
  SessionLogSnapshot,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { anchorCandidates, anchorRejection, retainedEstimate } from './anchor.ts'
import { contextRefFor } from './context-ref.ts'
import { foldContextProjection, type ContextProjectionConfig } from './projection.ts'
import type { ContextProjectionState } from './projection-state.ts'
import { DEFAULT_TIMELINE_ANCESTORS, type ContextTimelineSource } from './timeline.ts'

/** How many canonical hits one search presents. */
export const CONTEXT_SEARCH_RESULT_LIMIT = 8

/** How many preceding events one context read expands around its target. */
export const CONTEXT_READ_BEFORE = 4

/** How many following events one context read expands around its target. */
export const CONTEXT_READ_AFTER = 6

/** The render budget for one expanded event: a longer one is excerpted and says so. */
export const CONTEXT_READ_EVENT_CHARS = 1200

/**
 * The query capability the engine uses, and nothing more of it: the Harness
 * session-query service satisfies this structurally, so a host passes
 * `ctx.sessionQuery` unchanged. Only the four reads the ladder needs are named.
 */
export interface ContextSearchPort {
  /** Cross-Session full-text search, one ranked strongest match per Session. */
  searchSessions(request: SessionSearchRequest, exec?: SessionSearchExecContext): Promise<SessionSearchPage<SessionSearchHit>>
  /** Within-Session full-text search: several ranked matches from one generation. */
  searchEvents(request: SessionEventSearchRequest, exec?: SessionSearchExecContext): Promise<SessionEventSearchPage>
  /** Every event of one Session in one seq range, with its semantic text and folded surface. */
  filterEvents(sessionId: SessionId, filters: readonly SessionEventResultFilter[]): Promise<SessionEventSearchDocument[]>
  /** One complete logical Session log plus the identity the fold keys on. */
  readSession(sessionId: SessionId): Promise<SessionLogSnapshot>
}

/** One named scope a host offers: the model may select it, never define it. */
export interface SearchScopeOption {
  readonly scopeId: string
  readonly label: string
}

/**
 * Which Sessions a subject may search, answered by the host from subject
 * identity alone. The engine knows no workspace, team, or project: a named
 * scope is opaque here, and a model-supplied `scopeId` can only select among
 * what this provider already offered.
 */
export interface SearchScopeProvider<SubjectId> {
  /** The default range: every Session the subject itself ever lived in. */
  ownedSessions(subject: SubjectId): readonly SessionId[] | Promise<readonly SessionId[]>
  /** The named scopes the subject may search, or absent when the host has none. */
  availableScopes?(subject: SubjectId): readonly SearchScopeOption[] | Promise<readonly SearchScopeOption[]>
  /** Resolve a scope the model selected into the Sessions it authorizes. */
  sessionsInScope?(subject: SubjectId, scopeId: string): readonly SessionId[] | Promise<readonly SessionId[]>
}

/** The scope a search actually ran against, as reported back to the model. */
export type ContextSearchScope =
  | { readonly kind: 'owned' }
  | { readonly kind: 'named'; readonly scopeId: string; readonly label: string }

/**
 * Everything the search tools need from a host. Every member is per-exec: one
 * factory serves every subject a host runs, so identity, the current
 * generation, the meter, and the budget are resolved at call time.
 */
export interface ContextSearchAdapter<SubjectId> {
  /** The subject whose authorized history is searched. */
  subject(exec: ToolRunContext): SubjectId | Promise<SubjectId>
  /** The generation the subject lives in now: where the active lineage starts. */
  activeSessionId(exec: ToolRunContext): SessionId | Promise<SessionId>
  /** Which Sessions that subject may ever search. */
  scope: SearchScopeProvider<SubjectId>
  /** The query capability, e.g. the host's `ctx.sessionQuery`. */
  query: ContextSearchPort
  /** The fold configuration shared with the registered projection unit. */
  config: ContextProjectionConfig
  /** One source's replayed measurement; absent means no meter exists. */
  measureSource?(source: ContextTimelineSource, exec: ToolRunContext): number | undefined | Promise<number | undefined>
  /** The retained-context budget above which a return anchor stops being worth selecting. */
  handoffAt(exec: ToolRunContext): number | Promise<number>
  /** How many archived ancestors the active-lineage walk follows. */
  maxAncestors?: number
}

/** One bounded search over the subject's authorized history. */
export interface ContextSearchRequest {
  readonly exec: ToolRunContext
  /** Full-text query; the provider interprets it as data, never as FTS syntax. */
  readonly query: string
  /** Search only this generation deeply, instead of every authorized generation. */
  readonly within?: SessionId
  /** Inclusive lower time bound, in epoch milliseconds. */
  readonly after?: number
  /** Inclusive upper time bound, in epoch milliseconds. */
  readonly before?: number
  /** A named scope the host offered, or absent for the subject's own history. */
  readonly scope?: string
}

/** Where a remembered event's generation sits relative to the active lineage. */
export type ContextHitGeneration = 'current' | 'prior' | 'archived'

/**
 * The return anchor one hit carries: a ref `context_rollover` may accept, or
 * the reason no prefix of that history would contain the hit. An unavailable
 * anchor is never a synthesized ref.
 */
export type ContextHitAnchor =
  | { readonly available: true; readonly ref: string; readonly label: string }
  | { readonly available: false; readonly reason: string }

/** One remembered event, canonicalized to the generation that recorded it. */
export interface ContextSearchHit {
  /** Opaque ref for `context_read`; it carries no authority of its own. */
  readonly contextRef: string
  readonly generation: ContextHitGeneration
  /** The Session that actually recorded the event, not a generation inheriting it. */
  readonly sessionId: SessionId
  readonly seq: number
  readonly eventType: string
  /** ISO 8601 UTC. */
  readonly time: string
  /** The provider's own surface verdict for the matched event. */
  readonly surface: SessionEventSurface
  /** The provider's bounded excerpt around the match. */
  readonly snippet: string
  readonly anchor: ContextHitAnchor
}

/** What one search did not present, and why — never a silent omission. */
export interface ContextSearchDrops {
  /** Hits folded into an entry already presented: the same experience, once. */
  readonly duplicate: number
  /** Hits whose generation or own span could not be resolved and read. */
  readonly incomplete: number
  /** Hits the provider returned outside the authorized set; never presented. */
  readonly outOfScope: number
}

/** One bounded, deduplicated search answer. */
export interface ContextSearchResult {
  readonly query: string
  readonly scope: ContextSearchScope
  /** Every named scope the host offers this subject, so a search need not guess. */
  readonly availableScopes: readonly SearchScopeOption[]
  readonly hits: readonly ContextSearchHit[]
  readonly dropped: ContextSearchDrops
  /** Whether the provider holds more matching generations than this answer presents. */
  readonly capped: boolean
  /** Set when the active lineage could not be walked past one generation. */
  readonly lineageIncompleteAt?: { readonly sessionId: SessionId; readonly reason: string }
}

/** One expanded event of a neighbourhood. */
export interface ContextReadEvent {
  readonly seq: number
  readonly type: string
  readonly time: string
  readonly surface: SessionEventSurface
  /** Whether this is the event the ref named. */
  readonly target: boolean
  readonly text: string
  /** Whether the text was excerpted at the engine's own render budget. */
  readonly truncated: boolean
}

/** One remembered event expanded into its bounded neighbourhood. */
export interface ContextReadResult {
  readonly sessionId: SessionId
  readonly seq: number
  readonly generation: ContextHitGeneration
  readonly eventType: string
  readonly time: string
  readonly surface: SessionEventSurface
  readonly events: readonly ContextReadEvent[]
  readonly anchor: ContextHitAnchor
}

/** Read one remembered event and its bounded neighbourhood. */
export interface ContextReadRequest {
  readonly exec: ToolRunContext
  /** The Session named by a decoded `contextRef`. */
  readonly sessionId: SessionId
  readonly seq: number
}

/** One source read: the generation's log plus the fold every answer is read from. */
interface ContinuitySource {
  readonly source: ContextTimelineSource
  readonly state: ContextProjectionState
}

type SourceRead = { readonly ok: true; readonly value: ContinuitySource } | { readonly ok: false; readonly reason: string }

/** One provider hit, before the engine decides where it really came from. */
type ProviderHit = {
  readonly sessionId: SessionId
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly surface: SessionEventSurface
  readonly snippet: string
}

/** One hit folded to its canonical source. */
type CanonicalHit = {
  readonly ok: true
  /** The generation that recorded the event. */
  readonly sessionId: SessionId
  readonly seq: number
  /** The matched generation, when the match turned out to be an inherited event. */
  readonly foldedFrom?: SessionId
  /** Where the matched generation's own span begins, for the own-span retry. */
  readonly ownSpanFrom: number
} | { readonly ok: false; readonly reason: string }

/** One message a model may read: never a stack, never an unbounded provider dump. */
function describeFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim()
  if (message === '') return 'no reason given'
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

/**
 * Per-call Session access: one read and one measurement per generation, shared
 * by the provenance walk, the active-lineage walk, and enrichment, so every
 * answer about one generation comes from one observation of it.
 */
interface SessionAccess {
  source(sessionId: SessionId): Promise<SourceRead>
  usage(source: ContextTimelineSource): Promise<number | undefined>
}

function sessionAccess<SubjectId>(adapter: ContextSearchAdapter<SubjectId>, exec: ToolRunContext): SessionAccess {
  const reads = new Map<string, Promise<SourceRead>>()
  const usage = new Map<string, Promise<number | undefined>>()
  return {
    source(sessionId) {
      const cached = reads.get(String(sessionId))
      if (cached !== undefined) return cached
      const pending = (async (): Promise<SourceRead> => {
        try {
          const snapshot = await adapter.query.readSession(sessionId)
          const source: ContextTimelineSource = {
            sessionId,
            header: snapshot.session,
            inheritedEventCount: snapshot.inheritedEventCount,
            events: snapshot.events,
          }
          return {
            ok: true,
            value: {
              source,
              state: foldContextProjection(source.events, adapter.config, {
                sessionId,
                inheritedEventCount: Number(source.inheritedEventCount),
              }),
            },
          }
        } catch (error) {
          return { ok: false, reason: describeFailure(error) }
        }
      })()
      reads.set(String(sessionId), pending)
      return pending
    },
    usage(source) {
      const cached = usage.get(String(source.sessionId))
      if (cached !== undefined) return cached
      const pending = (async (): Promise<number | undefined> => {
        if (adapter.measureSource === undefined) return undefined
        try {
          const measured = await adapter.measureSource(source, exec)
          return typeof measured === 'number' && Number.isFinite(measured) ? measured : undefined
        } catch {
          // An unmeasured source is not a free one: the anchor policy refuses it.
          return undefined
        }
      })()
      usage.set(String(source.sessionId), pending)
      return pending
    },
  }
}

/** The active lineage of one subject: the generations a return could enter. */
interface ActiveLineage {
  readonly activeSessionId: SessionId
  /** Session id to distance from the current generation; nearest is `0`. */
  readonly depth: ReadonlyMap<string, number>
  readonly incompleteAt?: { readonly sessionId: SessionId; readonly reason: string }
}

/**
 * Walk from the current generation through `parentSession`, bounded. A
 * generation that cannot be read ends the walk loudly: everything beyond it is
 * unknown, and an unknown generation must never be offered as a return target.
 */
async function activeLineage<SubjectId>(
  adapter: ContextSearchAdapter<SubjectId>,
  access: SessionAccess,
  exec: ToolRunContext,
  maxAncestors: number,
): Promise<ActiveLineage> {
  const activeSessionId = await adapter.activeSessionId(exec)
  const depth = new Map<string, number>()
  let id: SessionId | undefined = activeSessionId
  for (let walked = 0; id !== undefined && walked <= maxAncestors; walked += 1) {
    depth.set(String(id), walked)
    const read = await access.source(id)
    if (!read.ok) return { activeSessionId, depth, incompleteAt: { sessionId: id, reason: read.reason } }
    id = read.value.source.header.parentSession
  }
  return { activeSessionId, depth }
}

/** Which generation one canonical source is, seen from the active lineage. */
function generationOf(sessionId: SessionId, lineage: ActiveLineage): ContextHitGeneration {
  if (String(sessionId) === String(lineage.activeSessionId)) return 'current'
  return lineage.depth.has(String(sessionId)) ? 'prior' : 'archived'
}

/**
 * Fold one provider hit to the generation that recorded it. A seeded generation
 * inherits its source's events at the same seqs, so an inherited hit is
 * canonicalized by following `parentSession` while the seq stays below that
 * generation's own start; deduplicating on the canonical source is what makes
 * one experience appear once across a lineage.
 */
async function canonicalSource(
  access: SessionAccess,
  sessionId: SessionId,
  seq: number,
  maxAncestors: number,
): Promise<CanonicalHit> {
  const first = await access.source(sessionId)
  if (!first.ok) return { ok: false, reason: first.reason }
  const ownSpanFrom = Number(first.value.source.inheritedEventCount)

  let id = sessionId
  let at = seq
  for (let depth = 0; depth <= maxAncestors; depth += 1) {
    const read = depth === 0 ? first : await access.source(id)
    if (!read.ok) return { ok: false, reason: read.reason }
    if (at >= Number(read.value.source.inheritedEventCount)) {
      return {
        ok: true,
        sessionId: id,
        seq: at,
        ownSpanFrom,
        ...(String(id) === String(sessionId) ? {} : { foldedFrom: sessionId }),
      }
    }
    const parent = read.value.source.header.parentSession
    // An inherited prefix with no parent to attribute it to is the log's own
    // claim about its history; take the claim at face value rather than guess.
    if (parent === undefined) {
      return {
        ok: true,
        sessionId: id,
        seq: at,
        ownSpanFrom,
        ...(String(id) === String(sessionId) ? {} : { foldedFrom: sessionId }),
      }
    }
    id = parent
  }
  return {
    ok: true,
    sessionId: id,
    seq: at,
    ownSpanFrom,
    ...(String(id) === String(sessionId) ? {} : { foldedFrom: sessionId }),
  }
}

/** The event predicates one search's time window compiles to. */
function timeFilters(after: number | undefined, before: number | undefined): readonly SessionEventMetadataFilter[] {
  if (after === undefined && before === undefined) return []
  return [{ kind: 'time', ...(after === undefined ? {} : { from: after }), ...(before === undefined ? {} : { to: before }) }]
}

/**
 * The authorized set of one search, or a refusal: an empty set never means "all
 * of them". A blank id is dropped rather than searched for.
 */
function authorizedIds(ids: readonly SessionId[], what: string): readonly SessionId[] {
  const unique: SessionId[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const key = String(id)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    unique.push(id)
  }
  if (unique.length === 0) {
    throw new Error(`context search has no authorized Session for ${what}; authorization comes from the host, and an empty set fails closed instead of searching everything`)
  }
  return unique
}

/** One resolved scope: the Sessions it authorizes and how to describe it. */
interface ResolvedScope {
  readonly ids: readonly SessionId[]
  readonly idSet: ReadonlySet<string>
  readonly scope: ContextSearchScope
  readonly availableScopes: readonly SearchScopeOption[]
}

async function resolveScope<SubjectId>(
  adapter: ContextSearchAdapter<SubjectId>,
  subject: SubjectId,
  scopeId: string | undefined,
): Promise<ResolvedScope> {
  const availableScopes = adapter.scope.availableScopes === undefined ? [] : await adapter.scope.availableScopes(subject)
  if (scopeId === undefined) {
    const owned = authorizedIds(await adapter.scope.ownedSessions(subject), 'the subject\'s own history')
    return { ids: owned, idSet: new Set(owned.map(String)), scope: { kind: 'owned' }, availableScopes }
  }
  const offered = availableScopes.find(option => option.scopeId === scopeId)
  if (offered === undefined) {
    const listing = availableScopes.length === 0
      ? 'no named scope is offered for this subject'
      : `offered scopes: ${availableScopes.map(option => `${option.label} (${option.scopeId})`).join(', ')}`
    throw new Error(`context_search scope ${scopeId} is not a scope this subject may search; ${listing}`)
  }
  if (adapter.scope.sessionsInScope === undefined) {
    throw new Error(`context_search scope ${scopeId} is offered but cannot be resolved: the host offers named scopes without implementing sessionsInScope`)
  }
  const ids = authorizedIds(await adapter.scope.sessionsInScope(subject, scopeId), `scope ${scopeId}`)
  return {
    ids,
    idSet: new Set(ids.map(String)),
    scope: { kind: 'named', scopeId, label: offered.label },
    availableScopes,
  }
}

/**
 * Everything the host authorizes this subject to read: its own history plus
 * every offered scope. A read takes no scope parameter, so it has to accept a
 * ref that a scoped search legitimately returned; the union is still entirely
 * host-derived, and the model can neither name it nor widen it.
 */
async function readAuthorizedSessions<SubjectId>(
  adapter: ContextSearchAdapter<SubjectId>,
  subject: SubjectId,
): Promise<ReadonlySet<string>> {
  const ids = [...await adapter.scope.ownedSessions(subject)]
  if (adapter.scope.availableScopes !== undefined && adapter.scope.sessionsInScope !== undefined) {
    for (const option of await adapter.scope.availableScopes(subject)) {
      ids.push(...await adapter.scope.sessionsInScope(subject, option.scopeId))
    }
  }
  const set = new Set(ids.map(String))
  set.delete('')
  if (set.size === 0) {
    throw new Error('context read has no authorized Session for this subject; authorization comes from the host, and an empty set fails closed')
  }
  return set
}

/**
 * The nearest return anchor for one remembered event, or why there is none.
 * Only a generation on the active lineage can be entered again, and only from
 * an anchor whose completed turn actually contains the hit — otherwise the seed
 * would not include the experience the model asked to return to.
 */
async function returnAnchorFor<SubjectId>(
  adapter: ContextSearchAdapter<SubjectId>,
  access: SessionAccess,
  generation: ContextHitGeneration,
  sessionId: SessionId,
  seq: number,
  handoffAt: number,
): Promise<ContextHitAnchor> {
  if (generation === 'archived') {
    return {
      available: false,
      reason: 'the generation holding this hit is not on the active lineage; an abandoned branch is searchable but is not a return target',
    }
  }
  const read = await access.source(sessionId)
  if (!read.ok) return { available: false, reason: `the source Session could not be read (${read.reason})` }
  const after = anchorCandidates(read.value.state, adapter.config.host, false)
    .filter(candidate => candidate.turnEndSeq >= seq)
    .sort((a, b) => a.turnEndSeq - b.turnEndSeq || a.seq - b.seq)
  if (after.length === 0) {
    return { available: false, reason: 'no anchor on that generation ends at or after the hit, so no return prefix would contain it' }
  }
  const sourceUsage = await access.usage(read.value.source)
  let nearestRejection: string | undefined
  for (const candidate of after) {
    const retained = retainedEstimate(sourceUsage ?? 0, read.value.source.events.length, candidate.turnEndSeq)
    const rejection = anchorRejection(candidate, retained, sourceUsage, handoffAt)
    if (rejection === undefined) return { available: true, ref: candidate.ref, label: candidate.label }
    nearestRejection ??= rejection
  }
  return { available: false, reason: nearestRejection ?? 'no restorable anchor exists after this hit' }
}

/**
 * Search one subject's authorized history: ranked, canonicalized, deduplicated,
 * bounded, and enriched with a return anchor only where the shared policy
 * proves one.
 */
export async function searchContext<SubjectId>(
  adapter: ContextSearchAdapter<SubjectId>,
  request: ContextSearchRequest,
): Promise<ContextSearchResult> {
  const exec = request.exec
  const subject = await adapter.subject(exec)
  const resolved = await resolveScope(adapter, subject, request.scope)
  const access = sessionAccess(adapter, exec)
  const maxAncestors = Math.max(0, Math.trunc(adapter.maxAncestors ?? DEFAULT_TIMELINE_ANCESTORS))
  const handoffAt = await adapter.handoffAt(exec)
  // The lineage is walked only once a hit has survived scope and provenance: an
  // answer with nothing to label or enrich must not pay for the walk.
  let walked: Promise<ActiveLineage> | undefined
  const lineage = (): Promise<ActiveLineage> =>
    walked ??= activeLineage(adapter, access, exec, maxAncestors)

  const eventFilters = timeFilters(request.after, request.before)
  const hits: ContextSearchHit[] = []
  const seen = new Set<string>()
  const dropped = { duplicate: 0, incomplete: 0, outOfScope: 0 }
  let capped = false

  /** Canonicalize one provider hit and keep it when it is an experience not yet shown. */
  async function admit(raw: ProviderHit): Promise<CanonicalHit> {
    if (!resolved.idSet.has(String(raw.sessionId))) {
      dropped.outOfScope += 1
      return { ok: false, reason: 'the hit is outside the authorized set' }
    }
    const canonical = await canonicalSource(access, raw.sessionId, raw.seq, maxAncestors)
    if (!canonical.ok) {
      dropped.incomplete += 1
      return canonical
    }
    const key = `${String(canonical.sessionId)}:${canonical.seq}`
    if (seen.has(key)) {
      dropped.duplicate += 1
      return canonical
    }
    seen.add(key)
    const generation = generationOf(canonical.sessionId, await lineage())
    hits.push({
      contextRef: contextRefFor(canonical.sessionId, SessionSeq(canonical.seq)),
      generation,
      sessionId: canonical.sessionId,
      seq: canonical.seq,
      eventType: String(raw.type),
      time: new Date(raw.time).toISOString(),
      surface: raw.surface,
      snippet: raw.snippet,
      anchor: await returnAnchorFor(adapter, access, generation, canonical.sessionId, canonical.seq, handoffAt),
    })
    return canonical
  }

  const within = request.within
  if (within !== undefined) {
    if (!resolved.idSet.has(String(within))) {
      throw new Error(`context_search within ${within} names a Session outside the authorized history being searched; copy a contextRef from a hit in the scope you are searching`)
    }
    const read = await access.source(within)
    if (!read.ok) throw new Error(`context_search within ${within} could not be read: ${read.reason}`)
    // Deep-searching one generation means its own span: its inherited prefix is
    // another generation's history, already covered by the broad search and
    // attributed there by provenance folding.
    const page = await providerCall(() => adapter.query.searchEvents({
      sessionId: within,
      query: request.query,
      filters: [
        { kind: 'seq', from: Number(read.value.source.inheritedEventCount) },
        ...eventFilters,
      ],
      limit: CONTEXT_SEARCH_RESULT_LIMIT,
    }, { signal: exec.signal }))
    capped = page.nextCursor !== undefined
    for (const hit of page.items) {
      if (hits.length >= CONTEXT_SEARCH_RESULT_LIMIT) {
        capped = true
        break
      }
      await admit(hit)
    }
  } else {
    const page = await providerCall(() => adapter.query.searchSessions({
      query: request.query,
      sessionFilters: [{ kind: 'id', values: resolved.ids }],
      ...(eventFilters.length === 0 ? {} : { eventFilters }),
      limit: CONTEXT_SEARCH_RESULT_LIMIT,
    }, { signal: exec.signal }))
    capped = page.nextCursor !== undefined
    for (const item of page.items) {
      if (hits.length >= CONTEXT_SEARCH_RESULT_LIMIT) {
        capped = true
        break
      }
      const canonical = await admit(item.bestMatch)
      // A generation whose strongest match is inherited still gets its own later
      // experience represented, rather than being swallowed by its ancestor's.
      if (canonical.ok && canonical.foldedFrom !== undefined && hits.length < CONTEXT_SEARCH_RESULT_LIMIT) {
        try {
          const own = await adapter.query.searchEvents({
            sessionId: canonical.foldedFrom,
            query: request.query,
            filters: [
              { kind: 'seq', from: canonical.ownSpanFrom },
              ...eventFilters,
            ],
            limit: 1,
          }, { signal: exec.signal })
          for (const hit of own.items) await admit(hit)
        } catch {
          dropped.incomplete += 1
        }
      }
    }
  }

  const resolvedLineage = walked === undefined ? undefined : await walked
  return {
    query: request.query,
    scope: resolved.scope,
    availableScopes: resolved.availableScopes,
    hits,
    dropped,
    capped,
    ...(resolvedLineage?.incompleteAt === undefined ? {} : { lineageIncompleteAt: resolvedLineage.incompleteAt }),
  }
}

/** One provider call whose failure reaches the model as a readable sentence. */
async function providerCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new Error(`context search could not run: ${describeFailure(error)}`)
  }
}

/**
 * Expand one remembered event into its bounded neighbourhood. The ref is
 * revalidated against the host's authorization on every call, the target is
 * always present, and the window is the engine's own budget — the model never
 * guesses raw event counts.
 */
export async function readContextHit<SubjectId>(
  adapter: ContextSearchAdapter<SubjectId>,
  request: ContextReadRequest,
): Promise<ContextReadResult> {
  const exec = request.exec
  const subject = await adapter.subject(exec)
  const authorized = await readAuthorizedSessions(adapter, subject)
  if (!authorized.has(String(request.sessionId))) {
    throw new Error(`context_read names Session ${request.sessionId}, which is not part of the history this subject may read`)
  }

  const access = sessionAccess(adapter, exec)
  const maxAncestors = Math.max(0, Math.trunc(adapter.maxAncestors ?? DEFAULT_TIMELINE_ANCESTORS))
  const lineage = await activeLineage(adapter, access, exec, maxAncestors)

  const from = Math.max(0, request.seq - CONTEXT_READ_BEFORE)
  const to = request.seq + CONTEXT_READ_AFTER
  let documents: readonly SessionEventSearchDocument[]
  try {
    documents = await adapter.query.filterEvents(request.sessionId, [{ kind: 'seq', from, to }])
  } catch (error) {
    throw new Error(`context_read could not read Session ${request.sessionId}: ${describeFailure(error)}`)
  }
  const target = documents.find(document => Number(document.seq) === request.seq)
  if (target === undefined) {
    throw new Error(`context_read: seq ${request.seq} is not in Session ${request.sessionId}'s current log; the ref may predate a compaction or come from another engine`)
  }

  const generation = generationOf(request.sessionId, lineage)
  return {
    sessionId: request.sessionId,
    seq: request.seq,
    generation,
    eventType: String(target.type),
    time: new Date(target.time).toISOString(),
    surface: target.surface,
    events: documents.map((document) => {
      const truncated = document.text.length > CONTEXT_READ_EVENT_CHARS
      return {
        seq: Number(document.seq),
        type: String(document.type),
        time: new Date(document.time).toISOString(),
        surface: document.surface,
        target: Number(document.seq) === request.seq,
        text: truncated ? `${document.text.slice(0, CONTEXT_READ_EVENT_CHARS)}…` : document.text,
        truncated,
      }
    }),
    anchor: await returnAnchorFor(adapter, access, generation, request.sessionId, request.seq, await adapter.handoffAt(exec)),
  }
}
