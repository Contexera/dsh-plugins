---
'@contexera/dsh-context-continuity': minor
---

Context pressure and return anchors now read the durable log as the evidence
they claim to read.

**The long-gap gate could never fire.** It measured the gap from the newest
event of a generation's log, but the loop appends the arriving turn's
`turn/start` before the pre-step call that runs this policy, so every span it
read ended with an event stamped now. The gate now measures from the newest
`turn/end` — the last turn the generation completed — which is the gap the gate
means, and stays off when no turn has completed.

**The pressure notice was delivered once per Session, not once per context.**
Compaction is that notice's own default action and leaves the subject in the
same Session, so after an in-place compaction the latch still reported "already
told" and pressure climbing back over the budget produced no second notice: the
subject was first reduced at the hard limit, where by design no subject is left
to write its own summary. A `compaction/end` now starts a fresh context for the
latch, and a notice written after it is what latches. The incremental fold that
cached this latch is gone: the host already re-reads the whole span on every
pre-step, so the cache saved a scan of an array that had just been built.

**A return anchor's retained cost was an estimate, and it was the number the
decision was made on.** `retainedTokens` was the source's total tokens times the
fraction of the log the anchor's prefix covers, so a prefix holding one
oversized tool result priced at a small share of its real cost — and an anchor
past the handoff budget could be reported as affordable. Anchors are now priced
node by node out of the source's own measurement, which is what entering them
would actually cost, and a source that prices no node prices no anchor rather
than pricing it as free. `ContextTimelineRequest.measureSource` and
`ContextSearchAdapter.measureSource` therefore return `SurfaceMeasurement`
(`{ totalTokens, nodes }`, the shape the compaction seam already uses and the
Harness token meter already returns) instead of a bare total; `retainedEstimate`
is removed. This is a breaking change for hosts: return the meter's own
measurement from your `measureSource`.

**The restorable-anchor rule now reads what a return would keep.** It judged a
boundary by that boundary's own topics, so a boundary attributable to exactly
one topic was accepted even when an earlier boundary had already put a second
topic's facts in the context a return would retain — and a host that wanted the
stricter answer had to re-derive it, in its own code, next to the engine's. The
rule now reads the anchor's retained prefix (`AnchorCandidate.topicsThrough`
replaces `attributions`), and the one thing no shared vocabulary can state —
which of a host's own boundary kinds close a context rather than open a topic —
is one host rule (`host.boundaryRestorableFor`) asked by both surfaces that
offer a return anchor, so a ref the timeline offers is a ref `context_rollover`
accepts.

The shared anchor rule is exported so both of a host's surfaces ask the same
one: `anchorCandidates`, `anchorRejection`, and `retainedPrice`, with an optional
`AnchorRule` carrying the host's `boundaryRestorableFor` and the nouns its
reasons are worded in (`ContextTimelineRequest.anchorText`) — the rule stays the
engine's, the words stay the reader's. A measurement that prices no node (a meter
reporting only a total, or not a measurement at all) reads as unmeasurable, which
is fail-closed rather than a failure on the read path.
