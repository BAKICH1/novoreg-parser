"""Главный оркестратор парсера 2-в-1 (разовый запуск для GitHub Actions cron или вечный демон --daemon)."""

from __future__ import annotations

import argparse
import logging
import os
import time
from pathlib import Path
from typing import Any

from .collectors.api_checko import CheckoCollector
from .collectors.api_dadata import DaDataCollector
from .collectors.api_fns import ApiFnsCollector
from .collectors.enrich_2gis import TwoGisEnricher
from .collectors.enrich_status_tg import StatusScheduleTelegramEnricher
from .collectors.open_contacts import OpenContactsCollector
from .collectors.open_egrul import FindOrgFrontierCollector, FnsDirectCollector
from .models import Lead
from .publisher import HereNowPublisher
from .state import LeadStore

ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SITE_DIR = ROOT_DIR / "site"
DEFAULT_STATE_PATH = ROOT_DIR / ".parser_state" / "state.json"


def run_cycle(
    store: LeadStore,
    regions_per_run: int = 5,
    cards_per_region: int = 6,
    dir_categories: int = 3,
    dir_items: int = 8,
    only_with_phone: bool = False,
    publish_herenow: bool = False,
    site_dir: Path = DEFAULT_SITE_DIR,
) -> dict[str, Any]:
    logger = logging.getLogger("novoreg.main")
    t0 = time.time()

    collected: list[Lead] = []
    active_sources: list[str] = []
    existing_ogrns = set(store.ogrn_index.keys())
    step_cursor = int(store.state.get("runs_count", 0))

    # --- ЧАСТЬ 1: БЕСПЛАТНЫЕ ОТКРЫТЫЕ ИСТОЧНИКИ ---
    frontier = FindOrgFrontierCollector()
    open_ooo = frontier.collect(
        store.state,
        regions_per_run=regions_per_run,
        cards_per_region=cards_per_region,
        existing_ogrns=existing_ogrns,
    )
    if open_ooo:
        collected.extend(open_ooo)
        active_sources.append(f"ЕГРЮЛ Open ({len(open_ooo)})")

    fns_direct = FnsDirectCollector()
    fns_leads = fns_direct.collect()
    if fns_leads:
        collected.extend(fns_leads)
        active_sources.append(f"ФНС Прямой ({len(fns_leads)})")

    open_contacts = OpenContactsCollector()
    dir_leads = open_contacts.collect_directory_leads(
        store.state,
        categories_per_run=dir_categories,
        items_per_category=dir_items,
    )
    if dir_leads:
        collected.extend(dir_leads)
        active_sources.append(f"Открытые каталоги + Сайты ({len(dir_leads)})")

    # --- ЧАСТЬ 2: ПОДКЛЮЧАЕМЫЕ ОФИЦИАЛЬНЫЕ API (при наличии ключей) ---
    dadata = DaDataCollector()
    if dadata.enabled:
        dd_leads = dadata.collect(step_cursor=step_cursor)
        collected.extend(dd_leads)
        active_sources.append(f"DaData API ({len(dd_leads)})")

    checko = CheckoCollector()
    if checko.enabled:
        ch_leads = checko.search_recent()
        collected.extend(ch_leads)
        active_sources.append(f"Checko API ({len(ch_leads)})")

    apifns = ApiFnsCollector()
    if apifns.enabled:
        af_leads = apifns.collect(step_cursor=step_cursor)
        collected.extend(af_leads)
        active_sources.append(f"API-ФНС ({len(af_leads)})")

    # --- ЧАСТЬ 3: ДООБОГАЩЕНИЕ ТЕЛЕФОНОВ И МЕССЕНДЖЕРОВ ---
    twogis = TwoGisEnricher()
    if twogis.enabled:
        enr_2gis = twogis.enrich_batch(collected, max_requests=15)
        if enr_2gis:
            active_sources.append(f"2ГИС Enrich (+{enr_2gis} тел.)")

    if checko.enabled:
        enr_ch = 0
        for lead in collected[:8]:
            if not lead.has_phone and lead.inn:
                if checko.enrich_by_inn(lead):
                    enr_ch += 1
        if enr_ch:
            active_sources.append(f"Checko Enrich (+{enr_ch} тел.)")

    enr_web = open_contacts.enrich_existing_leads(collected, max_probes=12)
    if enr_web:
        active_sources.append(f"Веб-обогащение (+{enr_web} тел.)")

    enr_st = StatusScheduleTelegramEnricher().enrich_batch(collected, max_inn_checks=12, max_tg_checks=15)
    if enr_st:
        active_sources.append(f"ФНС/Saby статус ({enr_st})")

    # --- СОХРАНЕНИЕ И ДЕДУПЛИКАЦИЯ ---
    added_new = 0
    updated_existing = 0
    for lead in collected:
        if only_with_phone and not lead.has_phone:
            continue
        _, is_new = store.upsert(lead)
        if is_new:
            added_new += 1
        else:
            updated_existing += 1

    elapsed = round(time.time() - t0, 1)
    run_summary = {
        "fetched": len(collected),
        "added_new": added_new,
        "updated": updated_existing,
        "duration_sec": elapsed,
        "sources": active_sources,
        "trigger": os.getenv("GITHUB_EVENT_NAME", "local"),
        "run_url": (
            f"https://github.com/{os.getenv('GITHUB_REPOSITORY')}/actions/runs/{os.getenv('GITHUB_RUN_ID')}"
            if os.getenv("GITHUB_REPOSITORY") and os.getenv("GITHUB_RUN_ID") else ""
        ),
    }
    stats = store.save(run_summary=run_summary)
    logger.info(
        "Цикл завершён за %.1f сек: получено=%d, новых=%d, обновлено=%d, всего в базе=%d (с тел.=%d)",
        elapsed,
        len(collected),
        added_new,
        updated_existing,
        stats["total_leads"],
        stats["with_phone"],
    )

    if publish_herenow:
        pub = HereNowPublisher(site_dir=site_dir)
        if pub.slug and (pub.api_key or pub.claim_token):
            pub_res = pub.publish()
            logger.info("Опубликовано обновление на here.now: %s", pub_res.get("siteUrl"))
            if pub.api_key:
                synced = pub.sync_leads_to_sitedata(
                    store.all_sorted(),
                    list(store.state.get("synced_herenow_ids") or []),
                )
                store.state["synced_herenow_ids"] = synced
                store.save()
        else:
            logger.info("Пропуск авто-деплоя here.now: не заданы HERENOW_SLUG и HERENOW_API_KEY/HERENOW_CLAIM_TOKEN")

    return stats


