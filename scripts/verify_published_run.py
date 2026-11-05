#!/usr/bin/env python3
"""Fail CI unless the latest parser run is actually visible on the public site."""
from __future__ import annotations

import json
import os
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    slug = os.environ.get("HERENOW_SLUG", "vivid-quill-yz5r")
    expected = json.loads((ROOT / "site/data/stats.json").read_text(encoding="utf-8"))
    expected_run = expected.get("automation", {}).get("last_run_url", "")
    actual_run = f"https://github.com/{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
    if os.environ.get("GITHUB_ACTIONS") == "true" and expected_run != actual_run:
        raise RuntimeError("Local statistics do not belong to this GitHub run")

    req = urllib.request.Request(
        f"https://{slug}.here.now/data/stats.json?verify_run={time.time_ns()}",
        headers={"User-Agent": "Mozilla/5.0 NovoRegPublicationCheck/1.0", "Cache-Control": "no-cache"},
    )
    with urllib.request.urlopen(req, timeout=25) as response:
        live = json.load(response)
    if live.get("automation", {}).get("last_run_url", "") != expected_run:
        raise RuntimeError("The website still shows a different run; publication is not verified")
    if live.get("total_leads") != expected.get("total_leads"):
        raise RuntimeError("Published lead count does not match the collected database")
    run = (live.get("recent_runs") or [{}])[0]
    if run.get("timestamp") != (expected.get("recent_runs") or [{}])[0].get("timestamp"):
        raise RuntimeError("Published collection timestamp does not match the local run")

    print(f"Publication verified: {live['total_leads']} server records, trigger={run.get('trigger', 'unknown')}, added={run.get('added_new', 0)}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as output:
            output.write(
                "## Публикация проверена\n\n"
                f"- Тип запуска: `{run.get('trigger', 'unknown')}`\n"
                f"- Добавлено: **{run.get('added_new', 0)}**; обновлено: **{run.get('updated', 0)}**\n"
                f"- Серверная база: **{live['total_leads']}** карточек (облачные карточки объединяются отдельно)\n"
                f"- Сбор: **{run.get('duration_sec', 0)} с**\n"
                f"- Сайт: https://{slug}.here.now/\n\n"
                "Ручной запуск `workflow_dispatch` не подтверждает работу расписания `schedule`.\n"
            )


if __name__ == "__main__":
    main()
