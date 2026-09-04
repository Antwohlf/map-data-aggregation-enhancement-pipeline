# Public repository checklist

Before creating or pushing a public remote:

- Confirm public visibility and choose a license. **Complete:** public,
  Apache-2.0.
- Include only synthetic fixtures by default.
- For any third-party fixture, record origin, license, attribution,
  transformation, redistribution permission, and a NOTICE entry.
- Scan Git history and the working tree for secrets, endpoints, hostnames,
  production paths, logs, raw artifacts, database/WAL files, and personal data.
- Verify generated examples cannot resolve ambient credentials or enter apply.
- Verify signed release tags/commits and every plugin integrity lock before
  execution.
- Keep detailed live-host reconciliation in the owning app's private/local
  operations record, not this repository.

`npm run audit:public` enforces the working-tree path/content and fixture
manifest subset of this checklist. History and third-party legal review remain
explicit release gates.
