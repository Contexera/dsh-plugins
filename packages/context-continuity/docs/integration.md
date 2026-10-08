# Integration guide — how a host adopts context continuity

This guide is for a **host** author: a plugin that wants a durable subject to
live one continuous context across many physical Sessions. The Agent Team is
one host (its subject is a Member); a single-Individual harness like Loom is
another (its subject is the Individual); a long-running coding agent is its own
single subject.

The engine owns the universal mechanics — the idle-boundary generation swap,
the admission gate, carried input, checkpoint continuations, the projection
fold, the lineage walk, the shared return-anchor policy, the model-facing tools
with their validation, the bounded retrieval ladder, and the pressure policy
(including the long-gap gate). It
knows nothing about what your subject is or what your domain treats as
meaningful. You supply exactly that, through the seams below.

## Seams

Every seam below is **shipped**: implemented and unit-tested in this package.

| Seam | Status |
| --- | --- |
| Subject identity | shipped |
| Message codec | shipped |
| Projection (`ContextProjectionHost` + fold unit) | shipped |
| Coordinator (`ContextContinuityHost`) | shipped |
| Timeline read (`readContextTimeline`) | shipped |
| Tools factory (`createContinuityTools`) | shipped |
| Retrieval ladder (`createSearchTools`, `SearchScopeProvider`) | shipped |
| Pressure policy (`ContextPressurePolicy`) | shipped |
| Long-gap gate (`relatednessFor` + `judgeFor`, optional) | shipped |
| Compaction backend (`ContinuityCompactionEngine`, optional) | shipped |

Everything a host reaches for is exported from the package root
(`@contexera/dsh-context-continuity`). The one exception is the compaction
backend, which is **also** reachable as the subpath
`@contexera/dsh-context-continuity/compaction-engine` so a preset can mount it by
name (seam 10).

## The one-paragraph model

A **subject** is a durable identity with, at any moment, one bound Session
generation. When context fills or the model asks, the subject *rolls over*:
the engine prepares a `TransitionPlan`, the host performs the swap in its own
lifecycle, and the subject continues in a fresh Session seeded by a handoff.
A **checkpoint** records a restorable anchor; a **timeline** walks the subject's
Session lineage (`parentSession` chain) as one continuous history; **search**
recalls across the sessions the host authorizes. Every durable fact lives in
the Session log; the engine derives, never stores a second copy.

## Seam 1 — subject identity (shipped)

Pick the id type your domain already has, and describe a subject as its id plus
the Session it is bound to right now.

```ts
import type { ContextSubject } from '@contexera/dsh-context-continuity'

type SubjectId = AgentTeamMemberId          // Team
// type SubjectId = IndividualId            // Loom (one value, always the same)

// A subject the engine reads: nothing more than id + current sessionId.
const subject: ContextSubject<SubjectId> = { id, sessionId }
```

The engine reads nothing else off a subject. Roles, workspaces, memory paths,
team membership all stay on the host side.

## Seam 2 — message codec (shipped)

The codec writes and reads the durable handoff and checkpoint-continuation
messages, through the shipped `plugin` snapshot form. Construct it once.

```ts
import { ContextMessageCodec } from '@contexera/dsh-context-continuity'

const codec = new ContextMessageCodec({
  pluginId: '@wowyuarm/dsh-agent-team',                              // your plugin's stable id
  handoffIntro: 'Context handoff: you are continuing as the same Team Member…',
  handoffVerifyNote: 'Your handoff follows. Verify external state before relying on it…',
})
```

Only `pluginId` and the two prose lines are yours. **Section names are fixed
by the engine** — a host that changed them could not decode its own history.

> **Durable identity — never change after first ship:** `pluginId` is written
> into every handoff/continuation message's `source.plugin` and matched on read.
> Change it and every past generation's messages become unreadable.

## Seam 3 — projection (shipped)

The projection folds one Session's continuity state from its log. The engine
owns the universal structure (checkpoints, pending rollover, continuation
delivery, carry candidates, open calls, turn cursors). You contribute only your
domain's ref naming and your timeline anchors, through `ContextProjectionHost`.

```ts
import { createContextProjectionDefinition, type ContextProjectionHost } from '@contexera/dsh-context-continuity'

const projectionHost: ContextProjectionHost = {
  // Durable, collision-resistant refs. Two Sessions repeating one provider
  // call id MUST produce two distinct refs — key on the Session id.
  checkpointRefFor: (sessionId, toolCallId) => `${sessionId}:ckpt:${sha(toolCallId)}`,
  boundaryRefFor:   (sessionId, seq)        => `${sessionId}:b:${seq}`,

  // Which of YOUR effect calls may anchor a boundary on success. The engine
  // already tracks its own rollover/checkpoint calls; omit if you have none.
  tracksCall: (name) => name === 'team_message' || name === 'team_claim',

  // Your timeline anchor for one event, or undefined when it anchors nothing.
  // Team: a committed message / claim change / a Thread's FIRST arrival.
  // Loom: a committed Input / Effect / Delivery fact.
  domainBoundaryOf: (input) => {
    // input.seenTopics lets you decide what a *first* arrival is in your terms.
    if (/* input is a first thread arrival */ false) {
      return { kind: 'team_thread_arrival', label: 'First arrival: …', topics: [threadId] }
    }
    return undefined
  },

  isEphemeralNotice: (message) => /* your domain's transient notices */ false,
}
```

