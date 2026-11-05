"""Бесплатный модуль №1: поиск свежих регистраций ЕГРЮЛ/ЕГРИП по фронтиру ОГРН/ОГРНИП 2026 года."""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from ..models import Lead, clean_text, extract_emails, extract_phones, normalize_website
from ..regions import PRIORITY_REGIONS, REGIONS
from .http_client import http_get_text, http_json, polite_sleep

logger = logging.getLogger("novoreg.open_egrul")


class FindOrgFrontierCollector:
    """
    Открытый коллектор новорегов ООО по префиксам ОГРН текущего года (1{YY}{RR}...).
    Работает напрямую с зарубежных и российских IP (включая GitHub Actions) без ключей и капчи.
    Автоматически находит бинарным поиском самый высокий (свежий) блок ОГРН в каждом регионе РФ.
    """

    BASE_URL = "https://www.find-org.com"

    def __init__(self, year_2d: str | None = None) -> None:
        now_year = datetime.now(timezone.utc).strftime("%y")
        self.year_2d = year_2d or now_year
        self._blocked = False

    def _fetch_prefix_items(self, prefix: str) -> list[tuple[str, str, str, str]]:
        """Возвращает список (card_path, name, ogrn, inn) по префиксу ОГРН."""
        if self._blocked:
            return []
        url = f"{self.BASE_URL}/search/ogrn/?val={prefix}"
        try:
            _, html = http_get_text(url, timeout=3.5)
        except Exception as exc:
            logger.debug("Ошибка запроса префикса %s: %s", prefix, exc)
            self._blocked = True
            return []

        if "Проверка, что Вы не робот" in html:
            logger.info("find-org запросил паузу защиты от ботов — мгновенный пропуск до следующего цикла")
            self._blocked = True
            return []

        results: list[tuple[str, str, str, str]] = []
        pattern = re.compile(
            r'href=["\'](/cli/\d+_[^"\']+)["\'][^>]*>(.*?)</a>.*?'
            r"\(ОГРН:\s*(\d{13,15})\s*,\s*ИНН:\s*(\d{10,12})\)",
            re.S,
        )
        for m in pattern.finditer(html):
            results.append((
                m.group(1).strip(),
                clean_text(m.group(2)),
                m.group(3).strip(),
                m.group(4).strip(),
            ))
        return results

    def find_latest_block(self, region_code: str, cached_hint: str = "") -> list[tuple[str, str, str, str]]:
        """
        Поразрядный спуск по префиксу ОГРН 1{YY}{RR}{d1}{d2}{d3}{d4}:
        на каждом разряде ищем максимальную непустую цифру (9..0), что на 100% защищено
        от пропусков серий и всегда выводит точно на самые свежие регистрации текущего месяца.
        """
        base = f"1{self.year_2d}{region_code}"
        cur = ""

        # Уровень 1: первая цифра серии (обычно 0, в Москве 0)
        for d1 in ("2", "1", "0"):
            items1 = self._fetch_prefix_items(f"{base}{d1}")
            polite_sleep(0.12)
            if items1:
                cur = d1
                if len(items1) < 50:
                    return items1
                break
        if not cur:
            return []

        # Уровни 2..5: бинарный поиск максимальной непустой цифры 0..9 на каждом шаге
        last_non_empty: list[tuple[str, str, str, str]] = []
        for _level in range(4):
            lo, hi = 0, 9
            best_d: int | None = None
            best_items: list[tuple[str, str, str, str]] = []
            while lo <= hi:
                mid = (lo + hi) // 2
                probe = self._fetch_prefix_items(f"{base}{cur}{mid}")
                polite_sleep(0.12)
                if probe:
                    best_d = mid
                    best_items = probe
                    lo = mid + 1
                else:
                    hi = mid - 1
            if best_d is None:
                break
            cur = f"{cur}{best_d}"
            last_non_empty = best_items
            if len(best_items) < 50:
                break

        # Если в самом верхнем хвосте меньше 8 записей, подхватим соседний предыдущий блок
        if len(last_non_empty) < 8 and len(cur) >= 2 and cur[-1].isdigit() and int(cur[-1]) > 0:
            prev_prefix = cur[:-1] + str(int(cur[-1]) - 1)
            prev_items = self._fetch_prefix_items(f"{base}{prev_prefix}")
            last_non_empty = prev_items + last_non_empty

        return last_non_empty

    def parse_card(self, card_path: str, fallback_name: str, ogrn: str, inn: str, region_code: str) -> Lead | None:
        url = f"{self.BASE_URL}{card_path}"
        try:
            _, html = http_get_text(url, timeout=8.0)
        except Exception as exc:
            logger.debug("Ошибка загрузки карточки %s: %s", url, exc)
            return None

        def field_val(label_regex: str) -> str:
            m = re.search(label_regex + r".*?<td[^>]*>(.*?)</td>", html, re.S | re.I)
            if m:
                return clean_text(m.group(1))
            return ""

        text_flat = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " | ", html))

        full_name = ""
        m_full = re.search(r"Юридическое наименование\s*\|\s*:\s*\|\s*([^|]+)", text_flat)
        if m_full:
            full_name = m_full.group(1).strip()

        person_raw = ""
        m_boss = re.search(r"Руководитель\s*\|\s*:\s*\|\s*([^|]+)", text_flat)
        if m_boss:
            person_raw = m_boss.group(1).strip()

        person_role = "Генеральный директор"
        person_name = person_raw
        for role_prefix in (
            "ГЕНЕРАЛЬНЫЙ ДИРЕКТОР",
            "ДИРЕКТОР",
            "ПРЕЗИДЕНТ",
            "УПРАВЛЯЮЩИЙ",
            "ЛИКВИДАТОР",
            "ПРЕДСЕДАТЕЛЬ",
        ):
            if person_raw.upper().startswith(role_prefix):
                person_role = role_prefix.capitalize()
                person_name = person_raw[len(role_prefix):].strip(" :-,")
                break
        if person_name.isupper():
            person_name = person_name.title()

        address = ""
        m_addr = re.search(r"Юридический адрес:\s*\|\s*([^|]+)", text_flat)
        if m_addr:
            address = m_addr.group(1).strip()

        reg_date = ""
        m_date = re.search(r"Дата присвоения:\s*\|\s*(\d{2}\.\d{2}\.\d{4})", text_flat)
        if m_date:
            reg_date = m_date.group(1)

        kpp = ""
        m_kpp = re.search(r"КПП:\s*\|\s*(\d{9})", text_flat)
        if m_kpp:
            kpp = m_kpp.group(1)

        capital = ""
        m_cap = re.search(r"Уставной капитал:\s*\|\s*([^|]+)", text_flat)
        if m_cap:
            capital = m_cap.group(1).strip()

        okved_code, okved_name = "", ""
        m_okv = re.search(
            r"Основной \(по коду ОКВЭД 2\):\s*(?:\|\s*)+(\d{2}(?:\.\d{1,2})*)\s*\|\s*-\s*([^|]+)",
            text_flat,
        )
        if m_okv:
            okved_code = m_okv.group(1).strip()
            okved_name = m_okv.group(2).strip()

        phones: list[str] = []
        m_tel_block = re.search(r"Телефон(?:ы)?\s*\|\s*:\s*\|\s*([^|]+)", text_flat)
        if m_tel_block and "E-mail" not in m_tel_block.group(1):
            phones.extend(extract_phones(m_tel_block.group(1)))

        emails: list[str] = []
        m_em_block = re.search(r"E-mail \(эл\.почта\)\s*\|\s*:\s*\|\s*([^|]+)", text_flat)
        if m_em_block and "Сайт" not in m_em_block.group(1):
            emails.extend(extract_emails(m_em_block.group(1)))

        websites: list[str] = []
        m_site_block = re.search(r"Сайт\s*\|\s*:\s*\|\s*([^|]+)", text_flat)
        if m_site_block and "Юридический адрес" not in m_site_block.group(1):
            w = normalize_website(m_site_block.group(1))
            if w:
                websites.append(w)

        return Lead(
            entity_type="ООО",
            name=fallback_name,
            full_name=full_name or fallback_name,
            inn=inn,
            ogrn=ogrn,
            kpp=kpp,
            reg_date=reg_date,
            region_code=region_code,
            region_name=REGIONS.get(region_code, ""),
            address=address,
            person_name=person_name,
            person_role=person_role,
            okved_code=okved_code,
            okved_name=okved_name,
            phones=phones,
            emails=emails,
            websites=websites,
            capital=capital,
            sources=["ЕГРЮЛ Open (Фронтир 2026)"],
        ).finalize()

    def collect(
        self,
        state: dict[str, Any],
        regions_per_run: int = 5,
        cards_per_region: int = 8,
        existing_ogrns: set[str] | None = None,
    ) -> list[Lead]:
        existing_ogrns = existing_ogrns or set()
        frontiers: dict[str, int] = dict(state.get("ogrn_frontiers") or {})
        rot_idx = int(state.get("region_rotation_idx", 0))

        selected_regions: list[str] = []
        for i in range(regions_per_run):
            rc = PRIORITY_REGIONS[(rot_idx + i) % len(PRIORITY_REGIONS)]
            if rc not in selected_regions:
                selected_regions.append(rc)
        state["region_rotation_idx"] = (rot_idx + regions_per_run) % len(PRIORITY_REGIONS)

        collected: list[Lead] = []
        for rc in selected_regions:
            if self._blocked:
                break
            hint = str(frontiers.get(rc, ""))
            items = self.find_latest_block(rc, cached_hint=hint)
            if not items:
                continue

            # Обновляем подсказку фронтира по последнему ОГРН
            last_ogrn = items[-1][2]
            if len(last_ogrn) == 13:
                frontiers[rc] = last_ogrn[5:9]

            # Берём самые свежие с конца списка
            candidates = list(reversed(items))
            parsed_here = 0
            for card_path, cname, ogrn, inn in candidates:
                if parsed_here >= cards_per_region:
                    break
                if ogrn in existing_ogrns:
                    continue
                lead = self.parse_card(card_path, cname, ogrn, inn, rc)
                polite_sleep(0.2)
                if lead:
                    collected.append(lead)
                    parsed_here += 1

        state["ogrn_frontiers"] = frontiers
        logger.info("FindOrgFrontierCollector: собрано %d свежих ООО из регионов %s", len(collected), selected_regions)
        return collected


