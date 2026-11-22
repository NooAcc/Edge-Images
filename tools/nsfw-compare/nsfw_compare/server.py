"""Minimal stdlib HTTP server for the NSFW comparison UI.

The browser sends base64 image bytes plus (optionally) Cloudflare credentials.
Credentials are used for that request only: they are never written to disk or
logged. When the browser supplies none, CF_ACCOUNT_ID / CF_API_TOKEN from the
environment are used as a fallback for scripts.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import mimetypes
import os
import time
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Mapping

from .cloud import CloudError, CloudflareClient
from .imaging import ImageError, load_rgb, prepare_for_clef
from .local import LocalClassifier, LocalModelError

LOGGER = logging.getLogger("nsfw_compare")
MAX_BODY_BYTES = 40 * 1024 * 1024
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class CompareHTTPError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Credentials:
    account_id: str
    token: str


def credentials_from(
    body: Mapping[str, Any], env: Mapping[str, str] | None = None
) -> Credentials | None:
    env = os.environ if env is None else env
    supplied = body.get("credentials")
    if isinstance(supplied, Mapping) and any(supplied.get(k) for k in ("accountId", "token")):
        account = str(supplied.get("accountId") or "").strip()
        token = str(supplied.get("token") or "").strip()
    else:
        account = str(env.get("CF_ACCOUNT_ID") or "").strip()
        token = str(env.get("CF_API_TOKEN") or "").strip()
    if not account or not token:
        return None
    return Credentials(account, token)


def decode_image_field(body: Mapping[str, Any]) -> bytes:
    raw = body.get("image")
    if not isinstance(raw, str) or not raw.strip():
        raise CompareHTTPError("缺少图片数据")
    raw = raw.strip()
    if raw.startswith("data:"):
        _, _, raw = raw.partition(",")
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CompareHTTPError("图片 base64 无效") from exc
    if not data:
        raise CompareHTTPError("图片数据为空")
    return data


def resolve_static(static_dir: Path, relative: str) -> Path | None:
    if not relative or relative.startswith(("/", "\\")):
        return None
    if len(relative) > 1 and relative[1] == ":":
        return None
    root = static_dir.resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def _cloud_payload(result, latency_ms: float) -> dict[str, Any]:
    return {
        "model": result.model,
        "probabilities": result.probabilities,
        "choice": result.choice,
        "confidence": result.confidence,
        "nsfwProbability": result.nsfw_probability,
        "inputTokens": result.input_tokens,
        "latencyMs": round(latency_ms, 1),
    }


def compare_image(
    classifier: LocalClassifier | None,
    image_bytes: bytes,
    credentials: Credentials | None,
    cloud_client_factory: Callable[..., Any] = CloudflareClient,
) -> dict[str, Any]:
    try:
        pil_image = load_rgb(image_bytes)
    except ImageError as exc:
        raise CompareHTTPError(str(exc)) from exc

    prepared = None
    prepare_error = None
    try:
        prepared = prepare_for_clef(image_bytes)
    except ImageError as exc:
        prepare_error = str(exc)

    if classifier is None:
        local: dict[str, Any] = {"error": "本地模型未加载"}
    else:
        started = time.perf_counter()
        try:
            result = classifier.classify(pil_image)
            local = {
                "model": result.model,
                "probabilities": result.probabilities,
                "inputSize": result.input_size,
                "latencyMs": round((time.perf_counter() - started) * 1000, 1),
            }
        except LocalModelError as exc:
            local = {"error": str(exc)}

    if credentials is None:
        cloud: dict[str, Any] = {
            "error": "尚未配置 Cloudflare，请在设置中填写 Account ID 和 API Token"
        }
    elif prepared is None:
        cloud = {"error": prepare_error or "图片无法发送给 Cloudflare"}
    else:
        started = time.perf_counter()
        try:
            client = cloud_client_factory(credentials.account_id, credentials.token)
            cloud = _cloud_payload(
                client.classify(prepared), (time.perf_counter() - started) * 1000
            )
        except CloudError as exc:
            cloud = {"error": str(exc)}

    return {
        "image": {
            "width": pil_image.width,
            "height": pil_image.height,
            "bytes": len(image_bytes),
            "note": prepared.note if prepared else None,
            "cloudReady": prepared is not None,
        },
        "local": local,
        "cloud": cloud,
    }


class CompareHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        classifier: LocalClassifier | None,
        static_dir: Path,
        cloud_client_factory: Callable[..., Any] = CloudflareClient,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self.classifier = classifier
        self.static_dir = Path(static_dir)
        self.cloud_client_factory = cloud_client_factory
        self.env = os.environ if env is None else env
        super().__init__(address, CompareRequestHandler)


class CompareRequestHandler(BaseHTTPRequestHandler):
    server: CompareHTTPServer

    def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
        path = urllib.parse.urlsplit(self.path).path
        if path in ("/", "/index.html"):
            self._serve_file(self.server.static_dir / "index.html")
        elif path == "/api/health":
            self._json(200, {"ok": True, "localModel": self.server.classifier is not None})
        elif path.startswith("/static/"):
            target = resolve_static(self.server.static_dir, path[len("/static/") :])
            if target is None:
                self._json(404, {"error": "Not found"})
            else:
                self._serve_file(target)
        else:
            self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
        path = urllib.parse.urlsplit(self.path).path
        try:
            body = self._read_json()
            if path == "/api/compare":
                image_bytes = decode_image_field(body)
                result = compare_image(
                    self.server.classifier,
                    image_bytes,
                    credentials_from(body, self.server.env),
                    self.server.cloud_client_factory,
                )
                self._json(200, result)
            elif path == "/api/test-credentials":
                creds = credentials_from({"credentials": body}, self.server.env)
                if creds is None:
                    raise CompareHTTPError(
                        "请先填写 Cloudflare Account ID 和 API Token"
                    )
                try:
                    self.server.cloud_client_factory(
                        creds.account_id, creds.token
                    ).verify()
                except CloudError as exc:
                    raise CompareHTTPError(str(exc)) from exc
                self._json(200, {"ok": True, "accountId": creds.account_id})
            else:
                self._json(404, {"error": "Not found"})
        except CompareHTTPError as exc:
            self._json(exc.status, {"error": str(exc)})
        except json.JSONDecodeError:
            self._json(400, {"error": "请求体不是有效的 JSON"})

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            raise CompareHTTPError("请求体为空")
        if length > MAX_BODY_BYTES:
            raise CompareHTTPError("请求体过大", 413)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CompareHTTPError("请求体不是有效的 JSON") from exc
        if not isinstance(body, dict):
            raise CompareHTTPError("请求体必须是 JSON 对象")
        return body

    def _serve_file(self, path: Path) -> None:
        try:
            data = path.read_bytes()
        except OSError:
            self._json(404, {"error": "Not found"})
            return
        content_type = STATIC_TYPES.get(
            path.suffix.lower(), mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        )
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:
        # The default logger writes to stderr; keep it in the app logger and
        # never include request bodies (they carry credentials).
        LOGGER.info("%s - %s", self.address_string(), fmt % args)
