"""Коннектор DaData API (до 10 000 бесплатных запросов в сутки): поиск свежих ИП и ООО."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from ..models import Lead, normalize_date
from ..regions import PRIORITY_REGIONS, REGIONS
from .http_client import http_json, polite_sleep

logger = logging.getLogger("novoreg.dadata")

SUGGEST_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party"

POPULAR_SURNAME_PREFIXES = [
    "Иванов", "Смирнов", "Кузнецов", "Попов", "Васильев", "Петров",
    "Соколов", "Михайлов", "Новиков", "Федоров", "Морозов", "Волков",
    "Алексеев", "Лебедев", "Семенов", "Егоров", "Павлов", "Козлов",
]

BUSINESS_KEYWORDS = [
    "ООО Строй", "ООО Трейд", "ООО Логистик", "ООО Тех", "ООО Групп",
    "ООО Сервис", "ООО Пром", "ООО Консалт", "ООО Маркет", "ООО Инвест",
]


class DaDataCollector:
    def __init__(self, api_key: str | None = None, max_age_days: int = 120) -> None:
        self.api_key = (api_key or os.getenv("DADATA_API_KEY", "")).strip()
        self.max_age_days = max_age_days

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _parse_suggestion(self, item: dict[str, Any], min_date_iso: str) -> Lead | None:
        data = item.get("data") or {}
        state = data.get("state") or {}
        raw_st = str(state.get("status") or "ACTIVE").upper()
        status_map = {
            "ACTIVE": ("Действующая (ЕГРЮЛ)", True),
            "LIQUIDATING": ("В процессе ликвидации", False),
            "LIQUIDATED": ("Закрыта / ликвидирована", False),
            "BANKRUPT": ("Банкротство", False),
            "REORGANIZING": ("Реорганизация", True),
        }
        org_status, is_active = status_map.get(raw_st, ("Действующая", True))

        reg_ts = state.get("registration_date")
        if not reg_ts:
            return None
        reg_iso = normalize_date(reg_ts)
        if reg_iso < min_date_iso:
            return None

        is_ip = data.get("type") == "INDIVIDUAL"
        etype = "ИП" if is_ip else "ООО"
        name_obj = data.get("name") or {}
        short_name = name_obj.get("short_with_opf") or item.get("value") or ""
        full_name = name_obj.get("full_with_opf") or short_name

        # Отсекаем АО/ПАО/НКО, оставляем только ИП и ООО
        if not is_ip and not (
            short_name.upper().startswith("ООО") or "ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ" in full_name.upper()
        ):
            return None

        person_name = ""
        person_role = "Индивидуальный предприниматель" if is_ip else "Генеральный директор"
        if is_ip:
            fio = data.get("fio") or {}
            person_name = " ".join(
                x for x in (fio.get("surname"), fio.get("name"), fio.get("patronymic")) if x
            )
        else:
            mgmt = data.get("management") or {}
            person_name = mgmt.get("name") or ""
            person_role = mgmt.get("post") or person_role

        addr_obj = data.get("address") or {}
        address = addr_obj.get("value") or ""
        addr_data = addr_obj.get("data") or {}
        reg_kladr = str(addr_data.get("region_kladr_id") or "")[:2]
        rc = reg_kladr if reg_kladr in REGIONS else ""

        phones: list[str] = []
        for ph in data.get("phones") or []:
            if isinstance(ph, dict) and ph.get("value"):
                phones.append(str(ph["value"]))
            elif isinstance(ph, str):
                phones.append(ph)

        emails: list[str] = []
        for em in data.get("emails") or []:
            if isinstance(em, dict) and em.get("value"):
                emails.append(str(em["value"]))
            elif isinstance(em, str):
                emails.append(em)

        return Lead(
            entity_type=etype,
            name=short_name,
            full_name=full_name,
            inn=str(data.get("inn") or ""),
            ogrn=str(data.get("ogrn") or ""),
            kpp=str(data.get("kpp") or ""),
            reg_date=reg_iso,
            region_code=rc,
            region_name=REGIONS.get(rc, ""),
            address=address,
            person_name=person_name,
            person_role=person_role,
            okved_code=str(data.get("okved") or ""),
            okved_name="",
            phones=phones,
            emails=emails,
            status=org_status,
            is_active=is_active,
            sources=["DaData API"],
        ).finalize()

    def collect(self, step_cursor: int = 0) -> list[Lead]:
        if not self.enabled:
            return []

        headers = {"Authorization": f"Token {self.api_key}"}
        min_date = (datetime.now(timezone.utc) - timedelta(days=self.max_age_days)).strftime("%Y-%m-%d")
        year_2d = datetime.now(timezone.utc).strftime("%y")

        queries: list[tuple[str, str]] = []
        # 1) Прямые префиксы ОГРНИП 3{YY}{RR} и ОГРН 1{YY}{RR}
        for i in range(4):
            rc = PRIORITY_REGIONS[(step_cursor + i) % len(PRIORITY_REGIONS)]
            queries.append((f"3{year_2d}{rc}", "INDIVIDUAL"))
            queries.append((f"1{year_2d}{rc}", "LEGAL"))

        # 2) Поиск свежих ИП по фамилиям и ООО по ключевым нишам
        for i in range(3):
            surname = POPULAR_SURNAME_PREFIXES[(step_cursor + i) % len(POPULAR_SURNAME_PREFIXES)]
            queries.append((f"ИП {surname}", "INDIVIDUAL"))
            kw = BUSINESS_KEYWORDS[(step_cursor + i) % len(BUSINESS_KEYWORDS)]
            queries.append((kw, "LEGAL"))

        leads: list[Lead] = []
        for q_text, party_type in queries:
            try:
                _, resp = http_json(
                    SUGGEST_URL,
                    method="POST",
                    payload={
                        "query": q_text,
                        "count": 20,
                        "type": party_type,
                        "status": ["ACTIVE"],
                    },
                    headers=headers,
                    timeout=8.0,
                )
                for item in resp.get("suggestions") or []:
                    lead = self._parse_suggestion(item, min_date)
                    if lead:
                        leads.append(lead)
                polite_sleep(0.15)
            except Exception as exc:
                logger.warning("Ошибка запроса DaData (%s): %s", q_text, exc)

        logger.info("DaDataCollector: найдено %d свежих ИП/ООО", len(leads))
        return leads
