/**
 * The checkpoint template: what a compaction summary is asked to preserve.
 * A host may replace the whole text.
 * @module @contexera/dsh-context-continuity/compaction-template
 */

/**
 * The default checkpoint instruction. It is delivered as the final user message
 * after the replayed conversation, so the summarizing call stays a genuine
 * prefix of the request it condenses and the provider's cache survives.
 */
export const DEFAULT_COMPACTION_TEMPLATE = [
  'You are now acting as a compaction engine for this agent. Condense the conversation ABOVE into a structured checkpoint that lets another generation of the same agent resume the work with nothing essential lost.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  'Budget rule: spend your length on what a successor CANNOT recover by itself. Files, code and command output can be read again at any time — name them and say why they matter, do not reproduce them. Decisions, obligations, and the reasons behind a choice exist nowhere but this conversation; lose them and they are gone.',
  '',
  '## Objective and Current Action',
  "- [the goal in the requester's own words, quoted verbatim where exact wording matters, plus corrections that changed it]",
  '- [the single action in flight at this checkpoint, precisely enough to resume mid-step]',
  '',
  '## Established Facts',
  '- [each durable finding this work produced, with its evidence]',
  '- [MARK EACH as verified (checked first-hand here — say how) or as trusted (reported by someone else, relayed, or assumed) — never leave the distinction implicit]',
  '',
  '## Open Loops and Obligations',
  '- [what this agent owes another participant: a reply, a review, a handoff, a decision — name the participant and what they are waiting for]',
  '- [what this agent is itself waiting on, and from whom]',
  '- [explicitly requested work not yet done]',
  '',
  '## Decisions and Constraints',
  '- [decision: the reasoning behind it, and what would have to change to revisit it]',
  '- [standing instructions, preferences and prohibitions stated by the requester]',
  '- [unresolved disagreements or contradictions, stated as such rather than silently resolved]',
  '',
  '## External Side Effects',
  '- [every change already made outside this conversation — files written, commands run, commits, pushes, running jobs, remote calls — and whether each was verified to have taken effect]',
  '',
  '## Working Material',
  '- [exact paths, identifiers, refs, commands, signatures and numeric values needed to continue: name them, do not reproduce their contents]',
  '- [errors encountered and how each was resolved, or that it is still open]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, concrete enough to start without re-deriving it, or "(none)"]',
  '',
  'Rules:',
  '- Write concise engineering prose. Preserve exact paths, commands, error strings, identifiers, refs, numeric values and signatures verbatim.',
  '- Capture instructions and feedback from the requester faithfully, especially corrections and anything they explicitly refused.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a prior checkpoint block, do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n')

/** The section headings {@link DEFAULT_COMPACTION_TEMPLATE} guarantees, in order. */
export const DEFAULT_COMPACTION_SECTIONS = [
  'Objective and Current Action',
  'Established Facts',
  'Open Loops and Obligations',
  'Decisions and Constraints',
  'External Side Effects',
  'Working Material',
  'Next Step',
] as const
