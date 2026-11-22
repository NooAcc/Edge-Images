#!/usr/bin/env python3
"""Launch the local NSFW comparison web UI.

    python tools/nsfw-compare/app.py
    python tools/nsfw-compare/app.py --port 9000 --open

Images never leave the machine for the local model. If Cloudflare credentials
are configured in the browser settings (or via CF_ACCOUNT_ID / CF_API_TOKEN),
the image is also sent to Cloudflare Workers AI for the clef-flash comparison.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import webbrowser
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parents[1]
DEFAULT_MODEL = REPO_ROOT / "models" / "nsfw_detection_2_mini.onnx"

sys.path.insert(0, str(TOOL_DIR))

from nsfw_compare.local import LocalClassifier, LocalModelError  # noqa: E402
from nsfw_compare.server import CompareHTTPServer  # noqa: E402

LOGGER = logging.getLogger("nsfw_compare")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    parser.add_argument("--port", type=int, default=8765, help="监听端口（0 表示随机）")
    parser.add_argument(
        "--model",
        default=os.environ.get("NSFW_MODEL_PATH") or str(DEFAULT_MODEL),
        help="nsfw_detection_2_mini.onnx 路径",
    )
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    classifier = None
    try:
        classifier = LocalClassifier(args.model)
        LOGGER.info("本地模型已加载：%s", args.model)
    except LocalModelError as exc:
        LOGGER.warning("本地模型不可用：%s", exc)
        LOGGER.warning("页面仍会启动，但左侧本地结果会显示错误。")

    server = CompareHTTPServer(
        (args.host, args.port),
        classifier=classifier,
        static_dir=TOOL_DIR / "static",
    )
    url = f"http://{args.host}:{server.server_port}/"
    LOGGER.info("对比工具已启动：%s", url)
    LOGGER.info("按 Ctrl+C 退出。")
    if args.open:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("正在退出…")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
