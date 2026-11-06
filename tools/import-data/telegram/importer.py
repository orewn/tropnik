"""Local, bounded Telegram export discovery and explicit reference-only publication.

No network requests, media reads, author data, message bodies, or inferred geometry.
"""
from __future__ import annotations

import copy
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unicodedata
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

CHAT = "poiskpohod"
CHAT_URL = f"https://t.me/{CHAT}"
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_MESSAGES = 50_000
MAX_DEPTH = 24
MAX_TEXT = 32_768
MAX_ENTITIES = 2_048
SOURCE_NAME = "Сообщество poiskpohod"
ROOT = Path(__file__).resolve().parents[3]
PUBLISHED_PATH = ROOT / "web/lib/telegram-reviewed.generated.json"
PERSONAL_ENTITIES = {"mention", "mention_name", "phone", "email", "bank_card", "ton_address", "custom_emoji"}
TEXT_ENTITIES = {"plain", "bold", "italic", "underline", "strikethrough", "spoiler", "code", "pre", "blockquote", "text_link", "link", "hashtag", "concat"}
CONTACT = re.compile(r"(?:\b[^\s@]+@[^\s@]+\.[a-zа-я]{2,}\b|(?<!\w)@[a-z0-9_]{3,}|(?:\+?\d[\s().-]*){7,15})", re.I)
ROUTE_WORD = re.compile(r"\b(?:маршрут\w*|троп[аыуе]\w*|поход\w*|трек\w*|route|trail|hiking|gpx)\b", re.I)
ROUTE_LABEL = re.compile(r"(?:маршрут|тропа|трек|route|trail)\s*(?::|[«“\"]|[—–-])\s*\S", re.I)
URL = re.compile(r"https?://[^\s<>\[\]{}\"']{1,2048}", re.I)


class ImportFailure(ValueError):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ImportFailure("Duplicate JSON object key")
        result[key] = value
    return result


def parse_bounded_json(data: bytes, maximum=MAX_JSON_BYTES):
    if len(data) > maximum:
        raise ImportFailure("JSON exceeds the byte budget")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeError as error:
        raise ImportFailure("JSON must be UTF-8") from error
    depth = 0
    quoted = escaped = False
    for character in text:
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
        elif character in "[{":
            depth += 1
            if depth > MAX_DEPTH:
                raise ImportFailure("JSON exceeds the nesting budget")
        elif character in "]}":
            depth -= 1
    def invalid_constant(_):
        raise ImportFailure("Non-finite JSON number")
    try:
        return json.loads(text, object_pairs_hook=_unique_pairs, parse_constant=invalid_constant)
    except (json.JSONDecodeError, RecursionError) as error:
        raise ImportFailure("Invalid JSON document") from error


def read_json(path, maximum=MAX_JSON_BYTES):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise ImportFailure("Input must be a regular bounded JSON file")
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    return parse_bounded_json(data, maximum)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".part", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def load_catalog():
    try:
        result = subprocess.run(["node", str(Path(__file__).with_name("catalog-index.mjs"))],
                                capture_output=True, timeout=20, check=False)
    except subprocess.TimeoutExpired as error:
        raise ImportFailure("Application catalogue lookup exceeded its time budget") from error
    if result.returncode:
        raise ImportFailure("Cannot read the actual application catalogue; install web dependencies first")
    catalog = parse_bounded_json(result.stdout, 8 * 1024 * 1024)
    region_ids(catalog)
    return catalog


def region_ids(catalog):
    """The application's current curated regions are the only allowed IDs."""
    if not isinstance(catalog, dict) or not isinstance(catalog.get("regions"), list) or not isinstance(catalog.get("routes"), list):
        raise ImportFailure("Invalid trusted catalogue index")
    result = {region.get("id") for region in catalog["regions"] if isinstance(region, dict)}
    if not result or len(result) != len(catalog["regions"]) or any(not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9-]{1,63}", value) for value in result):
        raise ImportFailure("Invalid curated region IDs")
    return result


def source_id(message_id):
    if type(message_id) is not int or not 0 < message_id <= 2_147_483_647:
        raise ImportFailure("Invalid canonical message ID")
    return f"telegram:{CHAT}:{message_id}"


