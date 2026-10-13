---
'@contexera/dsh-context-continuity': patch
---

Release checkpoint-continuation latches by subject instead of leaking them.

The coordinator's in-process latch for a scheduled quiet continuation was a flat
`Set<string>` keyed by `` `${subject}:${checkpointRef}` ``, and nothing removed
an entry once its continuation was delivered: `stopTracking` and `dispose` did
not touch it either. A long-running subject therefore kept one string per
checkpoint it had ever resolved, and the composite key could collide — a subject
`team:a` with ref `b:checkpoint` and a subject `team:a:b` with ref `checkpoint`
produced the same key, so the second continuation was suppressed as a duplicate.

Latches are now `Map<SubjectId, Set<string>>` holding the checkpoint ref as
itself. A latch is released when the durable continuation event is observed,
when scheduling throws, when `stopTracking(subject)` drops the subject, and when
`dispose()` clears the map. An empty per-subject Set is dropped too, so the map
does not retain one entry per subject id ever seen.
