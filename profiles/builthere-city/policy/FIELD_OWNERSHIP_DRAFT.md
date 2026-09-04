# BuildHere v1 field ownership contract

Status: proposed fail-closed contract derived from the current BuildHere schema
and ingestion code. It must be published and versioned by `builthere.city`
before preview or apply. The owner has approved field-level overrides, legacy
Ann Arbor mapper parity, and stored-procedure writes through PII-free views.

Every mapped field uses a tagged patch: `absent`, `set(value)`, or
`clear(reason, authority)`. JSON null never means clear. On update, `absent` and
legacy mapper nulls are no-ops. Official sources have no clear/tombstone
authority in v1. Manual overrides may explicitly set nullable fields to null.

## Field matrix

| Fields | Owner | Create | Source update | Manual/clear | Conflict rule |
| --- | --- | --- | --- | --- | --- |
| `id` | system | Product contract creates the current CUID shape | Never | Never | Wrong shape/collision is a hard conflict |
| `createdAt` | system | Database create time | Never | Never | Any proposed change is rejected |
| `updatedAt` | system | Database create time | Only when effective business data changes | Only when effective business data changes | Replay/no-op preserves it |
| `city`, `sourceType`, `sourceId` | identity | Exact source identity | Never | Never | Missing/mismatched identity is quarantined; no cross-source/address merge |
| `title`, `address`, `category`, `scale`, `phase` | source with override | Exact legacy mapper value | Apply non-null value unless overridden | Append-only typed override; no null clear | Active override suppresses source proposal |
| `verification` | reviewed decision | Legacy source value (`VERIFIED` official, `RUMOR` community) | Source cannot replace a later decision | Generic override is disabled pending an owner decision | Conflicting assertion is quarantined |
| `description`, `neighborhood`, `zipCode`, `sourceUrl`, `estimatedCost`, `numUnits`, `numStories`, `permitType`, `zoningDesignation`, `submittedDate`, `approvedDate`, `completedDate` | source with override | Mapper value or SQL NULL | Non-null value unless overridden; null/absent is no-op | Append-only typed override, including explicit null | Invalid type/range/date is quarantined |
| `latitude`, `longitude` | source with atomic location override | Mapper pair or SQL NULL | Apply as one location operation unless overridden | Set/clear as one atomic location override | Invalid or partial operation is quarantined |
| `addressHash` | derived | Versioned common algorithm over effective `address` | Recompute atomically with effective address | Never independently editable | Supplied mismatch is quarantined |

Official identity keys remain `(ANN_ARBOR, PLANNING, PLANNUMBER)` and
`(DETROIT, PERMIT, record_id)`. Community publication uses
`(tip.city, COMMUNITY, tip.id)`; introducing the missing community `sourceId`
is an explicit idempotency migration. Same-address records with different
identity keys are not merged.

Ann Arbor create and update preserve current mapper behavior, including the
current status precedence and conversion of year-only values to January 1.
Corrections require a later transform version and reviewed backfill.

## Overrides, provenance, and conflicts

Overrides are append-only events: `created`, `superseded`, or `removed`. Each
stores field, typed value, actor, reason, expected project revision/value hash,
and base observation. Removing an override restores the latest valid stored
source proposal through this policy, never a stale Project value.

Each write command carries profile/source namespace/external ID, observation ID,
transform and policy versions, source/mapped payload digests, retrieval and
observation time, target-contract version, and tagged field patches. Store each
field's latest permitted source proposal and outcome: `applied`, `unchanged`,
`absent`, `suppressed_by_override`, or `rejected`.

The product-owned stored procedure locks the Project and active-override
projection in one transaction. Source/manual races serialize; a current manual
override wins while the suppressed source proposal is still recorded. Missing
identity, invalid value, address/hash mismatch, stale manual revision, or target
contract mismatch is a hard conflict. Override suppression is not a failed row.

Receipts contain Project ID, source idempotency key, mapped/effective before and
after hashes, per-field outcomes, consulted override IDs, contract/migration/
transform versions, transaction/write ID, and verification time. An ambiguous
retry with the same idempotency key and payload hash returns the same receipt.

## Community approval and publication

Approval conditionally moves `PENDING` to `APPROVED_PENDING_PUBLICATION` and
appends one immutable decision plus a PII-free outbox payload. Publication
claims that event, upserts by `(tip.city, COMMUNITY, tip.id)`, links the Tip,
writes an immutable receipt, and moves to `PUBLISHED` in one transaction.
Replay returns the existing receipt. Submitter name/email never enter the view,
event, command, artifact, or logs.

Before the first apply, audit production Projects for edits made outside the
current application. Any such changes must be reviewed and seeded as override
events; otherwise the initial override set is empty.
