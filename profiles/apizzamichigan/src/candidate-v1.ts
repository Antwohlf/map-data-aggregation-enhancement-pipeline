/** Pure APizza profile-domain contract shared by source normalizers and matchers. */

export const APIZZA_SOURCE_CANDIDATE_SCHEMA = {
  name: "apizza.source-candidate",
  version: 1,
} as const;

export type ApizzaCandidateRouteV1 =
  | "ready_for_match"
  | "closed_evidence_candidate"
  | "filtered_non_pizza"
  | "excluded_unusable"
  | "excluded_out_of_scope";

export interface ApizzaCandidateRoutingPayloadV1 {
  name: string | null;
  lat: number | null;
  lng: number | null;
  region: string | null;
  website: string | null;
  source_url: string | null;
  categories: string[];
  is_closed: boolean;
}

const APIZZA_V1_PIZZA_TERMS = [
  "apizza",
  "flatbread",
  "italian restaurant",
  "pizza",
  "pizzeria",
  "slice",
  "wood fired",
  "wood-fired",
];

const APIZZA_V1_SCOPE = [
  { bbox: [41.6, -90.5, 48.4, -82.1], regionCodes: [] },
  { bbox: [40.4, -79.8, 45.1, -71.7], regionCodes: ["NY"] },
  { bbox: [32.4, -124.5, 42.1, -114.1], regionCodes: [] },
  { bbox: [25.8, -106.7, 36.6, -93.5], regionCodes: [] },
] as const;

export function normalizeApizzaCandidateTextV1(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isWithinApizzaV1Scope(payload: ApizzaCandidateRoutingPayloadV1): boolean {
  if (payload.lat === null || payload.lng === null) return false;
  return APIZZA_V1_SCOPE.some(({ bbox, regionCodes }) => {
    const [south, west, north, east] = bbox;
    if (
      payload.lat! < south || payload.lat! > north ||
      payload.lng! < west || payload.lng! > east
    ) return false;
    if (!regionCodes.length) return true;
    const region = String(payload.region ?? "").trim().toUpperCase();
    return !region || (regionCodes as readonly string[]).includes(region);
  });
}

function isApizzaV1PizzaCandidate(payload: ApizzaCandidateRoutingPayloadV1): boolean {
  const haystack = normalizeApizzaCandidateTextV1([
    payload.name,
    payload.categories.join(" "),
    payload.website,
    payload.source_url,
  ].join(" "));
  return APIZZA_V1_PIZZA_TERMS.some((term) => haystack.includes(term));
}

export function classifyApizzaCandidateRouteV1(
  payload: ApizzaCandidateRoutingPayloadV1,
): ApizzaCandidateRouteV1 {
  if (!payload.name || payload.lat === null || payload.lng === null) {
    return "excluded_unusable";
  }
  if (!isWithinApizzaV1Scope(payload)) return "excluded_out_of_scope";
  if (!isApizzaV1PizzaCandidate(payload)) return "filtered_non_pizza";
  return payload.is_closed ? "closed_evidence_candidate" : "ready_for_match";
}
