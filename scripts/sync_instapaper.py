#!/usr/bin/env python3
"""Merge a public Instapaper profile's liked articles into Jekyll data."""

from __future__ import annotations

import argparse
import hashlib
import html
import ipaddress
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit


DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "_data" / "reading.json"
DEFAULT_PROFILE_URL = "https://www.instapaper.com/p/snatalenko"
MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
MAX_PROFILE_PAGES = 100


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def child_text(element: ET.Element, names: tuple[str, ...]) -> str:
    for child in element:
        if local_name(child.tag) in names:
            return clean_text("".join(child.itertext()))
    return ""


def entry_link(element: ET.Element) -> str:
    fallback = ""
    for child in element:
        if local_name(child.tag) != "link":
            continue
        value = clean_text(child.attrib.get("href") or "".join(child.itertext()))
        if not value:
            continue
        if child.attrib.get("rel", "alternate") == "alternate":
            return value
        fallback = fallback or value
    return fallback


def canonical_url(value: str) -> str:
    parts = urlsplit(clean_text(value))
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        return ""
    hostname = parts.hostname.lower()
    port = parts.port
    if port and not ((parts.scheme.lower() == "http" and port == 80) or (parts.scheme.lower() == "https" and port == 443)):
        hostname = f"{hostname}:{port}"
    return urlunsplit((parts.scheme.lower(), hostname, parts.path or "/", parts.query, ""))


def normalized_date(value: str) -> str:
    if not value:
        return ""
    parsed: datetime | None = None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return ""
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def source_name(url: str) -> str:
    hostname = urlsplit(url).hostname or ""
    return hostname.removeprefix("www.")


def thumbnail_url(value: object) -> str:
    url = canonical_url(str(value or ""))
    if not url:
        return ""
    parts = urlsplit(url)
    hostname = parts.hostname or ""
    if parts.scheme != "https" or hostname == "localhost" or hostname.endswith(".localhost"):
        return ""
    try:
        if not ipaddress.ip_address(hostname).is_global:
            return ""
    except ValueError:
        pass
    return url


def parse_profile(payload: object, imported_at: str) -> list[dict[str, str]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("bookmarks"), list):
        raise ValueError("Instapaper profile response did not contain bookmarks")
    articles: list[dict[str, str]] = []
    for bookmark in payload["bookmarks"]:
        if not isinstance(bookmark, dict):
            continue
        url = canonical_url(str(bookmark.get("url") or ""))
        if not url:
            continue
        article_id = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
        article = {
            "id": article_id,
            "title": clean_text(str(bookmark.get("title") or "")) or url,
            "url": url,
            "source": clean_text(str(bookmark.get("site_name") or "")) or source_name(url),
            # Instapaper's public profile does not expose the like time.
            # The first sync that sees a new item is the closest reliable value.
            "liked_at": imported_at,
        }
        description = bookmark.get("description")
        if isinstance(description, str) and description:
            article["description"] = description
        image = thumbnail_url(bookmark.get("og_image"))
        if image:
            article["image"] = image
        articles.append(article)
    return articles


def parse_feed(xml: bytes, imported_at: str) -> list[dict[str, str]]:
    root = ET.fromstring(xml)
    entries = [node for node in root.iter() if local_name(node.tag) in {"item", "entry"}]
    articles: list[dict[str, str]] = []
    for entry in entries:
        url = canonical_url(entry_link(entry))
        if not url:
            continue
        title = child_text(entry, ("title",)) or url
        date_value = child_text(entry, ("pubdate", "date", "published", "updated"))
        article_id = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
        articles.append(
            {
                "id": article_id,
                "title": title,
                "url": url,
                "source": source_name(url),
                "liked_at": normalized_date(date_value) or imported_at,
            }
        )
    return articles


def fetch_feed(feed_url: str) -> bytes:
    parts = urlsplit(feed_url)
    hostname = (parts.hostname or "").lower()
    if parts.scheme != "https" or not (hostname == "instapaper.com" or hostname.endswith(".instapaper.com")):
        raise ValueError("INSTAPAPER_RSS_URL must be an HTTPS instapaper.com URL")
    request = urllib.request.Request(feed_url, headers={"User-Agent": "natalenko.com reading sync"})
    with urllib.request.urlopen(request, timeout=30) as response:
        content = response.read(MAX_DOWNLOAD_BYTES + 1)
    if len(content) > MAX_DOWNLOAD_BYTES:
        raise ValueError("Instapaper feed exceeded the 5 MB safety limit")
    return content


