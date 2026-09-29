# dsh-jev

Jev (TypeSafe System One) as a Cordis service for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one
headless evaluation call, `ctx.jev.decide(...)`.

The service exists for work that runs while the main model does not — an
after-chat pass deciding whether to speak, a maintenance loop scoring a
situation. That is why it is a service and not a tool: a tool would have to wake
the model and ask it whether to act, which is the decision being made.

It holds no policy. It does not threshold a confidence, gate a decision, pick a
posture or a word list, or decide that a failure means "quiet". It sends the
questions it is given, returns the vendor's answers, and raises a typed
`JevError` when there are none.

## Contract

| Surface | Shape |
| --- | --- |
| The service | `ctx.jev.decide({ state, questions, signal? }): Promise<JevResult>` |
| The result | `JevResult { model, answers, usage }` — the vendor's response, unmodified |
| A question | `noul` (yes/no) · `choice` (options, unordered) · `score` (a scale, ordered, at most ten levels) |
| An answer | `{ type: 'noul', noul }` · `{ type: 'choice', choice, confidence, probabilities }` · `{ type: 'score', score, confidence, legend, probabilities }` |
| A failure | `JevError` with `kind: 'config' \| 'request' \| 'transport' \| 'timeout' \| 'http' \| 'protocol' \| 'cancelled'` |

`decide` returns the whole response rather than only `answers`, because two of
its members are load-bearing: `model` reports the versioned id that actually
answered, which is what makes a pinned model verifiable, and `usage` carries the
call's cost. Answers are passed through as the vendor sent them — the package
checks the response envelope, not each answer member. Field-by-field shapes and
the retry policy are in [`docs/architecture.md`](docs/architecture.md).

## Install

The package is a DSH bundle: adding it inserts the Jev service row.

```sh
dsh plugin add @wowyuarm/dsh-jev --profile <profile>
```

The row carries the endpoint, the model and the bounds; the key comes from the
environment, so no secret enters a configuration file:

```yaml
- id: jev
  config:
    apiKeyEnv: TYPESAFE_API_KEY
```

| Field | Default | Meaning |
| --- | --- | --- |
| `apiBase` | `https://api.typesafe.ai/v1` | Endpoint base; the call goes to this plus `/systemone`. |
| `model` | `jev-1.13.0` | The model id sent with every call. |
| `apiKey` | — | The key itself. Prefer `apiKeyEnv`. |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | The environment variable holding the key. |
| `timeoutMs` | `30000` | How long one attempt may take. |
| `attempts` | `3` | Attempts per call, the first included. |
| `retryDelayMs` | `500` | Wait before the second attempt; it doubles per further attempt. |
| `maxRetryDelayMs` | `30000` | Longest wait between attempts. |

**A missing key fails at load**, not at the first call: a deployment that cannot
authenticate says so once, instead of failing on every turn behind a consumer's
fail-closed handler.

