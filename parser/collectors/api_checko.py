"""Коннектор Checko API v2 (100 бесплатных запросов в сутки): поиск ИП и ООО + официальные телефоны."""

from __future__ import annotations

import logging
import os
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any

from ..models import Lead, normalize_date
from ..regions import REGIONS
from .http_client import http_json, polite_sleep

logger = logging.getLogger("novoreg.checko")

CHECKO_BASE = "https://api.checko.ru/v2"


class CheckoCollector:
    def __init__(self, api_key: str | None = None, max_age_days: int = 180) -> None:
        self.api_key = (api_key or os.getenv("CHECKO_API_KEY", "")).strip()
        self.max_age_days = max_age_days

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def enrich_by_inn(self, lead: Lead) -> bool:
        """Запрашивает карточку Checko по ИНН и вытягивает официальные телефоны, email и сайт."""
        if not self.enabled or not lead.inn:
            return False

        endpoint = "entrepreneur" if lead.entity_type == "ИП" or len(lead.inn) == 12 else "company"
        url = f"{CHECKO_BASE}/{endpoint}?key={urllib.parse.quote(self.api_key)}&inn={lead.inn}"
        try:
            _, resp = http_json(url, timeout=8.0)
        except Exception as exc:
            logger.debug("Ошибка Checko enrich (%s): %s", lead.inn, exc)
            return False

        data = resp.get("data") or {}
        if not data:
            return False

        contacts = data.get("Контакты") or {}
        before = len(lead.phones)
        for ph in contacts.get("Тел") or []:
            lead.phones.append(str(ph))
        for em in contacts.get("Емэйл") or []:
            lead.emails.append(str(em))
        site = contacts.get("ВебСайт")
        if site:
            lead.websites.append(str(site))

        okv = data.get("ОКВЭД") or {}
        if not lead.okved_code and okv.get("Код"):
            lead.okved_code = str(okv.get("Код"))
            lead.okved_name = str(okv.get("Наим") or "")

        if not lead.reg_date and data.get("ДатаРег"):
            lead.reg_date = normalize_date(data.get("ДатаРег"))

        if "Checko API" not in lead.sources:
            lead.sources.append("Checko API")
        lead.finalize()
        return len(lead.phones) > before

    def search_recent(self, queries: list[str] | None = None) -> list[Lead]:
        if not self.enabled:
            return []

        min_date = (datetime.now(timezone.utc) - timedelta(days=self.max_age_days)).strftime("%Y-%m-%d")
        search_terms = queries or ["Строй", "Логистик", "Техно", "Маркет"]
        leads: list[Lead] = []

        for obj_type, etype in (("org", "ООО"), ("ent", "ИП")):
            for term in search_terms[:2]:
                params = urllib.parse.urlencode({
                    "key": self.api_key,
                    "by": "name",
                    "obj": obj_type,
                    "query": term,
                    "active": "true",
                    "limit": "15",
                })
                try:
                    _, resp = http_json(f"{CHECKO_BASE}/search?{params}", timeout=8.0)
                    records = (resp.get("data") or {}).get("Записи") or []
                    for rec in records:
                        reg_iso = normalize_date(rec.get("ДатаРег"))
                        if reg_iso < min_date:
                            continue
                        inn = str(rec.get("ИНН") or "")
                        ogrn = str(rec.get("ОГРН") or rec.get("ОГРНИП") or "")
                        raw_name = str(rec.get("НаимСокр") or rec.get("ФИО") or "")
                        if etype == "ИП" and raw_name and not raw_name.upper().startswith("ИП "):
                            name = f"ИП {raw_name}"
                        else:
                            name = raw_name
                        rc = str(rec.get("РегионКод") or "")
                        lead = Lead(
                            entity_type=etype,
                            name=name,
                            full_name=str(rec.get("НаимПолн") or name),
                            inn=inn,
                            ogrn=ogrn,
                            reg_date=reg_iso,
                            region_code=rc,
                            region_name=REGIONS.get(rc, ""),
                            address=str(rec.get("ЮрАдрес") or ""),
                            okved_code=str(rec.get("ОКВЭД") or ""),
                            sources=["Checko API"],
                        ).finalize()
                        # Дообогащаем контактами первые свежие записи
                        if len(leads) < 10:
                            self.enrich_by_inn(lead)
                            polite_sleep(0.2)
                        leads.append(lead)
                except Exception as exc:
                    logger.warning("Ошибка поиска Checko (%s/%s): %s", obj_type, term, exc)
                polite_sleep(0.25)

        return leads
