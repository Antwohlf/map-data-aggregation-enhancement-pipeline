#!/usr/bin/env python3
"""
Export a bounded FSQ OS Places sample from Hugging Face Parquet shards.

This path is useful when the Hugging Face Dataset Viewer search endpoint is
still indexing. It reads only enough authenticated Parquet shards to produce a
small JSON sample for source-input-sample-report.mjs.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
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
    parser.add_argument("--max-scan-rows", type=int, default=1250000)
    parser.add_argument("--refresh-hours", type=float, default=168)
    parser.add_argument("--cache-max-bytes", type=int, default=536870912)
    parser.add_argument("--cursor", help="Private product/region checkpoint; acknowledge only after downstream success.")
    parser.add_argument("--ack-page", help="Acknowledge an exact pending page without acquiring new input.")
    parser.add_argument("--preview", action="store_true", help="Read the cursor without changing it.")
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

    if not args.token and not args.ack_page:
        parser.error("Missing HF_TOKEN or HUGGINGFACE_HUB_TOKEN for gated Hugging Face FSQ OS Places access.")
    if args.limit < 1 or args.limit > 5000:
        parser.error("--limit must be between 1 and 5000")
    if args.max_files < 1 or args.max_files > 100:
        parser.error("--max-files must be between 1 and 100")
    if not 1 <= args.max_scan_rows <= 5000000:
        parser.error("--max-scan-rows must be between 1 and 5000000")
    if not 1 <= args.refresh_hours <= 8760:
        parser.error("--refresh-hours must be between 1 and 8760")
    if not 1048576 <= args.cache_max_bytes <= 1073741824:
        parser.error("--cache-max-bytes must be between 1 MiB and 1 GiB")
    if args.ack_page and (not args.cursor or args.preview):
        parser.error("--ack-page requires --cursor and cannot use --preview")
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
    # The viewer's refs/convert/parquet URLs are mutable. Resolve each branch
    # once, then pin every shard to the immutable Hub commit for this scan.
    revisions: dict[str, str] = {}
    pinned = []
    for item in sorted(selected, key=lambda value: file_url(args.dataset, value)[0]):
        url, name = file_url(args.dataset, item)
        prefix = f"/datasets/{args.dataset}/resolve/"
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.netloc != "huggingface.co" or not parsed.path.startswith(prefix):
            raise ValueError("Unexpected FSQ Parquet provider URL")
        revision, separator, path = parsed.path[len(prefix):].partition("/")
        if not separator:
            raise ValueError("Missing Parquet revision/path")
        if revision not in revisions:
            info = fetch_json(f"https://huggingface.co/api/datasets/{args.dataset}/revision/{revision}", args.token)
            sha = info.get("sha", "")
            if not re.fullmatch(r"[a-f0-9]{40}", sha):
                raise ValueError("Missing immutable Parquet revision")
            revisions[revision] = sha
        pinned.append({"url": f"https://huggingface.co{prefix}{revisions[revision]}/{path}", "filename": name, "size": item.get("size")})
    return pinned


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


def download_parquet(url: str, cache_path: Path, token: str, expected_size: int, max_bytes: int) -> Path:
    if not isinstance(expected_size, int) or not 0 < expected_size <= max_bytes:
        raise ValueError("Parquet shard exceeds the configured cache budget or has no size")
    if cache_path.exists() and cache_path.stat().st_size == expected_size:
        os.utime(cache_path, None)
        return cache_path
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    # Evict only this adapter's v2 content-addressed download cache, never the
    # legacy cache, checkpoints, review evidence, or any user-authored file.
    cached = sorted((path for path in cache_path.parent.iterdir()
                     if re.fullmatch(r"[a-f0-9]{64}\.(parquet|partial)", path.name) and path.is_file()),
                    key=lambda path: path.stat().st_mtime)
    used = sum(path.stat().st_size for path in cached)
    for path in cached:
        if used + expected_size <= max_bytes:
            break
        used -= path.stat().st_size
        path.unlink()
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    temporary = cache_path.with_suffix(".partial")
    # The cache lock prevents another process from using this partial download.
    # Its deterministic name also makes a SIGKILL-left partial count toward the
    # next invocation's cache budget rather than accumulating orphan files.
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle, urllib.request.urlopen(request, timeout=120) as response:
            received = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > expected_size:
                    raise ValueError("Parquet download exceeded its declared size")
                handle.write(chunk)
            if received != expected_size:
                raise ValueError("Incomplete Parquet download")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, cache_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
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
        else ("pizzeria", "pizza")
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
        lat, lng = float(row.get("latitude")), float(row.get("longitude"))
        if not math.isfinite(lat) or not math.isfinite(lng) or not -90 <= lat <= 90 or not -180 <= lng <= 180:
            return False
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


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def scope(args: argparse.Namespace) -> dict[str, str]:
    return {key: getattr(args, key) for key in ("dataset", "config", "split", "entity", "query", "country", "region")}


def load_cursor(args: argparse.Namespace) -> dict[str, Any] | None:
    if not args.cursor or not Path(args.cursor).exists():
        return None
    state = json.loads(Path(args.cursor).read_text())
    if state.get("version") != 1 or state.get("scope") != scope(args) or digest(state.get("files")) != state.get("files_digest"):
        raise ValueError("FSQ cursor identity mismatch; do not reuse across products, regions or releases")
    position = state.get("position", {})
    if any(type(position.get(key)) is not int or position[key] < 0 for key in ("file_index", "row_offset")) or position["file_index"] >= len(state["files"]):
        raise ValueError("Invalid FSQ cursor position")
    pending = state.get("pending")
    if pending and (pending.get("start") != position or pending.get("page_id") != digest({key: value for key, value in pending.items() if key != "page_id"})):
        raise ValueError("Invalid FSQ pending page")
    return state


def acknowledge_page(args: argparse.Namespace) -> None:
    state = load_cursor(args)
    if not state or not state.get("pending") or state["pending"]["page_id"] != args.ack_page:
        raise ValueError("FSQ page acknowledgement mismatch")
    pending = state["pending"]
    if pending["cycle_complete"] and not state.get("complete"):
        state["completed_at"] = time.time()
    state.update(position=pending["next"], complete=pending["cycle_complete"], pending=None)
    atomic_json(Path(args.cursor), state)


def scan_page(args: argparse.Namespace, files: list[dict[str, Any]], position: dict[str, int], opener=None) -> dict[str, Any]:
    if opener is None:
        opener = open_parquet
    rows: list[dict[str, Any]] = []
    scanned = 0
    file_index, row_offset = position["file_index"], position["row_offset"]
    visited = 0
    complete = False
    while visited < args.max_files and scanned < args.max_scan_rows and len(rows) < args.limit:
        item = files[file_index]
        parquet_file = opener(args, item)
        try:
            total = parquet_file.metadata.num_rows
            if row_offset > total:
                raise ValueError("FSQ cursor exceeds pinned Parquet file")
            # Skip complete row groups without decoding them. Only the current
            # group may be decoded again to reach an exact mid-group offset.
            group_start = 0
            for group in range(parquet_file.metadata.num_row_groups):
                group_end = group_start + parquet_file.metadata.row_group(group).num_rows
                if group_end <= row_offset:
                    group_start = group_end
                    continue
                batch_start = group_start
                for batch in parquet_file.iter_batches(batch_size=4096, row_groups=[group], use_threads=False):
                    batch_end = batch_start + batch.num_rows
                    skip = max(0, row_offset - batch_start)
                    if skip < batch.num_rows:
                        for raw_row in batch.slice(skip).to_pylist():
                            row = {str(key): json_safe(value) for key, value in raw_row.items()}
                            row_offset += 1
                            scanned += 1
                            if matches(row, args):
                                rows.append(row)
                            if len(rows) >= args.limit or scanned >= args.max_scan_rows:
                                break
                    batch_start = batch_end
                    if len(rows) >= args.limit or scanned >= args.max_scan_rows:
                        break
                group_start = group_end
                if len(rows) >= args.limit or scanned >= args.max_scan_rows:
                    break
        finally:
            parquet_file.close()
        visited += 1
        if row_offset == total:
            file_index += 1
            row_offset = 0
            if file_index == len(files):
                file_index = 0
                complete = True
                break
    return {"start": position, "next": {"file_index": file_index, "row_offset": row_offset},
            "rows": rows, "scanned_rows": scanned, "files_visited": visited, "cycle_complete": complete}


class ParquetLease:
    """Keep the managed-cache lock until the last reader releases its file."""
    def __init__(self, parquet_file, lock):
        self.file, self.lock = parquet_file, lock
        self.metadata = parquet_file.metadata

    def iter_batches(self, **kwargs):
        return self.file.iter_batches(**kwargs)

    def close(self):
        try:
            self.file.close()
        finally:
            self.lock.close()


def open_parquet(args: argparse.Namespace, item: dict[str, Any]):
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError(
            "Missing pyarrow. Create the ignored FSQ environment with: "
            "python3 -m venv scripts/.fsq-venv && "
            "scripts/.fsq-venv/bin/python -m pip install --upgrade pip pyarrow"
        ) from exc

    url, _ = file_url(args.dataset, item)
    path = Path(args.cache_dir) / "v2" / (digest(url) + ".parquet")
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = (path.parent / ".download.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return ParquetLease(pq.ParquetFile(download_parquet(url, path, args.token, item.get("size"), args.cache_max_bytes)), lock)
    except BaseException:
        lock.close()
        raise


def export_page(args: argparse.Namespace) -> dict[str, Any]:
    state = load_cursor(args)
    waiting = bool(state and state.get("complete") and time.time() - state.get("completed_at", 0) < args.refresh_hours * 3600)
    if not state or state.get("complete") and not state.get("pending") and not waiting:
        files = parquet_metadata(args)
        state = {"version": 1, "scope": scope(args), "files": files, "files_digest": digest(files),
                 "position": {"file_index": 0, "row_offset": 0}, "complete": False, "pending": None}
    if not state.get("pending"):
        # Another region can still be scanning hourly after this one finishes.
        # Do not restart a completed region on every shared scheduler rotation.
        pending = ({"start": state["position"], "next": state["position"], "rows": [],
                    "scanned_rows": 0, "files_visited": 0, "cycle_complete": True, "deferred": True}
                   if waiting else scan_page(args, state["files"], state["position"]))
        pending["files_digest"] = state["files_digest"]
        pending["scope"] = state["scope"]
        pending["page_id"] = digest(pending)
        state["pending"] = pending
        if args.cursor and not args.preview:
            # Commit the durable page BEFORE writing disposable output. A crash
            # or failed review replays these exact rows, even if HF is offline.
            atomic_json(Path(args.cursor), state)
    return state["pending"]


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
    if args.cursor:
        lock_path = Path(args.cursor + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return execute(args)
    return execute(args)


def execute(args: argparse.Namespace) -> int:
    if args.ack_page:
        acknowledge_page(args)
        print("FSQ page acknowledged")
        return 0
    page = export_page(args)
    rows = page["rows"]

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(output_path, rows)
    atomic_json(Path(args.output + ".page.json"), {key: value for key, value in page.items() if key != "rows"})

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
    print(f"Rows scanned: {page['scanned_rows']}; next position: {page['next']}; cycle complete: {page['cycle_complete']}")
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
