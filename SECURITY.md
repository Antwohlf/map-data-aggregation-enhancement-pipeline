# Security

Do not commit credentials, production endpoints, hostnames, production paths,
raw source snapshots, review records, runtime state, logs, database copies, or
personal data.

The scaffold is default-deny: profiles are deployment-disabled, have no effect
policy or plugin-lock binding, and do not resolve ambient `.env` files.
Future apply deployments must bind a profile, stage, deployment identity,
exact target resource, operation, record bound, canonical plugin catalog, and
one host-owned capacity policy. The deployment also pins the exact definition
and profile-policy digests. Every mutation uses a broker-registered dataset
input or a one-shot output/state capability tied to an active stage invocation;
public writes additionally require post-read verification, unexpired ancestry,
and redistribution approval from every inherited source policy. Expired inputs
are rejected before plugin execution. The apply authorization context snapshots
and freezes verified inputs before a broker may use them, and the executor must
close each invocation in a `finally` boundary.

Direct database access must use product-owned, revocable roles. Prefer EXECUTE
on narrowly scoped product functions and PII-free views over raw table access.
No pipeline role receives DDL, DELETE, owner, migration, or unrelated-table
privileges.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting form](https://github.com/Antwohlf/map-data-aggregation-enhancement-pipeline/security/advisories/new).
Do not include production credentials, source payloads, personal data, or live
host details in a report unless the repository owner requests a secure transfer.
