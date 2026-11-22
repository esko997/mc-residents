import argparse
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("knowledge_research", Path(__file__).with_name("knowledge-research.py"))
research = importlib.util.module_from_spec(spec)
spec.loader.exec_module(research)
SCHEMA = Path(__file__).resolve().parents[1] / "commons" / "schema.sql"
SCOPE = "Minecraft Java 1.20.1; Mekanism 10.4.16.80"
URL = "https://wiki.aidancbrady.com/wiki/Metallurgic_Infuser"
OTHER = "https://wiki.aidancbrady.com/wiki/Osmium"


def answer():
    return {"status": "ready", "title": "Infuser", "version_scope": SCOPE,
            "answer": "Inspect the installed recipe before attempting construction.",
            "prerequisites": ["Recipe ingredients"], "body_controls": [{"control": "recipes", "step": "then inspect screen; do not guess slots"}],
            "caveats": "Untested reference, not a tested skill.",
            "sources": [{"url": URL, "title": "Infuser", "supports": "Machine overview", "version_evidence": "Research fixture version evidence", "excerpt": "Fixture source excerpt"}]}


def trace(url=URL, action="open_page"):
    result = {"type": "text_result", "url": url, "ref_id": "turn0view0", "snippet": "Total lines: 100"} if action == "open_page" else {"type": "text_result", "url": url, "ref_id": "turn0search0", "snippet": "A search excerpt"}
    return json.dumps({"type": "item.completed", "item": {"type": "web_search", "action": {"type": action, "url": url}, "results": [result]}})


def web(action, results):
    return json.dumps({"type": "item.completed", "item": {"type": "web_search", "action": action, "results": results}})


class ResearchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = str(Path(self.directory.name) / "commons.sqlite")
        self.db = self.connect()
        self.db.executescript(SCHEMA.read_text())
        self.db.execute("INSERT INTO knowledge_gaps(normalized_question,question,scope,created_at,updated_at) VALUES('infuser','Infuser',?,1,1)", (SCOPE,))
        self.db.execute("INSERT INTO knowledge_requests(gap_id,resident,first_at,last_at) VALUES(1,'Gary',1,1)")

    def connect(self):
        db = sqlite3.connect(self.path, isolation_level=None)
        db.row_factory = sqlite3.Row
        return db

    def tearDown(self):
        self.db.close()
        self.directory.cleanup()

    def gap(self):
        return dict(self.db.execute("SELECT status,reason,next_attempt_at,revision,attempts FROM knowledge_gaps WHERE id=1").fetchone())

    def test_two_caretakers_cannot_claim_same_live_revision(self):
        claim = research.claim(self.db, 3, 180, at=100)
        other = self.connect()
        try:
            self.assertIsNone(research.claim(other, 3, 180, at=101))
            self.assertEqual(claim["attempts"], 1)
            # Expiry permits recovery, but the old token must no longer publish.
            recovered = research.claim(other, 3, 180, at=300000)
            self.assertNotEqual(claim["lease_token"], recovered["lease_token"])
            data = research.validate(json.dumps(answer()), trace(), SCOPE)
            self.assertFalse(research.publish(self.db, claim, data, "astra", at=300001))
            self.assertTrue(research.publish(other, recovered, data, "astra", at=300001))
        finally:
            other.close()

    def test_feedback_revision_rejects_inflight_answer(self):
        claim = research.claim(self.db, 3, 180, at=100)
        self.db.execute("UPDATE knowledge_gaps SET revision=2,status='pending',lease_token=NULL,lease_until=NULL,attempts=0 WHERE id=1")
        data = research.validate(json.dumps(answer()), trace(), SCOPE)
        self.assertFalse(research.publish(self.db, claim, data, "astra", at=200))
        self.assertEqual(self.db.execute("SELECT count(*) FROM knowledge_references").fetchone()[0], 0)
        # A stale failure must not overwrite the pending correction either.
        research.fail(self.db, claim, "Old research failed", 60, at=200)
        self.assertEqual(self.db.execute("SELECT status FROM knowledge_gaps").fetchone()[0], "pending")

    def test_backoff_and_attempt_cap_preserve_reason_without_fake_reference(self):
        first = research.claim(self.db, 2, 30, at=100)
        research.fail(self.db, first, "Research unavailable", 60, at=200)
        self.assertIsNone(research.claim(self.db, 2, 30, at=60199))
        second = research.claim(self.db, 2, 30, at=60200)
        research.fail(self.db, second, "No version-appropriate sources", 60, at=60300)
        self.assertIsNone(research.claim(self.db, 2, 30, at=99999999))
        gap = self.db.execute("SELECT status,reason,attempts FROM knowledge_gaps").fetchone()
        self.assertEqual(tuple(gap), ("unavailable", "No version-appropriate sources", 2))
        self.assertEqual(self.db.execute("SELECT count(*) FROM knowledge_references").fetchone()[0], 0)

    def test_expired_final_attempt_is_not_permanently_researching(self):
        research.claim(self.db, 1, 30, at=100)
        self.assertIsNone(research.claim(self.db, 1, 30, at=90101))
        self.assertEqual(self.db.execute("SELECT status FROM knowledge_gaps").fetchone()[0], "unavailable")

    def test_publication_after_read_failure_is_discoverable_again(self):
        claim = research.claim(self.db, 3, 180, at=100)
        self.db.execute("UPDATE knowledge_requests SET seen_revision=1")
        data = research.validate(json.dumps(answer()), trace(), SCOPE)
        self.assertTrue(research.publish(self.db, claim, data, "astra", at=200))
        self.assertEqual(self.db.execute("SELECT seen_revision FROM knowledge_requests").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM skills").fetchone()[0], 0)
        self.assertEqual(json.loads(self.db.execute("SELECT controls_json FROM knowledge_references").fetchone()[0]), ["recipes: then inspect screen; do not guess slots"])

    def test_model_citations_or_search_queries_are_not_source_visits(self):
        for provenance in ("", json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": URL}}), trace(action="search")):
            with self.assertRaisesRegex(ValueError, "completed public web-tool visit"):
                research.validate(json.dumps(answer()), provenance, SCOPE)
        self.assertEqual(research.validate(json.dumps(answer()), trace(), SCOPE)["evidence"]["visited_urls"], [URL])

    def test_failed_open_is_not_evidence_and_batch_results_are_retained(self):
        failed = json.dumps({"type": "item.completed", "item": {"type": "web_search",
            "action": {"type": "open_page", "url": URL},
            "results": [{"type": "text_result", "ref_id": "turn0view0", "snippet": ""}]}})
        self.assertEqual(research.trace_evidence(failed), set())
        other = "https://www.minecraft.net/en-us/article/chicken"
        batch = json.dumps({"type": "item.completed", "item": {"type": "web_search",
            "action": {"type": "search", "query": "mixed search and open batch"}, "results": [
                {"type": "text_result", "url": other, "ref_id": "turn2view0", "snippet": "Total lines: 626"},
                {"type": "text_result", "url": URL, "ref_id": "turn2view1", "snippet": "Total lines: 100"}]}})
        self.assertEqual(research.trace_evidence(batch), {URL, other})

    def test_provenance_failures_name_their_cause(self):
        def failure(provenance):
            with self.assertRaises(research.ResearchError) as caught:
                research.validate(json.dumps(answer()), provenance, SCOPE)
            return caught.exception

        searched = failure(trace(action="search"))
        self.assertEqual(searched.code, "provenance")
        self.assertIn("only in search results", searched.reason)
        opened_badly = failure(web({"type": "open_page", "url": URL}, [{"type": "text_result", "ref_id": "turn0view0", "snippet": ""}]))
        self.assertIn("page open did not complete", opened_badly.reason)
        self.assertEqual(opened_badly.detail["failed_opens"], [URL])
        mismatch = failure(trace(OTHER))
        self.assertIn("never opened", mismatch.reason)
        self.assertIn("opened on that site: wiki.aidancbrady.com/wiki/Osmium", mismatch.reason)
        self.assertEqual(failure(web({"type": "open_page", "url": URL}, [{"type": "page_result", "body": "..."}])).code, "trace_format")
        self.assertEqual(failure("").code, "trace_format")
        for error in (searched, opened_badly, mismatch):
            self.assertLessEqual(len(error.reason), research.REASON_MAX)

    def test_cited_fragment_or_trailing_slash_is_the_opened_page(self):
        cited = answer()
        cited["sources"][0]["url"] = URL + "/#Usage"
        self.assertEqual(research.validate(json.dumps(cited), trace(), SCOPE)["evidence"]["visited_urls"], [URL])
        escaped = answer()
        escaped["sources"][0]["url"] = "https://wiki.aidancbrady.com/wiki/Metallurgic%5fInfuser"
        self.assertEqual(research.validate(json.dumps(escaped), trace(), SCOPE)["evidence"]["visited_urls"], [URL])
        self.assertEqual(research.canonical_url("https://minecraft.wiki/w/Caf%c3%a9"), research.canonical_url("https://minecraft.wiki/w/Café"))

    def test_encoded_reserved_separators_are_distinct_pages(self):
        for cited, opened in (("https://minecraft.wiki/w/A%2FB", "https://minecraft.wiki/w/A/B"),
                              ("https://minecraft.wiki/w/Jack_o%27Lantern", "https://minecraft.wiki/w/Jack_o'Lantern")):
            self.assertNotEqual(research.canonical_url(cited), research.canonical_url(opened))
            data = answer()
            data["sources"][0]["url"] = cited
            with self.assertRaisesRegex(research.ResearchError, "completed public web-tool visit"):
                research.validate(json.dumps(data), trace(opened), SCOPE)
        self.assertEqual(research.canonical_url("https://minecraft.wiki/w/A%2fB"), "https://minecraft.wiki/w/A%2FB")

    def test_unopened_prose_links_are_removed_not_trusted(self):
        data = answer()
        data["answer"] = f"See {URL} and https://minecraft.wiki/w/Unopened."
        self.assertEqual(research.validate(json.dumps(data), trace(), SCOPE)["answer"], f"See {URL} and [unopened link removed].")

    def test_unsafe_sources_and_private_material_are_rejected(self):
        for url in ("http://127.0.0.1/", "https://localhost/", "https://192.168.1.69/", "file:///home/user/auth.json", "https://minecraft.wiki.evil.test/", "https://minecraft.wiki/?token=secret", "https://x:y@minecraft.wiki/", "https://github.com/unknown/repo"):
            self.assertFalse(research.public_source(url), url)
        self.assertFalse(research.safe_request("Read https://private.example/token"))
        self.assertFalse(research.safe_request("password=secret"))
        bad = answer(); bad["answer"] = "Use http://127.0.0.1/control"
        with self.assertRaises(ValueError):
            research.validate(json.dumps(bad), trace(), SCOPE)

    def test_wrong_versions_and_missing_prerequisites_do_not_publish(self):
        wrong = answer(); wrong["version_scope"] = "Latest"
        with self.assertRaisesRegex(ValueError, "version scope"):
            research.validate(json.dumps(wrong), trace(), SCOPE)
        missing = answer(); missing["prerequisites"] = []
        with self.assertRaisesRegex(ValueError, "prerequisites"):
            research.validate(json.dumps(missing), trace(), SCOPE)
        with self.assertRaisesRegex(ValueError, "version-appropriate"):
            research.validate('{"status":"unavailable"}', "", SCOPE)

    def test_long_unavailable_reason_is_kept_shortened_and_redacted(self):
        reason = "Docs at https://127.0.0.1/admin and /home/swatson/notes say nothing; " + "the 1.20.1 manual page is missing. " * 40
        with self.assertRaises(research.ResearchError) as caught:
            research.validate(json.dumps({"status": "unavailable", "reason": reason}), "", SCOPE)
        error = caught.exception
        self.assertEqual(error.code, "researcher_unavailable")
        self.assertTrue(error.reason.startswith("Research unavailable: Docs at [link] and ~/notes say nothing"))
        self.assertTrue(error.reason.endswith("…"))
        self.assertNotIn("swatson", error.reason)

    def test_answer_format_errors_say_what_is_wrong(self):
        with self.assertRaisesRegex(research.ResearchError, "not one JSON object"):
            research.validate("Here is the answer: {", trace(), SCOPE)
        long_title = answer(); long_title["title"] = "t" * 200
        with self.assertRaisesRegex(research.ResearchError, r"title must be 1\.\.160 characters \(got 200\)"):
            research.validate(json.dumps(long_title), trace(), SCOPE)
        fenced = "```json\n" + json.dumps(answer()) + "\n```"
        self.assertEqual(research.validate(fenced, trace(), SCOPE)["title"], "Infuser")

    def test_body_controls_must_name_resident_tools(self):
        invented = answer()
        invented["body_controls"] = [{"control": "ride_minecart", "step": "board it"}]
        with self.assertRaises(research.ResearchError) as caught:
            research.validate(json.dumps(invented), trace(), SCOPE)
        self.assertEqual(caught.exception.code, "unknown_control")
        self.assertIn("ride_minecart is not a resident tool", caught.exception.reason)
        invented["body_controls"] = [{"control": "mount", "step": "board it"}]
        self.assertEqual(research.validate(json.dumps(invented), trace(), SCOPE, tools={"mount"})["body_controls"], ["mount: board it"])
        legacy = answer(); legacy["body_controls"] = ["use the cart"]
        with self.assertRaisesRegex(research.ResearchError, "control"):
            research.validate(json.dumps(legacy), trace(), SCOPE)

    def test_missing_capabilities_publish_knowledge_and_queue_maintainers(self):
        data = answer()
        data["missing_body_capabilities"] = [{"capability": "Hold a mod keybinding", "needed_for": "ascending"}]
        claim = research.claim(self.db, 3, 180, at=100)
        self.assertTrue(research.publish(self.db, claim, research.validate(json.dumps(data), trace(), SCOPE), "astra", at=200))
        self.assertIn("Body cannot yet: Hold a mod keybinding (needed for: ascending)", self.db.execute("SELECT caveats FROM knowledge_references").fetchone()[0])
        self.assertEqual(tuple(self.db.execute("SELECT normalized_capability,status FROM capability_gaps").fetchone()), ("hold a mod keybinding", "open"))
        self.assertEqual(tuple(self.db.execute("SELECT gap_id,revision,blocking FROM capability_reports").fetchone()), (1, 1, 0))
        self.assertEqual(self.gap()["status"], "published")
        existing = answer(); existing["missing_body_capabilities"] = [{"capability": "use", "needed_for": "x"}]
        with self.assertRaisesRegex(research.ResearchError, "existing resident tool"):
            research.validate(json.dumps(existing), trace(), SCOPE)

    def capability_only(self):
        return research.validate(json.dumps({"status": "needs_body_capability", "reason": "Flying needs the ascend key",
                                             "capabilities": [{"capability": "Hold a mod keybinding", "needed_for": "ascend"}]}), "", SCOPE)

    def test_capability_only_answer_parks_revision_until_provided(self):
        self.db.execute("UPDATE knowledge_requests SET seen_revision=1")
        claim = research.claim(self.db, 3, 180, at=100)
        reason = research.block(self.db, claim, self.capability_only(), 60, at=200)
        self.assertTrue(reason.startswith("Needs body capability: cap-1 Hold a mod keybinding."))
        self.assertEqual(self.gap()["next_attempt_at"], research.NEVER)
        self.assertEqual(self.db.execute("SELECT seen_revision FROM knowledge_requests").fetchone()[0], 0)
        self.assertIsNone(research.claim(self.db, 3, 180, at=10 ** 15))
        self.assertEqual(tuple(self.db.execute("SELECT blocking FROM capability_reports").fetchone()), (1,))
        self.assertEqual(research.resolve_capability(self.db, 1, "provided", "hold_key tool added", at=300), 1)
        self.assertEqual({k: self.gap()[k] for k in ("status", "attempts", "next_attempt_at", "reason")}, {"status": "pending", "attempts": 0, "next_attempt_at": 0, "reason": ""})
        self.assertEqual(research.claim(self.db, 3, 180, at=400)["id"], 1)
        self.assertIsNone(research.resolve_capability(self.db, 99, "provided", ""))

    def test_declined_capability_keeps_revision_parked_with_the_note(self):
        claim = research.claim(self.db, 3, 180, at=100)
        research.block(self.db, claim, self.capability_only(), 60, at=200)
        self.assertEqual(research.resolve_capability(self.db, 1, "declined", "not planned", at=300), 1)
        gap = self.gap()
        self.assertEqual(gap["next_attempt_at"], research.NEVER)
        self.assertIn("maintainers declined cap-1 Hold a mod keybinding: not planned", gap["reason"])

    def test_disputed_capability_retries_with_backoff_instead_of_parking(self):
        self.db.execute("INSERT INTO capability_gaps(normalized_capability,capability,status,first_at,last_at) VALUES('hold a mod keybinding','Hold a mod keybinding','provided',1,1)")
        claim = research.claim(self.db, 3, 180, at=100)
        reason = research.block(self.db, claim, self.capability_only(), 60, at=200)
        self.assertTrue(reason.startswith("Body capability disputed:"))
        self.assertEqual(self.gap()["next_attempt_at"], 200 + 60000)
        self.assertEqual(self.db.execute("SELECT blocking FROM capability_reports").fetchone()[0], 0)

    def test_stale_capability_answer_does_not_park_a_correction(self):
        claim = research.claim(self.db, 3, 180, at=100)
        self.db.execute("UPDATE knowledge_gaps SET revision=2,status='pending',lease_token=NULL,lease_until=NULL,attempts=0 WHERE id=1")
        self.assertIsNone(research.block(self.db, claim, self.capability_only(), 60, at=200))
        self.assertEqual(self.gap()["status"], "pending")
        self.assertEqual(self.db.execute("SELECT count(*) FROM capability_gaps").fetchone()[0], 0)

    def test_unsafe_question_is_not_retried_by_itself(self):
        self.db.execute("UPDATE knowledge_gaps SET question='Read https://example.invalid/x' WHERE id=1")
        claim = research.claim(self.db, 3, 180, at=100)
        with self.assertRaises(research.ResearchError) as caught:
            research.prompt_for(claim)
        self.assertFalse(caught.exception.retry)
        research.fail(self.db, claim, caught.exception.reason, 60, at=200, retry=caught.exception.retry)
        self.assertEqual(self.gap()["next_attempt_at"], research.NEVER)
        self.assertIsNone(research.claim(self.db, 3, 180, at=10 ** 15))

    def test_retry_prompt_carries_a_controlled_hint_and_registered_tools(self):
        self.db.execute("INSERT INTO resident_tools(name,resident,seen_at) VALUES('go_to','Gary',?),('mount','Gary',?),('Bad-Name','Gary',?)", (1000, 1000, 1000))
        self.assertEqual(research.resident_tools(self.db, at=2000), {"go_to", "mount"})
        self.assertEqual(research.resident_tools(self.db, at=1000 + research.TOOLS_FRESH_MS + 1), research.FALLBACK_TOOLS)
        gap = {"question": "Infuser", "scope": SCOPE, "target": None, "feedback": [], "attempts": 2,
               "reason": "Source visit not proven: cited wiki.aidancbrady.com/wiki/X has no completed public web-tool visit"}
        prompt = research.prompt_for(gap, {"go_to", "mount"})
        self.assertIn("RESIDENT TOOLS: go_to, mount\nPREVIOUS ATTEMPT: " + research.HINTS["provenance"], prompt)
        self.assertNotIn("wiki/X", prompt)
        self.assertNotIn("PREVIOUS ATTEMPT", research.prompt_for({**gap, "attempts": 1}))


FAKE_CODEX = """#!/usr/bin/env python3
import json, os, sys
sys.stdin.read()
if os.environ["FAKE_CODEX_MODE"] == "auth":
    sys.stderr.write("error: HTTP 401 Unauthorized token=abcd1234efgh for /home/swatson/.codex/auth.json\\n")
    sys.exit(1)
print(json.dumps({"type": "item.completed", "item": {"type": "web_search", "action": {"type": "search", "query": "infuser api_key=zzz999"},
                  "results": [{"type": "text_result", "url": URL, "ref_id": "turn0search0", "snippet": "lead"}]}}))
with open(sys.argv[sys.argv.index("-o") + 1], "w") as out:
    out.write(ANSWER)
"""


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.base = Path(self.directory.name)
        (self.base / "bin").mkdir()
        codex = self.base / "bin" / "codex"
        codex.write_text(FAKE_CODEX.replace("URL", repr(URL)).replace("ANSWER", repr(json.dumps(answer()))))
        codex.chmod(0o700)
        self.saved = research.BASE, os.environ.get("FAKE_CODEX_MODE")
        research.BASE = self.base
        self.gap = {"id": 1, "revision": 1, "attempts": 1, "question": "Infuser", "scope": SCOPE, "target": None, "feedback": []}
        self.args = argparse.Namespace(model="test-model", timeout=30)

    def tearDown(self):
        research.BASE = self.saved[0]
        if self.saved[1] is None:
            os.environ.pop("FAKE_CODEX_MODE", None)
        else:
            os.environ["FAKE_CODEX_MODE"] = self.saved[1]
        self.directory.cleanup()

    def attempt(self, mode):
        os.environ["FAKE_CODEX_MODE"] = mode
        with self.assertRaises(research.ResearchError) as caught:
            research.research(self.gap, self.args)
        return caught.exception

    def test_service_failure_names_cause_and_keeps_private_redacted_evidence(self):
        error = self.attempt("auth")
        self.assertEqual(error.reason, "Research service failed: Codex exited with status 1 (authentication rejected)")
        name = research.write_diagnostic(self.base / "diagnostics", self.gap, error, "test-model")
        path = self.base / "diagnostics" / name
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        text = path.read_text()
        self.assertIn("401 Unauthorized", text)
        for secret in ("abcd1234efgh", "/home/swatson"):
            self.assertNotIn(secret, text)

    def test_provenance_failure_diagnostic_shows_answer_and_trace_shape(self):
        error = self.attempt("search-only")
        self.assertEqual(error.code, "provenance")
        record = json.loads((self.base / "d" / research.write_diagnostic(self.base / "d", self.gap, error, "m")).read_text())
        self.assertEqual(record["code"], "provenance")
        self.assertIn("Metallurgic_Infuser", record["answer_excerpt"])
        self.assertEqual(record["trace_summary"]["searched_only"], [URL])
        self.assertEqual(record["trace_summary"]["visited"], [])
        self.assertNotIn("zzz999", json.dumps(record))

    def test_diagnostics_are_pruned_to_newest_files(self):
        error = research.ResearchError("timeout", "no answer within 30 s; retrying later")
        for attempt in (1, 2, 3):
            research.write_diagnostic(self.base / "d", {**self.gap, "attempts": attempt}, error, "m", at=attempt * 1000, keep=2)
        research.write_diagnostic(self.base / "d", {**self.gap, "attempts": 4}, error, "m", at=4000, keep=2)
        self.assertEqual(len(list((self.base / "d").glob("ref-*.json"))), 2)
        self.assertEqual(list((self.base / "d").glob(".*")), [])


if __name__ == "__main__":
    unittest.main()