def message_url(message_id):
    source_id(message_id)
    return f"{CHAT_URL}/{message_id}"


def date_value(value):
    if not isinstance(value, str) or len(value) > 40 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?)?", value):
        raise ImportFailure("Invalid source/review date")
    try:
        dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ImportFailure("Invalid calendar date") from error
    return value  # Preserve the export's offset; never invent a timezone.


def normal(value):
    return re.sub(r"[^\w]+", " ", unicodedata.normalize("NFKC", value).casefold().replace("ё", "е")).strip()


def mixed_text(message):
    texts, links = [], []
    count = characters = 0
    def walk(value, level=0, collect_text=True):
        nonlocal count, characters
        count += 1
        if count > MAX_ENTITIES or level > 12:
            raise ImportFailure("Message exceeds the entity budget")
        if isinstance(value, str):
            characters += len(value)
            if characters > MAX_TEXT:
                raise ImportFailure("Message exceeds the text budget")
            if collect_text:
                texts.append(value)
            links.extend(URL.findall(value))
        elif isinstance(value, list):
            for item in value:
                walk(item, level + 1, collect_text)
        elif isinstance(value, dict):
            kind = value.get("type", "plain")
            if kind in PERSONAL_ENTITIES or kind not in TEXT_ENTITIES:
                return
            if kind == "text_link" and isinstance(value.get("href"), str):
                links.append(value["href"][:2049])
            walk(value.get("text", ""), level + 1, collect_text)
    walk(message.get("text", ""))
    if "text_entities" in message:
        walk(message["text_entities"], collect_text=not bool(texts))
    return "".join(texts), links


def clean_link(value):
    """Store a useful public link only; remove query tracking/contact fields.

    No URL is fetched. GPX contents and exported local paths are never opened.
    """
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20]", value):
        return None
    value = value.rstrip(".,;:!?)»")
    try:
        url = urlsplit(value)
        host = (url.hostname or "").lower().encode("idna").decode("ascii")
        if url.scheme not in {"http", "https"} or url.username or url.password or url.port not in {None, 80, 443}:
            return None
        if "." not in host or re.fullmatch(r"[\d.]+", host) or host.endswith((".local", ".internal", ".localhost")):
            return None
        try:
            ipaddress.ip_address(host)
            return None
        except ValueError:
            pass
    except (ValueError, UnicodeError):
        return None
    if host in {"t.me", "telegram.me"}:
        match = re.fullmatch(rf"/{CHAT}/([1-9]\d{{0,9}})/?", url.path)
        if not match or int(match[1]) > 2_147_483_647:
            return None
        return {"url": message_url(int(match[1])), "kind": "message"}
    if host in {"vk.com", "m.vk.com", "facebook.com", "instagram.com", "wa.me", "api.whatsapp.com"}:
        return None
    if host in {"openstreetmap.org", "www.openstreetmap.org"}:
        match = re.fullmatch(r"/relation/([1-9]\d{0,11})/?", url.path)
        if match:
            return {"url": f"https://www.openstreetmap.org/relation/{match[1]}", "kind": "route"}
    decoded = unquote(unquote(url.path))
    if re.search(r"[\x00-\x20\\<>@]", decoded) or CONTACT.search(decoded) or re.search(r"/(?:users?|members?|profiles?|contacts?)/", decoded, re.I):
        return None
    # Only numeric route identifiers survive. Signed/private tokens and arbitrary
    # query text remain accessible through the original message, not the queue.
    try:
        query = [(key, item) for key, item in parse_qsl(url.query, max_num_fields=32)
                 if key.lower() in {"id", "route", "routeid", "track", "trackid"} and re.fullmatch(r"\d{1,18}", item)]
    except ValueError:
        return None
    safe = urlunsplit((url.scheme, host, url.path or "/", urlencode(query), ""))
    kind = "gpx" if decoded.lower().endswith(".gpx") else "route" if re.search(r"/(?:routes?|trails?|tracks?|hiking|trek)", decoded, re.I) else "source"
    return {"url": safe, "kind": kind}


