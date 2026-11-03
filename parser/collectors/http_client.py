"""Надёжный HTTP-клиент на стандартной библиотеке Python с поддержкой прокси и строгих таймаутов."""

from __future__ import annotations

import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


def _build_opener(use_ru_proxy: bool = False) -> tuple[urllib.request.OpenerDirector, ssl.SSLContext]:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    handlers: list[urllib.request.BaseHandler] = [urllib.request.HTTPSHandler(context=ctx)]
    proxy_url = ""
    if use_ru_proxy:
        proxy_url = os.getenv("RU_PROXY_URL", "").strip()
    if not proxy_url:
        proxy_url = os.getenv("HTTPS_PROXY", "").strip() or os.getenv("HTTP_PROXY", "").strip()

    if proxy_url:
        handlers.insert(0, urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}))

    opener = urllib.request.build_opener(*handlers)
    return opener, ctx


def _encode_url(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    try:
        ascii_host = host.encode("idna").decode("ascii") if host else ""
    except Exception:
        ascii_host = host
    netloc = f"{ascii_host}:{parts.port}" if parts.port else ascii_host
    path = urllib.parse.quote(urllib.parse.unquote(parts.path), safe="/:@!$&'()*+,;=-._~")
    query = urllib.parse.quote(urllib.parse.unquote(parts.query), safe="=&+:;@!$'()*+,/?-._~")
    return urllib.parse.urlunsplit((parts.scheme, netloc, path, query, parts.fragment))


def http_get_text(
    url: str,
    headers: dict[str, str] | None = None,
    timeout: float = 8.0,
    max_bytes: int = 350_000,
    use_ru_proxy: bool = False,
) -> tuple[int, str]:
    opener, _ = _build_opener(use_ru_proxy=use_ru_proxy)
    req_headers = {
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.7",
    }
    if headers:
        req_headers.update(headers)

    req = urllib.request.Request(_encode_url(url), headers=req_headers, method="GET")
    with opener.open(req, timeout=timeout) as resp:
        raw = resp.read(max_bytes)
        charset = resp.headers.get_content_charset() or "utf-8"
        try:
            text = raw.decode(charset, errors="replace")
        except LookupError:
            text = raw.decode("utf-8", errors="replace")
        return resp.status, text


def http_json(
    url: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    form_data: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 10.0,
    use_ru_proxy: bool = False,
) -> tuple[int, Any]:
    opener, _ = _build_opener(use_ru_proxy=use_ru_proxy)
    req_headers = {
        "User-Agent": DEFAULT_UA,
        "Accept": "application/json",
        "Accept-Language": "ru-RU,ru;q=0.9",
    }
    body: bytes | None = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req_headers["Content-Type"] = "application/json; charset=utf-8"
    elif form_data is not None:
        body = urllib.parse.urlencode(form_data).encode("utf-8")
        req_headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8"

    if headers:
        req_headers.update(headers)

    req = urllib.request.Request(url, data=body, headers=req_headers, method=method)
    with opener.open(req, timeout=timeout) as resp:
        raw = resp.read(1_000_000).decode("utf-8", errors="replace")
        return resp.status, json.loads(raw) if raw.strip() else {}


def polite_sleep(seconds: float = 0.25) -> None:
    if seconds > 0:
        time.sleep(seconds)
