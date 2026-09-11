"""Exercise the real cursor/page code with tiny deterministic Parquet batches.

The separately recorded iMac canary uses real gated provider Parquet files.
These fixtures make every crash/retry/filter boundary reproducible without HF.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("fsq", Path(__file__).parents[1] / "scripts/ops/export-fsq-hf-parquet-sample.py")
fsq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fsq)


def row(i, **changes):
    return {"fsq_place_id": str(i), "name": "Taco Example", "country": "US", "region": "MI",
            "latitude": 42.3, "longitude": -83.1, **changes}


class Batch:
    def __init__(self, rows):
        self.rows, self.num_rows = rows, len(rows)

    def slice(self, start):
        return Batch(self.rows[start:])

    def to_pylist(self):
        return self.rows


class Parquet:
    def __init__(self, groups):
        self.groups, self.read_groups = groups, []
        self.metadata = SimpleNamespace(num_rows=sum(map(len, groups)), num_row_groups=len(groups),
                                        row_group=lambda index: SimpleNamespace(num_rows=len(groups[index])))

    def iter_batches(self, *, batch_size, row_groups, use_threads):
        self.read_groups.extend(row_groups)
        for group in row_groups:
            # Smaller batches than production also exercise skipping batches
            # within a partly consumed row group.
            for start in range(0, len(self.groups[group]), 2):
                yield Batch(self.groups[group][start:start + 2])

    def close(self):
        pass


class CursorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.args = SimpleNamespace(dataset="fixture/fsq", config="places", split="train", entity="taco",
                                    query="taco", country="US", region="MI", max_files=1, limit=2,
                                    max_scan_rows=4, refresh_hours=168, cursor=str(Path(self.tmp.name) / "cursor.json"),
                                    output=str(Path(self.tmp.name) / "rows.json"), preview=False,
                                    ack_page=None, run_report=False)
        self.files = [{"url": "https://example.test/immutable/a", "size": 10}, {"url": "https://example.test/immutable/b", "size": 10}]
        self.data = [Parquet([[row(0, region="CA"), row(1, region="CA")]]),
                     Parquet([[row(2), row(3), row(4)], [row(5), row(6)]])]
        self.addCleanup(patch.stopall)
        patch.object(fsq, "parquet_metadata", return_value=self.files).start()
        patch.object(fsq, "open_parquet", side_effect=lambda args, item: self.data[self.files.index(item)]).start()

    def ack(self, page):
        self.args.ack_page = page["page_id"]
        fsq.acknowledge_page(self.args)
        self.args.ack_page = None

    def test_empty_shard_advances_only_after_ack_and_replays_without_provider(self):
        page = fsq.export_page(self.args)
        self.assertEqual(page["rows"], [])
        self.assertEqual(page["next"], {"file_index": 1, "row_offset": 0})
        self.assertEqual(fsq.load_cursor(self.args)["position"], {"file_index": 0, "row_offset": 0})
        with patch.object(fsq, "scan_page", side_effect=AssertionError("retry must not reacquire")):
            self.assertEqual(fsq.export_page(self.args), page)
        self.ack(page)
        self.assertEqual([r["fsq_place_id"] for r in fsq.export_page(self.args)["rows"]], ["2", "3"])

    def test_limit_mid_group_resumes_exactly_and_skips_finished_groups(self):
        self.ack(fsq.export_page(self.args))
        all_rows = []
        for expected in (["2", "3"], ["4", "5"], ["6"]):
            page = fsq.export_page(self.args)
            self.assertEqual([r["fsq_place_id"] for r in page["rows"]], expected)
            all_rows.extend(expected)
            self.ack(page)
        self.assertEqual(len(set(all_rows)), 5)
        self.assertTrue(fsq.load_cursor(self.args)["complete"])
        self.assertEqual(self.data[1].read_groups, [0, 0, 1, 1])

    def test_scan_budget_applies_to_unmatched_rows(self):
        self.args.max_scan_rows = 1
        page = fsq.export_page(self.args)
        self.assertEqual(page["scanned_rows"], 1)
        self.assertEqual(page["next"], {"file_index": 0, "row_offset": 1})
        self.ack(page)
        next_page = fsq.export_page(self.args)
        self.assertEqual(next_page["next"], {"file_index": 1, "row_offset": 0})

    def test_completed_region_waits_for_refresh_without_extending_deadline(self):
        self.ack(fsq.export_page(self.args))
        for _ in range(3):
            self.ack(fsq.export_page(self.args))
        completed_at = fsq.load_cursor(self.args)["completed_at"]
        with patch.object(fsq, "scan_page", side_effect=AssertionError("completed cycle must wait")):
            deferred = fsq.export_page(self.args)
            self.assertTrue(deferred["deferred"])
            self.ack(deferred)
        self.assertEqual(fsq.load_cursor(self.args)["completed_at"], completed_at)
        with patch.object(fsq.time, "time", return_value=completed_at + 169 * 3600):
            page = fsq.export_page(self.args)
            self.assertFalse(page.get("deferred", False))
            self.assertEqual(page["next"], {"file_index": 1, "row_offset": 0})

    def test_preview_never_changes_checkpoint_and_wrong_ack_is_rejected(self):
        self.args.preview = True
        fsq.export_page(self.args)
        self.assertFalse(Path(self.args.cursor).exists())
        self.args.preview = False
        page = fsq.export_page(self.args)
        before = Path(self.args.cursor).read_bytes()
        self.args.preview = True
        fsq.export_page(self.args)
        self.assertEqual(before, Path(self.args.cursor).read_bytes())
        self.args.ack_page = "wrong"
        with self.assertRaisesRegex(ValueError, "acknowledgement mismatch"):
            fsq.acknowledge_page(self.args)
        self.assertEqual(before, Path(self.args.cursor).read_bytes())
        self.assertEqual(page["rows"], [])

    def test_scope_corruption_and_release_change_cannot_skip_pending_page(self):
        page = fsq.export_page(self.args)
        for key, replacement in (("entity", "pizza"), ("region", "NY"), ("query", "pizza")):
            original = getattr(self.args, key)
            setattr(self.args, key, replacement)
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                fsq.export_page(self.args)
            setattr(self.args, key, original)
        with patch.object(fsq, "parquet_metadata", side_effect=AssertionError("pinned scan must not refresh")):
            self.assertEqual(fsq.export_page(self.args), page)
            self.ack(page)
            fsq.export_page(self.args)
        state = json.loads(Path(self.args.cursor).read_text())
        state["files"][0]["url"] = "changed"
        fsq.atomic_json(Path(self.args.cursor), state)
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            fsq.export_page(self.args)

    def test_output_failure_leaves_durable_retry_page(self):
        real_atomic = fsq.atomic_json
        def fail_output(path, value):
            if str(path) == self.args.output:
                raise OSError("injected output failure")
            real_atomic(path, value)
        with patch.object(fsq, "atomic_json", side_effect=fail_output):
            with self.assertRaisesRegex(OSError, "injected"):
                fsq.execute(self.args)
        page = fsq.export_page(self.args)
        self.assertIsNotNone(fsq.load_cursor(self.args)["pending"])
        self.assertEqual(page["start"], {"file_index": 0, "row_offset": 0})

    def test_country_region_open_entity_and_coordinates(self):
        self.assertTrue(fsq.matches(row(1), self.args))
        for changes in ({"region": "IL"}, {"country": "CA"}, {"date_closed": "2026-01-01"},
                        {"name": "Pizza"}, {"latitude": float("nan")}, {"longitude": 181}):
            self.assertFalse(fsq.matches(row(1, **changes), self.args), changes)
        self.assertTrue(fsq.matches(row(1, name="Example", fsq_category_labels=["Mexican Restaurant"]), self.args))
        self.args.entity, self.args.query = "pizza", "pizza"
        self.assertFalse(fsq.matches(row(1), self.args))
        self.assertTrue(fsq.matches(row(1, name="Pizza Example"), self.args))


if __name__ == "__main__":
    unittest.main()