def import_export(export, catalog, previous=None):
    region_ids(catalog)
    if not isinstance(export, dict) or export.get("type") not in {"public_supergroup", "public_channel", "public_group"} or not isinstance(export.get("messages"), list):
        raise ImportFailure("Export one public chat, not a private chat or a whole account")
    if export.get("username") not in {None, CHAT, "@" + CHAT}:
        raise ImportFailure("Export username does not match poiskpohod")
    messages = export["messages"]
    if len(messages) > MAX_MESSAGES:
        raise ImportFailure("Export exceeds the message budget; split it by date")
    stats = {"messages": len(messages), "serviceSkipped": 0, "unsupportedSkipped": 0, "nonRouteSkipped": 0, "invalidSkipped": 0, "duplicateIds": 0, "conflictingIds": 0}
    candidates = {}
    if previous:
        validate_queue(previous)
        candidates = {item["sourceId"]: copy.deepcopy(item) for item in previous["candidates"]}
    index = catalog["routes"]
    for message in messages:
        if not isinstance(message, dict) or message.get("type") != "message":
            stats["serviceSkipped"] += 1
            continue
        if "rich_message" in message and "text" not in message:
            stats["unsupportedSkipped"] += 1
            continue
        try:
            mid = message["id"]
            sid = source_id(mid)
            published = date_value(message["date"])
            edited = date_value(message["edited"]) if message.get("edited") else None
            text, urls = mixed_text(message)
            links = {item["url"]: item for value in urls if (item := clean_link(value))}
            if len(links) > 24:
                raise ImportFailure("Message exceeds the useful-link budget")
        except (KeyError, TypeError, ValueError, ImportFailure):
            stats["invalidSkipped"] += 1
            continue
        normalized = " " + normal(text) + " "
        matched = sorted({route["id"] for route in index if
                          (len(normal(route["title"])) >= 8 and " " + normal(route["title"]) + " " in normalized)
                          or any((clean := clean_link(url)) and clean["url"] in links for url in route.get("sourceUrls", [route.get("sourceUrl", "")]))})
        # Attachment names and paths can contain people/contacts; keep only a
        # boolean and a link to this message, never the name, bytes or local path.
        gpx = any(isinstance(message.get(key), str) and message[key].lower().endswith(".gpx") for key in ("file", "file_name"))
        if gpx:
            links[message_url(mid)] = {"url": message_url(mid), "kind": "gpx_attachment"}
        route_label = bool(ROUTE_LABEL.search(text))
        route_link = any(item["kind"] in {"route", "gpx", "gpx_attachment"} for item in links.values())
        if not (matched or gpx or route_label or route_link and ROUTE_WORD.search(text)):
            stats["nonRouteSkipped"] += 1
            continue
        hints = [region["id"] for region in catalog["regions"] if " " + normal(region["name"]) + " " in normalized]
        item = {"sourceId": sid, "messageId": mid, "sourceUrl": message_url(mid), "publishedAt": published,
                "editedAt": edited, "matchedCatalogIds": matched, "regionHints": hints,
                "routeLabelPresent": route_label, "gpxAttachmentPresent": gpx,
                "links": sorted(links.values(), key=lambda value: value["url"]), "state": "review_required", "conflict": False}
        item["candidateDigest"] = digest(item)
        old = candidates.get(sid)
        if old:
            stats["duplicateIds"] += 1
            if old["candidateDigest"] != item["candidateDigest"]:
                old["conflict"] = True
                stats["conflictingIds"] += 1
            continue
        candidates[sid] = item
    queue = {"schemaVersion": 1, "sourceChat": CHAT_URL, "binding": "operator_supplied_not_verified_by_api",
             "status": "private_review_queue", "statistics": stats,
             "candidates": sorted(candidates.values(), key=lambda item: item["messageId"])}
    validate_queue(queue)
    return queue


