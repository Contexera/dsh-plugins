'@contexera/dsh-context-continuity': patch
---

Keep the long-gap gate off for input arriving mid-turn.

`idleMsFor` anchored the gap on the newest `turn/end` alone. An input steered
into a running turn is admitted by a later pre-step of that same turn, and by
then the loop has already written the turn's `step/start` into the log — so the
span read "45 minutes since the last finished turn" while the generation was
actively working. With usage over the gate's token floor and a judge reading
the fresh input as unrelated, the gate held a mid-turn step and rolled a live
generation over.

The idle anchor now also respects the newest `step/start`: when a completed
turn's steps have already opened, the span measures work in progress rather
than an absence, the gap is unmeasurable, and the gate stays off. A later
`turn/end` re-arms the gap from the newest one, so a generation that finishes
after mid-turn arrivals is still gated on its next return.
