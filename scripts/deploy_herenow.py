#!/usr/bin/env python3
"""CLI-утилита публикации и инкрементального обновления веб-витрины на хостинге here.now."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from parser.publisher import HereNowPublisher  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="Деплой веб-витрины парсера новорегов на here.now")
    ap.add_argument("--site-dir", default=str(ROOT / "site"), help="Папка статического сайта")
    ap.add_argument("--slug", default="", help="Существующий slug для обновления")
    ap.add_argument("--save-meta", default=str(ROOT / ".parser_state" / "herenow_deploy.json"), help="Куда сохранить метаданные деплоя")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    meta_path = Path(args.save_meta)
    saved_slug = ""
    saved_claim_token = ""
    if meta_path.exists():
        try:
            saved = json.loads(meta_path.read_text(encoding="utf-8"))
            saved_slug = saved.get("slug", "")
            saved_claim_token = saved.get("claimToken", "")
        except Exception:
            pass

    pub = HereNowPublisher(
        site_dir=Path(args.site_dir),
        slug=args.slug or saved_slug,
        claim_token=saved_claim_token,
    )
    res = pub.publish()

    # Сохраняем локально (вне папки site/, чтобы секретный claimToken никогда не попал в публичный веб!)
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    merged_meta = {}
    if meta_path.exists():
        try:
            merged_meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    merged_meta.update({k: v for k, v in res.items() if v is not None})
    meta_path.write_text(json.dumps(merged_meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