def validate_queue(queue):
    if not isinstance(queue, dict) or set(queue) != {"schemaVersion", "sourceChat", "binding", "status", "statistics", "candidates"} or type(queue.get("schemaVersion")) is not int or queue["schemaVersion"] != 1 or queue.get("sourceChat") != CHAT_URL or queue.get("status") != "private_review_queue" or queue.get("binding") != "operator_supplied_not_verified_by_api":
        raise ImportFailure("Invalid review queue")
    candidates = queue.get("candidates")
    if not isinstance(candidates, list) or len(candidates) > MAX_MESSAGES:
        raise ImportFailure("Invalid candidate count")
    seen = set()
    keys = {"sourceId", "messageId", "sourceUrl", "publishedAt", "editedAt", "matchedCatalogIds", "regionHints", "routeLabelPresent", "gpxAttachmentPresent", "links", "state", "conflict", "candidateDigest"}
    for item in candidates:
        if not isinstance(item, dict) or set(item) != keys or not isinstance(item["sourceId"], str) or item["sourceId"] in seen:
            raise ImportFailure("Invalid or duplicated queue item")
        seen.add(item["sourceId"])
        if item["sourceId"] != source_id(item["messageId"]) or item["sourceUrl"] != message_url(item["messageId"]):
            raise ImportFailure("Queue source identity mismatch")
        date_value(item["publishedAt"])
        if item["editedAt"] is not None:
            date_value(item["editedAt"])
        if item["state"] != "review_required" or any(type(item[key]) is not bool for key in ("conflict", "routeLabelPresent", "gpxAttachmentPresent")):
            raise ImportFailure("Queue cannot contain a preapproved record")
        for key in ("matchedCatalogIds", "regionHints"):
            if not isinstance(item[key], list) or len(item[key]) > 1_000 or any(not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", value) for value in item[key]) or len(set(item[key])) != len(item[key]):
                raise ImportFailure("Queue contains an invalid curated catalogue identifier")
        if not isinstance(item["links"], list) or len(item["links"]) > 25:
            raise ImportFailure("Queue exceeds the useful-link budget")
        seen_links = set()
        for link in item["links"]:
            if not isinstance(link, dict) or set(link) != {"url", "kind"} or not isinstance(link["url"], str) or link["url"] in seen_links:
                raise ImportFailure("Invalid queue link")
            clean = clean_link(link["url"])
            if clean != link and not (link == {"url": item["sourceUrl"], "kind": "gpx_attachment"} and item["gpxAttachmentPresent"]):
                raise ImportFailure("Unsafe or noncanonical queue link")
            seen_links.add(link["url"])
        original = {key: value for key, value in item.items() if key != "candidateDigest"}
        original["conflict"] = False
        if digest(original) != item["candidateDigest"]:
            raise ImportFailure("Queue candidate integrity mismatch")


def review_template(queue):
    validate_queue(queue)
    return {"schemaVersion": 1, "sourceChatConfirmed": False, "decisions": [
        {"sourceId": item["sourceId"], "candidateDigest": item["candidateDigest"], "decision": "pending",
         "sourceRead": False, "privacyReviewed": False, "reviewedAt": None}
        for item in queue["candidates"]]}


def editorial(value, minimum, maximum):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum or CONTACT.search(value) or re.search(r"[\x00-\x08\x0b-\x1f<>]|https?://|\b(?:from_id|user_id)\b", value, re.I):
        raise ImportFailure("Editorial text must be bounded and free of contacts, markup and participant identifiers")
    return value.strip()


def validate_source(source):
    keys = {"url", "name", "messageId", "publishedAt", "reviewedAt", "scope"}
    if not isinstance(source, dict) or set(source) != keys or source["url"] != message_url(source["messageId"]) or source["name"] != SOURCE_NAME or source["scope"] != "community_mention":
        raise ImportFailure("Invalid public source reference")
    date_value(source["publishedAt"])
    date_value(source["reviewedAt"])
    if source["reviewedAt"][:10] < source["publishedAt"][:10]:
        raise ImportFailure("Review cannot precede its source message")


def empty_published():
    return {"schemaVersion": 1, "sourceChat": CHAT_URL, "status": "pending_history_access", "routes": [], "sourcesByRouteId": {}}


def validate_published(value, catalog):
    allowed_regions = region_ids(catalog)
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "sourceChat", "status", "routes", "sourcesByRouteId"} or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1 or value["sourceChat"] != CHAT_URL or not isinstance(value["status"], str) or value["status"] not in {"pending_history_access", "reviewed_references"}:
        raise ImportFailure("Invalid public Telegram catalogue")
    routes, sources = value["routes"], value["sourcesByRouteId"]
    if not isinstance(routes, list) or len(routes) > 10_000 or not isinstance(sources, dict) or len(sources) > 10_000:
        raise ImportFailure("Public catalogue exceeds its record budget")
    if value["status"] == "pending_history_access" and (routes or sources):
        raise ImportFailure("Pending source access cannot contain published Telegram data")
    known = {route["id"] for route in catalog["routes"]}
    ids = set()
    keys = {"id", "regionId", "title", "subtitle", "description", "distanceKm", "duration", "ascentM", "difficulty", "difficultyLabel", "sourceUrl", "sourceName", "checkedAt", "publicationStatus", "season", "notes", "sourceKind", "additionalSources"}
    for route in routes:
        if not isinstance(route, dict) or set(route) != keys or not isinstance(route["id"], str) or route["id"] in ids or not re.fullmatch(r"telegram-poiskpohod-[1-9]\d{0,9}", route["id"]):
            raise ImportFailure("Invalid or duplicated reference route")
        ids.add(route["id"])
        if not isinstance(route["regionId"], str) or route["regionId"] not in allowed_regions or route["sourceKind"] != "community" or route["publicationStatus"] != "reference" or route["difficulty"] != "unknown" or any(route[key] is not None for key in ("distanceKm", "duration", "ascentM")):
            raise ImportFailure("Community reference cannot invent metrics, geometry or verification")
        editorial(route["title"], 3, 160)
        editorial(route["description"], 20, 1600)
        editorial(route["subtitle"], 3, 200)
        if route["difficultyLabel"] != "Сложность требует проверки" or route["season"] != "Требует проверки" or not isinstance(route["notes"], list) or not 1 <= len(route["notes"]) <= 8:
            raise ImportFailure("Reference uncertainty labels must be explicit")
        for note in route["notes"]:
            editorial(note, 3, 300)
        if not isinstance(route["additionalSources"], list) or not 1 <= len(route["additionalSources"]) <= 500 or route["sourceName"] != SOURCE_NAME:
            raise ImportFailure("Reference lacks its reviewed original message")
        for source in route["additionalSources"]:
            validate_source(source)
        if route["sourceUrl"] != route["additionalSources"][0]["url"] or route["id"] != f"telegram-{CHAT}-{route['additionalSources'][0]['messageId']}":
            raise ImportFailure("Reference primary source identity mismatch")
        date_value(route["checkedAt"])
    for route_id, entries in sources.items():
        if route_id not in known | ids or not isinstance(entries, list) or not entries or len(entries) > 500:
            raise ImportFailure("Additional source must refer to a real existing route")
        seen = set()
        for source in entries:
            validate_source(source)
            if source["url"] in seen:
                raise ImportFailure("Duplicate source URL")
            seen.add(source["url"])
    return value