Register the fold with the Harness projection framework, which owns the drive
(replay, incremental application, persistence, invalidation):

```ts
import { createContextProjectionDefinition } from '@contexera/dsh-context-continuity'

// Register ONCE for the whole host — not once per Session. The framework keeps
// one unit per projection key, and this engine's state carries the Session
// identity it folded.
ctx.sessionProjections.register(createContextProjectionDefinition({
  codec, host: projectionHost,
  // Fold a legacy tool alias too, if your history carries one:
  rolloverToolNames: ['context_rollover', 'new_context'],
}))
```

One registration serves every Session, seeded successors included. `init` reads
the header and records the Session id and its fork-inherited prefix length in
the state; `apply` skips events below that cut, returning the same state
reference; every ref is keyed by the state's own Session. A generation that
folded its inherited prefix would re-key its ancestor's checkpoints under its
own id — refs the ancestor's log does not know — and re-derive the ancestor's
completed rollover intent as its own pending swap.

The coordinator reads this state back through `host.projectionForSubject` — you
may return the framework's folded state, or fold by hand with
`foldContextProjection(events, config, { sessionId, inheritedEventCount })`.
Both converge on one value (cold == live).

**Anchor policy the engine owns:** a boundary is a selectable default return
anchor exactly when it resolved at a completed turn and is attributable to
exactly one topic. What a *topic* is (`attributions`) is your call — a Thread,
a continuity line, a repo. Multi-topic or mid-turn boundaries are searchable
evidence but not default return targets.

## Seam 4 — coordinator (shipped)

Implement `ContextContinuityHost<SubjectId>` and drive the coordinator from your
Session-event dispatch.

```ts
import { ContextContinuityCoordinator, type ContextContinuityHost } from '@contexera/dsh-context-continuity'

const host: ContextContinuityHost<SubjectId> = {
  agentForSubject:   (id) => handles.get(id)?.agent,
  subjectForAgent:   (agent) => resolveSubject(agent),           // → { id, sessionId } | undefined
  projectionForSubject: (id, sid) => readFoldedState(id, sid),   // from seam 3
  executeTransition: (id, plan) => performSwap(id, plan),        // see contract below
  rolloverIdentity:  (prevSessionId, toolCallId) => ({           // durable naming — yours
    newSessionId: `myhost-rollover-${sha([prevSessionId, toolCallId])}`,
    requestId:    `myhost:rollover:${sha([prevSessionId, toolCallId])}`,
  }),
  isEphemeralNotice: (message) => /* same rule as seam 3 */ false,
  log: (message) => ctx.logger.warn(message),
}

const coordinator = new ContextContinuityCoordinator(host, codec)
```

Wire it (call sites are yours; the coordinator holds only reconstructible
process state):

- **On every subject Session event:** `coordinator.onSessionEvent(id, agent, event)`.
- **At a subject's turn-stop boundary, before the turn closes:**
  `coordinator.captureQueuedInput(agent)` — real input is preserved for delivery
  after the handoff, ephemeral notices are dropped.
- **Before admitting queued input to an old generation:** consult
  `coordinator.needsAdmissionGate(agent)`.
- **During subject activation (crash recovery):**
  `coordinator.recoverPendingTransition(id, agent, sessionId)` and, for quiet
  continuations, `coordinator.repairContinuations(agent, state)`.
- **On subject dispose/removal:** `coordinator.stopTracking(id)`.

### `executeTransition` contract

Perform one prepared swap at a true idle boundary, in your lifecycle: commit the
rollover, dispose the old Agent, archive the old Session, create and activate the
successor (seed it — `SessionStore.create({ seed, meta })` — with the handoff via
`coordinator.handoffMessageFor(plan)` delivered first, then `plan.carriedInput`).
Resolve once the subject runs its new generation; **reject to leave the previous
generation recoverable** (never half-swap).

A rejection hands `plan.carriedInput` back: the engine takes it out of the plan
and delivers it to the previous generation itself, once the driver goes idle
(and, if you retry the swap first, into that retry instead). So do not deliver it
before the swap commits — a host that hands input over and then rejects gets it
delivered twice.

> **Durable identity — keep stable:** `rolloverIdentity`'s Session-id and
> request-id scheme is what makes an interrupted rollover converge on one
> operation across restart. Changing the scheme risks a duplicate successor.

## Seam 5 — timeline read (shipped)

`readContextTimeline` walks the subject's lineage — the current generation, then
archived ancestors through your stored-Session reader — and returns the bounded,
priced list of return anchors behind `context_status`. The engine owns the
walk, the dedupe, the pricing, and the shared restorable-anchor rule; you supply
the mechanism it cannot have as a pure library.

