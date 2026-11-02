"""Публикация и мгновенное инкрементальное обновление сайта и базы данных на хостинге here.now."""

from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import os
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from .models import Lead

logger = logging.getLogger("novoreg.publisher")

HERENOW_API_BASE = "https://here.now"
CLIENT_HEADER = "arena-agent/novoreg-parser"

CONTENT_TYPES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
}


def guess_content_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in CONTENT_TYPES:
        return CONTENT_TYPES[ext]
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


class HereNowPublisher:
    def __init__(
        self,
        site_dir: Path,
        api_key: str | None = None,
        slug: str | None = None,
        claim_token: str | None = None,
    ) -> None:
        self.site_dir = site_dir.resolve()
        self.api_key = (api_key or os.getenv("HERENOW_API_KEY", "")).strip()
        if not self.api_key:
            cred_file = Path.home() / ".herenow" / "credentials"
            if cred_file.exists():
                self.api_key = cred_file.read_text(encoding="utf-8").strip()

        self.slug = (slug or os.getenv("HERENOW_SLUG", "")).strip()
        self.claim_token = (claim_token or os.getenv("HERENOW_CLAIM_TOKEN", "")).strip()

    def _api_request(self, method: str, url: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {
            "X-HereNow-Client": CLIENT_HEADER,
            "Accept": "application/json",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        data: bytes | None = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"here.now API HTTP {exc.code}: {err_body}") from exc

    def _upload_file_to_r2(self, put_url: str, file_path: Path, content_type: str) -> None:
        payload = file_path.read_bytes()
        req = urllib.request.Request(
            put_url,
            data=payload,
            headers={"Content-Type": content_type},
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()

    def collect_manifest_files(self) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for file_path in sorted(self.site_dir.rglob("*")):
            if not file_path.is_file():
                continue
            rel = file_path.relative_to(self.site_dir).as_posix()
            # Пропускаем служебные временные файлы ОС, но оставляем .herenow/
            if rel.startswith(".git/") or rel.endswith(".DS_Store"):
                continue
            entries.append({
                "path": rel,
                "abs_path": file_path,
                "size": file_path.stat().st_size,
                "contentType": guess_content_type(file_path),
                "hash": sha256_file(file_path),
            })
        return entries

    def publish(self) -> dict[str, Any]:
        """Создаёт новый сайт или инкрементально обновляет существующий на here.now."""
        manifest_items = self.collect_manifest_files()
        file_map = {item["path"]: item for item in manifest_items}

        api_files = [
            {
                "path": item["path"],
                "size": item["size"],
                "contentType": item["contentType"],
                "hash": item["hash"],
            }
            for item in manifest_items
        ]

        body: dict[str, Any] = {
            "files": api_files,
            "displayName": "НовоРег Радар РФ — ИП и ООО с телефонами",
            "displayDescription": (
                "Постоянно обновляемый парсер 2-в-1 и веб-CRM новых ИП и ООО по всей РФ "
                "с деловыми телефонами, фильтрацией по регионам/ОКВЭД и экспортом в Excel/CSV."
            ),
        }

        is_update = bool(self.slug and (self.api_key or self.claim_token))
        if is_update:
            if not self.api_key and self.claim_token:
                body["claimToken"] = self.claim_token
            stage_url = f"{HERENOW_API_BASE}/api/v1/publish/{self.slug}"
            logger.info("Инкрементальное обновление сайта %s на here.now...", self.slug)
            staged = self._api_request("PUT", stage_url, body)
        else:
            stage_url = f"{HERENOW_API_BASE}/api/v1/publish"
            logger.info("Создание нового сайта на here.now (%d файлов)...", len(api_files))
            staged = self._api_request("POST", stage_url, body)

        upload_block = staged.get("upload") or {}
        uploads = upload_block.get("uploads") or []
        skipped = upload_block.get("skipped") or []
        version_id = upload_block.get("versionId")
        finalize_url = upload_block.get("finalizeUrl")

        logger.info("Загрузка файлов в R2: к загрузке=%d, пропущено без изменений=%d", len(uploads), len(skipped))
        for u in uploads:
            rel_path = u["path"]
            item = file_map[rel_path]
            hdrs = u.get("headers") or {}
            ctype = hdrs.get("Content-Type") or item["contentType"]
            self._upload_file_to_r2(u["url"], item["abs_path"], ctype)

        finalized = self._api_request("POST", finalize_url, {"versionId": version_id})
        result = {
            "slug": staged.get("slug") or finalized.get("slug") or self.slug,
            "siteUrl": finalized.get("siteUrl") or staged.get("siteUrl"),
            "versionId": finalized.get("currentVersionId") or version_id,
            "uploadedCount": len(uploads),
            "skippedCount": len(skipped),
            "publishStatus": finalized.get("publishStatus"),
            "warnings": finalized.get("warnings"),
        }
        if staged.get("claimUrl"):
            result["claimUrl"] = staged["claimUrl"]
        if staged.get("claimToken"):
            result["claimToken"] = staged["claimToken"]
        if staged.get("expiresAt"):
            result["expiresAt"] = staged["expiresAt"]

        self.slug = str(result["slug"] or self.slug)
        return result

    def sync_leads_to_sitedata(
        self,
        leads: list[Lead],
        already_synced_ids: list[str],
        max_batch: int = 30,
    ) -> list[str]:
        """
        Пушит новые карточки в встроенную БД here.now Site Data (/api/v1/publishes/:slug/data/leads),
        когда сайт привязан к аккаунту и задан HERENOW_API_KEY.
        """
        if not (self.api_key and self.slug):
            return already_synced_ids

        synced_set = set(already_synced_ids)
        newly_synced: list[str] = []

        for lead in leads:
            if len(newly_synced) >= max_batch:
                break
            if lead.id in synced_set:
                continue

            record_body = {
                "lead_key": lead.id[:64],
                "entity_type": lead.entity_type,
                "name": lead.name[:180],
                "inn": lead.inn[:16],
                "ogrn": lead.ogrn[:20],
                "reg_date": lead.reg_date[:16],
                "region_code": lead.region_code[:8],
                "region_name": lead.region_name[:100],
                "okved_code": lead.okved_code[:20],
                "okved_category": lead.okved_category[:80],
                "person_name": lead.person_name[:140],
                "phone_primary": (lead.phones[0] if lead.phones else "")[:40],
                "phones_all": ", ".join(lead.phones)[:200],
                "email_primary": (lead.emails[0] if lead.emails else "")[:120],
                "website": (lead.websites[0] if lead.websites else "")[:180],
                "address": lead.address[:240],
                "source_tag": ", ".join(lead.sources)[:120],
                "has_phone": lead.has_phone,
            }

            url = f"{HERENOW_API_BASE}/api/v1/publishes/{self.slug}/data/leads"
            headers = {
                "X-HereNow-Client": CLIENT_HEADER,
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json; charset=utf-8",
                "Idempotency-Key": str(uuid.uuid5(uuid.NAMESPACE_URL, f"novoreg:{self.slug}:{lead.id}")),
            }
            req = urllib.request.Request(
                url,
                data=json.dumps(record_body, ensure_ascii=False).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    resp.read()
                newly_synced.append(lead.id)
                synced_set.add(lead.id)
            except Exception as exc:
                logger.debug("Пропуск синхронизации Site Data (%s): %s", lead.id, exc)
                break

        combined = list(synced_set)
        return combined[-3000:]
