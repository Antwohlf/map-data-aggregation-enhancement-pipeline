#!/usr/bin/env python3
"""Bounded, resumable Overture Places export for one geographic region."""

import argparse
import json
from pathlib import Path

import duckdb


def parse_bbox(value):
    values = [float(item) for item in value.split(',')]
    if len(values) != 4 or values[0] >= values[2] or values[1] >= values[3]:
        raise ValueError('bbox must be south,west,north,east')
    return values


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
            lng += step
        lat += step
    return output


def json_value(value):
    if value is None or not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except Exception:
        return value


def export_tile(con, bbox, release, limit):
    south, west, north, east = bbox
    path = f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
    query = f"""
      SELECT id, names.primary AS name, confidence, basic_category,
             categories.primary AS primary_category, operating_status,
             bbox.xmin AS lng, bbox.ymin AS lat,
             CAST(websites AS JSON) AS websites, CAST(phones AS JSON) AS phones
      FROM read_parquet('{path}', filename=true, hive_partitioning=1)
      WHERE categories.primary = 'pizza_restaurant'
        AND bbox.xmin BETWEEN {west} AND {east}
        AND bbox.ymin BETWEEN {south} AND {north}
        AND COALESCE(operating_status, 'open') NOT IN ('closed', 'permanently_closed')
      LIMIT {int(limit)}
    """
    columns = [item[0] for item in con.execute(query).description]
    rows = []
    for values in con.execute(query).fetchall():
        row = dict(zip(columns, values))
        rows.append({
            'id': row.get('id'),
            'name': row.get('name'),
            'lat': row.get('lat'),
            'lng': row.get('lng'),
            'category': row.get('primary_category') or row.get('basic_category'),
            'confidence': row.get('confidence'),
            'operating_status': row.get('operating_status'),
            'websites': json_value(row.get('websites')),
            'phones': json_value(row.get('phones')),
            'country': 'US',
            'source_url': f"https://explore.overturemaps.org/places/{row.get('id')}",
        })
    return rows


def main():
    parser = argparse.ArgumentParser()
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

    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        'version': 1, 'bbox': bbox, 'step': args.step, 'tiles': {}
    }
    if manifest.get('bbox') != bbox or float(manifest.get('step', args.step)) != args.step:
        raise ValueError('manifest bbox or step mismatch; use a new manifest')

    all_tiles = tiles(bbox, args.step)
    manifest['total_tiles'] = len(all_tiles)
    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs;')
    con.execute("SET s3_region='us-west-2'")
    release = con.execute("SELECT latest FROM read_json_auto('https://stac.overturemaps.org/catalog.json')").fetchone()[0]
    manifest['release'] = release
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
        rows = export_tile(con, tile, release, args.limit)
        for row in rows:
            if row.get('id'):
                rows_by_id[row['id']] = row
        manifest['tiles'][key] = {'bbox': tile, 'status': 'success', 'rows': rows}
        manifest['rows'] = len(rows_by_id)
        manifest['updated_at'] = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(list(rows_by_id.values()), indent=2) + '\n')
    statuses = {}
    for tile in manifest['tiles'].values():
        statuses[tile['status']] = statuses.get(tile['status'], 0) + 1
    manifest['statuses'] = statuses
    manifest['rows'] = len(rows_by_id)
    manifest['updated_at'] = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'source': 'overture_places', 'release': release, 'rows': len(rows_by_id), 'tiles': len(all_tiles), 'processed': processed, 'statuses': statuses}))


if __name__ == '__main__':
    main()
