# Architecture

`dsh-jev` is one seam. A caller describes a state and asks typed questions about
it; the vendor evaluates them and answers; the service carries both directions
without interpreting either. This document is the wire reference — the exact
request, the exact answers, what is validated and what is deliberately not, and
how a failed call is handled.

## Scope

1. **Ask.** One call, `ctx.jev.decide({ state, questions })`, with the questions
   keyed by the caller and answers returned under those same keys.
2. **Carry.** The vendor's response, unmodified, including the model id that
   answered and the usage record.
3. **Fail.** A typed `JevError`, never a fabricated answer.

What a decision means is not in scope. The service does not threshold a
confidence, gate a decision, choose a posture or a word list, and it registers no
tool: its caller runs where the main model does not, so a tool would require
waking that model to ask it the very question this call answers.

## Registration

`Jev` is a Cordis `Service`, registered as `ctx.jev` with the plugin that mounts
it and removed with that plugin's fiber — the service lives exactly as long as
its row does. A consumer therefore declares `inject: ['jev']`, which also makes
an unmounted row fail loudly at load rather than at the first judgement.

Configuration is resolved before the service registers itself, so a deployment
with an unusable endpoint, model, bound or key fails without leaving a
half-built service addressable. `resolveConfig` is exported for a host that wants
to check a configuration before mounting the row.

## The request

`POST {apiBase}/systemone`, with `Authorization: Bearer <key>`,
`Content-Type: application/json`, and exactly three body members:

| Member | Type | Meaning |
| --- | --- | --- |
| `state` | `string \| object \| array` | What the questions are asked about: text, or structured data such as a chat log or a record. Text only — pre-process images and binaries into text. |
| `model` | `string` | The model that handles the call, from configuration. |
| `questions` | `map<string, Question>` | One typed question per id the caller chose. The id is not sent to the model and is not used in inference; it only names the answer. |

### Question types

A question is one of three documented types. All three carry `instructions`;
each adds its own `criteria`.

| `type` | `criteria` | The answer is |
| --- | --- | --- |
| `noul` | Optional: an object whose `true` and `false` entries describe what each answer means. | A probability that the answer is yes. |
| `choice` | A map: each key is an option name, each value describes that option. An option description may be `null` when the name alone is clear. | The chosen option, a probability per option, and confidence. |
| `score` | An ordered array of level descriptions, low end first. A level's number is its position, starting at 0 — which is why this is an array and not a map. The order *is* the numbering. | A position on the scale, a probability per level, and confidence. |

The difference between a map and an array is a difference between question types,
not between endpoints or transports: a choice's options have no order, a score's
levels do. Sending one where the other belongs is rejected locally, before any
round trip.

`instructions` and every value in a `criteria` accept the vendor's `EntryType`:
a string, an object, an array, or `null`. Structured entries are how a question
carries supporting data, a schema, or examples next to its wording — the
package passes them through untouched.

### `boolean` as an alias

`type: 'boolean'` is accepted as a compatibility alias and normalized to `noul`
before the request is built. The vendor documents `noul` and answers in `noul`,
so the wire never carries the alias, and a request written against either name
behaves the same. The reverse is never done: an answer is only ever read as the
documented type.

### What is checked, and what is not

Checked, because each is a documented requirement or plainly unusable:

- `state` is present, and is a non-blank string, a non-empty object, or a
  non-empty array.
- `questions` is a map with at least one entry.
- Every question has a documented `type` and an `instructions` that is an
  `EntryType`.
- A `choice`'s `criteria` is a map with at least one option; a `score`'s is an
  array of at least one and at most ten levels (the vendor's API limit; it
  recommends at least two, and a one-level scale is left to the caller because
  the endpoint accepts it); a `noul`'s is an object when present.
- Every entry inside a `criteria` is an `EntryType`.

Not checked, because the vendor allows it and this package has no standing to be
narrower: the prose of an instruction or a description (an empty string and
`null` are both allowed), and the members inside an answer.

## The response

The vendor answers with an envelope, which the service validates before
returning it as a `JevResult`:

| Member | Meaning |
| --- | --- |
| `model` | The versioned model id that answered. Kept because it is the only way to see that a pinned `model` config is what actually ran. |
| `answers` | One answer object per requested id, each tagged with the type of the question it answers. |
| `usage` | The vendor's usage record, unmodified and optional: the vendor's examples carry `input_tokens` and `output_tokens`, and another route may report more, such as a `cost`. This is accounting, so a missing record is not a protocol failure. |

The envelope is checked: the body is JSON, it is an object, it carries a non-empty
`model` string, an `answers` object with an object for every id that was asked,
each tagged with the type that was asked for, and a `usage` object when present.
Anything else is a `protocol` failure rather than a partial result — a caller
that reads `answers['tone']` must never find it missing, and an answer to a
different question than the one asked is worse than no answer.

