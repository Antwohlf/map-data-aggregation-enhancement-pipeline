#!/usr/bin/env python3
"""Bounded, resumable Overture Places export for one food profile."""

import argparse
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path


MANIFEST_VERSION = 2
ATTRIBUTION = 'Overture Maps Foundation, overturemaps.org'
ATTRIBUTION_URL = 'https://docs.overturemaps.org/attribution/'
CATEGORY_POLICIES = {
    'overture-pizza-taxonomy-v1': {
        'entity': 'pizza',
        'adapter_id': 'food-source-overture-v1',
        'categories': ('pizza_restaurant',),
    },
    'overture-taco-taxonomy-v1': {
        'entity': 'taco',
        'adapter_id': 'food-source-overture-taco-v1',
        'categories': ('mexican_restaurant', 'taco_restaurant', 'texmex_restaurant'),
    },
}


def parse_bbox(value):
    values = [float(item) for item in value.split(',')]
    if len(values) != 4 or values[0] >= values[2] or values[1] >= values[3]:
        raise ValueError('bbox must be south,west,north,east')
    return values


def category_policy(entity, policy_id):
    policy = CATEGORY_POLICIES.get(policy_id)
    if not policy or policy['entity'] != entity:
        raise ValueError(f'Unsupported Overture category policy for {entity}')
    return policy


def tile_key(bbox):
    return '_'.join(str(round(value, 6)).replace('-', 'm').replace('.', 'p') for value in bbox)


def tiles(bbox, step):
    south, west, north, east = bbox
    output = []
    lat = south
    while lat < north:
        lng = west
        while lng < east:
            output.append([
                round(lat, 6), round(lng, 6),
                round(min(lat + step, north), 6), round(min(lng + step, east), 6),
            ])
            lng = round(lng + step, 6)
        lat = round(lat + step, 6)
    return output


def json_value(value):
    if value is None or not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except Exception:
        return value


def build_query(bbox, release, limit, policy, after_id=None):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.\d+', release):
        raise ValueError('Unexpected Overture release identity')
    south, west, north, east = bbox
    categories = ', '.join(f"'{value}'" for value in policy['categories'])
    path = f's3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*'
    cursor_filter = "AND id > '" + str(after_id).replace("'", "''") + "'" if after_id else ''
    return f"""
      SELECT id, names.primary AS name, confidence, basic_category,
             taxonomy.primary AS primary_category, CAST(taxonomy AS JSON) AS taxonomy,
             operating_status, bbox.xmin AS lng, bbox.ymin AS lat,
             addresses[1].freeform AS address, addresses[1].locality AS locality,
             addresses[1].region AS region, addresses[1].postcode AS postcode,
             addresses[1].country AS country,
             CAST(websites AS JSON) AS websites, CAST(phones AS JSON) AS phones,
             CAST(sources AS JSON) AS overture_sources
      FROM read_parquet('{path}', filename=true, hive_partitioning=1)
      WHERE (
          list_has_any(taxonomy.hierarchy, [{categories}])
          OR list_has_any(COALESCE(taxonomy.alternates, []), [{categories}])
        )
        AND addresses[1].country = 'US'
        AND bbox.xmin BETWEEN {west} AND {east}
        AND bbox.ymin BETWEEN {south} AND {north}
        AND COALESCE(operating_status, 'open') <> 'permanently_closed'
        {cursor_filter}
      ORDER BY id
      LIMIT {int(limit)}
    """


def export_tile(con, bbox, release, limit, entity, policy_id, after_id=None):
    policy = category_policy(entity, policy_id)
    result = con.execute(build_query(bbox, release, limit, policy, after_id))
    columns = [item[0] for item in result.description]
    rows = []
    for values in result.fetchall():
        row = dict(zip(columns, values))
        rows.append({
            'id': row.get('id'),
            'name': row.get('name'),
            'lat': row.get('lat'),
            'lng': row.get('lng'),
            'basic_category': row.get('basic_category'),
            'primary_category': row.get('primary_category'),
            'taxonomy': json_value(row.get('taxonomy')),
            'confidence': row.get('confidence'),
            'operating_status': row.get('operating_status'),
            'address': row.get('address'),
            'locality': row.get('locality'),
            'region': row.get('region'),
            'postcode': row.get('postcode'),
            'country': row.get('country'),
            'websites': json_value(row.get('websites')),
            'phones': json_value(row.get('phones')),
            'overture_sources': json_value(row.get('overture_sources')),
            'overture_release': release,
            'overture_adapter': policy['adapter_id'],
            'overture_category_policy': policy_id,
            'attribution': ATTRIBUTION,
            'attribution_url': ATTRIBUTION_URL,
            'source_url': f"https://explore.overturemaps.org/places/{row.get('id')}",
        })
    return rows


def manifest_identity(bbox, step, release, entity, policy_id):
    policy = category_policy(entity, policy_id)
    return {
        'version': MANIFEST_VERSION,
        'pagination': 'id-keyset-v1',
        'entity': entity,
        'adapter_id': policy['adapter_id'],
        'category_policy': policy_id,
        'categories': list(policy['categories']),
        'country': 'US',
        'bbox': bbox,
        'step': step,
        'release': release,
    }


