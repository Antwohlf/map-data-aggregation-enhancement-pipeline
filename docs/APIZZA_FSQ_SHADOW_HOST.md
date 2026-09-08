# APizza FSQ read-only shadow host

The APizza FSQ shadow runner is the first host-composed product pipeline in
this repository. It reads one exact FSQ OS Places projection and one
least-privileged PostgreSQL view, runs the APizza-owned normalization and
matching stages, and writes only private preview artifacts.

It cannot write the application database, review queue, or public API. The
legacy APizza pipeline remains authoritative.

## Fail-closed activation state

The checked-in source assertion at
`profiles/apizzamichigan/policy/fsq-os-places-shadow-policy.v1.json` is
approved for the owner's requested restricted read-only comparison. Compute its
current digest with `npm run digest:json --
profiles/apizzamichigan/policy/fsq-os-places-shadow-policy.v1.json` and pin that
digest in the private manifest. Pending or expired assertions remain rejected.

Foursquare documents FSQ OS Places as Apache-2.0 data and now delivers it
through the Places Portal. Those facts establish useful license evidence, but
do not prove the provenance or privacy classification of a particular
host-side projection:

- https://docs.foursquare.com/data-products/docs/fsq-places-open-source
- https://docs.foursquare.com/data-products/docs/access-fsq-os-places
- https://opensource.foursquare.com/places-notice-txt/

The owner identified the existing source as FSQ **OS Places**, corroborated by
the host's exporter configuration. The first comparison uses a historical host
snapshot, identified by its exact checksum. Its original upstream release version
is unknown; this run cannot establish freshness or official-release parity.
The approval retains `containsPii: true`, private derived artifacts, no raw
artifact retention, and no redistribution. It does not approve commercial FSQ
API data or authorize publication.

## Host-owned inputs

The host preparation helper `projectApizzaFsqHostRowsV1` projects up to 5,000
existing FSQ rows into the bounded input contract. It removes unapproved fields,
normalizes nullable values, excludes removal/privacy-flagged records, and reports
invalid-row counts. Closure dates and other flags are preserved for normalization.
This helper neither approves a source nor establishes its upstream release.

For historical captures, record the original file checksum, projected checksum,
selection rule, capture time, and any unknown upstream release information in a
private provenance record. A host file checksum identifies those exact bytes;
it must never be presented as a verified Foursquare release version.

None of these files belong in the public repository:

- the projected FSQ rows;
- the host manifest;
- the PostgreSQL connection string;
- SQLite state and generated preview artifacts.

The host manifest is an owner-only JSON file with this exact shape:

```json
{
  "schemaVersion": 1,
  "deploymentIdentity": "apizza-fsq-shadow-host-v1",
  "partition": "US",
  "runtimeRoot": "<absolute-normalized-private-runtime-directory>",
  "evaluationTime": "2026-09-07T12:00:00.000Z",
  "fallbackRetrievedAt": "2026-09-07T12:00:00.000Z",
  "expectedSourcePolicyDigest": "sha256:<approved-policy-digest>",
  "fsq": {
    "rootPath": "<absolute-normalized-private-input-directory>",
    "relativePath": "fsq-release.json",
    "expectedContentDigest": "sha256:<exact-file-byte-digest>",
    "childIds": ["host-snapshot:sha256:<original-file-digest>"],
    "maxRecords": 5000
  },
  "postgres": {
    "databaseInstanceId": "<database-owned-lowercase-uuid>",
    "viewDefinitionDigest": "sha256:<digest-of-pg-get-viewdef>",
    "pageSize": 500,
    "maxRowBytes": 65536
  }
}
```

The manifest and projection file must be regular, current-user-owned files
with no group or other permissions. Their containing input and runtime
directories must also be current-user-owned and private. Symbolic-link
substitution, unknown fields, policy drift, content drift, schema drift,
database identity drift, role drift, view-definition drift, and concurrent
runs all fail closed.

Database name, role, relation, columns, types, cursor, and contract digest are
derived from the checked-in
`profiles/apizzamichigan/contracts/canonical-match-v1.json`. The host
manifest cannot override them. Provision the narrow view and reader role using
the adjacent `provision-canonical-match-v1.sql` template.

## Run

Supply the dedicated read-only connection string through the
`APIZZA_SHADOW_DATABASE_URL` process environment using the host secret
manager, then run:

```sh
npm run preview:apizza-fsq-shadow -- \
  --host-manifest <owner-only-host-manifest> \
  --run-id <unique-run-id>
```

The process acquires one manifest-independent, per-user host lock before
reading the projection, so different runtime roots cannot bypass admission.
`SIGINT` and `SIGTERM` abort active broker operations, mark a started run
failed, close PostgreSQL and SQLite, and release the lock. A hard process kill
can leave a stale lock; inspect host state before removing it.

Successful stdout contains only run/binding digests and the terminal report
identity. It omits the DSN, input path, runtime path, and source rows.

## Still not a cutover

A successful run is parity evidence only. It does not register the app's
shadow status lane, enqueue human review, publish records, disable the legacy
writer, or authorize apply mode. Those require separate app-owned contracts,
receipts, and no-dual-writer gates.