```ts
import { readContextTimeline } from '@contexera/dsh-context-continuity'

const timeline = await readContextTimeline({
  current: {
    sessionId: agent.session.id,
    header: agent.session.header,
    inheritedEventCount: agent.session.inheritedEventCount,
    events: agent.session.snapshotEvents(),      // the cut is handled by the fold
  },
  config,                                        // the same fold config as seam 3
  readAncestor: id => sessionReader.read(id),    // your StoredSessionReader
  measureSource: source => source.sessionId === agent.session.id
    ? meter?.measure(agent.session)?.totalTokens
    : measureStoredLog(source),                  // your own replay of the ancestor
  currentUsageTokens: meter?.measure(agent.session)?.totalTokens ?? 0,
  handoffAt,                                     // from your route limits
  hardLimit,                                     // optional: echoed back for display only
})
```

- **The engine prices; you measure.** A pure library has no `tokenMeter` on
  `ctx`, so measurement arrives as `measureSource` — the *source's own* replayed
  token count, so a small current generation never shrinks a large ancestor's
  real seed cost. `undefined` means unmeasurable: those anchors stay listed with
  a reason instead of being priced as free.
- **Anchors are structural.** Resolved checkpoints, resolved host boundaries
  (your `domainBoundaryOf` contributions), and the current head. An unresolved
  anchor is not a candidate, and an archived generation contributes no head.
- **The restorable rule is the one `context_rollover` uses:** a boundary is
  selectable exactly when it resolved at a completed turn and is attributable to
  exactly one topic; a checkpoint while its retained context stays below
  `handoffAt`. Every non-restorable anchor carries its reason, and quotes its
  own identifier marked not selectable — a reader has to be able to name the row
  it is being told it cannot return to.
- **An unreadable ancestor ends the walk and is reported** in `incompleteFrom`:
  history is then complete through the last listed generation, and never
  silently short.
- **Two priced facts are yours to add to the result, and both are optional.**
  `composition` is the work set's measured shape (`systemTokens` /
  `toolsTokens` / `messagesTokens`) — a heuristic split your meter already has,
  and the one number a subject cannot derive. Note that `toolsTokens` prices the
  tool **schemas** offered to it; a tool result is a message and counts in
  `messagesTokens`. `compactible` is what a compaction started now would replace
  and what it would keep verbatim; price it with the engine's
  `compactibleNow(session, scope)` rather than by subtracting yourself, because
  that runs the same selection `context_compact` performs — a status and the
  action it announces then cannot disagree. Omit either one when you cannot
  price it (no meter, no compaction engine in that scope): the status then
  renders no line for it, and an unpriced number is never shown as a zero.

## Seam 6 — tools factory (shipped)

The product surface: one factory produces the four model-facing tools — with
fixed names — from your adapter plus optional prose. The engine keeps the
argument contract, the anti-forgery gate, the `concludeTurn()` timing, the
compaction range, and the render shapes; you perform every effect.

```ts
import { createContinuityTools } from '@contexera/dsh-context-continuity'

const tools = createContinuityTools({
  // resolve the calling execution to its subject, then answer/act
  isRestorableRef: (ref, exec) => timelineOffered(subjectOf(exec), ref),
  requestRollover: (request, exec) => lifecycle.requestRollover(subjectOf(exec), request),
  recordCheckpoint: ({ name, callId }, exec) => bindings.record(subjectOf(exec), name, callId),
  timeline: async ({ limit }, exec) => {
    const subject = subjectOf(exec)
    const compactible = compactibleNowFor(subject)   // compactibleNow(agent.session, compactionFor(agent))
    return {
      ...await readTimeline(subject, limit),
      // Optional: the two priced facts the status renders (see seam 5).
      composition: compositionOf(subject),           // { systemTokens, toolsTokens, messagesTokens }
      ...(compactible === undefined ? {} : { compactible }),
    }
  },
  // The compaction capability of the CALLING agent's own scope, or undefined.
  // Resolving it is your addressing job: `ctx.get('compaction')` does not see a
  // service a preset mounted behind `isolate`, so address the preset's service.
  compactionFor: agent => ({
    engine: compactionServiceFor(agent),          // { compactRegion(start, end, agent, signal) }
    meter: tokenMeterFor(agent),                  // optional; { measure(session) }
    retainTokens: 32 * 1024,                      // optional; this is the default
  }),
}, {              // optional; sensible domain-neutral defaults
  subjectNoun: 'Team Member',
  rolloverChecklist: '…what a handoff must cover in your domain…',
  checkpointGuidance: '…when to bury an anchor…',
  // Name the durable channels a rollover carries, so the handoff is a delta,
  // not a re-derivation of what a fresh generation already receives:
  carriedContext: 'Your @handle, role, private memory.md, and the Team ledger carry across a rollover — do not restate them.',
  // Domain glossary spliced into the timeline description, plus the word your
  // boundaries are attributed to (the structural contract stays engine-owned):
  timelineGuidance: 'Team boundaries render as `Team message`, `Team task claim change`, or `First arrival: <refs>`.',
  topicNoun: 'Thread',
  topicNounPlural: 'Threads',
  // The engine has no job concept and never refuses a rollover over one, so this
  // sentence is your guarantee, not the engine's: keep the default only where you
  // actually enforce it, and pass '' where you have no background work to lose.
  jobsNote: 'Collect or stop your background jobs before calling: a rollover is refused while jobs this Team Member owns are still running.',
})
// register tools.rollover / tools.checkpoint / tools.status / tools.compact
```

