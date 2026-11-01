"""Дообогащение деловых телефонов, сайтов и мессенджеров через официальный 2ГИС Catalog API v3."""

from __future__ import annotations

import logging
import os
import re
import urllib.parse

from ..models import Lead, normalize_website
from .http_client import http_json, polite_sleep

logger = logging.getLogger("novoreg.twogis")


class TwoGisEnricher:
    BASE_URL = "https://catalog.api.2gis.com/3.0/items"

    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = (api_key or os.getenv("TWOGIS_API_KEY", "")).strip()

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def enrich_batch(self, leads: list[Lead], max_requests: int = 15) -> int:
        if not self.enabled:
            return 0

        enriched = 0
        used = 0
        for lead in leads:
            if used >= max_requests:
                break
            if lead.has_phone:
                continue

            clean_brand = re.sub(r'^(?:ООО|ИП)\s*', "", lead.name, flags=re.I).strip(' "«»')
            if len(clean_brand) < 3:
                continue

            city_hint = lead.region_name.replace("г. ", "")
            q = f"{clean_brand} {city_hint}".strip()
            params = urllib.parse.urlencode({
                "q": q,
                "fields": "items.contact_groups,items.address_name",
                "page_size": "3",
                "key": self.api_key,
            })

            used += 1
            try:
                _, resp = http_json(f"{self.BASE_URL}?{params}", timeout=7.0)
                items = ((resp.get("result") or {}).get("items")) or []
                if not items:
                    continue

                top = items[0]
                before = len(lead.phones)
                for group in top.get("contact_groups") or []:
                    for c in group.get("contacts") or []:
                        ctype = c.get("type")
                        val = str(c.get("value") or c.get("text") or "").strip()
                        if not val:
                            continue
                        if ctype == "phone":
                            lead.phones.append(val)
                        elif ctype == "email":
                            lead.emails.append(val)
                        elif ctype == "website":
                            nw = normalize_website(val)
                            if nw:
                                lead.websites.append(nw)
                        elif ctype in ("telegram", "whatsapp", "vkontakte"):
                            key = "vk" if ctype == "vkontakte" else ctype
                            lead.socials[key] = val

                lead.finalize()
                if len(lead.phones) > before:
                    if "2ГИС API" not in lead.sources:
                        lead.sources.append("2ГИС API")
                    enriched += 1
            except Exception as exc:
                logger.debug("Ошибка 2ГИС enrich (%s): %s", q, exc)
            polite_sleep(0.15)

        return enriched