def profile_id(profile_url: str) -> str:
    parts = urlsplit(profile_url)
    hostname = (parts.hostname or "").lower()
    if parts.scheme != "https" or not (hostname == "instapaper.com" or hostname.endswith(".instapaper.com")):
        raise ValueError("Instapaper profile URL must use HTTPS on instapaper.com")
    match = re.fullmatch(r"/p/([^/]+)/?", parts.path)
    if not match:
        raise ValueError("Instapaper profile URL must look like https://www.instapaper.com/p/username")
    return match.group(1)


def fetch_profile_page(username: str, page: int) -> dict[str, object]:
    url = f"https://www.instapaper.com/data/profile/{quote(username, safe='')}?page={page}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "natalenko.com reading sync",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        content = response.read(MAX_DOWNLOAD_BYTES + 1)
    if len(content) > MAX_DOWNLOAD_BYTES:
        raise ValueError("Instapaper profile response exceeded the 5 MB safety limit")
    payload = json.loads(content)
    if not isinstance(payload, dict):
        raise ValueError("Instapaper profile response was not a JSON object")
    return payload


def fetch_profile(profile_url: str, imported_at: str) -> list[dict[str, str]]:
    username = profile_id(profile_url)
    articles: list[dict[str, str]] = []
    for page in range(1, MAX_PROFILE_PAGES + 1):
        payload = fetch_profile_page(username, page)
        articles.extend(parse_profile(payload, imported_at))
        if not payload.get("has_next"):
            return articles
    raise ValueError(f"Instapaper profile exceeded {MAX_PROFILE_PAGES} pages")


def load_archive(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"{path} must contain a JSON array")
    return data


def merge_articles(existing: list[dict[str, str]], incoming: list[dict[str, str]]) -> list[dict[str, str]]:
    existing_by_id = {article["id"]: article for article in existing if article.get("id")}
    merged: list[dict[str, str]] = []
    seen: set[str] = set()
    for article in incoming:
        is_existing = article["id"] in existing_by_id
        previous = existing_by_id.get(article["id"], {})
        merged_article = {
            "id": article["id"],
            "title": article["title"],
            "url": article["url"],
            "source": article["source"],
        }
        # Existing descriptions are authoritative so manual edits survive sync.
        if is_existing and "description" in previous:
            merged_article["description"] = previous["description"]
        elif article.get("description"):
            merged_article["description"] = article["description"]
        if article.get("image"):
            merged_article["image"] = article["image"]
        liked_at = previous.get("liked_at") if is_existing else article.get("liked_at")
        if liked_at:
            merged_article["liked_at"] = liked_at
        merged.append(merged_article)
        seen.add(article["id"])
    # Keep previously imported items that no longer appear in the current
    # profile response, but place them after the profile's current ordering.
    merged.extend(article for article in existing if article.get("id") not in seen)
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--input", type=Path, help="Read a local RSS/Atom file instead of the public profile")
    source.add_argument("--profile-json", type=Path, help="Read one local public-profile JSON response")
    parser.add_argument(
        "--profile-url",
        default=os.environ.get("INSTAPAPER_PROFILE_URL", DEFAULT_PROFILE_URL),
        help=f"Public Instapaper profile URL (default: {DEFAULT_PROFILE_URL})",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    imported_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    if args.input:
        xml = args.input.read_bytes()
        incoming = parse_feed(xml, imported_at)
    elif args.profile_json:
        incoming = parse_profile(json.loads(args.profile_json.read_bytes()), imported_at)
    else:
        incoming = fetch_profile(args.profile_url, imported_at)
    if not incoming:
        raise ValueError("Instapaper contained no usable article links")
    merged = merge_articles(load_archive(args.output), incoming)
    rendered = json.dumps(merged, ensure_ascii=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if not args.output.exists() or args.output.read_text(encoding="utf-8") != rendered:
        args.output.write_text(rendered, encoding="utf-8")
    print(f"Imported {len(incoming)} liked articles; reading archive contains {len(merged)} items.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ET.ParseError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Instapaper sync failed: {error}", file=sys.stderr)
        raise SystemExit(1)