def load_manifest(path, identity):
    if not path.exists():
        return {**identity, 'tiles': {}}
    manifest = json.loads(path.read_text())
    for key, value in identity.items():
        if manifest.get(key) != value:
            raise ValueError(f'Overture manifest {key} mismatch; rotate to a new output/manifest path')
    if not isinstance(manifest.get('tiles'), dict):
        raise ValueError('Overture manifest tiles must be an object')
    return manifest


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.' + path.name, delete=False) as handle:
            temporary = handle.name
            json.dump(value, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def select_manifest(path, latest_identity, all_tiles):
    if not path.exists():
        return load_manifest(path, latest_identity)
    previous = json.loads(path.read_text())
    pinned = {**latest_identity, 'release': previous.get('release')}
    if not isinstance(pinned['release'], str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.\d+', pinned['release']):
        raise ValueError('Unexpected pinned Overture release identity')
    previous = load_manifest(path, pinned)
    complete = all(previous['tiles'].get(tile_key(tile), {}).get('status') == 'success' for tile in all_tiles)
    if not complete or pinned['release'] == latest_identity['release']:
        return previous
    archive = path.with_name(path.name + '.' + pinned['release'] + '.archive.json')
    if archive.exists():
        if json.loads(archive.read_text()) != previous:
            raise ValueError('Existing Overture release archive differs; refusing overwrite')
    else:
        atomic_json(archive, previous)
    # Keep the current manifest/output intact until the first new tile succeeds.
    return {**latest_identity, 'tiles': {}}


def tile_page(previous, bbox, page, limit):
    rows = page[:limit]
    return {
        'bbox': bbox,
        'status': 'partial' if len(page) > limit else 'success',
        'after_id': rows[-1]['id'] if rows else previous.get('after_id'),
        'rows': previous.get('rows', []) + rows,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--entity', required=True, choices=('pizza', 'taco'))
    parser.add_argument('--category-policy', required=True)
    parser.add_argument('--bbox', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--step', type=float, default=1.0)
    parser.add_argument('--max-tiles', type=int, default=1)
    parser.add_argument('--limit', type=int, default=5000)
    args = parser.parse_args()
    bbox = parse_bbox(args.bbox)
    if args.step <= 0 or args.max_tiles <= 0 or args.limit <= 0:
        raise ValueError('step, max-tiles, and limit must be positive')
    policy = category_policy(args.entity, args.category_policy)

    import duckdb

    con = duckdb.connect()
    con.execute("SET threads=2; SET memory_limit='2GB';")
    con.execute('INSTALL httpfs; LOAD httpfs;')
    con.execute("SET s3_region='us-west-2'")
    latest = con.execute("SELECT latest FROM read_json_auto('https://stac.overturemaps.org/catalog.json')").fetchone()[0]
    identity = manifest_identity(bbox, args.step, latest, args.entity, args.category_policy)
    manifest_path = Path(args.manifest)
    all_tiles = tiles(bbox, args.step)
    manifest = select_manifest(manifest_path, identity, all_tiles)
    release = manifest['release']
    manifest['total_tiles'] = len(all_tiles)
    rows_by_id = {}
    for tile in manifest['tiles'].values():
        for row in tile.get('rows', []):
            if row.get('id'):
                rows_by_id[row['id']] = row

    processed = 0
    for tile in all_tiles:
        key = tile_key(tile)
        if manifest['tiles'].get(key, {}).get('status') == 'success':
            continue
        if processed >= args.max_tiles:
            break
        processed += 1
        previous_tile = manifest['tiles'].get(key, {})
        page = export_tile(con, tile, release, args.limit + 1, args.entity, args.category_policy, previous_tile.get('after_id'))
        rows = page[:args.limit]
        for row in rows:
            if row.get('id'):
                rows_by_id[row['id']] = row
        manifest['tiles'][key] = tile_page(previous_tile, tile, page, args.limit)
        manifest['rows'] = len(rows_by_id)
        manifest['updated_at'] = utc_now()
        atomic_json(manifest_path, manifest)

    atomic_json(Path(args.output), list(rows_by_id.values()))
    statuses = {}
    for tile in manifest['tiles'].values():
        statuses[tile['status']] = statuses.get(tile['status'], 0) + 1
    manifest['statuses'] = statuses
    manifest['rows'] = len(rows_by_id)
    manifest['updated_at'] = utc_now()
    atomic_json(manifest_path, manifest)
    print(json.dumps({
        'source': 'overture_places',
        'entity': args.entity,
        'adapter_id': policy['adapter_id'],
        'category_policy': args.category_policy,
        'release': release,
        'rows': len(rows_by_id),
        'tiles': len(all_tiles),
        'processed': processed,
        'statuses': statuses,
    }))


if __name__ == '__main__':
    main()
