#!/usr/bin/env node
import pg from 'pg';

const hours = Number(process.argv[2] || 2);
const entity = String(process.env.APIZZA_SYNC_ENTITY || process.argv[3] || 'pizza').toLowerCase();
if (!['pizza', 'taco'].includes(entity)) throw new Error('Entity must be pizza or taco');
const table = entity === 'taco' ? 'taco_places' : 'pizza_places';
const client = new pg.Client({ host: 'localhost', database: 'pizza_enrichment', user: process.env.PGUSER || process.env.USER });
await client.connect();
const result = await client.query(`
  INSERT INTO place_sources (entity_type, place_id, source, source_id, source_url, license, attribution, data, match_confidence, match_method, retrieved_at, updated_at)
  SELECT $2, id, 'official_website', CONCAT('place:', id), website_url, 'first-party-factual-evidence', 'official restaurant website',
         jsonb_build_object('website', website_url, 'phone', phone, 'menu_url', menu_url, 'email', email, 'hours', hours,
                            'delivery', delivery, 'takeaway', takeaway, 'scrape_method', scrape_method),
         1.0, 'scraped_first_party', COALESCE(last_enriched_at, NOW()), NOW()
  FROM ${table}
  WHERE scrape_method IN ('fetch', 'browser')
    AND website_url IS NOT NULL
    AND COALESCE(last_enriched_at, updated_at, NOW()) >= NOW() - ($1::text || ' hours')::interval
  ON CONFLICT (entity_type, source, source_id) DO UPDATE SET
    place_id = EXCLUDED.place_id,
    source_url = EXCLUDED.source_url,
    data = EXCLUDED.data,
    retrieved_at = EXCLUDED.retrieved_at,
    updated_at = NOW()
  RETURNING id
`, [String(hours), entity]);
console.log(`official_website provenance rows upserted: ${result.rowCount}`);
await client.end();
