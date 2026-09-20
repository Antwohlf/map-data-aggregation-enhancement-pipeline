// Public/manual inserts occupy IDs below one billion. Pipeline imports use
// a disjoint range, still within the int32 boundary of existing RPCs/queues.
export const PIPELINE_ID_MIN = 1_000_000_000;
export const PIPELINE_ID_MAX = 2_147_483_647;

export async function allocateNextCanonicalPlaceId(client, tableName) {
  if (!['pizza_places', 'taco_places'].includes(tableName)) throw new Error('Unsupported canonical table');
  // Caller must hold a transaction through the subsequent INSERT.
  await client.query(`LOCK TABLE ${tableName} IN EXCLUSIVE MODE`);
  const result = await client.query(`SELECT GREATEST(COALESCE(MAX(id), 0) + 1, ${PIPELINE_ID_MIN}) AS next_id FROM ${tableName}`);
  const id = Number(result.rows[0]?.next_id);
  if (!Number.isSafeInteger(id) || id < PIPELINE_ID_MIN || id > PIPELINE_ID_MAX) {
    throw new Error('Pipeline ID range exhausted or invalid; refusing canonical insert');
  }
  return id;
}
