// Holds are explicit, auditable review decisions. An unavailable registry is
// an error, not permission to publish. Identity checks still run for every
// unheld row, including dry runs and lifecycle-only updates.
export async function readPublicationHolds(client, entity, requestedIds = []) {
  const { rows } = await client.query(`SELECT place_id, reason FROM publication_holds
    WHERE entity_type = $1 AND released_at IS NULL ORDER BY place_id`, [entity]);
  const ids = rows.map(row => String(row.place_id));
  const requested = new Set(requestedIds.map(String));
  const blocked = rows.filter(row => requested.has(String(row.place_id)));
  if (blocked.length) throw new Error(`Publication held for review: ${blocked.map(row => `${entity}:${row.place_id} (${row.reason})`).join(', ')}`);
  return { ids, rows };
}
