# Application boundary locks

APizzaMichigan and TacoBoutMichigan own their output contracts in the
`Antwohlf/apizzamichigan` application repository. This repository records a
non-authorizing observation of those contracts so cross-repository drift can be
detected without copying private-repository source files or assuming permission
to redistribute them.

The metadata-only locks are:

- `profiles/apizzamichigan/contracts/app-boundary-lock.v1.json`
- `profiles/tacoboutmichigan/contracts/app-boundary-lock.v1.json`

Each lock identifies an exact source repository, commit, path, byte length, and
SHA-256 digest of the raw file bytes. It covers the shared application boundary
configuration, the status schema, and the product-specific target contract.
Pizza and Taco intentionally have different target-contract digests.

## Observation is not authorization

`observedTargetContract.rawByteDigest` means only that exact bytes were
reviewed. It is kept separate from `targetContract.digest`, which is the
canonical, activation-authorizing digest consumed by apply readiness. The raw
digest and a canonical JSON digest are different constructions and must never
be substituted for one another.

All current application observations have `activationEligible: false`. The
corresponding profile activation targets remain unbound:

```json
{
  "supportedVersions": [],
  "digestKind": "sha256-canonical-json-v1",
  "digest": null
}
```

The observed target document must also say that external apply and external
authorization are disabled. A valid lock therefore cannot grant an effect,
enable a profile, select a deployment, or authorize a database operation.

Apply readiness does not yet consume an application-signed target-authorization
receipt covering the global boundary veto and the exact target resource. Until
that receipt contract exists, no app-owned observation can become an executable
write target.

## Verification

With an authorized checkout of the application repository available locally:

```sh
npm run verify:app-boundaries -- \
  --app-repository /absolute/path/to/apizzamichigan \
  --app-ref origin/main
```

The verifier performs no fetch and requires no GitHub token. It confirms that
the pinned commit is an ancestor of the selected ref, that both revisions still
contain the exact bytes, that JSON has no duplicate keys, that Pizza and Taco
identities cannot be swapped, and that application-level write authorization
remains disabled. It also confirms that Pizza legacy is the only registered
status lane; every Taco lane and every external shadow/apply lane must remain
unregistered until a later exact-binding contract is implemented.

The source repository was private when these locks were recorded. No source
artifact is vendored here, and the locks assert only metadata. If application
history is rewritten during public cleanup, repoint these locks to a public,
immutable contract-release commit containing the same reviewed raw bytes, or
perform a new review if the bytes change.

## Shadow execution identity

Read-only shadow runs use a separate `ShadowExecutionLock`. The host binds the
exact profile policy, dynamic pipeline definition, plugin catalog, host policy,
pipeline identity, and deployment identity before executor construction. The
executor recomputes every digest and fails before creating run state on a
mismatch. Successful reports carry that frozen identity bundle plus the runtime
policy digest so the application status boundary can eventually validate a
specific observed execution instead of accepting a syntactically valid digest.

This still does not make the shadow executable a production deployment: it has
read and preview-artifact effects only and no product-write authority.
