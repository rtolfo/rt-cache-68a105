#!/usr/bin/env python3
import datetime as dt
import bisect
import difflib
import html
import json
import re
import sys
import time
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHANNELS_FILE = ROOT / "config" / "channels.json"
OUT_FILE = ROOT / "output" / "apsky-epg.xml"

MEUGUIA_BASE = "https://meuguia.tv/programacao/canal/"
CLARO_XML = "https://raw.githubusercontent.com/limaalef/BrazilTVEPG/refs/heads/main/claro.xml"
UA = "Mozilla/5.0 (APSKY EPG Builder)"
TZ = "-0300"


def fetch_text(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", "replace")


def normalize(value):
    value = unicodedata.normalize("NFD", value or "")
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Mn")
    value = re.sub(r"\[[^\]]*(FHD|HD|SD|H265|LEG)[^\]]*\]", " ", value, flags=re.I)
    value = re.sub(r"\b(FHD|HD|SD|H265|LEG|LEGENDADO|DUBLADO)\b", " ", value, flags=re.I)
    return re.sub(r"[^a-zA-Z0-9]+", "", value).lower()


def clean_text(value):
    value = html.unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\[[^\]]*(FHD|HD|SD|H265|LEG)[^\]]*\]", " ", value, flags=re.I)
    value = re.sub(r"\b(FHD|HD|SD|H265|LEG)\b", " ", value, flags=re.I)
    return re.sub(r"\s+", " ", value).strip()


def parse_br_day(label):
    match = re.search(r"(\d{1,2})/(\d{1,2})", label or "")
    if not match:
        return None
    day, month = int(match.group(1)), int(match.group(2))
    today = dt.datetime.now().date()
    year = today.year
    candidate = dt.date(year, month, day)
    if candidate < today - dt.timedelta(days=180):
        candidate = dt.date(year + 1, month, day)
    return candidate


def parse_meuguia_channel(channel):
    page = fetch_text(MEUGUIA_BASE + channel["meuguia_id"], timeout=35)
    headers = []
    for match in re.finditer(r"<li[^>]*class=['\"][^'\"]*subheader[^'\"]*['\"][^>]*>(.*?)</li>", page, flags=re.S | re.I):
        parsed = parse_br_day(clean_text(match.group(1)))
        if parsed:
            headers.append((match.start(), parsed))
    header_positions = [item[0] for item in headers]

    items = []
    program_re = re.compile(
        r"<div[^>]+class=['\"]lileft time['\"][^>]*>\s*(\d{1,2}:\d{2})\s*</div>.*?"
        r"<h2[^>]*>(.*?)</h2>(?:.*?<h3[^>]*>(.*?)</h3>)?",
        flags=re.S | re.I,
    )
    for match in program_re.finditer(page):
        header_idx = bisect.bisect_right(header_positions, match.start()) - 1
        if header_idx < 0:
            continue
        current_date = headers[header_idx][1]
        hour, minute = [int(x) for x in match.group(1).split(":")]
        title = clean_text(match.group(2))
        if not title:
            continue
        start = dt.datetime(current_date.year, current_date.month, current_date.day, hour, minute)
        items.append({
            "channel": channel["name"],
            "meuguia_id": channel["meuguia_id"],
            "start": start,
            "title": title,
            "category": clean_text(match.group(3) or ""),
            "desc": "",
            "rating": "",
        })

    items.sort(key=lambda item: item["start"])
    for idx, item in enumerate(items):
        if idx + 1 < len(items):
            stop = items[idx + 1]["start"]
            if stop <= item["start"]:
                stop = item["start"] + dt.timedelta(minutes=60)
        else:
            stop = item["start"] + dt.timedelta(minutes=60)
        item["stop"] = stop
    return items


def parse_xmltv_time(value):
    match = re.match(r"(\d{14})\s*([+-]\d{4})?", value or "")
    if not match:
        return None
    stamp = match.group(1)
    return dt.datetime.strptime(stamp, "%Y%m%d%H%M%S")