- **The engine decides, you report the fact.** `isRestorableRef` answers whether
  this subject recorded that ref and a timeline offered it; the engine turns a
  `false` into a model-visible rejection. A fabricated ref never becomes a silent
  fresh rollover, and your verdict must agree with the timeline's own `restorable`
  flag (`readContextTimeline`) — one policy, two readers.
- **`concludeTurn()` follows the durable intent, never precedes it.** The rollover
  and checkpoint bodies conclude the turn only after your adapter resolves; a
  rejection leaves the previous generation running and is what the model sees.
  `context_status` is a read that never concludes a turn, and neither does
  `context_compact`: shortening a context keeps working in the turn it was asked
  from.
- **An unavailable scope is a result, not a rejection.** `compactionFor` returning
  `undefined` — or a call that carries no agent at all — answers
  `status: 'unavailable'` with a reason. That is a supported composition (mount no
  engine, get no compaction), so the model reads what happened instead of guessing;
  the tool never silently no-ops.
- **The engine chooses the range; you never pass one.** `context_compact` takes
  no range argument. The engine picks the largest older stretch that is safe: it never
  starts on a leading `system/message`, never reaches the newest `user/message` or
  anything after it, retreats off any edge that would split a tool call from its
  result, and prices the recent tail through your `meter` (keeping `retainTokens`,
  default 32K, verbatim) when you supply one. A scope without a meter still
  compacts — it just keeps less.
- **A stale meter costs the budget, nothing else.** A measurement whose nodes no
  longer match the current surface is ignored, and every structural bound still
  holds. `measure(session)` is called again after the replacement, so the reported
  `usageTokens` is the post-compaction reading; a scope with no meter reports no
  total rather than one it cannot verify.
- **What survives is the subject's choice; where the boundary falls is not.**
  `summary` is the one argument `context_compact` declares, and it replaces the
  stretch the engine selected — a subject can never aim the replacement, only
  write what stands in for it. Omit it and the engine writes one from the same
  stretch, which is the only option when a reduction is forced (seam 10).
- **A failure says whether this context moved.** A rejection from the engine
  surfaces as `context_compact failed: <message>`, followed by either "This context
  is unchanged." or — when the durable surface's `replaceGeneration` advanced —
  "A replacement may already be on this context; read this context again before
  deciding what to do." The log stays append-only either way.
- **Validation has two layers.** The declared parameter schema rejects wrong
  types at the tool boundary (`ToolArgsError`); the body owns what a JSON Schema
  cannot express — a non-blank handoff within the 32 KiB cap, at most 32 related
  files each with a non-blank path and reason, and a blank `checkpointRef` that
  would otherwise read as absent. Either rejection is model-visible and touches
  no host state.
- **The handoff is a delta, not a state dump.** The default rollover guidance
  tells the model to write only the live working state a fresh generation could
  not reconstruct on its own, and states the one universal carried fact — the
  subject keeps its identity across the switch. `carriedContext` is where you
  name your own durable channels (a memory file, a domain ledger, an injected
  role) so the model does not re-derive what it already receives; a handoff that
  restates identity, standing role, or facts already in those channels wastes the
  very context it is meant to preserve.
- **The status speaks your vocabulary.** `timelineGuidance` splices your
  boundary glossary into the `context_status` description, and
  `topicNoun`/`topicNounPlural` name what an anchor is attributed to (`Thread`
  rather than `topic`) in both the description and the rendered rows. The
  structural contract, the restorable rule, and "Structural only: no transcript
  content" stay engine-owned.
- **A checkpointRef return keeps the prefix and still writes the handoff.** The
  default rollover prose states what the arguments never reveal: the successor
  opens on the exact prefix through the anchor, word for word, *and* the handoff
  is written and delivered on top of it — so the move is a chosen verbatim base
  plus a self-written delta, not a discard. It is the mirror of `context_compact`:
  compaction keeps the recent tail and summarizes what is older, while a return
  keeps an older stretch and lets the subject summarize what came after. Reach for
  it when the value sits before the stretch being dropped; reach for compaction
  when the value is the recent work.
- **The checkpoint trigger is the state being left, not the risk ahead.** A
  checkpoint is cheap — one call, and work continues in the next turn — so it buys
  an option rather than committing to a return, and the default guidance asks
  whether this context is one the subject might want back. That covers a long dig
  whose value is its conclusion, a stretch likely to fill the window with bulk, and
  a risky refactor alike; anchoring on risk alone is what leaves the move unused.
  `checkpointGuidance` replaces the wording, and the engine keeps the sentences
  about when a checkpoint resolves and what it never snapshots.
- **Neither move deletes anything.** A rollover archives the generation it ends and
  a compaction replaces what the subject sees rather than what was recorded, so the
  default prose says so: what is being chosen is what stays in front of the subject,
  not what survives. A host whose subject can search its own history should say so
  in `carriedContext` — recall is what makes discarding the recent work cheap.
