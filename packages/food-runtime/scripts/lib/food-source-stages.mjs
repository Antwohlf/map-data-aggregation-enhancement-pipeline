// Trusted-host stage definitions for the legacy food source path. These nodes
// intentionally do not use the preview broker or claim opaque-plugin security.
export const FOOD_SOURCE_ADAPTER_IDS = Object.freeze({
  acquisition: Object.freeze({
    pizza: Object.freeze({ osm: 'food-source-osm-v1', fsq_os_places: 'food-source-fsq-os-places-v1', overture_places: 'food-source-overture-v1', wikidata: 'food-source-wikidata-v1' }),
    taco: Object.freeze({ osm: 'food-source-osm-v1', fsq_os_places: 'food-source-fsq-os-places-v1', overture_places: 'food-source-overture-taco-v1' }),
  }),
  match: 'food-source-legacy-match-v1',
  review: 'food-source-legacy-review-v1',
});

export function createFoodSourceStages({ entity, source, adapterIds = {}, acquire, match, review }) {
  if (!entity || !source || typeof acquire !== 'function' || typeof match !== 'function' || typeof review !== 'function') {
    throw new TypeError('Food source stages require entity, source, acquire, match, and review callbacks');
  }
  const acquisitionAdapter = adapterIds.acquisition;
  const matchAdapter = adapterIds.match;
  const reviewAdapter = adapterIds.review;
  const expectedAcquisition = FOOD_SOURCE_ADAPTER_IDS.acquisition[entity]?.[source];
  if (!acquisitionAdapter || acquisitionAdapter !== expectedAcquisition || matchAdapter !== FOOD_SOURCE_ADAPTER_IDS.match || reviewAdapter !== FOOD_SOURCE_ADAPTER_IDS.review) throw new TypeError(`Unknown food source adapter selection for ${entity}:${source}`);
  const definition = {
    schemaVersion: 1,
    id: `food-${entity}-${source}-source-run-v1`,
    stages: [
      { id: 'acquire', adapter: acquisitionAdapter, version: 1, kind: 'source', dependsOn: [], config: {} },
      { id: 'match', adapter: matchAdapter, version: 1, kind: 'transform', dependsOn: ['acquire'], config: {} },
      { id: 'review', adapter: reviewAdapter, version: 1, kind: 'review', dependsOn: ['match'], config: {} },
    ],
  };
  const registry = [
    { id: acquisitionAdapter, version: 1, kind: 'source', run: ({ context }) => acquire(context) },
    { id: matchAdapter, version: 1, kind: 'transform', run: ({ context, inputs }) => match(context, inputs) },
    { id: reviewAdapter, version: 1, kind: 'review', run: ({ context, inputs }) => review(context, inputs) },
  ];
  return { definition, registry };
}
