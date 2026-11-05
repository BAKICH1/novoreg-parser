"""Бесплатный модуль №2: сбор и дообогащение деловых телефонов, email и мессенджеров из открытых справочников и сайтов."""

from __future__ import annotations

import concurrent.futures
import logging
import os
import re
from typing import Any

from ..models import (
    Lead,
    clean_text,
    detect_org_status_from_html,
    extract_emails,
    extract_phones,
    extract_telegram,
    extract_work_hours_from_html,
    normalize_website,
)
from ..regions import resolve_region
from .http_client import http_get_text, polite_sleep

logger = logging.getLogger("novoreg.open_contacts")

PUBLIC_MAIL_DOMAINS = {
    "mail.ru", "bk.ru", "inbox.ru", "list.ru", "internet.ru",
    "yandex.ru", "ya.ru", "yandex.com", "gmail.com", "rambler.ru",
    "icloud.com", "outlook.com", "hotmail.com", "yahoo.com",
}

ORGPAGE_CITY_FEEDS = [
    ("moskva", "77", "г. Москва"),
    ("sankt-peterburg", "78", "г. Санкт-Петербург"),
    ("krasnodar", "23", "Краснодарский край"),
    ("ekaterinburg", "66", "Свердловская область"),
    ("novosibirsk", "54", "Новосибирская область"),
    ("kazan", "16", "Республика Татарстан"),
    ("nizhniy-novgorod", "52", "Нижегородская область"),
    ("rostov-na-donu", "61", "Ростовская область"),
    ("samara", "63", "Самарская область"),
    ("chelyabinsk", "74", "Челябинская область"),
    ("ufa", "02", "Республика Башкортостан"),
    ("krasnoyarsk", "24", "Красноярский край"),
    ("voronezh", "36", "Воронежская область"),
    ("perm", "59", "Пермский край"),
    ("tyumen", "72", "Тюменская область"),
    ("volgograd", "34", "Волгоградская область"),
    ("saratov", "64", "Саратовская область"),
    ("tolyatti", "63", "Самарская область"),
    ("izhevsk", "18", "Удмуртская Республика"),
    ("barnaul", "22", "Алтайский край"),
    ("ulyanovsk", "73", "Ульяновская область"),
    ("irkutsk", "38", "Иркутская область"),
    ("khabarovsk", "27", "Хабаровский край"),
    ("yaroslavl", "76", "Ярославская область"),
    ("vladivostok", "25", "Приморский край"),
    ("tomsk", "70", "Томская область"),
    ("orenburg", "56", "Оренбургская область"),
    ("kemerovo", "42", "Кемеровская область — Кузбасс"),
    ("ryazan", "62", "Рязанская область"),
    ("astrakhan", "30", "Астраханская область"),
    ("penza", "58", "Пензенская область"),
    ("lipetsk", "48", "Липецкая область"),
    ("kirov", "43", "Кировская область"),
    ("cheboksary", "21", "Чувашская Республика"),
    ("tula", "71", "Тульская область"),
    ("kaliningrad", "39", "Калининградская область"),
    ("kursk", "46", "Курская область"),
    ("stavropol", "26", "Ставропольский край"),
    ("sochi", "23", "Краснодарский край"),
    ("tver", "69", "Тверская область"),
    ("ivanovo", "37", "Ивановская область"),
    ("bryansk", "32", "Брянская область"),
    ("belgorod", "31", "Белгородская область"),
]

