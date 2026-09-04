# Synthetic examples

These files exercise structural and semantic validation only. The plugin
catalog digests are correctly shaped placeholders, not verified package hashes,
and no executor may load this catalog. The example reads only a synthetic
fixture capability and requests preview artifact output; it has no network or
database target.

Apply deployments will resolve a trusted lock from an installed signed profile
release rather than accepting the development `--catalog` override.