def publish_reviewed(queue, review, catalog, previous=None):
    validate_queue(queue)
    allowed_regions = region_ids(catalog)
    if not isinstance(review, dict) or set(review) != {"schemaVersion", "sourceChatConfirmed", "decisions"} or type(review.get("schemaVersion")) is not int or review["schemaVersion"] != 1 or type(review["sourceChatConfirmed"]) is not bool or not isinstance(review.get("decisions"), list) or len(review["decisions"]) > MAX_MESSAGES:
        raise ImportFailure("A separate review decision document is required")
    result = copy.deepcopy(previous if previous is not None else empty_published())
    validate_published(result, catalog)
    candidates = {item["sourceId"]: item for item in queue["candidates"]}
    known = {route["id"]: route for route in catalog["routes"]}
    own = {route["id"]: route for route in result["routes"]}
    seen = set()
    allowed = {"sourceId", "candidateDigest", "decision", "sourceRead", "privacyReviewed", "reviewedAt", "route", "existingRouteId", "regionConfirmedForRussia"}
    for decision in review["decisions"]:
        if not isinstance(decision, dict) or set(decision) - allowed or not isinstance(decision.get("sourceId"), str) or decision.get("sourceId") in seen:
            raise ImportFailure("Invalid or duplicated review decision")
        sid = decision.get("sourceId")
        seen.add(sid)
        candidate = candidates.get(sid)
        if not candidate or decision.get("candidateDigest") != candidate["candidateDigest"]:
            raise ImportFailure("Review does not match this exact queued candidate")
        action = decision.get("decision")
        if not isinstance(action, str):
            raise ImportFailure("Review action must be a supported string")
        if action in {"pending", "reject"}:
            continue
        if not isinstance(action, str) or action not in {"new_reference", "attach_existing"} or candidate["conflict"]:
            raise ImportFailure("Conflicting source or unsupported approval action")
        if review.get("sourceChatConfirmed") is not True or decision.get("sourceRead") is not True or decision.get("privacyReviewed") is not True:
            raise ImportFailure("Publication requires explicit source/chat and privacy review")
        reviewed = date_value(decision.get("reviewedAt"))
        source = {"url": candidate["sourceUrl"], "name": SOURCE_NAME, "messageId": candidate["messageId"],
                  "publishedAt": candidate["publishedAt"], "reviewedAt": reviewed, "scope": "community_mention"}
        validate_source(source)
        if action == "attach_existing":
            target = decision.get("existingRouteId")
            if not isinstance(target, str) or target not in known and target not in own:
                raise ImportFailure("Reviewed match is not an existing catalogue route")
        else:
            value = decision.get("route")
            if not isinstance(value, dict) or set(value) != {"title", "description", "regionId"} or decision.get("regionConfirmedForRussia") is not True or not isinstance(value.get("regionId"), str) or value["regionId"] not in allowed_regions:
                raise ImportFailure("New references require an explicitly reviewed supported Russian region and editorial fields only")
            title = editorial(value["title"], 3, 160)
            description = editorial(value["description"], 20, 1600)
            target = f"telegram-{CHAT}-{candidate['messageId']}"
            duplicate_ids = {route["id"] for route in catalog["routes"] if normal(route["title"]) == normal(title) and route["regionId"] == value["regionId"]}
            duplicate_ids.update(candidate["matchedCatalogIds"])
            duplicate_ids.discard(target)
            if duplicate_ids:
                raise ImportFailure("Potential existing route match; review an attach_existing decision instead of duplicating it")
            same = next((route for route in own.values() if normal(route["title"]) == normal(title) and route["regionId"] == value["regionId"]), None)
            if same:
                target = same["id"]
            elif target not in own:
                name = next(region["name"] for region in catalog["regions"] if region["id"] == value["regionId"])
                route = {"id": target, "regionId": value["regionId"], "title": title, "subtitle": f"Справочное упоминание · {name}", "description": description,
                         "distanceKm": None, "duration": None, "ascentM": None, "difficulty": "unknown", "difficultyLabel": "Сложность требует проверки",
                         "sourceUrl": source["url"], "sourceName": SOURCE_NAME, "checkedAt": reviewed[:10], "publicationStatus": "reference", "season": "Требует проверки",
                         "notes": ["Геометрия не добавлена. Карточка не является навигационным треком.", "Перед выходом проверить доступ, ограничения и описание у ответственного за территорию."],
                         "sourceKind": "community", "additionalSources": [source]}
                own[target] = route
                result["routes"].append(route)
        entries = {entry["url"]: entry for entry in result["sourcesByRouteId"].get(target, [])}
        # A repeat import is idempotent; a later explicit review can renew the
        # source review date without changing the route's operational status.
        if source["url"] not in entries or entries[source["url"]]["reviewedAt"] <= reviewed:
            entries[source["url"]] = source
        result["sourcesByRouteId"][target] = sorted(entries.values(), key=lambda entry: entry["messageId"])
    if result["routes"] or result["sourcesByRouteId"]:
        result["status"] = "reviewed_references"
    result["routes"].sort(key=lambda route: route["id"])
    return validate_published(result, catalog)
