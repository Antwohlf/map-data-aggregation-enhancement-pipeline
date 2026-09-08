#!/usr/bin/env python3
"""
Export a bounded FSQ OS Places sample from Hugging Face Parquet shards.

This path is useful when the Hugging Face Dataset Viewer search endpoint is
still indexing. It reads only enough authenticated Parquet shards to produce a
small JSON sample for source-input-sample-report.mjs.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
import shutil


DEFAULT_DATASET = "foursquare/fsq-os-places"
DEFAULT_CACHE_DIR = "data/source-samples/.hf-fsq-cache"


def load_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip("\"'")
    return out


def merged_env() -> dict[str, str]:
    env = {}
    env.update(load_env_file(Path.cwd() / ".env"))
    env.update(load_env_file(Path.cwd() / ".env.local"))
    env.update(os.environ)
    return env


def parse_args() -> argparse.Namespace:
    env = merged_env()
    parser = argparse.ArgumentParser(
        description="Export a bounded FSQ OS Places sample from authenticated Hugging Face Parquet shards.",
    )
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--config", default="places")
    parser.add_argument("--split", default="train")
    parser.add_argument("--query", default=None)
    parser.add_argument("--country", default="US", help="Optional exact country filter; use empty string to disable.")
    parser.add_argument("--region", default="", help="Optional exact region/state filter.")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--max-files", type=int, default=5)
    parser.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
    parser.add_argument("--output", default="data/source-samples/fsq-os-places-us-pizza-sample.json")
    parser.add_argument("--entity", choices=["pizza", "taco"], default="pizza")
    parser.add_argument("--scope-config", default=None)
    parser.add_argument("--review-output", default="reports/source-review/fsq-os-places-us-review.json")
    parser.add_argument("--run-report", action="store_true")
    parser.add_argument("--token", default=env.get("HF_TOKEN") or env.get("HUGGINGFACE_HUB_TOKEN") or "")
    args = parser.parse_args()

    if args.query is None:
        args.query = args.entity
    if args.scope_config is None:
        args.scope_config = (
            "config/source-pipeline-taco.json"
            if args.entity == "taco"
            else "config/source-pipeline.json"
        )

    if not args.token:
        parser.error("Missing HF_TOKEN or HUGGINGFACE_HUB_TOKEN for gated Hugging Face FSQ OS Places access.")
    if args.limit < 1 or args.limit > 5000:
        parser.error("--limit must be between 1 and 5000")
    if args.max_files < 1 or args.max_files > 100:
        parser.error("--max-files must be between 1 and 100")
    return args


def auth_request(url: str, token: str) -> urllib.request.Request:
    return urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )


def fetch_json(url: str, token: str) -> Any:
    with urllib.request.urlopen(auth_request(url, token), timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def parquet_metadata(args: argparse.Namespace) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({"dataset": args.dataset})
    payload = fetch_json(f"https://datasets-server.huggingface.co/parquet?{params}", args.token)
    files = payload.get("parquet_files") or payload.get("parquetFiles") or []
    selected = [
        item for item in files
        if item.get("config") == args.config and item.get("split") == args.split
    ]
    if not selected:
        configs = sorted({str(item.get("config")) for item in files})
        raise RuntimeError(
            f"No Parquet files found for config={args.config} split={args.split}. "
            f"Available configs: {', '.join(configs) or '(none)'}"
        )
    return selected


def file_url(dataset: str, item: dict[str, Any]) -> tuple[str, str]:
    filename = item.get("url") or item.get("filename") or item.get("path")
    if not filename:
        raise RuntimeError(f"Parquet metadata item is missing a filename/url: {item}")
    if str(filename).startswith("http://") or str(filename).startswith("https://"):
        url = str(filename)
        cache_name = Path(urllib.parse.urlparse(url).path).name
    else:
        quoted_dataset = urllib.parse.quote(dataset, safe="/")
        quoted_file = urllib.parse.quote(str(filename), safe="/=")
        url = f"https://huggingface.co/datasets/{quoted_dataset}/resolve/main/{quoted_file}"
        cache_name = Path(str(filename)).name
    return url, cache_name or "fsq-os-places.parquet"


def download_parquet(url: str, cache_path: Path, token: str) -> Path:
    if cache_path.exists() and cache_path.stat().st_size > 0:
        return cache_path
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=600) as response, cache_path.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    return cache_path


def normalize_text(value: Any) -> str:
    return str(value or "").strip().lower()


def matches(row: dict[str, Any], args: argparse.Namespace) -> bool:
    name = normalize_text(row.get("name"))
    categories = normalize_text(" ".join(
        str(value) for value in (row.get("fsq_category_labels") or row.get("categories") or [])
    ))
    category_terms = (
        ("burrito", "mexican", "taco", "taqueria", "tex-mex")
        if args.entity == "taco"
        else ("apizza", "flatbread", "italian restaurant", "pizza", "pizzeria", "slice", "wood fired", "wood-fired")
    )
    if args.query and args.query.lower() not in name and not any(term in categories for term in category_terms):
        return False
    if args.country and normalize_text(row.get("country")) != args.country.lower():
        return False
    if args.region and normalize_text(row.get("region")) != args.region.lower():
        return False
    if row.get("date_closed") not in (None, ""):
        return False
    try:
        float(row.get("latitude"))
        float(row.get("longitude"))
    except (TypeError, ValueError):
        return False
    return True


def json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if hasattr(value, "as_py"):
        return json_safe(value.as_py())
    return str(value)


def export_rows(args: argparse.Namespace) -> list[dict[str, Any]]:
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError(
            "Missing pyarrow. Create the ignored FSQ environment with: "
            "python3 -m venv scripts/.fsq-venv && "
            "scripts/.fsq-venv/bin/python -m pip install --upgrade pip pyarrow"
        ) from exc

    rows: list[dict[str, Any]] = []
    cache_dir = Path(args.cache_dir)
    for item in parquet_metadata(args)[: args.max_files]:
        url, name = file_url(args.dataset, item)
        cache_path = download_parquet(url, cache_dir / name, args.token)
        parquet_file = pq.ParquetFile(cache_path)
        for batch in parquet_file.iter_batches(batch_size=4096):
            for raw_row in batch.to_pylist():
                row = {str(key): json_safe(value) for key, value in raw_row.items()}
                if matches(row, args):
                    rows.append(row)
                    if len(rows) >= args.limit:
                        return rows
    return rows


def run_report(args: argparse.Namespace) -> None:
    command = [
        os.environ.get("NODE_BINARY") or shutil.which("node") or "/usr/local/bin/node",
        "scripts/ops/source-input-sample-report.mjs",
        "--source", "fsq_os_places",
        "--input", args.output,
        "--entity", args.entity,
        "--scope-config", args.scope_config,
        "--max-distance-m", "100",
        "--limit", "5000",
        "--sample", "25",
        "--review-output", args.review_output,
    ]
    subprocess.run(command, check=True)


def main() -> int:
    args = parse_args()
    rows = export_rows(args)
    if not rows:
        raise RuntimeError("No matching rows found. Try a broader query, country/region, or more --max-files.")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")

    print("# FSQ Hugging Face Parquet Sample Export")
    print()
    print(f"Dataset: {args.dataset}")
    print(f"Config: {args.config}")
    print(f"Split: {args.split}")
    print(f"Query: {args.query or '(none)'}")
    print(f"Country: {args.country or '(any)'}")
    print(f"Region: {args.region or '(any)'}")
    print(f"Max files: {args.max_files}")
    print(f"Rows written: {len(rows)}")
    print(f"Output: {args.output}")
    print()
    print("Next command:")
    print(
        "node scripts/ops/source-input-sample-report.mjs "
        f"--source fsq_os_places --input {args.output} --entity {args.entity} "
        f"--scope-config {args.scope_config} --max-distance-m 100 --limit 5000 "
        f"--sample 25 --review-output {args.review_output}"
    )

    if args.run_report:
        print()
        print("Running source adapter report...")
        run_report(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - operator-facing CLI
        print(f"export-fsq-hf-parquet-sample failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
