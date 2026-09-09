#!/usr/bin/env node
/**
 * Link high-confidence ambiguous source review rows to their nearest canonical
 * place. Default mode is read-only. With --apply, this only writes local
 * source_review_queue decisions and place_sources evidence; it never creates
 * canonical places, promotes fields, or syncs to Supabase.
 */

import pg from 'pg';
import { resolve } from 'path';
import { summarizeDatabaseError } from '../lib/source-freshness-status.mjs';
import { loadRuntimeEnvironment } from '../lib/runtime-environment.mjs';

const ENTITY_TABLES = {
  pizza: 'pizza_places',
  taco: 'taco_places',
};

const BRAND_RULES = [
  {
    id: 'papa_murphys',
    source: 'all_the_places',
    reportFile: 'papa_murphys-review.json',
    nearestNamePattern: '^Papa Murph',
    maxDistanceM: 25,
  },
  {
    id: 'dominos',
    source: 'all_the_places',
    reportFile: 'dominos_pizza_us-review.json',
    nearestNamePattern: '^Domino',
    maxDistanceM: 100,
  },
  {
    id: 'dominos_typos',
    source: 'all_the_places',
    reportFile: 'dominos_pizza_us-review.json',
    nearestNamePattern: "^(Domoino|Domiono)'?s?$",
    maxDistanceM: 25,
    sourceNamePattern: "^Domino's Pizza$",
  },
  {
    id: 'california_pizza_kitchen',
    source: 'all_the_places',
    reportFile: 'california_pizza_kitchen-review.json',
    nearestNamePattern: '^Cal+ifornia Pizza Kit?chen',
    maxDistanceM: 100,
  },
  {
    id: 'papa_johns',
    source: 'all_the_places',
    reportFile: 'papa_johns-review.json',
    nearestNamePattern: '^Papa Johns$',
    maxDistanceM: 25,
  },
  {
    id: 'papa_johns_variants',
    source: 'all_the_places',
    reportFile: 'papa_johns-review.json',
    nearestNamePattern: "^Papa John'?s( Pizza)?$|^Papa Jones$",
    maxDistanceM: 25,
    sourceNamePattern: "^Papa John's$",
  },
  {
    id: 'pizza_hut_variants',
    source: 'all_the_places',
    reportFile: 'pizza_hut_us-review.json',
    nearestNamePattern: '^Pizza Hut( Delivery| Express)?$',
    maxDistanceM: 100,
    sourceNamePattern: '^Pizza Hut$',
  },
  {
    id: 'pizza_hut_express',
    source: 'all_the_places',
    reportFile: 'pizza_hut_us-review.json',
    nearestNamePattern: '^Pizza Hut',
    maxDistanceM: 100,
    sourceNamePattern: '^Pizza Hut Express$',
  },
  {
    id: 'simple_simons',
    source: 'all_the_places',
    reportFile: 'simple_simons_pizza_us-review.json',
    nearestNamePattern: '^Simple Simons Pizza$',
    maxDistanceM: 25,
  },
  {
    id: 'foxs_pizza',
    source: 'all_the_places',
    reportFile: 'foxs_pizza-review.json',
    nearestNamePattern: '^Fox',
    maxDistanceM: 100,
    sourceNamePattern: 'Fox',
  },
  {
    id: 'and_pizza',
    source: 'all_the_places',
    reportFile: 'and_pizza-review.json',
    nearestNamePattern: '^& ?pizza$',
    maxDistanceM: 25,
  },
  {
    id: 'round_table_pizza',
    source: 'all_the_places',
    reportFile: 'round_table_pizza-review.json',
    nearestNamePattern: '^Round Table Pizza',
    maxDistanceM: 100,
  },
  {
    id: 'little_caesars',
    source: 'all_the_places',
    reportFile: 'little_caesars_us-review.json',
    nearestNamePattern: "^Little C(aesars?|aesers?|easars?|easers?|esars?|esar'?s|aesar'?s)",
    maxDistanceM: 25,
  },
  {
    id: 'larosas',
    source: 'all_the_places',
    reportFile: 'larosas-review.json',
    nearestNamePattern: "^LaRosa['’]?s",
    maxDistanceM: 25,
  },
  {
    id: 'mod_pizza',
    source: 'all_the_places',
    reportFile: 'mod_pizza-review.json',
    nearestNamePattern: '^MOD Pizza$',
    maxDistanceM: 100,
    sourceNamePattern: '^MOD Pizza',
  },
  {
    id: 'monicals_pizza',
    source: 'all_the_places',
    reportFile: 'monicals_pizza_us-review.json',
    nearestNamePattern: "^Monical['’]?s( Pizza)?$",
    maxDistanceM: 100,
    sourceNamePattern: "^Monical['’]?s Pizza",
  },
  {
    id: 'marcos_variants',
    source: 'all_the_places',
    reportFile: 'marcos-review.json',
    nearestNamePattern: "^Marco['’]?s( Pizza| Pizaa)?$",
    maxDistanceM: 100,
    sourceNamePattern: "^Marco['’]?s Pizza$",
  },
  {
    id: 'bc_pizza',
    source: 'all_the_places',
    reportFile: 'bc_pizza-review.json',
    nearestNamePattern: '^BC Pizza$',
    maxDistanceM: 25,
  },
];