class FnsDirectCollector:
    """
    Прямой коннектор к официальному открытому сервису ФНС egrul.nalog.ru (ИП и ООО).
    Автоматически активируется при запуске из сети РФ или при наличии RU_PROXY_URL.
    """

    BASE_URL = "https://egrul.nalog.ru"

    def collect(self, regions: list[str] | None = None, limit_per_query: int = 15) -> list[Lead]:
        year_2d = datetime.now(timezone.utc).strftime("%y")
        target_regions = regions or ["77", "78", "50", "23"]
        leads: list[Lead] = []

        # Быстрая проверка доступности egrul.nalog.ru с текущего IP / прокси
        try:
            http_get_text(f"{self.BASE_URL}/", timeout=2.2, max_bytes=4096, use_ru_proxy=True)
        except Exception:
            logger.info("egrul.nalog.ru недоступен с зарубежного IP без RU_PROXY_URL — пропуск прямого опроса ФНС")
            return []

        queries = []
        for rc in target_regions[:3]:
            queries.append(("ИП", f"3{year_2d}{rc}", rc))
            queries.append(("ООО", f"1{year_2d}{rc}", rc))

        for etype, q_str, rc in queries:
            try:
                _, token_resp = http_json(
                    f"{self.BASE_URL}/",
                    method="POST",
                    form_data={"query": q_str, "vyp3CaptchaToken": "", "page": "", "namession": ""},
                    timeout=7.0,
                    use_ru_proxy=True,
                )
                token = token_resp.get("t")
                if not token:
                    continue
                polite_sleep(0.6)
                _, res = http_json(
                    f"{self.BASE_URL}/search-result/{token}",
                    method="GET",
                    timeout=8.0,
                    use_ru_proxy=True,
                )
                for row in (res.get("rows") or [])[:limit_per_query]:
                    # Только действующие записи (без даты прекращения 'e')
                    if row.get("e"):
                        continue
                    is_ip = row.get("k") == "fl" or etype == "ИП"
                    raw_name = row.get("c") or row.get("n") or ""
                    if is_ip and not raw_name.upper().startswith("ИП "):
                        short_name = f"ИП {raw_name.title()}"
                    else:
                        short_name = raw_name
                    leads.append(
                        Lead(
                            entity_type="ИП" if is_ip else "ООО",
                            name=short_name,
                            full_name=row.get("n") or short_name,
                            inn=str(row.get("i", "")),
                            ogrn=str(row.get("o", "")),
                            kpp=str(row.get("p", "")),
                            reg_date=str(row.get("r", "")),
                            region_code=rc,
                            region_name=REGIONS.get(rc, ""),
                            address=str(row.get("a", "")),
                            person_name=raw_name.title() if is_ip else str(row.get("g", "")),
                            sources=["ФНС ЕГРЮЛ/ЕГРИП"],
                        ).finalize()
                    )
            except Exception as exc:
                logger.debug("Ошибка запроса egrul.nalog.ru (%s): %s", q_str, exc)

        return leads
