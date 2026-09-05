# Source data and retention policy

This repository contains synthetic fixtures only. A public source adapter does
not imply permission to retain or redistribute its results.

For production deployments, each source/profile pair requires an approved terms
reference, exact resource-URI allowlist, allowed schema and field lists,
attribution rule, artifact policy, and retention value. Until that review is
complete, the source stays `pending`, its resource/schema allowlists stay
empty, its artifact policy stays `forbidden`, and its retention is effectively
zero.

When source terms permit operational raw artifacts, the provisional maximum is
30 days. A shorter source-specific or legal limit always wins. Durable review
evidence must be a permitted minimal projection with its own declared policy;
retention of a checksum never justifies retaining prohibited source content.

Every source stage binds each output port to one policy, one complete read
effect (class, resource, and operations), and one artifact class: `raw`,
`derived`, or `review_evidence`. No source read or output may be unlabeled or
bound twice. Sources with independently
licensed children, such as All the Places spiders or snapshots, also bind the
exact observed child IDs; each must have a distinct child-ID-to-terms-reference
entry in the approved profile policy. A generic terms link cannot authorize an
unrelated child.

The runtime broker records that complete binding on every finalized dataset.
It derives observed child identities, output schema, payload field names,
digests, and record count from the registered acquisition rather than accepting
them as plugin claims. A finalized schema and every field must appear on the
source policy's allowlists; this prevents a website body from being relabeled
as derived evidence.
Raw, derived, and review-evidence references include an expiry calculated from
the shorter of the approved source retention and the applicable provisional
ceiling. Plugins cannot select `audit_metadata`. Only the runtime broker may
create non-expiring audit metadata, using its fixed versioned schema and exact
minimal field set without source payload ancestry.

Derived and reviewed artifacts retain immutable source-policy ancestry. Their
expiry cannot exceed the earliest parent expiry; redistribution is forbidden
if any parent forbids it; and all parent attribution references survive.
Canonical/public mutation requests carry a registered dataset subject, and a
public write is denied unless that subject is unexpired and every inherited
policy approves redistribution.

Special restrictions:

- Community-tip submitter names, email addresses, and other PII are excluded
  from ordinary pipeline artifacts and logs. Pipelines consume a PII-free
  approval event only.
- Raw official-website bodies are not ordinary artifacts. Retain only approved
  field-level evidence and provenance needed for review.
- Third-party fixtures cannot enter this public repository without recorded
  origin, license, attribution, transformation, redistribution review, and a
  matching fixture-manifest entry.
- A legal hold or pending delivery can extend retention only when the underlying
  source policy permits it. Otherwise the workflow must preserve a permitted
  projection or reacquire the source.

The initial inventory requiring source-by-source review is:

| Source class | Post-approval artifact intent | Raw max | Derived/review max | Additional gate |
| --- | --- | ---: | ---: | --- |
| OSM | Required durability boundary | 30 days | 30 days after terminal review | Pinned terms and attribution |
| FSQ open data | Derived only by default | 0 days | 30 days after terminal review | Raw export requires an explicit terms exception |
| Overture | Required durability boundary | 30 days | 30 days after terminal review | Pinned terms and attribution |
| All the Places | Derived only | 0 days | 30 days after terminal review | Per-snapshot/per-spider upstream terms manifest |
| Wikidata | Required durability boundary | 30 days | 30 days after terminal review | Pinned terms and attribution |
| Official website | Derived only | 0 days | 30 days after terminal review | Ephemeral fetch; no bodies, screenshots, cookies, query strings, or headers |
| Detroit/Ann Arbor ArcGIS | Required durability boundary | 30 days | 30 days after terminal review | City/source-specific terms review |
| Community-tip decision | Derived PII-free event only | 0 days | 30 days after terminal review | Submitter PII excluded at the product view |

These intentions are duplicated in each product profile even where two
profiles may reference the same reviewed terms document. Approval in one
profile never activates the other.
