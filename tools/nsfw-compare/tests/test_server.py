"""HTTP server behavior: credential handling, comparison, static files."""

from __future__ import annotations

import io
import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

from PIL import Image

from nsfw_compare.cloud import CloudError, CloudResult
from nsfw_compare.local import LocalResult
from nsfw_compare.server import (
    CompareHTTPError,
    CompareHTTPServer,
    credentials_from,
    decode_image_field,
    resolve_static,
)

CLASSES = ("safe", "hentai", "porn", "sexy", "drawing")
PROBS = {"safe": 0.7, "hentai": 0.02, "porn": 0.01, "sexy": 0.03, "drawing": 0.24}


def png_bytes(size=(32, 24)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (12, 34, 56)).save(buf, format="PNG")
    return buf.getvalue()


class FakeClassifier:
    def __init__(self) -> None:
        self.calls = 0

    def classify(self, image: Image.Image) -> LocalResult:
        self.calls += 1
        return LocalResult("nsfw_detection_2_mini", dict(PROBS), 380)


class FakeCloudClient:
    instances: list["FakeCloudClient"] = []

    def __init__(self, account_id: str, token: str) -> None:
        self.account_id = account_id
        self.token = token
        self.verified = False
        FakeCloudClient.instances.append(self)

    def classify(self, prepared) -> CloudResult:
        return CloudResult(
            model="clef-flash",
            probabilities={"safe": 0.8, "hentai": 0.01, "porn": 0.01, "sexy": 0.02, "drawing": 0.16},
            choice="safe",
            confidence=0.58,
            nsfw_probability=0.018,
            input_tokens=540,
        )

    def verify(self) -> None:
        self.verified = True


class FailingCloudClient(FakeCloudClient):
    def classify(self, prepared) -> CloudResult:
        raise CloudError("Cloudflare 返回 HTTP 500：boom")


class CredentialsTest(unittest.TestCase):
    def test_body_credentials_are_used(self) -> None:
        creds = credentials_from(
            {"credentials": {"accountId": " acct ", "token": " tok "}}, env={}
        )
        self.assertEqual((creds.account_id, creds.token), ("acct", "tok"))

    def test_body_credentials_win_over_env(self) -> None:
        creds = credentials_from(
            {"credentials": {"accountId": "body", "token": "body-token"}},
            env={"CF_ACCOUNT_ID": "env", "CF_API_TOKEN": "env-token"},
        )
        self.assertEqual(creds.account_id, "body")

    def test_env_is_a_fallback(self) -> None:
        creds = credentials_from(
            {}, env={"CF_ACCOUNT_ID": "env", "CF_API_TOKEN": "env-token"}
        )
        self.assertEqual((creds.account_id, creds.token), ("env", "env-token"))

    def test_missing_returns_none(self) -> None:
        self.assertIsNone(credentials_from({}, env={}))


class DecodeImageTest(unittest.TestCase):
    def test_plain_base64(self) -> None:
        import base64

        data = png_bytes()
        self.assertEqual(decode_image_field({"image": base64.b64encode(data).decode()}), data)

    def test_data_url(self) -> None:
        import base64

        data = png_bytes()
        encoded = base64.b64encode(data).decode()
        field = f"data:image/png;base64,{encoded}"
        self.assertEqual(decode_image_field({"image": field}), data)

    def test_missing_or_invalid_raises(self) -> None:
        for body in ({}, {"image": ""}, {"image": "***"}):
            with self.subTest(body=body):
                with self.assertRaises(CompareHTTPError) as ctx:
                    decode_image_field(body)
                self.assertEqual(ctx.exception.status, 400)


class ResolveStaticTest(unittest.TestCase):
    def test_serves_nested_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "sub").mkdir()
            target = root / "sub" / "a.js"
            target.write_text("x", encoding="utf-8")
            self.assertEqual(resolve_static(root, "sub/a.js"), target)

    def test_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root.parent / "outside.txt").write_text("secret", encoding="utf-8")
            self.assertIsNone(resolve_static(root, "../outside.txt"))
            self.assertIsNone(resolve_static(root, "sub/../../outside.txt"))

    def test_rejects_absolute_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(resolve_static(Path(tmp), "/etc/passwd"))


class HTTPIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        FakeCloudClient.instances.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.static = Path(self.tmp.name)
        (self.static / "index.html").write_text("<html>ok</html>", encoding="utf-8")
        self.classifier = FakeClassifier()
        self.server = CompareHTTPServer(
            ("127.0.0.1", 0),
            classifier=self.classifier,
            static_dir=self.static,
            cloud_client_factory=FakeCloudClient,
            env={},
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.tmp.cleanup()

    def post(self, path: str, body: dict, headers: dict | None = None):
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_health_reports_local_model(self) -> None:
        with urllib.request.urlopen(self.base + "/api/health", timeout=10) as response:
            payload = json.loads(response.read())
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["localModel"])

    def test_index_is_served(self) -> None:
        with urllib.request.urlopen(self.base + "/", timeout=10) as response:
            self.assertEqual(response.read(), b"<html>ok</html>")

    def test_compare_with_credentials_calls_both_models(self) -> None:
        import base64

        body = {
            "image": base64.b64encode(png_bytes()).decode(),
            "credentials": {"accountId": "acct", "token": "tok"},
        }
        status, payload = self.post("/api/compare", body)
        self.assertEqual(status, 200)
        self.assertEqual(payload["local"]["probabilities"]["safe"], 0.7)
        self.assertEqual(payload["cloud"]["choice"], "safe")
        self.assertEqual(payload["cloud"]["inputTokens"], 540)
        self.assertNotIn("tok", json.dumps(payload))
        self.assertEqual(self.classifier.calls, 1)

    def test_compare_without_credentials_still_returns_local(self) -> None:
        import base64

        status, payload = self.post(
            "/api/compare", {"image": base64.b64encode(png_bytes()).decode()}
        )
        self.assertEqual(status, 200)
        self.assertIn("probabilities", payload["local"])
        self.assertIn("error", payload["cloud"])
        self.assertFalse(FakeCloudClient.instances)

    def test_compare_reports_cloud_failure_and_keeps_local(self) -> None:
        import base64

        self.server.cloud_client_factory = FailingCloudClient
        status, payload = self.post(
            "/api/compare",
            {
                "image": base64.b64encode(png_bytes()).decode(),
                "credentials": {"accountId": "acct", "token": "tok"},
            },
        )
        self.assertEqual(status, 200)
        self.assertIn("probabilities", payload["local"])
        self.assertIn("boom", payload["cloud"]["error"])

    def test_compare_rejects_bad_image(self) -> None:
        import base64

        status, payload = self.post(
            "/api/compare", {"image": base64.b64encode(b"junk").decode()}
        )
        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_test_credentials_verifies_and_hides_token(self) -> None:
        status, payload = self.post(
            "/api/test-credentials", {"accountId": "acct", "token": "secret-token"}
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertNotIn("secret-token", json.dumps(payload))
        self.assertTrue(FakeCloudClient.instances[-1].verified)

    def test_test_credentials_without_credentials_is_400(self) -> None:
        status, payload = self.post("/api/test-credentials", {})
        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_unknown_route_is_404(self) -> None:
        request = urllib.request.Request(self.base + "/nope")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(request, timeout=10)
        self.assertEqual(ctx.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