- **The jobs sentence is a host promise.** `jobsNote` defaults to the
  `Collect or stop your background jobs before calling` sentence, and the engine
  itself never refuses a rollover over a job — it has no job concept. Keep the
  default where the host really enforces such a guard (the Agent Team does); pass
  `''` where the subject owns no background work, so the model is not reading a
  refusal that cannot happen.
- **Names are fixed:** `context_rollover`, `context_checkpoint`,
  `context_status`, `context_compact`. The prose you override refers to them by
  name, so only
  subject-facing vocabulary is yours: the anti-forgery sentence, "a context change
  never rolls back an external effect", the shape of a `checkpointRef` return, and
  the memory discipline are
  engine-owned and survive any override. The compaction description's four
  non-negotiables are engine-owned for the same reason: it replaces what the
  subject sees rather than what was recorded, it never switches generation, the
  subject may write the replacement itself while the engine writes one when no
  subject is present, and it states what happened instead of implying success.
- **The contract is deliberately generic.** A tool value carries `ref`, `label`,
  and `affectedTopics`, not one host's words for a Thread or a Claim: the same
  factory serves every host. Your render-facing vocabulary belongs in `text`.

## Seam 7 — the retrieval ladder (shipped)

`context_search` and `context_read` are the product surface for recall: a
bounded ranked question, then one expanded neighbourhood. The engine owns the
ladder's contract, the canonical `contextRef` codec, provenance folding, the
budgets, and the return-anchor verdict; you own authorization, the query
capability, the fold configuration, and the meter.

```ts
import { createSearchTools } from '@contexera/dsh-context-continuity'

const tools = createSearchTools({
  subject: exec => subjectOf(exec),
  activeSessionId: exec => sessionIdOf(exec),
  scope: {
    // Default range: every Session this subject ever lived in.
    ownedSessions: subject => ledger.sessionsOf(subject),
    // Named scopes you define — a Team workspace or team; Loom usually has none.
    availableScopes: subject => teamsOf(subject).map(team => ({ scopeId: team.id, label: team.name })),
    sessionsInScope: (subject, scopeId) => ledger.sessionsOfSubjectIn(subject, scopeId),
  },
  query: ctx.sessionQuery,                       // the Harness capability, unchanged
  config,                                        // the same fold config as seams 3 and 5
  measureSource: (source, exec) => measuredTokensOf(source),
  handoffAt: exec => handoffBudgetOf(exec),
})
// register tools.search / tools.read
```

- **Scope is derived by you, never declared by the model.** `ownedSessions` is
  the default range; a model-supplied `scope` only *selects* among
  `availableScopes`, an unoffered scope is a model-visible rejection that lists
  the offered ones, and an empty authorized set refuses to run rather than
  searching everything. Every query carries
  `sessionFilters: [{ kind: 'id', values: <authorized> }]`, and a hit a provider
  returns outside that set is dropped and counted, never presented.
- **The query capability is injected, not reached for.** The engine is a pure
  library with no `ctx` (see seam 5), so you pass `ctx.sessionQuery` — typed by
  the published `@deepseek-ai/dsh-session-query` contract through the four reads
  the ladder uses: `searchSessions`, `searchEvents`, `filterEvents`,
  `readSession`. That declaration is the whole dependency: `ContextSearchPort` is
  an interface with those four methods, and `SessionQueryEngine` satisfies it
  structurally, so there is no adapter glue.
