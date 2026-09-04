# Canonical JSON v1

Identity hashes accept only JSON values. Object keys are ordered by JavaScript
UTF-16 code units using ordinal `<`/`>` comparison; locale collation is never
used. Array order is significant. Numbers must be finite and are serialized by
ECMAScript `JSON.stringify`; strings are not normalized implicitly.

Identity components are non-empty, trimmed, and already NFC-normalized. Case
and internal whitespace are significant. The digest format is lowercase
`sha256:<64 hex>`.

This alpha scheme is versioned separately because a later RFC 8785/JCS adoption
would change digests. Cross-language adapters must pass the published vectors
before producing keys or checksums.

Golden vector:

```text
input object keys: é, z, a
canonical JSON: {"a":3,"z":2,"é":1}
digest: sha256:fa7ddcf43923b2711f2f592f210e5ab9e4a54a3b2df09830d93f402391a33e4e
```