ORGPAGE_CATEGORIES = [
    ("https://www.orgpage.ru/rossiya/строительство/", "41.20", "Строительство жилых и нежилых зданий"),
    ("https://www.orgpage.ru/rossiya/бизнес/", "70.22", "Консультирование по вопросам коммерческой деятельности"),
    ("https://www.orgpage.ru/rossiya/услуги/", "96.09", "Предоставление прочих персональных и деловых услуг"),
    ("https://www.orgpage.ru/rossiya/промышленность/", "25.11", "Производство промышленной продукции"),
    ("https://www.orgpage.ru/rossiya/розничная_торговля/", "47.19", "Торговля розничная и электронная коммерция"),
    ("https://www.orgpage.ru/rossiya/транспорт/", "49.41", "Деятельность автомобильного грузового транспорта"),
    ("https://www.orgpage.ru/rossiya/informatsionnye-tekhnologii/", "62.01", "Разработка компьютерного ПО и ИТ-интеграция"),
    ("https://www.orgpage.ru/rossiya/nedvizhimost/", "68.31", "Деятельность агентств недвижимости"),
    ("https://www.orgpage.ru/rossiya/avto-i-moto/", "45.20", "Техническое обслуживание и ремонт автотранспорта"),
    ("https://www.orgpage.ru/rossiya/yuridicheskie-uslugi/", "69.10", "Деятельность в области права и консалтинга"),
    ("https://www.orgpage.ru/rossiya/reklama-i-poligrafiya/", "73.11", "Деятельность рекламных агентств и полиграфии"),
    ("https://www.orgpage.ru/rossiya/dom-i-interer/", "43.39", "Производство мебели и обустройство интерьеров"),
    ("https://www.orgpage.ru/rossiya/otdelochnye-raboty/", "43.39", "Отделочные и строительно-монтажные работы"),
    ("https://www.orgpage.ru/rossiya/ремонт/", "43.39", "Строительно-отделочные и ремонтные работы"),
    ("https://www.orgpage.ru/rossiya/odezhda-i-obuv/", "47.71", "Торговля одеждой, обувью и текстилем"),
    ("https://www.orgpage.ru/rossiya/krasota-i-zdorove/", "96.02", "Индустрия красоты и оздоровительные центры"),
    ("https://www.orgpage.ru/rossiya/restorany-kafe/", "56.10", "Деятельность ресторанов и доставка питания"),
    ("https://www.orgpage.ru/rossiya/oteli-i-gostinitsy/", "55.10", "Деятельность гостиниц и мест размещения"),
    ("https://www.orgpage.ru/rossiya/медицина/", "86.21", "Медицинская и стоматологическая практика"),
    ("https://www.orgpage.ru/rossiya/kompyuternyy-remont/", "95.11", "Ремонт компьютеров и коммуникационного оборудования"),
    ("https://www.orgpage.ru/rossiya/remont-elektriki/", "43.21", "Производство электромонтажных работ"),
    ("https://www.orgpage.ru/rossiya/remont-instrumentov/", "33.12", "Ремонт машин и промышленного оборудования"),
    ("https://www.orgpage.ru/rossiya/dorozhnyy-remont/", "42.11", "Строительство автомобильных дорог и благоустройство"),
    ("https://www.orgpage.ru/rossiya/жкх_и_благоустройство/", "81.21", "Обслуживание зданий и территорий"),
    ("https://www.orgpage.ru/rossiya/образование/", "85.42", "Образование дополнительное детей и взрослых"),
    ("https://www.orgpage.ru/rossiya/sport/", "93.13", "Деятельность фитнес-центров и спортивных студий"),
    ("https://www.orgpage.ru/rossiya/туризм_и_отдых/", "79.11", "Деятельность туристических агентств"),
    ("https://www.orgpage.ru/rossiya/досуг/", "93.29", "Организация отдыха и развлечений"),
]

EXCLUDED_OPF_SET = {
    "ЗАО", "ОАО", "ПАО", "НАО", "АО", "ГБУ", "ГБУЗ", "ГБОУ",
    "МБУ", "МБОУ", "МУП", "ГУП", "ФГУП", "ФГБУ", "АНО", "ТСЖ", "ТСН", "СНТ",
}


def _fetch_orgpage_fast(url: str, timeout: float = 5.5, max_bytes: int = 240_000) -> tuple[int, str]:
    """
    Быстрое чтение карточек и рубрик Orgpage с использованием Cloudflare Edge-маршрута
    (отвечает за ~0.35 сек с любых зарубежных IP, включая GitHub Actions) и прямым резервом.
    """
    slug = os.getenv("HERENOW_SLUG", "vivid-quill-yz5r").strip()
    if slug and url.startswith("https://www.orgpage.ru/"):
        rel_path = url[len("https://www.orgpage.ru"):]
        edge_url = f"https://{slug}.here.now/api/orgpage{rel_path}"
        try:
            code, html = http_get_text(edge_url, timeout=timeout, max_bytes=max_bytes)
            if code == 200 and html:
                return code, html
        except Exception:
            pass
    return http_get_text(url, timeout=timeout, max_bytes=max_bytes)


