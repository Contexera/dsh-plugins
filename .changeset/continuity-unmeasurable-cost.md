'@contexera/dsh-context-continuity': patch
---

Report an unmeasurable context cost as unknown, and correct four defects.

The notice latch treated any `compaction/end` as proof that the context a
notice was sent into no longer exists. The compaction backend writes that
event on the failed close too, with an `error` member, and leaves the surface
as it was — so a failed compaction made the standing notice look stale and
the next step stayed quiet. The latch now requires the close to have
succeeded, and also honours `compaction/prune`: a model-free tool-result
prune replaces surface nodes without writing any compaction event.

`ContextTimelineItem.retainedTokens` and `discardedTokens` were required
numbers, so an unmeasurable source rendered as `retained ~0, discarded ~0`
while its own verdict said the cost could not be measured. Both are now
optional and omitted from the render, which reads "cost unmeasurable"
instead.

A checkpoint anchor reported no affected topics, because the candidate was
built with a hardcoded empty list. Returning to a checkpoint keeps the topics
that entered context before it, and the row said "none".

`context_status`'s `limit` parameter documented "at most 24" against a clamp
that only floors the value at 1, so any larger number was accepted while the
schema said it would not be.
