# Design principles

Why `dsh-context-continuity` is shaped the way it is. These principles are the
standing rationale behind the seams in `integration.md`; when a change is
proposed, it should be justified against them.

## Stance: session as context infrastructure

The plugin exists to give a durable subject **one continuous context across many
physical Sessions**: roll forward into a fresh Session and stay the same
identity, bury a restorable anchor and return to it, walk the lineage as one
timeline, recall across past sessions. This is the *solution* — the model-facing
tools are the product, not an accessory to a library.

Continuity is *semantics over native Harness primitives*. The Harness already
provides Session fork/seed, header lineage, the Session log as the only durable
store, the projection framework, and `sessionQuery`. The plugin adds the meaning
those primitives do not carry: that a chain of Sessions is one subject's life.

## P1 — Reuse Harness primitives; do not reinvent

Before building anything, check whether the Harness already owns it. The
core-gap judgement that founded this package:

| Capability | Harness state | Decision |
| --- | --- | --- |
| Session fork/seed | native (`SessionStore.create({ seed, meta })`) | reuse |
| Session lineage | native (`parentSession` / `seedLength`) | reuse |
| Session search | native (`sessionQuery`, off by default) | reuse the provider; add only authorization + a two-tool surface |
| Projection fold drive | native (`dsh-session-projection`) | register a unit; do not hand-roll a driver |
| Durable store | native (the Session log) | the log is the only truth; no second store |
| rollover / checkpoint / timeline *as a subject's continuous life* | absent | **this is what the plugin owns** |

The plugin owns the continuity *semantics* and nothing that the Harness already
owns well.

## P2 — The engine owns universal mechanics; the host owns domain meaning

The seam rule: **anything that needs event or domain semantics is a host
contribution, not an engine label.** The engine owns what is invariant across
every subject — the durable-result gate, the idle-boundary swap, the admission
gate, carried input, checkpoint continuations, turn cursors, the lineage walk,
the return-anchor policy. The host contributes what only it can know — what its
subject is, what events are worth returning to (`domainBoundaryOf`), what a
"first arrival" means (`seenTopics`), what a topic is (`attributions`).

This is why domain anchors are a fold *contribution*, not a configurable
labeller: rules like "a boundary is a default return anchor exactly when it is
attributable to one topic" need to read event semantics, and only the host has
them.

## P3 — Durable identity and authorization belong to the host

The engine derives no naming and grants no access. A Session-id scheme and an
idempotency request-id scheme (`rolloverIdentity`) are durable domain concerns —
getting them wrong duplicates a successor or breaks crash convergence, so the
host, which owns its persistence, owns them. Likewise the searchable scope
(`SearchScopeProvider`) is derived by the host from subject identity; the engine
only ever searches within the set the host returns. The model selects among
authorized scopes, never widens them.

## P4 — The log is the only truth; folds are pure and converge

Every durable fact is derived from the Session log, never stored a second time.
The projection fold is pure and reads nothing outside the log, so a cold fold
over stored events and the live incremental fold produce exactly one state
(this is what lets the timeline replay archived ancestors identically). Refs are
derived deterministically from `(sessionId, callId)` or `(sessionId, seq)`, so
two generations never collide and no ref table needs persisting. An event the
fold does not care about returns the **same state reference**, which is how the
framework knows to do no downstream work.

## P5 — Safety invariants are non-overridable

A host customizes subject-facing prose; it never customizes safety. These hold
for every host:

- **A context change never rolls back an external effect.** Files, git, jobs,
  remote calls, domain facts are not reverted by a rollover or a checkpoint
  return; a seed restores a conversation prefix and nothing else. The handoff
  describes current state so the successor re-verifies.
- **Anti-forgery refs.** A `checkpointRef` must be one the subject actually
  recorded and a timeline actually offered; a synthesized or guessed ref is a
  model-visible error, not a silent fresh rollover.
- **Fail closed on the unreadable.** An unreadable committed seed blocks a
  checkpoint return; an unreadable current binding blocks activation; an
  unreadable ancestor only truncates the timeline (marked, never silent) and
  never changes subject availability. Conservative degradation: an
  unclassifiable failure blocks rather than skips.
- **The model gets evidence, not authority.** Search results are historical,
  untrusted evidence — never instructions, never a permission grant.
  Shadowed/log-only hits are labelled as such.

## P6 — Scope boundary: session continuity, not memory

The plugin does **session continuity** — sessions as context infrastructure. It
does **not** manage `memory.md`, notes, attention, or threads. Those are
workspace files a subject edits with ordinary fs tools, guided by a skill; their
persistence, projection, and recovery semantics differ from an append-only
event log, and merging the two would muddy both interfaces. The connection is
one-directional and thin: a handoff *references* what the subject recorded to
memory before rolling over; the plugin never reads or writes those files.

## P7 — The product surface is first-class

Because the plugin is a *solution* for a subject to manage its own context, the
model-facing tools (`context_rollover`, `context_checkpoint`, `context_timeline`,
`context_search`, and `context_read`) are a first-class deliverable,
not an optional add-on. A consumer that only imported the engine and re-wrote the
tools would duplicate the exact surface the plugin exists to standardize — so the
tools ship from here, parameterized by prose, with the safety-bearing validation
kept inside.