def _extract_socials(html: str) -> dict[str, str]:
    socials: dict[str, str] = {}
    tg = extract_telegram(html)
    if tg:
        socials["telegram"] = f"https://t.me/{tg.lstrip('@')}"

    m_wa = re.search(r"https?://(?:wa\.me|api\.whatsapp\.com/send\?phone=)(\d{10,15})", html, re.I)
    if m_wa:
        socials["whatsapp"] = f"https://wa.me/{m_wa.group(1)}"

    m_vk = re.search(r"https?://vk\.com/([a-zA-Z0-9_.\-]{3,40})", html, re.I)
    if m_vk and m_vk.group(1).lower() not in ("share.php", "widget", "feed", "login", "orgpage"):
        socials["vk"] = f"https://vk.com/{m_vk.group(1)}"
    return socials


def _probe_company_site(url: str) -> dict[str, Any]:
    """Быстрый и безопасный обход главной страницы корпоративного сайта для поиска реквизитов, Telegram и часов работы."""
    out: dict[str, Any] = {
        "phones": [],
        "emails": [],
        "socials": {},
        "telegram": "",
        "work_hours": "",
        "is_active": True,
        "status": "Действующая",
        "inn": "",
        "ogrn": "",
        "entity_type": "",
        "legal_name": "",
        "person_name": "",
    }
    try:
        _, html = http_get_text(url, timeout=3.5, max_bytes=160_000)
    except Exception:
        return out

    out["phones"] = extract_phones(html)[:3]
    out["emails"] = extract_emails(html)[:3]
    out["socials"] = _extract_socials(html)
    out["telegram"] = extract_telegram(html)
    out["work_hours"] = extract_work_hours_from_html(html)
    out["is_active"], out["status"] = detect_org_status_from_html(html, out["work_hours"])

    flat = clean_text(html)
    # Если не найдены ИНН или Telegram или часы работы — проверяем страницу контактов/реквизитов
    if ("ИНН" not in flat and "ОГРН" not in flat) or not out["telegram"] or not out["work_hours"]:
        m_sub = re.search(
            r'href=["\'](/(?:contacts?|kontakty|rekvizit[a-z]*|privacy[a-z\-_]*|policy[a-z\-_]*|oferta[a-z\-_]*|legal|about)/?)["\']',
            html,
            re.I,
        )
        if m_sub:
            try:
                _, sub_html = http_get_text(url.rstrip("/") + m_sub.group(1), timeout=2.8, max_bytes=120_000)
                flat = flat + " | " + clean_text(sub_html)
                for p in extract_phones(sub_html)[:2]:
                    if p not in out["phones"]:
                        out["phones"].append(p)
                for e in extract_emails(sub_html)[:2]:
                    if e not in out["emails"]:
                        out["emails"].append(e)
                sub_soc = _extract_socials(sub_html)
                for k, v in sub_soc.items():
                    if k not in out["socials"]:
                        out["socials"][k] = v
                if not out["telegram"]:
                    out["telegram"] = extract_telegram(sub_html)
                if not out["work_hours"]:
                    out["work_hours"] = extract_work_hours_from_html(sub_html)
            except Exception:
                pass

    m_inn = re.search(r"ИНН[\s:№\-]*(\d{10}|\d{12})\b", flat)
    if m_inn:
        out["inn"] = m_inn.group(1)

    m_ogrn = re.search(r"ОГРН(?:ИП)?[\s:№\-]*(\d{13}|\d{15})\b", flat)
    if m_ogrn:
        out["ogrn"] = m_ogrn.group(1)

    m_ip = re.search(
        r"(?:\bИП\b|Индивидуальный\s+предприниматель)\s+([А-ЯЁ][а-яё\-]+\s+[А-ЯЁ][а-яё.\-]+(?:\s+[А-ЯЁ][а-яё.\-]+)?)",
        flat,
    )
    if m_ip:
        fio = m_ip.group(1).strip(" .,;:")
        out["entity_type"] = "ИП"
        out["person_name"] = fio
        out["legal_name"] = f"ИП {fio}"
    else:
        m_ooo = re.search(r'ООО\s*[«"]([^«"»\n]{2,42})[»"]', flat)
        if m_ooo:
            out["entity_type"] = "ООО"
            out["legal_name"] = f'ООО "{m_ooo.group(1).strip()}"'

    return out