def main() -> None:
    ap = argparse.ArgumentParser(description="Парсер 2-в-1 новорегов ИП и ООО с телефонами")
    ap.add_argument("--daemon", action="store_true", help="Непрерывный режим работы 24/7 в цикле")
    ap.add_argument("--interval", type=int, default=1200, help="Интервал между циклами в секундах (по умолчанию 1200 = 20 мин)")
    ap.add_argument("--regions-per-run", type=int, default=5, help="Сколько регионов РФ обходить за один цикл")
    ap.add_argument("--cards-per-region", type=int, default=6, help="Сколько свежих карточек ЕГРЮЛ брать на регион")
    ap.add_argument("--dir-categories", type=int, default=3, help="Сколько рубрик бизнес-справочника проверять за цикл")
    ap.add_argument("--dir-items", type=int, default=8, help="Сколько карточек с телефонами брать из рубрики")
    ap.add_argument("--only-phone", action="store_true", help="Сохранять строго только карточки с телефоном")
    ap.add_argument("--publish", action="store_true", help="После сбора автоматически обновить сайт на here.now")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    only_phone = args.only_phone or os.getenv("ONLY_WITH_PHONE", "").lower() in ("1", "true", "yes")
    auto_pub = args.publish or os.getenv("HERENOW_AUTO_PUBLISH", "").lower() in ("1", "true", "yes")

    store = LeadStore(site_data_dir=DEFAULT_SITE_DIR / "data", state_path=DEFAULT_STATE_PATH)

    if not args.daemon:
        run_cycle(
            store=store,
            regions_per_run=args.regions_per_run,
            cards_per_region=args.cards_per_region,
            dir_categories=args.dir_categories,
            dir_items=args.dir_items,
            only_with_phone=only_phone,
            publish_herenow=auto_pub,
        )
        return

    logging.info("Запущен постоянный демон 24/7 (интервал %d сек)...", args.interval)
    while True:
        try:
            run_cycle(
                store=store,
                regions_per_run=args.regions_per_run,
                cards_per_region=args.cards_per_region,
                dir_categories=args.dir_categories,
                dir_items=args.dir_items,
                only_with_phone=only_phone,
                publish_herenow=auto_pub,
            )
        except Exception as exc:
            logging.exception("Ошибка в цикле демона (работа продолжается): %s", exc)
        time.sleep(max(60, args.interval))


if __name__ == "__main__":
    main()
