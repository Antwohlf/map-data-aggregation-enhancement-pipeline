# Source data and retention policy

This repository contains synthetic fixtures only. A public source adapter does
not imply permission to retain or redistribute its results.

For production deployments, each source/profile pair requires an approved terms
reference, allowed-field list, attribution rule, artifact policy, and retention
value. Until that review is complete, the source stays `pending`, its artifact
policy stays `forbidden`, and its retention is effectively zero.

When source terms permit operational raw artifacts, the provisional maximum is
30 days. A shorter source-specific or legal limit always wins. Durable review
evidence must be a permitted minimal projection with its own declared policy;
retention of a checksum never justifies retaining prohibited source content.

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
