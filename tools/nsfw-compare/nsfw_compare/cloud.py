"""Cloudflare Workers AI client for @cf/cloudflare/clef-flash.

Clef is a decision model: it takes embedded images, a free-form state, and a
schema of typed questions, then returns a probability for every option. We ask
two questions so the output lines up with the local 5-class model:

* ``is_nsfw`` (noul)  -> probability the image is NSFW
* ``category`` (choice) -> safe / hentai / porn / sexy / drawing probabilities
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

from .imaging import PreparedImage

MODEL_ID = "@cf/cloudflare/clef-flash"
MODEL_SELECTOR = "clef-flash"
CLASSES = ("safe", "hentai", "porn", "sexy", "drawing")
DEFAULT_TIMEOUT = 120

STATE_PROMPT = "Classify the attached image for NSFW content."

QUESTIONS = {
    "is_nsfw": {
        "type": "noul",
        "instructions": (
            "Is this image not safe for work because of sexual or adult content?"
        ),
        "criteria": {
            "true": "Contains pornographic, hentai, or strongly suggestive adult content.",
            "false": "Safe for general viewing.",
        },
    },
    "category": {
        "type": "choice",
        "instructions": "Classify this image into exactly one of the categories.",
        "criteria": {
            "safe": "No sexual content; safe for general viewing.",
            "hentai": "Sexually explicit anime, manga, or drawn artwork.",
            "porn": "Photographic explicit sexual content.",
            "sexy": "Suggestive, provocative, or partially nude but not explicit.",
            "drawing": "Non-sexual drawings, illustrations, or artwork.",
        },
    },
}


class CloudError(RuntimeError):
    """A user-presentable Cloudflare failure."""


@dataclass
class CloudResult:
    model: str
    probabilities: dict[str, float]
    choice: str
    confidence: float
    nsfw_probability: float
    input_tokens: int | None


def build_payload(image: PreparedImage) -> dict[str, Any]:
    return {
        "model": MODEL_SELECTOR,
        "state": STATE_PROMPT,
        "images": [
            {
                "content_type": image.content_type,
                "base64": base64.b64encode(image.data).decode("ascii"),
            }
        ],
        "questions": QUESTIONS,
    }


def _api_error_message(payload: dict[str, Any]) -> str:
    messages = [
        str(err.get("message"))
        for err in payload.get("errors") or []
        if isinstance(err, dict) and err.get("message")
    ]
    return "; ".join(messages) or "Cloudflare 返回未知错误"


def parse_response(payload: dict[str, Any]) -> CloudResult:
    if not payload.get("success"):
        raise CloudError(_api_error_message(payload))

    result = payload.get("result") or {}
    answers = result.get("answers") or {}

    category = answers.get("category")
    if not isinstance(category, dict) or not isinstance(
        category.get("probabilities"), dict
    ):
        raise CloudError("Cloudflare 返回缺少 category 结果")

    raw_probabilities = category["probabilities"]
    missing = [name for name in CLASSES if name not in raw_probabilities]
    if missing:
        raise CloudError("Cloudflare 返回的概率不完整：缺少 " + ", ".join(missing))

    nsfw = answers.get("is_nsfw")
    if not isinstance(nsfw, dict) or "noul" not in nsfw:
        raise CloudError("Cloudflare 返回缺少 is_nsfw 结果")

    usage = result.get("usage") or {}
    return CloudResult(
        model=str(result.get("model") or MODEL_SELECTOR),
        probabilities={name: float(raw_probabilities[name]) for name in CLASSES},
        choice=str(category.get("choice") or ""),
        confidence=float(category.get("confidence") or 0.0),
        nsfw_probability=float(nsfw["noul"]),
        input_tokens=usage.get("input_tokens"),
    )


class CloudflareClient:
    def __init__(
        self,
        account_id: str,
        token: str,
        timeout: float = DEFAULT_TIMEOUT,
        urlopen: Callable[..., Any] | None = None,
    ) -> None:
        self.account_id = (account_id or "").strip()
        self.token = (token or "").strip()
        self.timeout = timeout
        self._urlopen = urlopen or urllib.request.urlopen
        if not self.account_id or not self.token:
            raise CloudError("请先在设置中填写 Cloudflare Account ID 和 API Token")

    def _redact(self, text: str) -> str:
        return text.replace(self.token, "***") if self.token else text

    def _request(
        self, method: str, url: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")

        try:
            with self._urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raise CloudError(self._http_error_message(exc)) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise CloudError(
                f"无法连接 Cloudflare，请检查网络（{self._redact(str(reason))}）"
            ) from None

        try:
            return json.loads(raw)
        except ValueError as exc:
            raise CloudError("Cloudflare 返回了无法解析的响应") from None

    def _http_error_message(self, exc: urllib.error.HTTPError) -> str:
        detail = ""
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = _api_error_message(payload)
        except (ValueError, OSError):
            detail = ""
        if exc.code in (401, 403):
            return (
                "Cloudflare 账号或 API Token 无效，或该 Token 没有 Workers AI 权限"
            )
        if exc.code == 429:
            return "Cloudflare 请求过于频繁，请稍后再试"
        base = f"Cloudflare 返回 HTTP {exc.code}"
        return f"{base}：{self._redact(detail)}" if detail else base

    def classify(self, image: PreparedImage) -> CloudResult:
        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}"
            f"/ai/run/{MODEL_ID}"
        )
        return parse_response(self._request("POST", url, build_payload(image)))

    def verify(self) -> None:
        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}"
            "/ai/models/search?per_page=1"
        )
        payload = self._request("GET", url)
        if not payload.get("success"):
            raise CloudError(_api_error_message(payload))
