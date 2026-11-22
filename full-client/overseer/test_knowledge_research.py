import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("knowledge_research", Path(__file__).with_name("knowledge-research.py"))
research = importlib.util.module_from_spec(spec)
spec.loader.exec_module(research)
SCHEMA = Path(__file__).resolve().parents[1] / "commons" / "schema.sql"
SCOPE = "Minecraft Java 1.20.1; Mekanism 10.4.16.80"
URL = "https://wiki.aidancbrady.com/wiki/Metallurgic_Infuser"


def answer():
    return {"status": "ready", "title": "Infuser", "version_scope": SCOPE,
            "answer": "Inspect the installed recipe before attempting construction.",
            "prerequisites": ["Recipe ingredients"], "body_controls": ["recipes, then inspect screen; do not guess slots"],
            "caveats": "Untested reference, not a tested skill.",
            "sources": [{"url": URL, "title": "Infuser", "supports": "Machine overview", "version_evidence": "Research fixture version evidence", "excerpt": "Fixture source excerpt"}]}


def trace(url=URL, action="open_page"):
    result = {"type": "text_result", "url": url, "ref_id": "turn0view0", "snippet": "Total lines: 100"} if action == "open_page" else {"type": "text_result", "url": url, "ref_id": "turn0search0", "snippet": "A search excerpt"}
    return json.dumps({"type": "item.completed", "item": {"type": "web_search", "action": {"type": action, "url": url}, "results": [result]}})


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


if __name__ == "__main__":
    unittest.main()