def load_claro_programs():
    try:
        data = fetch_text(CLARO_XML, timeout=60)
    except Exception as exc:
        print(f"aviso: nao consegui baixar claro.xml: {exc}", file=sys.stderr)
        return []

    root = ET.fromstring(data)
    programs = []
    for node in root.findall("programme"):
        title_node = node.find("title")
        desc_node = node.find("desc")
        rating_node = node.find("./rating/value")
        title = clean_text(title_node.text if title_node is not None else "")
        if not title:
            continue
        programs.append({
            "channel": node.attrib.get("channel", ""),
            "channel_key": normalize(node.attrib.get("channel", "")),
            "title": title,
            "title_key": normalize(title),
            "start": parse_xmltv_time(node.attrib.get("start", "")),
            "stop": parse_xmltv_time(node.attrib.get("stop", "")),
            "desc": clean_text(desc_node.text if desc_node is not None else ""),
            "rating": clean_text(rating_node.text if rating_node is not None else "").replace("[", "").replace("]", ""),
        })
    return programs


def enrich_from_claro(items, claro_programs):
    by_title = {}
    for program in claro_programs:
        if not program["desc"]:
            continue
        by_title.setdefault(program["title_key"], []).append(program)

    for item in items:
        title_key = normalize(item["title"])
        candidates = list(by_title.get(title_key, []))
        if not candidates:
            # Fuzzy only among exact-ish first letters to keep it cheap and conservative.
            prefix = title_key[:4]
            for key, values in by_title.items():
                if prefix and not key.startswith(prefix):
                    continue
                if difflib.SequenceMatcher(None, title_key, key).ratio() >= 0.91:
                    candidates.extend(values)
        best = None
        best_score = 0
        item_channel = normalize(item["channel"])
        for cand in candidates[:80]:
            score = difflib.SequenceMatcher(None, title_key, cand["title_key"]).ratio()
            if cand["channel_key"] and item_channel and (cand["channel_key"] in item_channel or item_channel in cand["channel_key"]):
                score += 0.08
            if cand["start"] and abs((cand["start"] - item["start"]).total_seconds()) <= 45 * 60:
                score += 0.08
            if score > best_score:
                best = cand
                best_score = score
        if best and best_score >= 0.91:
            item["desc"] = best["desc"]
            item["rating"] = best["rating"]


def xml_escape(value):
    return html.escape(value or "", quote=True)


def xml_time(value):
    return value.strftime("%Y%m%d%H%M%S ") + TZ


def write_xml(channels, items):
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    lines.append('<tv generator-info-name="APSKY Meuguia + Claro">')
    for channel in channels:
        name = channel["name"].upper()
        lines.append(f'  <channel id="{xml_escape(name)}">')
        lines.append(f'    <display-name lang="pt">{xml_escape(name)}</display-name>')
        lines.append("  </channel>")
    for item in sorted(items, key=lambda x: (x["channel"], x["start"])):
        channel = item["channel"].upper()
        lines.append(f'  <programme start="{xml_time(item["start"])}" stop="{xml_time(item["stop"])}" channel="{xml_escape(channel)}">')
        lines.append(f'    <title lang="pt">{xml_escape(item["title"])}</title>')
        if item.get("category"):
            lines.append(f'    <category lang="pt">{xml_escape(item["category"])}</category>')
        if item.get("desc"):
            lines.append(f'    <desc lang="pt">{xml_escape(item["desc"])}</desc>')
        if item.get("rating"):
            lines.append('    <rating system="Brazil">')
            lines.append(f'      <value>{xml_escape(item["rating"])}</value>')
            lines.append("    </rating>")
        lines.append("  </programme>")
    lines.append("</tv>")
    OUT_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    config = json.loads(CHANNELS_FILE.read_text(encoding="utf-8"))
    channels = config["channels"]
    claro_programs = load_claro_programs()
    all_items = []
    page_cache = {}
    for idx, channel in enumerate(channels, 1):
        print(f"({idx}/{len(channels)}) {channel['name']} <- {channel['meuguia_id']}")
        try:
            source_id = channel["meuguia_id"]
            if source_id not in page_cache:
                page_cache[source_id] = parse_meuguia_channel(channel)
                time.sleep(0.35)
            for item in page_cache[source_id]:
                clone = dict(item)
                clone["channel"] = channel["name"]
                clone["meuguia_id"] = source_id
                all_items.append(clone)
        except Exception as exc:
            print(f"aviso: falhou {channel['name']}: {exc}", file=sys.stderr)
    enrich_from_claro(all_items, claro_programs)
    write_xml(channels, all_items)
    with_desc = sum(1 for item in all_items if item.get("desc"))
    print(f"ok: {len(channels)} canais, {len(all_items)} programas, {with_desc} com sinopse")
    print(OUT_FILE)


if __name__ == "__main__":
    main()
