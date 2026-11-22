"""Cloudflare clef-flash request building, response parsing, and errors."""

from __future__ import annotations

import base64
import io
import json
import unittest
import urllib.error

from nsfw_compare.cloud import (
    CLASSES,
    CloudError,
    CloudflareClient,
    build_payload,
    parse_response,
)
from nsfw_compare.imaging import PreparedImage

ACCOUNT = "acct-123"
TOKEN = "cfut_secret_token"

SAMPLE_RESPONSE = {
    "result": {
        "model": "clef-flash",
        "answers": {
            "is_nsfw": {"type": "noul", "noul": 0.0178},
            "category": {
                "type": "choice",
                "choice": "safe",
                "probabilities": {
                    "safe": 0.8037,
                    "hentai": 0.0162,
                    "porn": 0.0188,
                    "sexy": 0.0208,
                    "drawing": 0.1405,
                },
                "confidence": 0.5835,
            },
        },
        "usage": {"input_tokens": 540, "output_tokens": 0},
    },
    "success": True,
    "errors": [],
    "messages": [],
}


def prepared() -> PreparedImage:
    return PreparedImage(b"\x89PNG fake", "image/png", 32, 32, None)


def http_error(code: int, body: dict) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        "https://example.test", code, "boom", {}, io.BytesIO(json.dumps(body).encode())
    )


class BuildPayloadTest(unittest.TestCase):
    def test_embeds_image_and_five_class_choice(self) -> None:
        payload = build_payload(prepared())
        self.assertEqual(payload["model"], "clef-flash")
        self.assertIsInstance(payload["state"], str)
        self.assertEqual(len(payload["images"]), 1)
        image = payload["images"][0]
        self.assertEqual(image["content_type"], "image/png")
        self.assertEqual(
            base64.b64decode(image["base64"]), prepared().data
        )
        self.assertEqual(
            set(payload["questions"]["category"]["criteria"]), set(CLASSES)
        )
        self.assertEqual(payload["questions"]["is_nsfw"]["type"], "noul")


class ParseResponseTest(unittest.TestCase):
    def test_maps_probabilities_and_usage(self) -> None:
        result = parse_response(SAMPLE_RESPONSE)
        self.assertEqual(result.model, "clef-flash")
        self.assertEqual(result.choice, "safe")
        self.assertAlmostEqual(result.confidence, 0.5835)
        self.assertAlmostEqual(result.nsfw_probability, 0.0178)
        self.assertEqual(result.input_tokens, 540)
        self.assertAlmostEqual(result.probabilities["drawing"], 0.1405)
        self.assertEqual(set(result.probabilities), set(CLASSES))

    def test_success_false_raises_with_api_message(self) -> None:
        with self.assertRaises(CloudError) as ctx:
            parse_response(
                {"success": False, "errors": [{"message": "Bad input: nope"}], "result": {}}
            )
        self.assertIn("Bad input: nope", str(ctx.exception))

    def test_missing_category_answer_raises(self) -> None:
        broken = json.loads(json.dumps(SAMPLE_RESPONSE))
        del broken["result"]["answers"]["category"]
        with self.assertRaises(CloudError):
            parse_response(broken)

    def test_incomplete_probabilities_raise(self) -> None:
        broken = json.loads(json.dumps(SAMPLE_RESPONSE))
        broken["result"]["answers"]["category"]["probabilities"].pop("porn")
        with self.assertRaises(CloudError):
            parse_response(broken)


class CloudflareClientTest(unittest.TestCase):
    def test_classify_posts_to_run_endpoint(self) -> None:
        seen: dict = {}

        def fake_urlopen(request, timeout=None):
            seen["url"] = request.full_url
            seen["auth"] = request.headers.get("Authorization")
            seen["body"] = json.loads(request.data.decode())
            return io.BytesIO(json.dumps(SAMPLE_RESPONSE).encode())

        client = CloudflareClient(ACCOUNT, TOKEN, urlopen=fake_urlopen)
        result = client.classify(prepared())

        self.assertIn(f"/accounts/{ACCOUNT}/ai/run/@cf/cloudflare/clef-flash", seen["url"])
        self.assertEqual(seen["auth"], f"Bearer {TOKEN}")
        self.assertEqual(seen["body"]["model"], "clef-flash")
        self.assertEqual(result.choice, "safe")

    def test_auth_failure_is_reported_without_leaking_token(self) -> None:
        def fake_urlopen(request, timeout=None):
            raise http_error(403, {"success": False, "errors": [{"message": "forbidden"}]})

        client = CloudflareClient(ACCOUNT, TOKEN, urlopen=fake_urlopen)
        with self.assertRaises(CloudError) as ctx:
            client.classify(prepared())
        message = str(ctx.exception)
        self.assertIn("Token", message)
        self.assertNotIn(TOKEN, message)

    def test_rate_limit_is_reported(self) -> None:
        def fake_urlopen(request, timeout=None):
            raise http_error(429, {"success": False, "errors": [{"message": "slow down"}]})

        client = CloudflareClient(ACCOUNT, TOKEN, urlopen=fake_urlopen)
        with self.assertRaises(CloudError) as ctx:
            client.classify(prepared())
        self.assertIn("频繁", str(ctx.exception))

    def test_network_failure_is_reported(self) -> None:
        def fake_urlopen(request, timeout=None):
            raise urllib.error.URLError("no route to host")

        client = CloudflareClient(ACCOUNT, TOKEN, urlopen=fake_urlopen)
        with self.assertRaises(CloudError) as ctx:
            client.classify(prepared())
        self.assertIn("网络", str(ctx.exception))

    def test_verify_uses_models_search(self) -> None:
        seen: dict = {}

        def fake_urlopen(request, timeout=None):
            seen["url"] = request.full_url
            return io.BytesIO(b'{"success": true, "result": []}')

        CloudflareClient(ACCOUNT, TOKEN, urlopen=fake_urlopen).verify()
        self.assertIn("/ai/models/search", seen["url"])

    def test_verify_failure_raises(self) -> None:
        def fake_urlopen(request, timeout=None):
            raise http_error(401, {"success": False, "errors": [{"message": "nope"}]})

        with self.assertRaises(CloudError):
            CloudflareClient(ACCOUNT, TOKEN, urlopen=fake_urlopen).verify()


if __name__ == "__main__":
    unittest.main()
