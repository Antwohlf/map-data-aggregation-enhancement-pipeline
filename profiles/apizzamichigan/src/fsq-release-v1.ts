import type { CanonicalJsonValidator } from "@map-pipeline/core";

export const APIZZA_FSQ_RELEASE_ROWS_SCHEMA = {
  name: "apizza.fsq-release-rows",
  version: 1,
} as const;

export interface ApizzaFsqReleaseRowV1 {
  fsq_place_id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string | null;
  locality: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  tel: string | null;
  website: string | null;
  fsq_category_ids: string[];
  fsq_category_labels: string[];
  date_closed: string | null;
  unresolved_flags: string[];
}

export const APIZZA_FSQ_RELEASE_ROW_KEYS = [
  "fsq_place_id",
  "name",
  "latitude",
  "longitude",
  "address",
  "locality",
  "region",
  "postcode",
  "country",
  "tel",
  "website",
  "fsq_category_ids",
  "fsq_category_labels",
  "date_closed",
  "unresolved_flags",
] as const;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...APIZZA_FSQ_RELEASE_ROW_KEYS].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function boundedText(value: unknown, maxBytes: number, nullable = true): boolean {
  return (value === null && nullable) ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.trim() === value &&
      Buffer.byteLength(value, "utf8") <= maxBytes);
}

function boundedStrings(value: unknown, maxItems: number, maxBytes: number): boolean {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => boundedText(item, maxBytes, false));
}

function isCanonicalDate(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return !Number.isNaN(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === value;
  }
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

const FORBIDDEN_REMOVAL_OR_PRIVACY_FLAGS = new Set([
  "delete",
  "doesntexist",
  "inappropriate",
  "privatevenue",
]);

export function containsForbiddenRemovalOrPrivacyFlag(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((flag) => typeof flag === "string" &&
    FORBIDDEN_REMOVAL_OR_PRIVACY_FLAGS.has(flag.toLowerCase().replace(/[^a-z]+/g, "")));
}

export const validateApizzaFsqReleaseRowsV1: CanonicalJsonValidator = (value) => {
  if (!Array.isArray(value)) {
    throw new TypeError("FSQ release rows must be an array of objects");
  }
  for (const [index, row] of value.entries()) {
    assertRecord(row, `FSQ release row ${index}`);
    if (
      !hasExactKeys(row) ||
      !boundedText(row.fsq_place_id, 256, false) ||
      !boundedText(row.name, 1_024, false) ||
      typeof row.latitude !== "number" ||
      !Number.isFinite(row.latitude) ||
      row.latitude < -90 ||
      row.latitude > 90 ||
      typeof row.longitude !== "number" ||
      !Number.isFinite(row.longitude) ||
      row.longitude < -180 ||
      row.longitude > 180 ||
      !boundedText(row.address, 2_048) ||
      !boundedText(row.locality, 512) ||
      !boundedText(row.region, 256) ||
      !boundedText(row.postcode, 64) ||
      !boundedText(row.country, 128) ||
      !boundedText(row.tel, 128) ||
      !boundedText(row.website, 2_048) ||
      !boundedStrings(row.fsq_category_ids, 128, 128) ||
      !boundedStrings(row.fsq_category_labels, 128, 512) ||
      !isCanonicalDate(row.date_closed) ||
      !boundedStrings(row.unresolved_flags, 128, 256) ||
      containsForbiddenRemovalOrPrivacyFlag(row.unresolved_flags)
    ) {
      throw new TypeError(`FSQ release row ${index} does not match the bounded v1 projection`);
    }
  }
};
