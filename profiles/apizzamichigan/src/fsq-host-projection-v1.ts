import type { CanonicalJson } from "@map-pipeline/core";
import {
  APIZZA_FSQ_RELEASE_ROW_KEYS,
  containsForbiddenRemovalOrPrivacyFlag,
  validateApizzaFsqReleaseRowsV1,
  type ApizzaFsqReleaseRowV1,
} from "./fsq-release-v1.js";
import { APIZZA_MATCHING_V1_MAX_CANDIDATES } from "./matching-v1.js";

/** Host preparation only: this does not approve source provenance or run a pipeline. */
export function projectApizzaFsqHostRowsV1(input: CanonicalJson): {
  rows: ApizzaFsqReleaseRowV1[];
  counts: { input: number; projected: number; excludedRemovalOrPrivacy: number; rejectedInvalid: number };
} {
  if (!Array.isArray(input) || input.length > APIZZA_MATCHING_V1_MAX_CANDIDATES) {
    throw new TypeError("FSQ host preparation requires an array of at most 5000 rows");
  }
  const rows: ApizzaFsqReleaseRowV1[] = [];
  let excludedRemovalOrPrivacy = 0;
  let rejectedInvalid = 0;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      rejectedInvalid++;
      continue;
    }
    if (containsForbiddenRemovalOrPrivacyFlag(item.unresolved_flags)) {
      excludedRemovalOrPrivacy++;
      continue;
    }
    const row: Record<string, CanonicalJson> = {};
    for (const key of APIZZA_FSQ_RELEASE_ROW_KEYS) {
      const value = item[key];
      if (["fsq_category_ids", "fsq_category_labels", "unresolved_flags"].includes(key)) {
        row[key] = value === null || value === undefined ? [] : structuredClone(value);
      } else if (typeof value === "string") {
        row[key] = value.trim() || null;
      } else {
        row[key] = value ?? null;
      }
    }
    try {
      validateApizzaFsqReleaseRowsV1([row]);
    } catch {
      rejectedInvalid++;
      continue;
    }
    rows.push(row as unknown as ApizzaFsqReleaseRowV1);
  }
  return { rows, counts: { input: input.length, projected: rows.length, excludedRemovalOrPrivacy, rejectedInvalid } };
}
