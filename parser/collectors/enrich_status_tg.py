"""Модуль проверки статуса организации в ФНС/Saby (действующая или закрыта), верификации Telegram и графика работы."""

from __future__ import annotations

import concurrent.futures
import logging
import re
from typing import Any

from ..models import Lead, clean_text
from .http_client import http_get_text, polite_sleep

logger = logging.getLogger("novoreg.enrich_status_tg")


def check_saby_fns_by_inn(inn: str) -> dict[str, Any]:
    """
    Проверяет по ИНН в открытой карточке Saby (sbis.ru/contragents/<inn>),
    закрыта организация или действует по данным ЕГРЮЛ/ЕГРИП ФНС, а также ФИО руководителя/ИП и ОГРН.
    """
    res: dict[str, Any] = {
        "checked": False,
        "is_active": True,
        "status": "",
        "person_name": "",
        "ogrn": "",
    }
    clean_inn = re.sub(r"\D", "", inn or "")
    if len(clean_inn) not in (10, 12):
        return res

    try:
        code, html = http_get_text(
            f"https://sbis.ru/contragents/{clean_inn}",
            timeout=6.5,
            max_bytes=480_000,
        )
        if code != 200 or not html:
            return res
    except Exception as exc:
        logger.debug("Не удалось проверить ИНН %s в Saby: %s", clean_inn, exc)
        return res

    res["checked"] = True

    # 1. Проверяем JSON-поля ЕГРЮЛ/ЕГРИП в SSR Saby
    m_liq_date = re.search(r'"ДатаЛиквидации"\s*:\s*"([^"]+)"', html)
    m_in_liq = re.search(r'"ВПроцессеЛиквидации"\s*:\s*true', html, re.I)
    m_status_html = re.search(r"<b>Статус:</b>\s*([^<]{3,90})", html, re.I)

    if m_liq_date and m_liq_date.group(1) not in ("null", ""):
        res["is_active"] = False
        res["status"] = f"Закрыта / ликвидирована ({m_liq_date.group(1)[:10]})"
    elif m_in_liq:
        res["is_active"] = False
        res["status"] = "В процессе ликвидации (ФНС)"
    elif m_status_html:
        st_txt = clean_text(m_status_html.group(1)).rstrip(".")
        st_low = st_txt.lower()
        if any(w in st_low for w in ("ликвидир", "прекращ", "не действует", "закрыт", "банкрот")):
            res["is_active"] = False
            res["status"] = f"Закрыта ({st_txt})"
        elif "действует" in st_low:
            res["is_active"] = True
            res["status"] = "Действующая (ФНС)"
    else:
        # Если ДатаЛиквидации явно null и ВПроцессеЛиквидации: false
        if '"ДатаЛиквидации":null' in html and '"ВПроцессеЛиквидации":false' in html:
            res["is_active"] = True
            res["status"] = "Действующая (ФНС)"

    m_dir = re.search(
        r"<b>(?:Генеральный директор|Директор|Руководитель|Предприниматель):</b>\s*([^<]{4,100})",
        html,
        re.I,
    )
    if m_dir:
        res["person_name"] = clean_text(m_dir.group(1)).rstrip(".")

    m_ogrn = re.search(r"ОГРН(?:ИП)?[\s:]*(\d{13}|\d{15})\b", html)
    if m_ogrn:
        res["ogrn"] = m_ogrn.group(1)

    return res


def verify_telegram_handle(handle: str) -> bool:
    """Проверяет публичную страницу https://t.me/<handle>, что аккаунт/канал реально существует."""
    slug = (handle or "").lstrip("@").strip()
    if not slug:
        return False
    try:
        code, html = http_get_text(f"https://t.me/{slug}", timeout=4.0, max_bytes=80_000)
        if code != 200:
            return False
        # Реальный профиль или канал в Telegram всегда содержит tgme_page_title
        return "tgme_page_title" in html
    except Exception:
        return True  # При сетевом таймауте не удаляем найденную на сайте ссылку


class StatusScheduleTelegramEnricher:
    """Пакетно проверяет статус ФНС/Saby по ИНН и верифицирует найденные Telegram-аккаунты."""

    def enrich_batch(self, leads: list[Lead], max_inn_checks: int = 12, max_tg_checks: int = 15) -> int:
        updated = 0

        # 1. Параллельная проверка статуса организации в ЕГРЮЛ/ЕГРИП через Saby для карточек с ИНН
        inn_targets = [
            l for l in leads
            if l.inn and "(ФНС)" not in (l.status or "")
        ][:max_inn_checks]

        if inn_targets:
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                inn_fmap = {pool.submit(check_saby_fns_by_inn, lead.inn): lead for lead in inn_targets}
                for fut in inn_fmap:
                    lead = inn_fmap[fut]
                    try:
                        info = fut.result(timeout=7.5)
                    except Exception:
                        continue
                    if info["checked"] and info["status"]:
                        lead.is_active = info["is_active"]
                        lead.status = info["status"]
                        if info["person_name"] and not lead.person_name:
                            lead.person_name = info["person_name"]
                        if info["ogrn"] and not lead.ogrn:
                            lead.ogrn = info["ogrn"]
                        if "ФНС/Saby" not in lead.sources:
                            lead.sources.append("ФНС/Saby")
                        lead.finalize()
                        updated += 1

        # 2. Верификация публичных Telegram-аккаунтов (@username)
        tg_targets = [l for l in leads if l.telegram][:max_tg_checks]
        if tg_targets:
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
                fmap = {pool.submit(verify_telegram_handle, l.telegram): l for l in tg_targets}
                for fut in fmap:
                    lead = fmap[fut]
                    try:
                        ok = fut.result(timeout=5.0)
                        if not ok:
                            lead.telegram = ""
                            lead.socials.pop("telegram", None)
                            lead.finalize()
                    except Exception:
                        pass

        return updated