class OpenContactsCollector:
    """
    Собирает карточки российского бизнеса (ИП и ООО) с активными номерами телефонов
    из открытого бизнес-справочника Orgpage + проверяет корпоративные сайты на ИНН/ОГРН/ИП.
    """

    def collect_directory_leads(
        self,
        state: dict[str, Any],
        categories_per_run: int = 2,
        items_per_category: int = 10,
    ) -> list[Lead]:
        cursor = int(state.get("orgpage_cursor", 0))
        cat_page = int(state.get("orgpage_cat_page", 1))
        chosen = [
            ORGPAGE_CATEGORIES[(cursor + i) % len(ORGPAGE_CATEGORIES)]
            for i in range(categories_per_run)
        ]
        next_cursor = cursor + categories_per_run
        if next_cursor >= len(ORGPAGE_CATEGORIES):
            cat_page = (cat_page % 40) + 1
        state["orgpage_cursor"] = next_cursor % len(ORGPAGE_CATEGORIES)
        state["orgpage_cat_page"] = cat_page

        raw_cards: list[dict[str, Any]] = []
        seen_cids: set[str] = set()

        # Формируем параллельный пакет лент: федеральные рубрики + регионально-отраслевые ленты
        city_cursor = int(state.get("orgpage_city_cursor", 0))
        chosen_cities = [
            ORGPAGE_CITY_FEEDS[(city_cursor + i) % len(ORGPAGE_CITY_FEEDS)]
            for i in range(6)
        ]
        state["orgpage_city_cursor"] = (city_cursor + 6) % len(ORGPAGE_CITY_FEEDS)

        listing_tasks: list[tuple[str, str, str, str, str]] = []
        for idx_c, (base_cat_url, okved_code, okved_name) in enumerate(chosen):
            cat_url = base_cat_url if cat_page <= 1 else f"{base_cat_url.rstrip('/')}/{cat_page}/"
            listing_tasks.append((cat_url, okved_code, okved_name, "", ""))
            # Плюс региональный срез той же рубрики для глубокого охвата городов РФ
            c_slug, r_code, r_name = chosen_cities[idx_c % len(chosen_cities)]
            rub_slug = base_cat_url.rstrip("/").rsplit("/", 1)[-1]
            city_rub_url = (
                f"https://www.orgpage.ru/{c_slug}/{rub_slug}/"
                if cat_page <= 1
                else f"https://www.orgpage.ru/{c_slug}/{rub_slug}/{cat_page}/"
            )
            listing_tasks.append((city_rub_url, okved_code, okved_name, r_code, r_name))

        def fetch_listing_task(t: tuple[str, str, str, str, str]) -> tuple[tuple[str, str, str, str, str], str]:
            u = t[0]
            try:
                _, h = _fetch_orgpage_fast(u, timeout=6.0)
                return t, h
            except Exception as exc:
                logger.debug("Ошибка чтения каталога %s: %s", u, exc)
                return t, ""

        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as lpool:
            listing_results = list(lpool.map(fetch_listing_task, listing_tasks))

        for (_, okved_code, okved_name, f_rcode, f_rname), html in listing_results:
            if not html:
                continue
            blocks = re.findall(
                r'<div class="object-item[^"]*"\s+data-companyid="(\d+)">(.*?)<div class="similar-item__opened',
                html,
                re.S,
            )
            for cid, block in blocks[:items_per_category]:
                if cid in seen_cids:
                    continue
                m_title = re.search(
                    r'similar-item__title">.*?<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
                    block,
                    re.S,
                )
                if not m_title:
                    continue
                card_url = m_title.group(1).strip()
                brand = re.sub(r"^\d+\.\s*", "", clean_text(m_title.group(2))).strip(' "«»')

                phones: list[str] = []
                for pm in re.findall(r'<div class="phone\s*">\s*([^<]+?)\s*</div>', block, re.S):
                    phones.extend(extract_phones(pm))

                if not phones:
                    continue

                site_url = ""
                m_site = re.search(r'<div class="site">\s*([^<\s]+)', block, re.S)
                if m_site:
                    nw = normalize_website(m_site.group(1))
                    if nw:
                        site_url = nw

                address = ""
                m_addr = re.search(r'similar-item__adrss-item">\s*([^<]+?)\s*</div>', block, re.S)
                if m_addr:
                    address = clean_text(m_addr.group(1))

                desc = ""
                m_desc = re.search(r'similar-item__description">\s*([^<]+?)\s*</div>', block, re.S)
                if m_desc:
                    desc = clean_text(m_desc.group(1))

                seen_cids.add(cid)
                raw_cards.append({
                    "cid": cid,
                    "card_url": card_url,
                    "brand": brand,
                    "phones": phones,
                    "site_url": site_url,
                    "address": address,
                    "okved_code": okved_code,
                    "okved_name": desc or okved_name,
                    "region_code": f_rcode,
                    "region_name": f_rname,
                })

        # Параллельно собираем ленту самых свежих карточек (ID 61xxxxx/62xxxxx) и ИП с городских витрин РФ
        def fetch_city_home(city_tuple: tuple[str, str, str]) -> tuple[tuple[str, str, str], str]:
            try:
                _, ch = _fetch_orgpage_fast(f"https://www.orgpage.ru/{city_tuple[0]}/", timeout=5.5)
                return city_tuple, ch
            except Exception:
                return city_tuple, ""

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as cpool:
            city_homes = list(cpool.map(fetch_city_home, chosen_cities[:4]))

        for (city_slug, rcode, rname), chtml in city_homes:
            if not chtml:
                continue
            ip_matches = list(re.finditer(
                rf"(https://www\.orgpage\.ru/{city_slug}/[a-z0-9\-]*ip-[a-z0-9\-]+-(\d+)\.html)",
                chtml,
            ))
            fresh_matches = list(re.finditer(
                rf"(https://www\.orgpage\.ru/{city_slug}/[a-z0-9\-]+-(6[12]\d{{5}})\.html)",
                chtml,
            ))
            added_city = 0
            for m_url in (ip_matches + fresh_matches):
                full_u, cid = m_url.group(1), m_url.group(2)
                if cid in seen_cids:
                    continue
                seen_cids.add(cid)
                raw_cards.append({
                    "cid": cid,
                    "card_url": full_u,
                    "brand": "",
                    "phones": [],
                    "site_url": "",
                    "address": rname,
                    "okved_code": "",
                    "okved_name": "Новые компании города",
                    "region_code": rcode,
                    "region_name": rname,
                })
                added_city += 1
                if added_city >= 6:
                    break

        # Параллельно и быстро проверяем детальные карточки / сайты для извлечения ИП/ООО, ИНН, Email
        leads: list[Lead] = []

        def enrich_one(item: dict[str, Any]) -> Lead | None:
            emails: list[str] = []
            socials: dict[str, str] = {}
            telegram = ""
            work_hours = ""
            is_active = True
            org_status = "Действующая"
            inn = ""
            ogrn = ""
            person_name = ""
            etype = ""
            legal_name = ""
            phones = list(item["phones"])
            site_url = item["site_url"]
            brand = item["brand"]
            address = item["address"]
            okved_name = item["okved_name"]

            # 1) Быстрая проверка карточки на Orgpage для телефонов, часов работы, статуса, сайта, email и юрлица
            try:
                _, detail_html = _fetch_orgpage_fast(item["card_url"], timeout=4.5, max_bytes=180_000)
                m_any_opf = re.search(r'"opf"\s*:\s*"([^"]*)"', detail_html)
                if m_any_opf:
                    raw_opf = m_any_opf.group(1).strip().upper()
                    if raw_opf in EXCLUDED_OPF_SET:
                        return None
                    if raw_opf in ("ИП", "ООО"):
                        etype = raw_opf
                if not phones:
                    phones.extend(extract_phones(detail_html)[:3])
                emails.extend(extract_emails(detail_html)[:2])
                socials.update(_extract_socials(detail_html))
                telegram = extract_telegram(detail_html) or telegram
                work_hours = extract_work_hours_from_html(detail_html) or work_hours
                is_active, org_status = detect_org_status_from_html(detail_html, work_hours)
                m_cname = re.search(r'"name"\s*:\s*"([^"]{2,90})"', detail_html)
                if not brand and m_cname:
                    brand = clean_text(m_cname.group(1)).strip(' "«»')
                if not brand:
                    m_h1 = re.search(r"<h1[^>]*>(.*?)</h1>", detail_html, re.S)
                    if m_h1:
                        h1_txt = clean_text(m_h1.group(1))
                        if h1_txt.endswith(" ИП") or " ИП " in f" {h1_txt} ":
                            etype = "ИП"
                            h1_txt = re.sub(r"\bИП\b", "", h1_txt).strip()
                        elif h1_txt.endswith(" ООО") or " ООО " in f" {h1_txt} ":
                            etype = "ООО"
                            h1_txt = re.sub(r"\bООО\b", "", h1_txt).strip()
                        brand = h1_txt.strip(' "«»')
                if not site_url:
                    m_site_div = re.search(
                        r'itemprop="url"[^>]*href=["\']([^"\']+)["\']|<div class="site">\s*([^<\s]+)',
                        detail_html,
                        re.I,
                    )
                    if m_site_div:
                        nw = normalize_website(m_site_div.group(1) or m_site_div.group(2))
                        if nw:
                            site_url = nw
                m_rub = re.search(r'<meta\s+name="keywords"\s+content="([^"]+)"', detail_html, re.I)
                if m_rub and okved_name == "Новые компании города":
                    parts_kw = [p.strip() for p in clean_text(m_rub.group(1)).split(",") if p.strip()]
                    if len(parts_kw) >= 2:
                        okved_name = parts_kw[1][:90]

                flat_detail = clean_text(detail_html)
                m_leg_q = re.search(r'\b(ООО)\s*[«"]([^«"»]{2,45})[»"]', flat_detail)
                m_leg_ip = re.search(
                    r"\bИП\s+([А-ЯЁ][а-яё\-]+\s+[А-ЯЁ][а-яё.\-]+(?:\s+[А-ЯЁ][а-яё.\-]+)?)",
                    flat_detail,
                )
                if m_leg_ip:
                    etype = "ИП"
                    person_name = m_leg_ip.group(1).strip(" .,;:")
                    legal_name = f"ИП {person_name}"
                elif m_leg_q:
                    etype = "ООО"
                    legal_name = f'ООО "{m_leg_q.group(2).strip()}"'
            except Exception:
                pass

            if not phones:
                return None

            # 2) Если указан корпоративный сайт — проверяем подвал сайта на ИНН/ОГРН/ИП/мессенджеры
            if site_url:
                site_info = _probe_company_site(site_url)
                for p in site_info["phones"]:
                    if p not in phones:
                        phones.append(p)
                for e in site_info["emails"]:
                    if e not in emails:
                        emails.append(e)
                socials.update(site_info["socials"])
                telegram = telegram or site_info.get("telegram", "")
                work_hours = work_hours or site_info.get("work_hours", "")
                if not site_info.get("is_active", True):
                    is_active = False
                    org_status = site_info.get("status", "Закрыта / не работает")
                inn = site_info["inn"] or inn
                ogrn = site_info["ogrn"] or ogrn
                if site_info["entity_type"]:
                    etype = site_info["entity_type"]
                if site_info["legal_name"]:
                    legal_name = site_info["legal_name"]
                if site_info["person_name"]:
                    person_name = site_info["person_name"]

            # Если в карточке мобильный номер +7 (9XX) и не указано ООО, отмечаем малый бизнес / ИП при наличии признаков
            if not etype:
                if len(inn) == 12 or len(ogrn) == 15 or "/ip-" in item["card_url"]:
                    etype = "ИП"
                elif phones and phones[0].startswith("+7 (9") and not site_url:
                    etype = "ИП"
                else:
                    etype = "ООО"

            brand = brand or f"Компания #{item['cid']}"
            display_name = legal_name or (
                f"ИП — {brand}" if etype == "ИП" else f'ООО "{brand}"'
            )

            reg_date = ""
            if len(ogrn) in (13, 15) and ogrn[1:3].isdigit():
                yr = int(ogrn[1:3])
                if 20 <= yr <= 26:
                    reg_date = f"20{yr:02d}-10-15" if yr == 26 else f"20{yr:02d}-06-15"

            rc = item.get("region_code") or ""
            rn = item.get("region_name") or ""
            if not rc or inn or ogrn:
                rc, rn = resolve_region(inn=inn, ogrn=ogrn, address=address)
            sources = ["Открытый каталог РФ"]
            if site_url:
                sources.append("Сайт компании")

            return Lead(
                id=f"inn-{inn}" if inn else f"orgpage-{item['cid']}",
                entity_type=etype,
                name=display_name,
                full_name=display_name,
                inn=inn,
                ogrn=ogrn,
                reg_date=reg_date,
                region_code=rc,
                region_name=rn,
                address=address,
                person_name=person_name,
                okved_code=item["okved_code"],
                okved_name=okved_name,
                phones=phones[:4],
                emails=emails[:3],
                websites=[site_url] if site_url else [],
                socials=socials,
                status=org_status,
                is_active=is_active,
                work_hours=work_hours,
                telegram=telegram,
                sources=sources,
            ).finalize()

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            futures = [pool.submit(enrich_one, c) for c in raw_cards]
            for fut in futures:
                try:
                    lead = fut.result(timeout=8.5)
                    if lead and lead.has_phone:
                        leads.append(lead)
                except Exception as exc:
                    logger.debug("Таймаут/ошибка обогащения карточки каталога: %s", exc)

        logger.info("OpenContactsCollector: получено %d карточек с проверенными телефонами", len(leads))
        return leads

    def enrich_existing_leads(self, leads: list[Lead], max_probes: int = 15) -> int:
        """
        Дообогащает карточки без телефонов, если у них известен корпоративный сайт
        или корпоративный домен в email.
        """
        targets: list[tuple[Lead, str]] = []
        for lead in leads:
            if lead.has_phone and lead.emails:
                continue
            site = lead.websites[0] if lead.websites else ""
            if not site and lead.emails:
                dom = lead.emails[0].split("@", 1)[-1].lower()
                if dom and dom not in PUBLIC_MAIL_DOMAINS:
                    site = f"https://{dom}"
            if site:
                targets.append((lead, site))
            if len(targets) >= max_probes:
                break

        if not targets:
            return 0

        enriched_count = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            future_map = {pool.submit(_probe_company_site, url): (lead, url) for lead, url in targets}
            for fut in future_map:
                lead, url = future_map[fut]
                try:
                    info = fut.result(timeout=4.5)
                except Exception:
                    continue
                before = len(lead.phones)
                for p in info["phones"]:
                    if p not in lead.phones:
                        lead.phones.append(p)
                for e in info["emails"]:
                    if e not in lead.emails:
                        lead.emails.append(e)
                lead.socials.update(info["socials"])
                if url not in lead.websites:
                    lead.websites.append(url)
                if len(lead.phones) > before:
                    if "Сайт компании" not in lead.sources:
                        lead.sources.append("Сайт компании")
                    enriched_count += 1
                lead.finalize()

        return enriched_count