function parseArgs(argv) {
  const args = {
    entity: 'pizza',
    source: null,
    reportFile: null,
    minNameScore: 0.98,
    maxDistanceM: 100,
    brandRules: false,
    includeScoreDistance: false,
    exactIdentifiers: false,
    exactSourceId: false,
    sourceIdentity: false,
    minExactIdentifiers: 3,
    ids: [],
    limit: 100,
    apply: false,
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--entity') args.entity = argv[++i];
    else if (arg === '--source') args.source = argv[++i];
    else if (arg === '--report-file') args.reportFile = argv[++i];
    else if (arg === '--min-name-score') args.minNameScore = parseFloat(argv[++i]);
    else if (arg === '--max-distance-m') args.maxDistanceM = parseFloat(argv[++i]);
    else if (arg === '--brand-rules') args.brandRules = true;
    else if (arg === '--include-score-distance') args.includeScoreDistance = true;
    else if (arg === '--exact-identifiers') args.exactIdentifiers = true;
    else if (arg === '--exact-source-id') args.exactSourceId = true;
    else if (arg === '--source-identity') args.sourceIdentity = true;
    else if (arg === '--min-exact-identifiers') args.minExactIdentifiers = parseInt(argv[++i], 10);
    else if (arg === '--ids') args.ids = parseIds(argv[++i]);
    else if (arg === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!ENTITY_TABLES[args.entity]) throw new Error('Invalid --entity. Use pizza or taco.');
  if (!Number.isFinite(args.minNameScore) || args.minNameScore < 0 || args.minNameScore > 1) {
    throw new Error('Invalid --min-name-score. Use a number from 0 to 1.');
  }
  if (!Number.isFinite(args.maxDistanceM) || args.maxDistanceM <= 0) {
    throw new Error('Invalid --max-distance-m.');
  }
  if (!Number.isInteger(args.minExactIdentifiers) || args.minExactIdentifiers !== 3) {
    throw new Error('Invalid --min-exact-identifiers. Exact identifier mode requires all 3 identifiers.');
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) throw new Error('Invalid --limit.');

  return args;
}

function parseIds(value) {
  const ids = String(value || '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(Number.isFinite);
  if (!ids.length) throw new Error('Invalid --ids. Use a comma-separated list of numeric source_review_queue ids.');
  return [...new Set(ids)];
}

function printHelp() {
  console.log(`Usage: node scripts/ops/auto-link-source-review-queue.mjs [options]

Options:
  --entity <pizza|taco>          Entity type (default pizza)
  --source <key>                 Optional source filter
  --report-file <file>           Optional source review report filter
  --min-name-score <n>           Minimum nearest_name_score, 0-1 (default 0.98)
  --max-distance-m <n>           Maximum nearest distance in meters (default 100)
  --brand-rules                  Use explicit report/brand rules only
  --include-score-distance       Add the generic name/distance class to brand rules
  --exact-identifiers            Require exact address, phone, store URL, and nearby location
  --min-exact-identifiers <n>    Compatibility flag; exact mode requires 3 (default 3)
  --exact-source-id              Require an exact OSM source ID and unchanged source name
  --source-identity              Require an exact Wikidata brand identity and nearby location
  --ids <ids>                    Exact reviewed source_review_queue ids to link
  --limit <n>                    Candidate limit (default 100)
  --apply                        Link the bounded candidate set
  --json                         Emit JSON instead of Markdown

Default mode is read-only. This considers only pending ambiguous review rows
with an existing nearest canonical place, no existing place_sources row for the
same source id, a high name score, and a short distance. Apply mode updates only
local provenance/review tables.

Brand rules are intentionally explicit and narrow. They are for cases where the
source spider/report proves the brand but the source and canonical display names
use incompatible variants, such as Papa Murphy's ATP rows named "Pizza Takeout &
Delivery" or "Domino's Pizza" source rows nearest to "Domino's".

Exact identifier mode is limited to all_the_places by default and requires an
exact official store URL plus the configured number of corroborating identifiers
and nearby location. Production runs use all three core identifiers (address,
phone, and store-specific URL). It is intended for deterministic official-chain
links, not generic fuzzy matching.

Source-identity mode is limited to Wikidata brand identities. It only links an
unreviewed canonical place when the source QID matches the canonical brand QID,
the location is within 25m, and both Latin labels are not in conflict.
`);
}

function dbConfig() {
  const env = loadRuntimeEnvironment();

  return {
    host: env.LOCAL_DB_HOST || env.PGHOST || 'localhost',
    port: parseInt(env.LOCAL_DB_PORT || env.PGPORT || '5432', 10),
    database: env.LOCAL_DB_NAME || env.PGDATABASE || 'pizza_enrichment',
    user: env.LOCAL_DB_USER || env.PGUSER || process.env.USER,
    password: env.LOCAL_DB_PASSWORD || env.PGPASSWORD || '',
  };
}

function table(headers, rows) {
  if (!rows.length) return '_none_';
  const escape = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${headers.map(header => escape(row[header])).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function sourceMetadata(source) {
  const registry = {
    all_the_places: {
      license: 'CC0-1.0',
      attribution: 'All the Places contributors',
    },
    fsq_os_places: {
      license: 'Apache-2.0',
      attribution: 'Copyright Foursquare Labs, Inc.',
    },
    osm: {
      license: 'ODbL-1.0',
      attribution: 'OpenStreetMap contributors',
    },
    overture_places: {
      license: 'see-release-attribution',
      attribution: 'Overture Maps Foundation and source contributors',
    },
    wikidata: {
      license: 'CC0-1.0',
      attribution: 'Wikidata contributors',
    },
    government_open_data: {
      license: 'dataset-specific',
      attribution: 'dataset-specific',
    },
    denue: {
      license: 'verify-before-import',
      attribution: 'INEGI DENUE',
    },
    official_website: {
      license: 'first-party-factual-evidence',
      attribution: 'official restaurant website',
    },
  };
  return registry[source] || { license: 'source-specific', attribution: source };
}

async function tableExists(client, tableName) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
    ) AS exists
  `, [tableName]);
  return Boolean(result.rows[0]?.exists);
}

function reviewedSourceData(row, reviewerNotes) {
  return {
    ...(row.source_data || {}),
    review: {
      queue_id: row.id,
      review_kind: row.review_kind,
      decision: 'auto_linked',
      reviewed_by: 'ops:auto-link-source-review-queue',
      reviewer_notes: reviewerNotes,
      linked_place_id: row.nearest_place_id,
      nearest_place_id: row.nearest_place_id,
      nearest_place_name: row.nearest_place_name,
      nearest_distance_m: row.nearest_distance_m == null ? null : Number(row.nearest_distance_m),
      nearest_name_score: row.nearest_name_score == null ? null : Number(row.nearest_name_score),
      review_reason: row.review_reason || null,
    },
  };
}

function brandRuleSql(values) {
  const eligibility = [];
  const reasons = [];

  for (const rule of BRAND_RULES) {
    const sourceParam = values.push(rule.source);
    const reportParam = values.push(rule.reportFile);
    const distanceParam = values.push(rule.maxDistanceM);
    const nearestNameParam = values.push(rule.nearestNamePattern);
    const sourceNameClause = rule.sourceNamePattern
      ? `AND srq.source_name ~* $${values.push(rule.sourceNamePattern)}`
      : '';
    const condition = `(
      srq.source = $${sourceParam}
      AND srq.report_file = $${reportParam}
      AND srq.nearest_distance_m <= $${distanceParam}
      AND srq.nearest_place_name ~* $${nearestNameParam}
      ${sourceNameClause}
    )`;
    eligibility.push(condition);
    reasons.push(`WHEN ${condition} THEN 'brand_rule:${rule.id}'`);
  }

  return { eligibility, reasons };
}

async function fetchCandidates(client, args) {
  const tableName = ENTITY_TABLES[args.entity];
  const values = [args.entity, args.minNameScore, args.maxDistanceM];
  const filters = [
    'srq.entity_type = $1',
    '$2::double precision IS NOT NULL AND $3::double precision IS NOT NULL',
    "srq.review_kind = 'ambiguous'",
    "srq.status = 'pending'",
    'srq.nearest_place_id IS NOT NULL',
    args.exactIdentifiers || args.exactSourceId
      ? '(ps.id IS NULL OR ps.place_id = srq.nearest_place_id)'
      : 'ps.id IS NULL',
  ];
  const brandRuleReasons = [];
  const eligibility = [];
  let exactIdentifierReason = null;
  let exactSourceIdReason = null;
  let sourceIdentityReason = null;

  if (args.ids.length) {
    values.push(args.ids);
    filters.push(`srq.id = ANY($${values.length}::bigint[])`);
  } else {
    // Exact-match automation must not inherit the broader spatial/name rule.
    // Brand-rule mode is explicit-only unless an operator opts into both
    // classes, so a named brand report cannot silently pull generic candidates.
    const includeScoreDistance = !args.brandRules || args.includeScoreDistance;
    if (includeScoreDistance && !args.exactIdentifiers && !args.exactSourceId && !args.sourceIdentity) {
      eligibility.push('(srq.nearest_name_score >= $2 AND srq.nearest_distance_m <= $3)');
    }

    if (args.brandRules) {
      const brandRules = brandRuleSql(values);
      eligibility.push(...brandRules.eligibility);
      brandRuleReasons.push(...brandRules.reasons);
    }

    if (args.exactIdentifiers) {
      const exactSource = args.source || 'all_the_places';
      const exactSourceParam = values.push(exactSource);
      filters.push(`srq.source = $${exactSourceParam}`);
      const sourceAddress = `regexp_replace(lower(coalesce(NULLIF(srq.source_data->>'address', ''), NULLIF(srq.source_data->>'full_address', ''), NULLIF(srq.source_data->>'addr:full', ''), '')), '[^a-z0-9]', '', 'g')`;
      const canonicalAddress = `regexp_replace(lower(coalesce(canonical.address, '')), '[^a-z0-9]', '', 'g')`;
      const sourcePhone = `right(regexp_replace(coalesce(NULLIF(srq.source_data->>'phone', ''), NULLIF(srq.source_data->>'phone_number', ''), NULLIF(srq.source_data->>'contact:phone', ''), ''), '[^0-9]', '', 'g'), 10)`;
      const canonicalPhone = `right(regexp_replace(coalesce(canonical.phone, ''), '[^0-9]', '', 'g'), 10)`;
      const sourceWebsite = `regexp_replace(regexp_replace(lower(coalesce(NULLIF(srq.source_data->>'website', ''), NULLIF(srq.source_data->>'website_url', ''), NULLIF(srq.source_data->>'contact:website', ''), '')), '^https?://(www\\.)?', '', ''), '/+$', '', 'g')`;
      const canonicalWebsite = `regexp_replace(regexp_replace(lower(coalesce(canonical.website_url, '')), '^https?://(www\\.)?', '', ''), '/+$', '', 'g')`;
      const exactIdentifierMatches = `(
        CASE WHEN ${sourceAddress} <> '' AND ${sourceAddress} = ${canonicalAddress} THEN 1 ELSE 0 END
        + CASE WHEN length(${sourcePhone}) = 10 AND ${sourcePhone} = ${canonicalPhone} THEN 1 ELSE 0 END
        + CASE WHEN ${sourceWebsite} <> '' AND ${sourceWebsite} = ${canonicalWebsite} THEN 1 ELSE 0 END
      )`;
      const exactIdentifierCountParam = values.push(args.minExactIdentifiers);
      exactIdentifierReason = `(
        ${sourceWebsite} <> ''
        AND ${sourceWebsite} = ${canonicalWebsite}
        AND ${exactIdentifierMatches} >= $${exactIdentifierCountParam}
        AND srq.nearest_distance_m <= $3
        AND NOT EXISTS (
          SELECT 1
          FROM place_sources conflicting_source
          WHERE conflicting_source.entity_type = srq.entity_type
            AND conflicting_source.source = srq.source
            AND conflicting_source.source_id = srq.source_id
            AND conflicting_source.place_id <> srq.nearest_place_id
        )
      )`;
      eligibility.push(exactIdentifierReason);
    }

    if (args.exactSourceId) {
      const sourceParam = values.push('osm');
      const sourceName = `lower(regexp_replace(coalesce(srq.source_name, ''), '[^a-z0-9]+', ' ', 'g'))`;
      const canonicalName = `lower(regexp_replace(coalesce(canonical.name, ''), '[^a-z0-9]+', ' ', 'g'))`;
      exactSourceIdReason = `(
        srq.source = $${sourceParam}
        AND srq.source_id = canonical.google_place_id
        AND srq.nearest_distance_m <= $3
        AND COALESCE(canonical.lifecycle_status, '') = ''
        AND (${sourceName} = '' OR ${sourceName} = ${canonicalName})
        AND NOT EXISTS (
          SELECT 1
          FROM place_sources conflicting_source
          WHERE conflicting_source.entity_type = srq.entity_type
            AND conflicting_source.source = srq.source
            AND conflicting_source.source_id = srq.source_id
            AND conflicting_source.place_id <> srq.nearest_place_id
        )
      )`;
      eligibility.push(exactSourceIdReason);
    }

    if (args.sourceIdentity) {
      const identitySource = values.push('wikidata');
      const sourceName = `lower(regexp_replace(coalesce(srq.source_name, ''), '[^a-z0-9]+', ' ', 'g'))`;
      const canonicalName = `lower(regexp_replace(coalesce(canonical.name, ''), '[^a-z0-9]+', ' ', 'g'))`;
      sourceIdentityReason = `(
        srq.source = $${identitySource}
        AND (
          srq.source_id = NULLIF(canonical.brand_wikidata, '')
          OR srq.source_id = NULLIF(canonical.osm_tags->>'brand:wikidata', '')
        )
        AND srq.nearest_distance_m <= 25
        AND COALESCE(canonical.status, 'unvisited') = 'unvisited'
        AND canonical.rating IS NULL
        AND NULLIF(btrim(canonical.notes), '') IS NULL
        AND NOT (
          srq.source_name ~ '[A-Za-z]'
          AND canonical.name ~ '[A-Za-z]'
          AND ${sourceName} <> ${canonicalName}
        )
      )`;
      eligibility.push(sourceIdentityReason);
    }
  }

  if (args.source) {
    values.push(args.source);
    filters.push(`srq.source = $${values.length}`);
  }

  if (args.reportFile) {
    values.push(args.reportFile);
    filters.push(`srq.report_file = $${values.length}`);
  }

  if (eligibility.length) filters.push(`(${eligibility.join('\n      OR ')})`);

  values.push(args.limit);
  const result = await client.query(`
    SELECT
      srq.id,
      srq.entity_type,
      srq.review_kind,
      srq.source,
      srq.source_id,
      srq.source_name,
      srq.source_url,
      srq.source_data,
      srq.nearest_place_id,
      srq.nearest_google_place_id,
      srq.nearest_place_name,
      srq.nearest_distance_m,
      srq.nearest_name_score,
      srq.review_reason,
      ps.place_id AS existing_source_place_id,
      CASE
        WHEN ${args.ids.length ? 'TRUE' : 'FALSE'}
          THEN 'exact_reviewed_ids'
        WHEN ${exactIdentifierReason || 'FALSE'}
          THEN 'exact_identifiers'
        WHEN ${exactSourceIdReason || 'FALSE'}
          THEN 'exact_source_id'
        WHEN ${sourceIdentityReason || 'FALSE'}
          THEN 'source_identity'
        WHEN ${args.includeScoreDistance || !args.brandRules ? `srq.nearest_name_score >= $2 AND srq.nearest_distance_m <= $3` : 'FALSE'}
          THEN 'score_distance'
        ${brandRuleReasons.join('\n        ')}
        ELSE 'unknown'
      END AS auto_link_reason
    FROM source_review_queue srq
    JOIN ${tableName} canonical
      ON canonical.id = srq.nearest_place_id
    LEFT JOIN place_sources ps
      ON ps.entity_type = srq.entity_type
     AND ps.source = srq.source
     AND ps.source_id = srq.source_id
    WHERE ${filters.join('\n      AND ')}
      ORDER BY
      CASE
        WHEN ${exactIdentifierReason || 'FALSE'} THEN 0
        WHEN ${exactSourceIdReason || 'FALSE'} THEN 0
        WHEN ${sourceIdentityReason || 'FALSE'} THEN 0
        WHEN ${args.includeScoreDistance || !args.brandRules ? `srq.nearest_name_score >= $2 AND srq.nearest_distance_m <= $3` : 'FALSE'} THEN 0
        ELSE 1
      END ASC,
      srq.nearest_name_score DESC,
      srq.nearest_distance_m ASC,
      srq.id ASC
    LIMIT $${values.length}
  `, values);
  return result.rows;
}

async function applyCandidates(client, candidates, args) {
  const reviewerNotes = args.ids.length
    ? `Linked ambiguous source review row by exact reviewed source_review_queue ids: ${args.ids.join(',')}.`
    : args.exactIdentifiers
      ? `Auto-linked official source row by exact store URL plus at least ${args.minExactIdentifiers - 1} corroborating identifier(s) and location agreement.`
    : args.exactSourceId
      ? 'Auto-linked unchanged OSM evidence by exact source ID, matching name, nearby location, and active canonical lifecycle.'
    : args.sourceIdentity
      ? 'Auto-linked Wikidata source row by exact brand identity, nearby location, and non-conflicting labels on an unreviewed place.'
    : `Auto-linked ambiguous source review row with nearest_name_score >= ${args.minNameScore} and nearest_distance_m <= ${args.maxDistanceM}${args.brandRules ? ', or an explicit report/brand rule matched' : ''}.`;
  let linked = 0;

  await client.query('BEGIN');
  try {
    for (const row of candidates) {
      if (row.existing_source_place_id == null || args.exactSourceId) {
        const metadata = sourceMetadata(row.source);
        await client.query(`
        INSERT INTO place_sources (
          entity_type,
          place_id,
          source,
          source_id,
          source_url,
          license,
          attribution,
          data,
          match_confidence,
          match_method,
          retrieved_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, NOW())
        ON CONFLICT (entity_type, source, source_id) DO UPDATE SET
          place_id = EXCLUDED.place_id,
          source_url = EXCLUDED.source_url,
          license = EXCLUDED.license,
          attribution = EXCLUDED.attribution,
          data = EXCLUDED.data,
          match_confidence = EXCLUDED.match_confidence,
          match_method = EXCLUDED.match_method,
          retrieved_at = EXCLUDED.retrieved_at,
          updated_at = NOW()
        `, [
          row.entity_type,
          row.nearest_place_id,
          row.source,
          row.source_id,
          row.source_url,
          metadata.license,
          metadata.attribution,
          JSON.stringify(reviewedSourceData(row, reviewerNotes)),
          1,
          row.auto_link_reason === 'exact_identifiers'
            ? 'auto_exact_identifiers'
            : row.auto_link_reason === 'exact_source_id'
              ? 'auto_exact_source_id'
            : row.auto_link_reason === 'source_identity'
              ? 'auto_source_identity'
            : row.auto_link_reason?.startsWith('brand_rule:')
            ? 'auto_brand_reviewed_link'
            : row.auto_link_reason === 'exact_reviewed_ids'
              ? 'exact_reviewed_link'
            : 'auto_reviewed_link',
        ]);
      }

      const result = await client.query(`
        UPDATE source_review_queue
        SET status = 'linked',
          decision = 'auto_linked',
          canonical_place_id = $2,
          reviewer_notes = $3,
          reviewed_by = 'ops:auto-link-source-review-queue',
          reviewed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
          AND status = 'pending'
          AND review_kind = 'ambiguous'
      `, [row.id, row.nearest_place_id, reviewerNotes]);
      if (result.rowCount) {
        await client.query(`
          INSERT INTO source_review_decision_history (
            review_queue_id,
            entity_type,
            source,
            source_id,
            previous_review_kind,
            previous_status,
            previous_decision,
            previous_canonical_place_id,
            review_kind,
            status,
            decision,
            canonical_place_id,
            action,
            reviewer_notes,
            reviewed_by
          )
          VALUES ($1, $2, $3, $4, $5, 'pending', NULL, NULL, $5, 'linked', 'auto_linked', $6, 'auto_link', $7, 'ops:auto-link-source-review-queue')
        `, [
          row.id,
          row.entity_type,
          row.source,
          row.source_id,
          row.review_kind,
          row.nearest_place_id,
          reviewerNotes,
        ]);
      }
      linked += result.rowCount;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  return { linked };
}

function outputReport({ args, candidates, applyResult }) {
  const payload = {
    generated_at: new Date().toISOString(),
    mode: args.apply ? 'apply' : 'dry-run',
    entity: args.entity,
    source: args.source,
    report_file: args.reportFile,
    min_name_score: args.minNameScore,
    max_distance_m: args.maxDistanceM,
    brand_rules: args.brandRules,
    include_score_distance: args.includeScoreDistance,
    min_exact_identifiers: args.exactIdentifiers ? args.minExactIdentifiers : null,
    source_identity: args.sourceIdentity,
    exact_source_id: args.exactSourceId,
    ids: args.ids,
    limit: args.limit,
    candidates: candidates.length,
    linked: applyResult.linked,
    rows: candidates,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`# Auto-link Source Review Queue ${args.apply ? 'Apply' : 'Dry Run'}`);
  console.log('');
  console.log(`Mode: ${payload.mode}`);
  console.log(`Entity: ${args.entity}`);
  console.log(`Source: ${args.source || 'all'}`);
  console.log(`Report file: ${args.reportFile || 'all'}`);
  console.log(`Thresholds: name_score >= ${args.minNameScore}, distance <= ${args.maxDistanceM}m`);
  console.log(`Brand rules: ${args.brandRules ? 'explicit-only' : 'disabled'}`);
  console.log(`Generic score/distance class: ${args.brandRules ? (args.includeScoreDistance ? 'enabled' : 'disabled') : 'enabled'}`);
  console.log(`Exact identifiers: ${args.exactIdentifiers ? 'enabled' : 'disabled'}`);
  console.log(`Source identity: ${args.sourceIdentity ? 'enabled' : 'disabled'}`);
  console.log(`Exact source ID: ${args.exactSourceId ? 'enabled' : 'disabled'}`);
  console.log(`Minimum exact identifiers: ${args.exactIdentifiers ? args.minExactIdentifiers : 'n/a'}`);
  console.log(`Candidates: ${candidates.length}`);
  console.log(`Rows linked: ${applyResult.linked}`);
  console.log('');
  console.log(table([
    'id',
    'source',
    'source_name',
    'nearest_place_id',
    'nearest_place_name',
    'nearest_distance_m',
    'nearest_name_score',
    'auto_link_reason',
  ], candidates.slice(0, 50)));
  if (!args.apply && candidates.length) {
    console.log('');
    console.log('Re-run with `--apply` to link exactly this thresholded candidate class.');
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const client = new pg.Client(dbConfig());
  await client.connect();

  try {
    if (!(await tableExists(client, 'source_review_queue'))) {
      throw new Error('source_review_queue table does not exist.');
    }
    if (!(await tableExists(client, 'place_sources'))) {
      throw new Error('place_sources table does not exist.');
    }

    const candidates = await fetchCandidates(client, args);
    const applyResult = args.apply
      ? await applyCandidates(client, candidates, args)
      : { linked: 0 };
    outputReport({ args, candidates, applyResult });
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`auto-link-source-review-queue failed: ${summarizeDatabaseError(error)}`);
  process.exit(1);
});
