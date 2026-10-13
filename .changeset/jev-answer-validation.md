---
'@contexera/dsh-jev': patch
---

Validate the members a Jev answer declares, not just its envelope.

The response parser checked the envelope and each answer's `type` tag, but the
members `JevAnswer` declares were taken on trust, so an answer such as
`{ type: 'noul', noul: 'high' }` reached a consumer as a typed success and only
failed later, at the point a threshold was applied to it.

Each answer's declared members are now checked: `noul` is a finite number in
`0..1`; `choice` carries a string `choice`, an object of finite probabilities in
`0..1`, and a finite `confidence` in `0..1`; `score` carries finite `score` and
`confidence`, and object `legend` and `probabilities` whose values are finite
numbers in `0..1`. A missing or malformed member is a `protocol` failure, which
is never retried.

Fields the vendor adds beyond the declaration are kept rather than rejected, so a
passthrough provider still does not refuse an answer the vendor considers valid.