The members *inside* an answer are passed through as the vendor sent them, in
the vendor's documented shape (`noul`; `choice` with `probabilities` and
`confidence`; `score` with `legend` and `probabilities`). The service does not
re-validate them, because validating each member would mean rejecting an answer
the vendor considers valid. A consumer that turns an answer into a decision —
applying a threshold to a probability — is the one that guards the member it
reads.

## Retries and cancellation

One call is one or more attempts, up to `attempts`. An attempt is retried when
another one could plausibly succeed:

| Outcome | Kind | Retried |
| --- | --- | --- |
| The network or TLS failed | `transport` | yes |
| No response within `timeoutMs` | `timeout` | yes |
| Status 408 or 429, or any 5xx | `http` | yes |
| Any other non-2xx status | `http` | no — repeating the caller's own mistake only repeats the rejection. The vendor answers `422` for a malformed request. |
| A 2xx body that is not the documented response | `protocol` | no |
| `signal` fired | `cancelled` | no — the caller's decision outranks this service's judgement that a failure was transient |

Between attempts the service waits `retryDelayMs * 2^(attempt - 1)`, capped at
`maxRetryDelayMs`. A `retry-after` header from the endpoint outranks that
backoff — retrying earlier than it asked would only collect another rejection —
but never outranks `maxRetryDelayMs`: a longer wait stops the call instead of
blocking past the bound the deployment configured. Both documented header forms
are read, a number of seconds and an HTTP date; an unreadable one is ignored
rather than failing a call that could still succeed.

Each attempt composes two aborts: the caller's `signal`, and a per-attempt timer
of `timeoutMs`. The outcome is classified by the service's own flags rather than
by the abort reason, so a cancellation is never mistaken for a timeout — the two
differ in whether another attempt may happen at all. Cancelling during the wait
between attempts stops the call there, without another request.

The attempt timer is a local `setTimeout`. `ctx.timeout` belongs to a timer
plugin this package does not declare, and a provider that reaches for an
undeclared service is not installable on its own. Retries are logged with their
attempt number and reason, because a caller only ever sees the last failure.

## Failure text

Every failure is a `JevError` with a `kind` and, for a response, the HTTP status.
Kinds and their retry behaviour are tabulated in the
[README](../README.md#failures).

Messages never carry the API key: transport messages and response excerpts pass
through a redaction against it, because a key that reaches a log is a key that
has to be rotated. A response excerpt is bounded, so an error message is never a
place where a whole body lands. The key itself is read from `apiKey`, or from the
environment variable `apiKeyEnv` names, and from nowhere else.

## Compatibility

The package imports `@deepseek-ai/cordis` (the plugin and service API) and
`@deepseek-ai/schemastery` (row configuration), and nothing else outside its own
modules: no `@deepseek-ai/dsh-*` package, which `check:boundaries` enforces. That
is what keeps one published version installable on every DSH line, and what makes
`check:peers` report no DSH peer line to certify.

## What was observed against the live endpoint

Exercised on 2026-09-29 through this package's built entry, against
`https://api.typesafe.ai/v1/systemone`:

- One call carrying a `noul`, a `choice` and a `score` question was accepted and
  answered in about 650 ms. The response carried `model: "jev-1.13.0"`, one
  answer per id, and `usage: { input_tokens, output_tokens }` — no `cost` on this
  route, which is why the type documents `usage` as an open record.
- The answers matched the documented members exactly: `noul` alone; `choice` with
  `confidence` and `probabilities` keyed by option name; `score` with
  `confidence`, `probabilities` and `legend` keyed by level number as a string.
- The endpoint accepted a `null` option description, a `noul` `criteria` object,
  and structured entries inside a `criteria` — including a `score` level given as
  an object, which came back inside `legend` as that same object.
- A `score` whose `criteria` was a map was rejected with `422` and
  `"Input should be a valid list"`: the map/array split is a real difference
  between question types, and rejecting it locally saves a round trip.
- An unusable key was rejected with `401`, which this package reports as an
  `http` failure after exactly one attempt — the status is not retryable — with
  the key absent from the message.

Not observed: any retry path (no `429`, no 5xx, no timeout has occurred), and any
route other than the vendor's own endpoint. Those are covered by the offline
suite through an injected transport.

Mounted in a booted host on the same day, with the row's `apiKeyEnv` set: the row
activated under the `headless` profile, a second row declaring `inject: ['jev']`
received `ctx.jev` with a callable `decide`, and a malformed call made from
inside that host was rejected as a `request` failure. `--help` and
`--dump-config` compose configuration without activating plugins, so a run is
what proves a row.

## References

- [API reference](https://docs.typesafe.ai/api) — request body, question types,
  answers, rate limits.
- [Models](https://docs.typesafe.ai/models) — versioned ids, aliases, and the
  vendor's own recommendation to pin a version when thresholds are tuned.
- [Choice](https://docs.typesafe.ai/primitives/choice),
  [Score](https://docs.typesafe.ai/primitives/score),
  [Noul](https://docs.typesafe.ai/primitives/noul) — per-type criteria and
  answers.
- [Advanced: structure](https://docs.typesafe.ai/primitives/advanced) — the
  structured `EntryType` entries.