- **The capability is only as open as the deployment.** A mounted
  `ctx.sessionQuery` is not a working search: stock DSH ships the
  `session-query-sqlite` row with `openAt: never`, which keeps exact reads,
  titles, and lineage traces available while `searchSessions` and `searchEvents`
  fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is never opened. Tell your
  operator the prerequisite rather than letting the ladder look broken: the index
  opens in a later patch layer (the profile's own patch, or a `--patch` overlay)
  with `openAt: first-search` — which defers both the `node:sqlite` import and the
  build to the first search — plus a durable `path`, because an ephemeral
  `:memory:` index rebuilds on every start. Two facts belong with the switch: the
  build ingests every *stored* Session inside one failure boundary, so a single
  stored log the Harness format ladder refuses (pre-v3 leftovers it will not
  migrate, a corrupt log) fails every search rather than that one Session — check
  an existing session store can fold before enabling search on it — and the first
  search pays the whole build, after which the index is incremental. The read half
  (`filterEvents`, `readSession`) needs no index, which is why `context_read`
  keeps working while `context_search` does not.
- **A `contextRef` grants nothing.** `context-hit-<base64url([sessionId, seq])>`
  names the generation that *recorded* an event, round-trips across restarts, and
  is rejected when it is not the exact canonical form this codec issued.
  Ownership is revalidated on every read against `ownedSessions` plus every
  offered scope, because a read takes no scope parameter and a ref may have come
  from a scoped search.
- **One inherited experience appears once.** A seeded generation repeats its
  source's events at the same seqs, so a hit below its `inheritedEventCount` is
  folded along `parentSession` to its real source before dedupe; when that folds
  away a generation's strongest match, its own span is searched so its later
  experience is still represented.
- **Returning is optional enrichment.** A hit carries a `checkpointRef` only when
  its source generation is on the active lineage *and* an anchor whose completed
  turn contains the hit passes the shared policy — the same `anchorCandidates`
  and `anchorRejection` the timeline uses, so the two surfaces cannot disagree.
  Otherwise the hit states `unavailable — <reason>`; a ref is never synthesized,
  and an off-lineage branch is searchable but is not a return target.
- **The model surface has no paging.** No cursor, no page size, no Session id, no
  event type: the budgets are `CONTEXT_SEARCH_RESULT_LIMIT`,
  `CONTEXT_READ_BEFORE` / `CONTEXT_READ_AFTER`, and `CONTEXT_READ_EVENT_CHARS`. A
  capped answer says so and asks for a narrower query, time range, or `within`.
- **`within` deep-searches one generation's own span.** Copying a hit's
  `contextRef` into `within` searches the generation that recorded it, not its
  inherited prefix — that history already belongs to, and is attributed to, its
  own generation.
- **Errors are readable, not raw.** Provider failures reach the model as one
  sanitized sentence; a bad ref, an unoffered scope, a time bound without a
  timezone, and a stale seq each say what was wrong and what to do instead.

## Seam 8 — context pressure (shipped)

`ContextPressurePolicy` decides when a subject is told to prepare a handoff, and
what happens when it is at its limit. The engine owns the decision order, the
once-per-generation latch, and the proof a reduction has to earn; you own the
meter, the reduction capability, the steer, and what the notice calls whatever
the subject is holding.

```ts
import { ContextPressurePolicy } from '@contexera/dsh-context-continuity'

const pressure = new ContextPressurePolicy<MemberId>({
  pluginId: AGENT_TEAM_PLUGIN_ID,               // whose notice this is, on read-back
  limitsFor: member => routeLimitsForMember(member),   // meter + route window + reserves
  surfaceFor: member => ({
    generation: surfaceReplaceGenerationOf(member),
    tokens: meterOf(member)?.measure(sessionOf(member))?.totalTokens,
  }),
  compactionFor: member => compactionServiceOf(member),  // { reduce(reason, signal) }
  logSpanFor: member => ({
    sessionId: String(sessionOf(member).id),
    inheritedEventCount: Number(sessionOf(member).inheritedEventCount),
    events: sessionOf(member).snapshotEvents(),
  }),
  inHandFor: member => ({ inHand: activeClaimLabels(member), jobs: runningJobLabels(member) }),
  steer: (member, notice) => sessionOf(member).steer(notice),
  failedFor: (member, diagnostic) => setMemberFailure(member, 'compaction', diagnostic),
  log: (message, member) => ctx.logger.warn(`agent-team: ${message} (member ${member})`),
}, { inHandLabel: 'Active Claims', jobsLabel: 'Owner jobs' })

const decision = await pressure.onPreStep(member, signal)   // continue | notice | hold | reject
```

- **Two thresholds, one order.** Below the handoff budget nothing happens; at it
  one notice is steered into the running turn; at the hard limit the request is
  forced through a reduction first. A request at the hard limit is never merely
  noticed.
- **The notice is durable evidence, not process state.** The latch reads the
  subject's own log span for a `user/message` carrying `source.summary ===
  PRESSURE_NOTICE_SUMMARY`, or a durable `agent/inbox/spliced` insert of one, so
  a restart stays quiet and a fresh generation re-arms by itself. A steered
  notice you do not record in the log is delivered again — the latch reads the
  log, not your memory. An inherited notice belongs to the generation it came
  from and does not latch this one.
- **A reduction must be proven.** The engine reads `surfaceFor` before and after
  and continues only when the durable generation advanced or pressure measurably
  fell (`tokens`, when you meter); otherwise the step is refused with a
  recoverable diagnostic — a no-op, a throw, or an unavailable capability all
  block rather than submit over the limit. Background jobs are never touched.
- **Missing capacity is a refusal, not an unbounded policy.** An unresolvable
  route window rejects the step and says so.
- **Provider overflow gets one bounded retry.** On the context-window-exceeded
  failure code the policy reduces once and allows a single retry for that open
  sequence; a durable surface change is required for the retry to count, and a
  successful assistant response re-arms the sequence. The retry budget is
  process-only and per subject.
- **The notice's substance is the engine's.** The measured numbers, the default
  action, and the instruction to record durable knowledge before switching are not
  knobs; `PressureNoticeText` replaces only the two labels and the two tool names
  (`rolloverToolName`, `compactToolName`).
- **The named default action follows the capability.** When `compactionFor`
  resolves for the subject, the notice makes `context_compact` the default and
  keeps `context_rollover` for a genuine page turn — the subject wants this context
  cleared, or is resuming from an earlier anchor or moving to another session. When
  it does not resolve, a fresh generation stays the default and no compaction tool
  is named at all: a subject is never told to call a tool its scope lacks.

## Seam 9 — the long-gap gate (shipped, optional)

A subject that comes back to a large context after a long absence is usually
starting new work, and the old context is dead weight it pays for on every step.
The gate asks a judge once whether the arriving input continues the recent work.
An unrelated answer holds the step and steers one instruction to roll over, so
the work continues in a fresh generation seeded by a handoff written for that
input. Two optional host members switch the gate on; omit either and the gate
stays off, which is a supported deployment and never a failure.

```ts
import { ContextPressurePolicy, DEFAULT_GATE_TOKENS } from '@contexera/dsh-context-continuity'

const pressure = new ContextPressurePolicy<MemberId>({
  /* … seam 8 … */
  relatednessFor: member => ({
    input: pendingInputTextOf(member),        // the messages this pre-step is admitting
    recent: recentUserInputsOf(member),       // oldest first
  }),
  judgeFor: member => ctx.jev,                // anything with decide(request)
}, {}, { tokens: DEFAULT_GATE_TOKENS })

const decision = await pressure.onPreStep(member, signal)   // continue | notice | hold | reject
if (decision.kind === 'hold') {
  contextManagement.holdClaimedInput(agent, messages)       // arm the gate AND keep the input
  return { kind: 'reject' }
}
```

- **The judge is a deployment of its own.** `judgeFor` takes anything with a
  `decide(request)`, which in practice is the `ctx.jev` service of
  `@wowyuarm/dsh-jev`; a deployment adds that bundle as its own plugin row, and the
  row names the environment variable holding the key (`apiKeyEnv`, default
  `TYPESAFE_API_KEY`). This engine declares that package only as an optional peer,
  for the question and answer shapes it writes and reads, and never sees a
  credential: installing no judge leaves the whole gate off, which is a supported
  deployment.
- **`hold` is its own decision.** It says the input this step claimed is kept, so
  the host preserves it; `reject` says the step cannot run and has nothing to
  keep, which is what the hard limit returns. Do not treat them alike.
- **Arming and capturing are one call.** `holdClaimedInput` arms the hold and
  keeps the messages in one step, because a capture taken before the hold is
  armed keeps nothing.
- **The gate is also the admission gate, and only for the held turn.** While a
  hold is armed, `needsAdmissionGate` is true for that Agent and `isHoldingInput`
  reports the same fact. The arm has to be gone by the time the instruction's own
  turn reaches your pre-step: a host that checks the gate before its pressure
  policy — the shipped Team wiring does — would otherwise reject the one turn that
  carries the instruction, and the instruction would never reach a model.
- **The remedy needs no compaction engine.** The instruction asks for a fresh
  generation, so a scope that could never shorten a context in place is exactly
  the scope this gate is for, and `compactionFor` is not consulted.
- **The instruction quotes the held input back.** The input is held precisely so
  that it opens no step, which leaves the model writing the handoff blind to the
  request the handoff is for. The instruction therefore quotes that input (its
  first 4000 characters) and names `rolloverToolName`.
- **The coordinator owns every way out; the host owns none.** There is no host
  call to release a hold: releasing stays internal so a host cannot strand one.
  - *The rollover.* The instruction is steered as a next-step message, so the
    driver opens one turn with it as its only input — the model's chance to write
    the handoff. A rollover whose result lands durably in that turn (or that is
    already pending when the held turn ends) is the input's first exit: the swap
    carries it into the new generation as `carriedInput`.
  - *No rollover.* Otherwise the coordinator hands the kept input back as the
    next turn's input and logs that the requested rollover did not happen. That
    delivery waits for the driver to converge, which is what lets the
    instruction's turn run to itself first, and it re-checks for a rollover at
    that moment rather than at the turn end — so a model that rolls over during
    the instruction turn still gets the input through the swap.
  - *Where a hand-back goes.* Delivery reads your binding again at that moment
    rather than trusting the Agent the input was taken from: the subject may
    have rolled over or been activated again while the delivery waited. The
    Agent `agentForSubject` names now receives it; none named means the input is
    kept for the subject's next generation instead of being handed to an Agent
    that no longer answers for it.
  - Either way the hold itself is dropped at the end of the held turn, and the
    input is kept exactly once. A rollover counts as landed on its durable
    result — the projection's pending intent, which `isTransitioning` reports
    while the swap it asks for is still this process's to make.
- **The gap is measured from the log, not from memory.** The engine reads the
  newest event's own timestamp, so a restart cannot look like a half-hour
  absence, and a generation with no event at all has no measurable gap and is
  not gated.
- **The deadline is the engine's.** The judge is called with a signal that is
  cancelled at `judgeTimeoutMs` (default `DEFAULT_GATE_JUDGE_TIMEOUT_MS`), and the
  engine stops waiting at the same instant whether or not the judge honours it —
  this call sits on the path that starts a turn.
- **Every ungated outcome is recorded.** Related, undecided, timed out, failed,
  malformed, no judge: the step continues and the reason is logged. A gate that
  decided not to roll over is never silently indistinguishable from one that
  never ran.
- **The thresholds are defaults, not policy.** `DEFAULT_GATE_TOKENS` and
  `DEFAULT_GATE_IDLE_MS` are exported; the third constructor argument overrides
  them per policy.

## Seam 10 — the compaction backend (shipped, opt-in)

Seam 6 hands `context_compact` a way to shorten a context. That way is a
Harness compaction engine, and **which engine a host mounts is what decides who
writes the summary**. This package ships one, so the wording can be its own
rather than whichever engine happened to be mounted.

```yaml
# In a preset, where the stock backend would otherwise be mounted. Keep your own
# row id, and carry over whatever config that row already had.
- id: compaction-basic
  name: '@contexera/dsh-context-continuity/compaction-engine'
  config:
    auto: false
```

```ts
import { ContinuityCompactionEngine, DEFAULT_COMPACTION_TEMPLATE } from '@contexera/dsh-context-continuity'

// A host that wants different wording subclasses; no config key is involved.
class HouseStyle extends ContinuityCompactionEngine {
  protected override readonly template = '…your checkpoint structure…'
}
```

- **Mounting it is optional, and it is the only thing that changes the wording.**
  A host that keeps the stock `@deepseek-ai/dsh-compaction-basic` row keeps
  working exactly as before; the template and subject-authored summaries simply
  never apply. This is why the seam is opt-in: the engine is one assembly
  decision, not a new contract every host must meet.
- **The subpath default-exports the class, and that is what makes the `name:`
  form work.** The loader resolves an entry's `name` to a module and then takes
  **its default export** (`vendor/loader/src/config/entry.ts`), handing the result
  to a registry that accepts only a function, a class, or an `{ apply }` object —
  a module namespace is none of those. The stock backend is mounted the same way
  and default-exports its class for the same reason. The package root also
  exports the class by name for hosts that mount it from their own code.
- **Wording is changed by subclassing, not by a config key.** Cordis validates a
  plugin's config against the `Config` schema it inherits, and this package does
  not own the backend's schema; a `template` key would mean depending on the
  schema library purely to add one field. `template` is a `protected` field.
- **The template is the fallback, so it is never removable.** A summary is
  written by the subject when the subject is there to write one, and by the
  engine when it is not: at the hard limit, or after the provider refuses an
  oversized request, no subject is present to be asked. A host that overrides
  the field is changing that fallback, not replacing it.
- **The subject may write the replacement itself.** `context_compact` takes an
  optional `summary`, which becomes the content that replaces the stretch — and
  which the engine hands back as an **unmarked** result, because the backend's
  result type admits a summarizer that issues no `llm.stream()` call. Nothing in
  the transaction claims a call that did not happen.
- **The offer lasts one attempt.** The text reaches the engine out of band, keyed
  by the Session and cleared by the call that offered it — never consumed by the
  read, because one attempt may summarize more than once, and a failed attempt
  must not leave a stale summary for the next automatic compaction to reuse. That
  channel is internal to this package (`pending-summary`), so no host wiring is
  involved and no cross-package contract is created.
- **The subject-written text must still be smaller than the stretch it
  replaces.** The engine prices the framed summary against the shadowed content
  and refuses a replacement that does not shrink it; the tool reports that as a
  recoverable failure ("This context is unchanged."), so the model can retry
  shorter.
- **Two texts, two audiences.** The template is written for a compaction engine
  ("Condense the conversation ABOVE", and rules such as "do not mention this
  summarization request"). The prose a subject reads when deciding what to write
  is `compactSummaryGuidance` in `ContinuityToolText`, spliced into the tool's
  `summary` parameter. Keep them aligned in intent; do not collapse them into one
  string, because the engine's voice is wrong for a subject writing its own
  checkpoint.
- **The pressure notice asks for that summary by name.** Where a subject's scope
  can compact, the notice steers it to call `context_compact` **with a summary it
  writes itself** and says what omitting it means. That matters most where the
  engine's own automatic listeners are off (`auto: false`, as the Team preset
  sets): the notice is then the only soft trigger, so it is also the only place
  the subject is asked to write anything.

## Compatibility red lines (durable identity)

These are written into logs by earlier generations and read back by later ones.
Once a host ships, treat them as frozen:

1. `pluginId` — attribution the codec matches on read.
2. Section names — fixed by the engine; a host cannot change them.
3. `rolloverIdentity` naming scheme — in-flight rollover crash recovery depends on it.
4. Projection `stateVersion` — currently `2` (the state carries the Session
   identity and the fork-inherited cut); bump it whenever the serialized state
   shape or fold semantics change, so stale cached rows are discarded rather
   than misapplied.
5. Legacy tool names — if a tool was renamed, keep folding the old name
   (`rolloverToolNames`); it is a log decoder, not an active alias.
6. The `contextRef` prefix (`context-hit-`) — a conversation reads its own refs
   back, so a new payload format arrives under a new prefix; an old ref then
   rejects as a model-visible error instead of decoding into the wrong event.
7. The pressure notice's `source.summary` (`PRESSURE_NOTICE_SUMMARY`) — the
   latch reads notices back out of live logs to decide whether the current
   generation was already told, so a notice already written must keep matching.
