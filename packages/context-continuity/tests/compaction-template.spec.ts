/**
 * The default checkpoint template.
 *
 * The template is the only part of a compaction a successor cannot re-read: the
 * span it stands in for is gone. These tests pin the two properties that make it
 * worth measuring rather than tasteful — every declared section is actually
 * asked for, in order, and the two facts the corpus showed being lost (whether a
 * claim was verified, and which obligation is outstanding) are requested by
 * name. A later trim that silently drops one of them is the failure this spec
 * exists to catch.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPACTION_SECTIONS,
  DEFAULT_COMPACTION_TEMPLATE,
} from '../src/compaction-template.ts'

/** The headings the template actually writes, in the order they appear. */
function headings(template: string): string[] {
  return [...template.matchAll(/^## (.+)$/gm)].map(match => match[1] ?? '')
}

describe('the default compaction template', () => {
  it('asks for every declared section, in order, exactly once', () => {
    expect(headings(DEFAULT_COMPACTION_TEMPLATE)).toEqual([...DEFAULT_COMPACTION_SECTIONS])
  })

  it('names the verification status of a fact as something to record', () => {
    // The corpus lost this distinction in 4% of summaries when nothing asked for
    // it; the wording is what keeps it, not the model's own habit.
    expect(DEFAULT_COMPACTION_TEMPLATE).toMatch(/verified/i)
    expect(DEFAULT_COMPACTION_TEMPLATE).toMatch(/trusted/i)
  })

  it('asks which obligation is outstanding, naming the other participant', () => {
    // 41% of the sampled summaries dropped who was waiting on the subject.
    expect(DEFAULT_COMPACTION_TEMPLATE).toMatch(/owes|waiting/i)
  })

  it('tells the summarizer not to reproduce what can be read again', () => {
    expect(DEFAULT_COMPACTION_TEMPLATE).toMatch(/cannot recover|read again/i)
  })

  it('carries its own output contract rather than relying on a sibling instruction', () => {
    // The template is delivered as the final user message of the summarizing
    // call, so nothing else states the structure for it.
    expect(DEFAULT_COMPACTION_TEMPLATE).toMatch(/Output EXACTLY/i)
    expect(DEFAULT_COMPACTION_TEMPLATE).toMatch(/never drop a section/i)
  })
})
