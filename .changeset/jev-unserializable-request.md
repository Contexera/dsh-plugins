'@contexera/dsh-jev': patch
---

Classify an unserializable request before it is retried.

`buildWireBody` returned the object to send and left `JSON.stringify` to the
transport, so a parameter the vendor cannot represent — `NaN`, a `BigInt`, a
cycle — surfaced as a transport failure and was retried three times, sending
the request zero times and reporting a network error. Serialization now
happens in `request`, and its failure is a `JevError` of kind `request`,
which the retry policy does not cover.
