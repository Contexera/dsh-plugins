# dsh-context-continuity — one continuous context across many Sessions

[English](README.md) | [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@wowyuarm/dsh-context-continuity?style=flat-square)](https://www.npmjs.com/package/@wowyuarm/dsh-context-continuity)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**Let a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent
manage its own context, and turn its past Sessions into context it can draw on.**

## The problem

Every Session eventually fills up. It gets compacted, or it rolls over into a new
one — and the agent loses the thread. Whatever it was working on, whatever it had
figured out, is now on the other side of a wall.

This plugin gives an agent the tools to carry itself across that wall on its own:
when a Session is getting full, it writes a quick handoff and keeps going in a
fresh one as the same agent; it can mark a spot to come back to; and — with the
optional search tools mounted — it can search back through its earlier Sessions and
pull out what it said or did. Any agent that runs long enough to fill a Session can
use it — a
[Loom](https://github.com/wowyuarm/Loom) individual, an
[Agent Team](https://github.com/wowyuarm/dsh-agent-team) member, a coding agent on
a long task.

## What the agent gets

Three tools it can call, plus one automatic safeguard — these ship ready to use, so
every plugin that adopts this gives its agents the same set:

- **`context_rollover`** — start a fresh Session but stay the same agent, carrying
  a handoff you write into the new one.
- **`context_checkpoint`** — mark the current spot so you can come back to it.
- **`context_timeline`** — look back over your own history and pick a spot that's
  safe to return to.
- **pressure handling** — a heads-up when a Session is filling up, and a safe
  fallback at the limit, so the agent is never forced to switch at a bad moment.

Two more are **opt-in** — the agent only gets them if you mount `createSearchTools`
yourself:

- **`context_search`** — search your earlier Sessions for something you said or did.
- **`context_read`** — open one search result and read around it.

They are kept separate because they ask more of your setup than the core does. You
supply a `session-query` port — the published `@deepseek-ai/dsh-session-query`
contract they are typed against, and the peer this package declares for it — plus
which past Sessions each subject is allowed to search. The deployment has to hold up
its end too: the ladder reads the Harness Session index, so a deployment that leaves
that index closed fails closed instead of returning results. The wiring is seam 7 of
[`docs/integration.md`](docs/integration.md).

## How it works

The Harness already knows how to fork a Session, start a new one from an old one,
and treat the Session log as the source of truth. This plugin doesn't rebuild any
of that — it adds the one thing on top the Harness leaves out: tying a string of
Sessions together as the same agent over time. It handles the hard parts (the
switch itself, the safety checks, working out which past spots are safe to return
to) and asks your plugin only for what it can't figure out on its own. The
reasoning is in [`docs/principles.md`](docs/principles.md).

## Using it in your plugin

You tell it who your agent is and how to run a Session switch in your own setup —
plus, if you mount the search tools, which past Sessions each subject is allowed to
search. It does the rest. The step-by-step guide, with code, is
[`docs/integration.md`](docs/integration.md).

## Development

```bash
npm install
npm test          # package boundary check + unit tests
npm run typecheck # strict TypeScript, no emit
npm run build     # emit lib/
```

Tests run against the published `@deepseek-ai/dsh-*` packages — no sibling Harness
checkout, so the whole suite finishes in well under a second.
