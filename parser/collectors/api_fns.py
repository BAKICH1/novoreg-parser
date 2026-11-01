"""Коннектор API-ФНС (api-fns.ru): прямые выборки действующих ИП и ООО с фильтром наличия телефона."""

from __future__ import annotations

import logging
import os
import urllib.parse
from datetime import datetime, timedelta, timezone

from ..models import Lead, extract_emails, extract_phones, normalize_date

logger = logging.getLogger("novoreg.apifns")

from .http_client import http_json, polite_sleep


class ApiFnsCollector:
    BASE_URL = "https://api-fns.ru/api/search"

    def __init__(self, api_key: str | None = None, max_age_days: int = 180) -> None:
        self.api_key = (api_key or os.getenv("APIFNS_KEY", "")).strip()
        self.max_age_days = max_age_days

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def collect(self, step_cursor: int = 0) -> list[Lead]:
        if not self.enabled:
            return []

        min_date = (datetime.now(timezone.utc) - timedelta(days=self.max_age_days)).strftime("%Y-%m-%d")
        year_str = datetime.now(timezone.utc).strftime("%Y")
        terms = ["ООО Строй", "ООО Торг", "ИП Иванов", "ИП Смирнов", f"ООО {year_str}"]
        q = terms[step_cursor % len(terms)]

        params = urllib.parse.urlencode({
            "q": q,
            "filter": "active+only_phone",
            "key": self.api_key,
        })
        leads: list[Lead] = []
        try:
            _, resp = http_json(f"{self.BASE_URL}?{params}", timeout=10.0)
            for item in resp.get("items") or []:
                is_ip = "ИП" in item
                body = item.get("ИП") or item.get("ЮЛ") or {}
                if not body:
                    continue
                reg_iso = normalize_date(body.get("ДатаРег"))
                if reg_iso < min_date:
                    continue

                contacts_str = str(body.get("Контакты") or "")
                phones = extract_phones(contacts_str)
                emails = extract_emails(contacts_str)

                fio_or_name = str(body.get("ФИОПолн") or body.get("НаимСокрЮЛ") or "")
                if is_ip and fio_or_name and not fio_or_name.upper().startswith("ИП "):
                    short_name = f"ИП {fio_or_name}"
                else:
                    short_name = fio_or_name

                leads.append(
                    Lead(
                        entity_type="ИП" if is_ip else "ООО",
                        name=short_name,
                        full_name=str(body.get("НаимПолнЮЛ") or short_name),
                        inn=str(body.get("ИНН") or ""),
                        ogrn=str(body.get("ОГРНИП") or body.get("ОГРН") or ""),
                        reg_date=reg_iso,
                        address=str(body.get("АдресПолн") or ""),
                        person_name=fio_or_name if is_ip else str(body.get("Руководитель") or ""),
                        okved_name=str(body.get("ОснВидДеят") or ""),
                        phones=phones,
                        emails=emails,
                        sources=["API-ФНС"],
                    ).finalize()
                )
            polite_sleep(0.2)
        except Exception as exc:
            logger.warning("Ошибка API-ФНС: %s", exc)

        return leads