**The model id is named differently from route to route.** The vendor's own
endpoint names models like `jev-1.13.0`; an OpenRouter-style base uses
`typesafe/jev-1.13`. `apiBase` is configurable, so a deployment that moves it
usually has to move `model` with it. The default is a version rather than an
alias on purpose: a threshold is calibrated against one model's answers, so a
`latest` alias that moved underneath a deployment would invalidate that
calibration without anything failing — the vendor's [Models
page](https://docs.typesafe.ai/models) recommends pinning for the same reason.
The response's `model` reports the versioned id that answered, which is how a
pinned configuration is verified rather than assumed.

**The key never appears in a message or a log line** this package produces:
error text and response excerpts are redacted against it. `apiKeyEnv` defaults to
`TYPESAFE_API_KEY`, the name the vendor's own examples use.

## Consuming it

```ts
import type { Context } from '@deepseek-ai/cordis'
import { JevError } from '@wowyuarm/dsh-jev'

export const name = 'loom-after-chat'
export const inject = ['jev']

export async function judge(ctx: Context, state: string, signal: AbortSignal): Promise<number | undefined> {
  try {
    const result = await ctx.jev.decide({
      state,
      questions: {
        speak: {
          type: 'noul',
          instructions: 'should the assistant say something now?',
          criteria: { true: 'speak up', false: 'stay quiet' },
        },
      },
      signal,
    })
    const answer = result.answers['speak']
    if (answer?.type !== 'noul') return undefined
    return answer.noul // 0..1 — the threshold is the consumer's to apply
  } catch (error: unknown) {
    if (error instanceof JevError) return undefined // fail closed, in the consumer
    throw error
  }
}
```

`signal` is optional and is the only hard bound on how long a call may take: a
consumer that must not block — an after-chat pass that re-checks before it
inserts anything — aborts a call it no longer wants, and a cancellation is never
retried.

## Failures

| Kind | Raised when | Retried |
| --- | --- | --- |
| `config` | The endpoint, model, bound or key is unusable. Raised while the plugin loads. | no — no call could succeed |
| `request` | This call is malformed. Nothing was sent. | no |
| `transport` | The network or TLS failed. | yes |
| `timeout` | No answer arrived within `timeoutMs`. | yes |
| `http` | The endpoint answered non-2xx; `status` carries it. | 408, 429 and 5xx |
| `protocol` | A 2xx body that is not the documented response: JSON that is not the envelope, a missing answer, an answer type the question did not ask for. | no |
| `cancelled` | `signal` fired, on the attempt or on the wait between attempts. | no |

A `retry-after` the endpoint sends is honored, though never beyond
`maxRetryDelayMs`: a longer one stops the call rather than blocking past the
bound the deployment configured. Each retry is logged with its attempt number
and reason.

## Compatibility

The package reaches the host through exactly two published packages: cordis (the
plugin and service API) and schemastery (row configuration). It imports no
`@deepseek-ai/dsh-*` package — `check:boundaries` fails the build if one appears
— so it is not tied to a DSH line, and `check:peers` reports it as having no DSH
peer line to certify.

| Dependency | Declared peer | Pinned and tested against |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `^4.0.1` | `4.0.4` |
| `@deepseek-ai/schemastery` | `^3.18.1` | `3.18.4` |

**The wire contract was exercised against the live endpoint on 2026-09-29**,
through this package's own built entry. One call carrying a `noul`, a `choice`
and a `score` question came back as `model: "jev-1.13.0"` with one answer per id,
`usage` holding `input_tokens` and `output_tokens`, and the members documented in
[`docs/architecture.md`](docs/architecture.md) — including a `score` `legend`
keyed by level number. The endpoint also accepted a `null` option description, a
`noul` criteria object, and structured entries inside a `criteria`; it rejected a
`score` whose `criteria` was a map with `422 Input should be a valid list`, and an
unusable key with `401`, which this package reports as a non-retried `http`
failure and never quotes the key into.

Not yet observed against the live service: any retry — no `429`, no 5xx and no
timeout has happened — and any route other than the vendor's own endpoint. Those
paths are covered offline through an injected transport.

The row was also mounted in a booted `headless` profile: it activated, a second
plugin declaring `inject: ['jev']` received `ctx.jev` with a callable `decide`,
and a malformed call made from inside that host was rejected as a `request`
failure. `--help` and `--dump-config` compose configuration without activating
anything, so neither proves a row works on its own.

Re-verify against a running DSH:

```sh
corepack pnpm --filter @wowyuarm/dsh-jev build
cat > /tmp/jev.yml <<'EOF'
- insert:
    - id: jev
      name: 'file:///absolute/path/to/dsh-plugins/packages/jev/lib/index.js'
      config: { apiKeyEnv: TYPESAFE_API_KEY }
EOF
dsh --profile <profile> --patch /tmp/jev.yml --help
```

A row that fails to import is reported on stderr as `N entry did not activate`
with its reason. To exercise a real call, add a second row that declares
`inject: ['jev']`, calls `ctx.jev.decide` once, and logs `result.model`: it
reports which model id answered, which is the one fact a pinned `model` cannot
tell you on its own.

## Development

```sh
corepack pnpm install
corepack pnpm --filter @wowyuarm/dsh-jev typecheck   # tsc, strict, no emit
corepack pnpm --filter @wowyuarm/dsh-jev test        # boundary guard + vitest, offline
corepack pnpm --filter @wowyuarm/dsh-jev build       # emits lib/
```

`src/` may import only its own relative modules, Node builtins, and the two
declared peers; `check:boundaries` enforces that, so the neutral seam cannot
quietly acquire a host dependency. The suite drives an injected transport and
needs no key and no network.

## License

MIT.
