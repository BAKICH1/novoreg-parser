"""Хранилище базы лидов, курсоров парсинга и агрегированной статистики для веб-витрины."""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import Lead


class LeadStore:
    def __init__(self, site_data_dir: Path, state_path: Path, max_leads: int = 5000) -> None:
        self.site_data_dir = site_data_dir
        self.leads_path = site_data_dir / "leads.json"
        self.stats_path = site_data_dir / "stats.json"
        self.state_path = state_path
        self.max_leads = max_leads

        self.leads_by_id: dict[str, Lead] = {}
        self.inn_index: dict[str, str] = {}
        self.ogrn_index: dict[str, str] = {}
        self.state: dict[str, Any] = {
            "region_rotation_idx": 0,
            "ogrn_frontiers": {},
            "orgpage_cursor": 0,
            "runs_count": 0,
            "run_history": [],
            "synced_herenow_ids": [],
        }
        self._load()

    def _load(self) -> None:
        if self.state_path.exists():
            try:
                raw = json.loads(self.state_path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    self.state.update(raw)
            except Exception:
                pass

        if self.leads_path.exists():
            try:
                payload = json.loads(self.leads_path.read_text(encoding="utf-8"))
                items = payload.get("leads", payload) if isinstance(payload, dict) else payload
                if isinstance(items, list):
                    for item in items:
                        if isinstance(item, dict):
                            self.upsert(Lead.from_dict(item))
            except Exception:
                pass

    def upsert(self, lead: Lead) -> tuple[Lead, bool]:
        """Добавляет или обновляет карточку новорега. Возвращает (lead, is_new)."""
        lead.finalize()
        existing_id: str | None = None
        if lead.inn and lead.inn in self.inn_index:
            existing_id = self.inn_index[lead.inn]
        elif lead.ogrn and lead.ogrn in self.ogrn_index:
            existing_id = self.ogrn_index[lead.ogrn]
        elif lead.id in self.leads_by_id:
            existing_id = lead.id

        if existing_id and existing_id in self.leads_by_id:
            merged = self.leads_by_id[existing_id].merge(lead)
            if merged.inn:
                self.inn_index[merged.inn] = existing_id
            if merged.ogrn:
                self.ogrn_index[merged.ogrn] = existing_id
            return merged, False

        self.leads_by_id[lead.id] = lead
        if lead.inn:
            self.inn_index[lead.inn] = lead.id
        if lead.ogrn:
            self.ogrn_index[lead.ogrn] = lead.id
        return lead, True

    def all_sorted(self) -> list[Lead]:
        """Сортирует: сначала самые свежие и с найденными телефонами."""
        return sorted(
            self.leads_by_id.values(),
            key=lambda x: (x.reg_date or "", 1 if x.has_phone else 0, x.parsed_at or ""),
            reverse=True,
        )[: self.max_leads]

    def save(self, run_summary: dict[str, Any] | None = None) -> dict[str, Any]:
        self.site_data_dir.mkdir(parents=True, exist_ok=True)
        self.state_path.parent.mkdir(parents=True, exist_ok=True)

        sorted_leads = self.all_sorted()
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        if run_summary:
            self.state["runs_count"] = int(self.state.get("runs_count", 0)) + 1
            history = list(self.state.get("run_history") or [])
            history.insert(0, {"timestamp": now_iso, **run_summary})
            self.state["run_history"] = history[:30]

        total = len(sorted_leads)
        with_phone = sum(1 for x in sorted_leads if x.has_phone)
        with_email = sum(1 for x in sorted_leads if x.emails)
        with_site = sum(1 for x in sorted_leads if x.websites)
        ip_count = sum(1 for x in sorted_leads if x.entity_type == "ИП")
        ooo_count = sum(1 for x in sorted_leads if x.entity_type == "ООО")

        by_region = Counter(f"{x.region_code} — {x.region_name}" for x in sorted_leads if x.region_name)
        by_category = Counter(x.okved_category for x in sorted_leads if x.okved_category)
        by_source = Counter(s for x in sorted_leads for s in x.sources)
        by_date = Counter(x.reg_date for x in sorted_leads if x.reg_date)

        stats = {
            "updated_at": now_iso,
            "mode": "2-в-1 (Открытые реестры и каталоги + API контрагентов)",
            "total_leads": total,
            "with_phone": with_phone,
            "phone_rate_pct": round((with_phone / total * 100.0), 1) if total else 0.0,
            "with_email": with_email,
            "with_website": with_site,
            "ip_count": ip_count,
            "ooo_count": ooo_count,
            "regions_covered": len(by_region),
            "runs_count": int(self.state.get("runs_count", 1)),
            "top_regions": [{"label": k, "count": v} for k, v in by_region.most_common(15)],
            "top_categories": [{"label": k, "count": v} for k, v in by_category.most_common(12)],
            "sources_breakdown": [{"label": k, "count": v} for k, v in by_source.most_common(10)],
            "daily_registrations": [
                {"date": d, "count": c} for d, c in sorted(by_date.items(), reverse=True)[:14]
            ],
            "recent_runs": list(self.state.get("run_history") or [])[:10],
        }

        leads_doc = {
            "generated_at": now_iso,
            "count": total,
            "leads": [x.to_dict() for x in sorted_leads],
        }

        self.leads_path.write_text(
            json.dumps(leads_doc, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.stats_path.write_text(
            json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.state_path.write_text(
            json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return stats
