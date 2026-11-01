"""Модели данных и функции нормализации реквизитов, телефонов и email."""

from __future__ import annotations

import hashlib
import html
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .regions import classify_okved, resolve_region

BAD_EMAIL_DOMAINS = {
    "example.com",
    "domain.com",
    "test.ru",
    "sentry.io",
    "wixpress.com",
    "orgpage.ru",
    "find-org.com",
    "find-org.net",
    "2gis.ru",
    "dadata.ru",
    "checko.ru",
    "tilda.ws",
}

PHONE_RAW_RE = re.compile(
    r"(?:(?:\+7|8)[\s\-()]*\d{3,4}[\s\-()]*\d{2,3}[\s\-]*\d{2}[\s\-]*\d{2})"
)
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,10}")


def clean_text(val: str | None) -> str:
    if not val:
        return ""
    unescaped = html.unescape(str(val))
    cleaned = re.sub(r"<[^>]+>", " ", unescaped)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def normalize_phone(raw: str) -> str | None:
    """Нормализует российский телефон к виду +7 (XXX) XXX-XX-XX."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 10 and digits[0] in ("9", "4", "8", "3"):
        digits = "7" + digits
    elif len(digits) == 11 and digits[0] == "8":
        digits = "7" + digits[1:]
    elif len(digits) == 11 and digits[0] == "7":
        pass
    else:
        return None

    body = digits[1:]
    # Проверка допустимого российского DEF/ABC кода (+7 9XX, 800/804, 3XX, 4XX, 81X-87X)
    area = int(body[:3])
    valid_area = (
        900 <= area <= 999
        or area in (800, 804)
        or 300 <= area <= 499
        or 811 <= area <= 879
    )
    if not valid_area:
        return None

    # Отсекаем заведомо мусорные последовательности
    if len(set(body)) <= 2:
        return None
    if body.startswith("000") or body in ("1234567890", "9999999999"):
        return None

    return f"+7 ({body[:3]}) {body[3:6]}-{body[6:8]}-{body[8:10]}"


def extract_phones(text: str) -> list[str]:
    """Извлекает уникальные нормализованные российские телефоны из текста."""
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for match in PHONE_RAW_RE.findall(text):
        norm = normalize_phone(match)
        if norm and norm not in seen:
            seen.add(norm)
            found.append(norm)
    return found


def normalize_email(raw: str) -> str | None:
    if not raw:
        return None
    em = raw.strip().lower().strip(".,;:()[]<>\"'")
    if not EMAIL_RE.fullmatch(em):
        return None
    domain = em.split("@", 1)[1]
    if domain in BAD_EMAIL_DOMAINS:
        return None
    if any(em.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".js", ".css")):
        return None
    return em


def extract_emails(text: str) -> list[str]:
    if not text:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for m in EMAIL_RE.findall(text):
        em = normalize_email(m)
        if em and em not in seen:
            seen.add(em)
            out.append(em)
    return out


def normalize_website(raw: str) -> str | None:
    if not raw:
        return None
    s = raw.strip().lower().strip(".,;()[]<>\"'")
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^www\.", "", s)
    s = s.split("/")[0].split("?")[0]
    if "." not in s or len(s) < 4 or " " in s:
        return None
    bad_hosts = {
        "vk.com", "t.me", "telegram.me", "wa.me", "ok.ru", "youtube.com",
        "orgpage.ru", "find-org.com", "find-org.net", "yandex.ru", "google.com",
        "2gis.ru", "rusprofile.ru", "checko.ru", "fonts.googleapis.com",
        "googleapis.com", "gstatic.com", "cloudflare.com", "jsdelivr.net",
        "unpkg.com", "yastatic.net", "mc.yandex.ru", "apple.com", "google.ru",
        "whatsapp.com", "viber.com", "rutube.ru", "dzen.ru",
    }
    if any(s == b or s.endswith("." + b) for b in bad_hosts):
        return None
    return f"https://{s}"


def normalize_date(raw: Any) -> str:
    """Приводит дату к ISO YYYY-MM-DD."""
    if raw is None or raw == "":
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if isinstance(raw, (int, float)):
        ts = float(raw)
        if ts > 10_000_000_000:
            ts /= 1000.0
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
        except Exception:
            return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    s = str(raw).strip()
    m_ru = re.match(r"^(\d{2})\.(\d{2})\.(\d{4})", s)
    if m_ru:
        return f"{m_ru.group(3)}-{m_ru.group(2)}-{m_ru.group(1)}"
    m_iso = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    if m_iso:
        return m_iso.group(1)
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@dataclass
class Lead:
    entity_type: str  # "ООО" | "ИП"
    name: str
    full_name: str = ""
    inn: str = ""
    ogrn: str = ""
    kpp: str = ""
    reg_date: str = ""
    region_code: str = ""
    region_name: str = ""
    address: str = ""
    person_name: str = ""
    person_role: str = ""
    okved_code: str = ""
    okved_name: str = ""
    okved_category: str = ""
    phones: list[str] = field(default_factory=list)
    emails: list[str] = field(default_factory=list)
    websites: list[str] = field(default_factory=list)
    socials: dict[str, str] = field(default_factory=dict)
    capital: str = ""
    status: str = "Действующее"
    sources: list[str] = field(default_factory=list)
    parsed_at: str = ""
    id: str = ""

    def finalize(self) -> "Lead":
        self.name = clean_text(self.name)
        self.full_name = clean_text(self.full_name) or self.name
        self.inn = re.sub(r"\D", "", self.inn or "")
        self.ogrn = re.sub(r"\D", "", self.ogrn or "")
        self.kpp = re.sub(r"\D", "", self.kpp or "")

        if self.entity_type not in ("ООО", "ИП"):
            if len(self.ogrn) == 15 or len(self.inn) == 12 or self.name.upper().startswith("ИП "):
                self.entity_type = "ИП"
            else:
                self.entity_type = "ООО"

        self.reg_date = normalize_date(self.reg_date)
        if not self.region_code or not self.region_name:
            rc, rn = resolve_region(self.inn, self.ogrn, self.address)
            self.region_code = self.region_code or rc
            self.region_name = self.region_name or rn

        self.address = clean_text(self.address)
        self.person_name = clean_text(self.person_name)
        self.person_role = clean_text(self.person_role) or (
            "Индивидуальный предприниматель" if self.entity_type == "ИП" else "Генеральный директор"
        )
        self.okved_code = clean_text(self.okved_code)
        self.okved_name = clean_text(self.okved_name)
        self.okved_category = classify_okved(self.okved_code, self.okved_name)

        norm_phones: list[str] = []
        for p in self.phones:
            np = normalize_phone(p)
            if np and np not in norm_phones:
                norm_phones.append(np)
        self.phones = norm_phones

        norm_emails: list[str] = []
        for e in self.emails:
            ne = normalize_email(e)
            if ne and ne not in norm_emails:
                norm_emails.append(ne)
        self.emails = norm_emails

        norm_sites: list[str] = []
        for w in self.websites:
            nw = normalize_website(w)
            if nw and nw not in norm_sites:
                norm_sites.append(nw)
        self.websites = norm_sites

        self.sources = list(dict.fromkeys(s for s in self.sources if s))
        if not self.parsed_at:
            self.parsed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        if not self.id:
            if self.inn:
                self.id = f"inn-{self.inn}"
            elif self.ogrn:
                self.id = f"ogrn-{self.ogrn}"
            else:
                raw_key = f"{self.entity_type}:{self.name.lower()}:{self.phones[:1]}"
                self.id = "biz-" + hashlib.sha1(raw_key.encode("utf-8")).hexdigest()[:12]
        return self

    @property
    def has_phone(self) -> bool:
        return len(self.phones) > 0

    def merge(self, other: "Lead") -> "Lead":
        """Объединяет две карточки одного контрагента при дообогащении."""
        other.finalize()
        self.finalize()
        for attr in (
            "full_name", "inn", "ogrn", "kpp", "address",
            "person_name", "okved_code", "okved_name", "capital",
        ):
            if not getattr(self, attr) and getattr(other, attr):
                setattr(self, attr, getattr(other, attr))

        if other.reg_date and (not self.reg_date or other.reg_date < self.reg_date):
            self.reg_date = other.reg_date

        for p in other.phones:
            if p not in self.phones:
                self.phones.append(p)
        for e in other.emails:
            if e not in self.emails:
                self.emails.append(e)
        for w in other.websites:
            if w not in self.websites:
                self.websites.append(w)
        for k, v in other.socials.items():
            if v and k not in self.socials:
                self.socials[k] = v
        for s in other.sources:
            if s not in self.sources:
                self.sources.append(s)

        return self.finalize()

    def to_dict(self) -> dict[str, Any]:
        self.finalize()
        return {
            "id": self.id,
            "entity_type": self.entity_type,
            "name": self.name,
            "full_name": self.full_name,
            "inn": self.inn,
            "ogrn": self.ogrn,
            "kpp": self.kpp,
            "reg_date": self.reg_date,
            "region_code": self.region_code,
            "region_name": self.region_name,
            "address": self.address,
            "person_name": self.person_name,
            "person_role": self.person_role,
            "okved_code": self.okved_code,
            "okved_name": self.okved_name,
            "okved_category": self.okved_category,
            "phones": self.phones,
            "emails": self.emails,
            "websites": self.websites,
            "socials": self.socials,
            "capital": self.capital,
            "status": self.status,
            "sources": self.sources,
            "has_phone": self.has_phone,
            "parsed_at": self.parsed_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Lead":
        obj = cls(
            id=str(data.get("id", "")),
            entity_type=str(data.get("entity_type", "ООО")),
            name=str(data.get("name", "")),
            full_name=str(data.get("full_name", "")),
            inn=str(data.get("inn", "")),
            ogrn=str(data.get("ogrn", "")),
            kpp=str(data.get("kpp", "")),
            reg_date=str(data.get("reg_date", "")),
            region_code=str(data.get("region_code", "")),
            region_name=str(data.get("region_name", "")),
            address=str(data.get("address", "")),
            person_name=str(data.get("person_name", "")),
            person_role=str(data.get("person_role", "")),
            okved_code=str(data.get("okved_code", "")),
            okved_name=str(data.get("okved_name", "")),
            okved_category=str(data.get("okved_category", "")),
            phones=list(data.get("phones") or []),
            emails=list(data.get("emails") or []),
            websites=list(data.get("websites") or []),
            socials=dict(data.get("socials") or {}),
            capital=str(data.get("capital", "")),
            status=str(data.get("status", "Действующее")),
            sources=list(data.get("sources") or []),
            parsed_at=str(data.get("parsed_at", "")),
        )
        return obj.finalize()
