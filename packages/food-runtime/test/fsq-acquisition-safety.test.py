import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "fsq_exporter", ROOT / "scripts/ops/export-fsq-hf-parquet-sample.py"
)
EXPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORTER)


class Response:
    def __init__(self, chunks):
        self.chunks = iter(chunks)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _size):
        return next(self.chunks, b"")


class FsqAcquisitionSafetyTest(unittest.TestCase):
    def test_download_rejects_oversized_response_and_removes_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / ("a" * 64 + ".parquet")
            with patch.object(EXPORTER.urllib.request, "urlopen", return_value=Response([b"123456", b""])):
                with self.assertRaisesRegex(ValueError, "exceeded"):
                    EXPORTER.download_parquet("https://example.test/file", target, "token", 5, 100)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix(".partial").exists())

    def test_download_rejects_short_response_without_publishing_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / ("b" * 64 + ".parquet")
            with patch.object(EXPORTER.urllib.request, "urlopen", return_value=Response([b"123", b""])):
                with self.assertRaisesRegex(ValueError, "Incomplete"):
                    EXPORTER.download_parquet("https://example.test/file", target, "token", 5, 100)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix(".partial").exists())

    def test_metadata_pins_each_file_to_resolved_commit(self):
        args = SimpleNamespace(dataset="foursquare/fsq-os-places", config="places", split="train", token="token")
        items = [
            {"url": "https://huggingface.co/datasets/foursquare/fsq-os-places/resolve/refs%2Fconvert%2Fparquet/release/a.parquet", "size": 10, "config": "places", "split": "train"},
            {"url": "https://huggingface.co/datasets/foursquare/fsq-os-places/resolve/refs%2Fconvert%2Fparquet/release/b.parquet", "size": 11, "config": "places", "split": "train"},
        ]
        calls = []

        def fake_fetch(url, token):
            calls.append(url)
            if "/parquet?" in url:
                return {"parquet_files": items}
            return {"sha": "c" * 40}

        with patch.object(EXPORTER, "fetch_json", side_effect=fake_fetch):
            pinned = EXPORTER.parquet_metadata(args)
        self.assertEqual(len(pinned), 2)
        self.assertTrue(all("/resolve/" + "c" * 40 + "/" in item["url"] for item in pinned))
        self.assertEqual(sum("/revision/" in call for call in calls), 1)

    def test_metadata_rejects_unexpected_provider_url(self):
        args = SimpleNamespace(dataset="foursquare/fsq-os-places", config="places", split="train", token="token")
        with patch.object(EXPORTER, "fetch_json", return_value={"parquet_files": [{"url": "https://evil.test/a.parquet", "size": 1, "config": "places", "split": "train"}]}):
            with self.assertRaisesRegex(ValueError, "provider URL"):
                EXPORTER.parquet_metadata(args)


if __name__ == "__main__":
    unittest.main()
