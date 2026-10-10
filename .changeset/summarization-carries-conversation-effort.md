---
'@contexera/dsh-context-continuity': patch
---

The summarization call now carries the reasoning effort the conversation chose.

An adapter resolves its effort as `options.reasoningEffort ?? profile.reasoning`, so a summarization request naming none did not run effort-free — it silently took the deployment's profile default. That level is configured for whatever model the profile usually serves, and against a model that does not support it the request path refuses rather than clamping. The result was the hard-limit reduction failing closed and blocking the turn on the very model every ordinary request of that turn had been using successfully, which reads as "switching the model did not take effect".

An effort the adapter itself materialized is not a conversation choice and is still not sent, for the same reason: the adapter would reject its own default against that model.
