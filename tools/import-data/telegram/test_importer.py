"""Synthetic fixtures only. These messages are not data from poiskpohod."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from importer import (CHAT_URL, ImportFailure, MAX_DEPTH, MAX_ENTITIES, MAX_TEXT,
                      clean_link, digest, empty_published, import_export,
                      parse_bounded_json, publish_reviewed, read_json,
                      review_template, validate_published, validate_queue)

CATALOG = {"regions": [{"id": "altai", "name": "Алтай"}, {"id": "karelia", "name": "Карелия"}],
           "routes": [{"id": "existing-path", "title": "Учебная тропа у озера", "regionId": "altai",
                       "sourceUrl": "https://www.openstreetmap.org/relation/12345678",
                       "sourceUrls": ["https://www.openstreetmap.org/relation/12345678"]}]}


def message(mid=101, text="Маршрут: Тестовая долина. Алтай.", **kwargs):
    return {"id": mid, "type": "message", "date": "2026-10-31T10:20:30+03:00", "text": text, **kwargs}


def exported(*messages, **kwargs):
    return {"name": "Synthetic public chat fixture", "type": "public_supergroup", "id": 12345,
            "messages": list(messages), **kwargs}


def queue_for(*messages):
    return import_export(exported(*(messages or [message()])), CATALOG)


def review_for(queue, **changes):
    value = review_template(queue)
    value["sourceChatConfirmed"] = True
    for decision in value["decisions"]:
        decision.update({"decision": "new_reference", "sourceRead": True, "privacyReviewed": True,
                         "reviewedAt": "2026-11-06", "regionConfirmedForRussia": True,
                         "route": {"title": "Тестовая долина", "description": "Учебный пример ручного краткого описания маршрута без личных данных.", "regionId": "altai"}})
        decision.update(changes)
    return value


class BoundedInputTests(unittest.TestCase):
    def test_json_budget_depth_and_duplicates(self):
        for data, limit in [(b"{} ", 2), (("[" * (MAX_DEPTH + 1) + "]" * (MAX_DEPTH + 1)).encode(), 1000),
                            (b'{"id":1,"id":2}', 1000), (b'{"x":NaN}', 1000), (b"\xff", 1000), (b"{", 1000)]:
            with self.subTest(data=data[:20]), self.assertRaises(ImportFailure):
                parse_bounded_json(data, limit)
        self.assertEqual(parse_bounded_json(b'{"quoted":"[[[[\\\""}'), {"quoted": '[[[["'})

    def test_regular_input_only(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "safe.json"
            path.write_text("{}")
            alias = Path(directory) / "alias.json"
            alias.symlink_to(path)
            self.assertEqual(read_json(path), {})
            with self.assertRaises(ImportFailure):
                read_json(alias)

    def test_chat_binding_and_scope(self):
        for value in [exported(message(), type="private_chat"), {"chats": [exported(message())]}, exported(message(), username="another_chat")]:
            with self.subTest(value=value.get("type")), self.assertRaises(ImportFailure):
                import_export(value, CATALOG)

    def test_invalid_ids_dates_and_entity_limits_are_skipped(self):
        values = [message(mid=True), message(mid=-1), message(mid="123"), message(mid=2**40),
                  message(date="2026-02-30"), message(text="Маршрут: " + "а" * MAX_TEXT),
                  message(text=["т"] * (MAX_ENTITIES + 1))]
        queue = queue_for(*values)
        self.assertEqual(queue["candidates"], [])
        self.assertEqual(queue["statistics"]["invalidSkipped"], len(values))


class ExtractionTests(unittest.TestCase):
    def test_mixed_entities_extract_links_without_participants_or_body(self):
        mixed = ["Маршрут: ", {"type": "bold", "text": "Тестовая долина"}, " — Алтай. ",
                 {"type": "mention_name", "text": "PRIVATE PERSON", "user_id": 987654},
                 {"type": "phone", "text": "+7 999 123-45-67"}, {"type": "email", "text": "private@example.org"},
                 {"type": "text_link", "text": "GPX", "href": "https://example.org/tracks/example.gpx?token=SECRET&email=private@example.org#personal"}]
        value = message(text=mixed, from_id="user987654", from_="PRIVATE PERSON", reply_to_message_id=456)
        value["text_entities"] = [{"type": "text_link", "text": "route", "href": "https://example.org/routes/one"}]
        queue = queue_for(value)
        self.assertEqual(len(queue["candidates"]), 1)
        item = queue["candidates"][0]
        self.assertEqual(item["sourceUrl"], CHAT_URL + "/101")
        self.assertEqual(item["publishedAt"], "2026-10-31T10:20:30+03:00")
        self.assertEqual(item["regionHints"], ["altai"])
        self.assertEqual(len(item["links"]), 2)
        encoded = json.dumps(queue)
        for secret in ["PRIVATE", "987654", "+7", "private@", "SECRET", "from_id", "reply_to", "Тестовая долина"]:
            self.assertNotIn(secret, encoded)

    def test_filters_service_chat_and_unsupported_rich_message(self):
        queue = queue_for({"id": 1, "type": "service", "text": "Маршрут: join"},
                          message(mid=2, text="Привет! Кто идёт в поход в воскресенье?"),
                          {"id": 3, "type": "message", "date": "2026-10-31", "rich_message": {"text": "Маршрут: X"}},
                          message(mid=4, text="Маршрут: Тестовая долина"))
        self.assertEqual([item["messageId"] for item in queue["candidates"]], [4])
        self.assertEqual(queue["statistics"]["serviceSkipped"], 1)
        self.assertEqual(queue["statistics"]["nonRouteSkipped"], 1)
        self.assertEqual(queue["statistics"]["unsupportedSkipped"], 1)

    def test_gpx_attachment_is_only_a_canonical_message_reference(self):
        with patch("pathlib.Path.open", side_effect=AssertionError("must not read attachment")):
            queue = queue_for(message(text="", file="../../PRIVATE_PERSON/+79991234567.gpx", file_name="private@example.org.gpx"))
        item = queue["candidates"][0]
        self.assertTrue(item["gpxAttachmentPresent"])
        self.assertEqual(item["links"], [{"url": CHAT_URL + "/101", "kind": "gpx_attachment"}])
        self.assertNotIn("PRIVATE_PERSON", json.dumps(queue))

    def test_existing_title_and_source_url_matches(self):
        queue = queue_for(message(text="Учебная тропа у озера"),
                          message(mid=102, text="https://www.openstreetmap.org/relation/12345678"))
        self.assertEqual(len(queue["candidates"]), 2)
        for item in queue["candidates"]:
            self.assertEqual(item["matchedCatalogIds"], ["existing-path"])

    def test_duplicate_source_ids_merge_and_conflicts_block_publication(self):
        queue = queue_for(message(), message())
        self.assertEqual(len(queue["candidates"]), 1)
        self.assertEqual(queue["statistics"]["duplicateIds"], 1)
        merged = import_export(exported(message()), CATALOG, queue)
        self.assertEqual(merged["candidates"], queue["candidates"])
        conflict = import_export(exported(message(edited="2026-11-01T00:00:00")), CATALOG, queue)
        self.assertTrue(conflict["candidates"][0]["conflict"])
        with self.assertRaises(ImportFailure):
            publish_reviewed(conflict, review_for(conflict), CATALOG)

    def test_links_reject_contacts_local_paths_and_unsafe_schemes(self):
        bad = ["file:///tmp/track.gpx", "javascript:alert(1)", "https://user:pass@example.org/routes/one",
               "https://127.0.0.1/a.gpx", "https://localhost/a.gpx", "https://internal.local/a.gpx",
               "https://example.org:8443/a.gpx", "https://example.org/users/alice", "https://example.org/+79991234567.gpx",
               "https://example.org/%2540private.gpx", "https://t.me/private_person", "https://t.me/poiskpohod/9999999999",
               "https://example.org/a?" + "&".join("id=1" for _ in range(40))]
        for url in bad:
            with self.subTest(url=url):
                self.assertIsNone(clean_link(url))
        self.assertEqual(clean_link("https://example.org/routes?routeid=42&token=SECRET&utm_source=who#location"),
                         {"url": "https://example.org/routes?routeid=42", "kind": "route"})


class ReviewAndPublicationTests(unittest.TestCase):
    def test_pending_review_never_publishes(self):
        queue = queue_for()
        result = publish_reviewed(queue, review_template(queue), CATALOG)
        self.assertEqual(result, empty_published())

    def test_requires_all_explicit_review_gates_and_matching_digest(self):
        queue = queue_for()
        for mutation in [lambda x: x.update(sourceChatConfirmed=False),
                         lambda x: x["decisions"][0].update(sourceRead=False),
                         lambda x: x["decisions"][0].update(privacyReviewed=False),
                         lambda x: x["decisions"][0].update(regionConfirmedForRussia=False),
                         lambda x: x["decisions"][0].update(candidateDigest="0" * 64),
                         lambda x: x["decisions"][0].update(reviewedAt="2026-01-01")]:
            review = review_for(queue)
            mutation(review)
            with self.assertRaises(ImportFailure):
                publish_reviewed(queue, review, CATALOG)

    def test_new_reference_has_unknown_metrics_and_no_geometry(self):
        queue = queue_for()
        result = publish_reviewed(queue, review_for(queue), CATALOG)
        route = result["routes"][0]
        self.assertEqual(route["id"], "telegram-poiskpohod-101")
        for key in ["geometry", "geometryUrl", "center", "bbox", "author", "participants"]:
            self.assertNotIn(key, route)
        for key in ["distanceKm", "duration", "ascentM"]:
            self.assertIsNone(route[key])
        self.assertEqual(route["publicationStatus"], "reference")
        self.assertEqual(route["sourceKind"], "community")
        self.assertEqual(set(route["additionalSources"][0]), {"url", "name", "messageId", "publishedAt", "reviewedAt", "scope"})
        self.assertEqual(publish_reviewed(queue, review_for(queue), CATALOG, result), result)

    def test_existing_match_must_attach_without_duplicating_route(self):
        queue = queue_for(message(text="Учебная тропа у озера"))
        with self.assertRaises(ImportFailure):
            publish_reviewed(queue, review_for(queue), CATALOG)
        review = review_for(queue, decision="attach_existing", existingRouteId="existing-path")
        result = publish_reviewed(queue, review, CATALOG)
        self.assertEqual(result["routes"], [])
        self.assertEqual(list(result["sourcesByRouteId"]), ["existing-path"])
        self.assertEqual(len(result["sourcesByRouteId"]["existing-path"]), 1)
        self.assertEqual(publish_reviewed(queue, review, CATALOG, result), result)

    def test_new_reference_titles_deduplicate_within_one_batch(self):
        queue = queue_for(message(), message(mid=102))
        result = publish_reviewed(queue, review_for(queue), CATALOG)
        self.assertEqual(len(result["routes"]), 1)
        self.assertEqual(len(result["sourcesByRouteId"]["telegram-poiskpohod-101"]), 2)

    def test_rejects_geometry_foreign_regions_and_personal_fields(self):
        queue = queue_for()
        for field, value in [("geometry", [[1, 2], [3, 4]]), ("duration", "1 час"), ("author", "PRIVATE")]:
            review = review_for(queue)
            review["decisions"][0]["route"][field] = value
            with self.assertRaises(ImportFailure):
                publish_reviewed(queue, review, CATALOG)
        for region in ["foreign-region", "__proto__"]:
            review = review_for(queue)
            review["decisions"][0]["route"]["regionId"] = region
            with self.assertRaises(ImportFailure):
                publish_reviewed(queue, review, CATALOG)
        for description in ["Свяжитесь с @private_person для похода", "Телефон для связи +7 999 123-45-67", "<script>message</script> учебное описание"]:
            review = review_for(queue)
            review["decisions"][0]["route"]["description"] = description
            with self.assertRaises(ImportFailure):
                publish_reviewed(queue, review, CATALOG)

    def test_regions_follow_the_actual_curated_catalogue(self):
        queue = queue_for()
        catalog = copy.deepcopy(CATALOG)
        catalog["regions"].append({"id": "primorye", "name": "Приморский край"})
        review = review_for(queue)
        review["decisions"][0]["route"]["regionId"] = "primorye"
        self.assertEqual(publish_reviewed(queue, review, catalog)["routes"][0]["regionId"], "primorye")

    def test_public_validation_rejects_schema_and_source_tampering(self):
        queue = queue_for()
        baseline = publish_reviewed(queue, review_for(queue), CATALOG)
        for mutation in [lambda x: x["routes"][0].update(center=[1, 2]),
                         lambda x: x["routes"][0].update(duration="2 часа"),
                         lambda x: x["routes"][0].update(sourceKind="database"),
                         lambda x: x["routes"][0]["additionalSources"][0].update(url=CHAT_URL + "/999"),
                         lambda x: x["routes"][0]["additionalSources"][0].update(authorId=123),
                         lambda x: x.update(status="pending_history_access")]:
            value = copy.deepcopy(baseline)
            mutation(value)
            with self.assertRaises(ImportFailure):
                validate_published(value, CATALOG)

    def test_private_queue_rejects_preapproval_and_injected_fields(self):
        for changes in [{"state": "approved"}, {"authorId": 123}, {"links": [{"url": "https://localhost/a", "kind": "route"}]}]:
            queue = queue_for()
            queue["candidates"][0].update(changes)
            original = {key: value for key, value in queue["candidates"][0].items() if key != "candidateDigest"}
            queue["candidates"][0]["candidateDigest"] = digest(original)
            with self.assertRaises(ImportFailure):
                validate_queue(queue)


if __name__ == "__main__":
    unittest.main()
