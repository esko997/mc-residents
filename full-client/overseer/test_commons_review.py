"""commons-review.py against a throwaway commons and a stand-in for the model.

    python3 -m unittest full-client/overseer/test_commons_review.py
"""
import os, sqlite3, stat, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "..", "commons", "schema.sql")


class CommonsReview(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self.home.name, "bin"))
        self.db_path = os.path.join(self.home.name, "commons.sqlite")
        self.db = sqlite3.connect(self.db_path, isolation_level=None)
        self.db.executescript(open(SCHEMA).read())
        self.now = int(time.time() * 1000) - 60_000
        self.db.execute("INSERT INTO skills (name, author, description, code, expect_json, status, version, created_at, updated_at) VALUES ('make_sticks', 'Gary', 'Sticks.', 'return 1', '{}', 'verified', 1, ?, ?)", (self.now, self.now))
        self.db.execute("INSERT INTO shared_notes (author, topic, text, status, created_at, updated_at) VALUES ('Margo', 'wheat', 'Wheat grows near water.', 'proposed', ?, ?)", (self.now, self.now))

    def tearDown(self):
        self.db.close(); self.home.cleanup()

    def review(self, answer, meanwhile=""):
        """Run one pass; the stand-in model writes `answer`, after running the SQL in `meanwhile`."""
        stub = os.path.join(self.home.name, "bin", "codex")
        with open(stub, "w") as handle:
            handle.write(f"""#!{sys.executable}
import sqlite3, sys
out = sys.argv[sys.argv.index("-o") + 1]
db = sqlite3.connect({self.db_path!r}, isolation_level=None)
db.executescript({meanwhile!r})
open(out, "w").write({answer!r})
""")
        os.chmod(stub, os.stat(stub).st_mode | stat.S_IEXEC)
        return subprocess.run([sys.executable, os.path.join(HERE, "commons-review.py"), "--db", self.db_path],
                              env={**os.environ, "GARY_CLIENT_HOME": self.home.name}, capture_output=True, text=True, timeout=30)

    def status(self, table):
        return self.db.execute(f"SELECT status FROM {table} WHERE id = 1").fetchone()[0]

    def reviews(self):
        return self.db.execute("SELECT kind, reviewer, verdict, text FROM reviews ORDER BY id").fetchall()

    def test_verdicts_are_applied_and_the_same_revision_is_not_reviewed_twice(self):
        first = self.review("skill 1: keep - fine\nnote 1: reject - false\nskill 9: reject - made up id\n")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(self.status("skills"), "curated")
        self.assertEqual(self.status("shared_notes"), "rejected")
        self.assertEqual(self.reviews(), [("skill", "caretaker", "keep", "v1: fine"), ("note", "caretaker", "reject", "false")])
        # Nothing new: the model must not even be asked (a call would add a review).
        self.review("skill 1: reject - asked twice\n")
        self.assertEqual(len(self.reviews()), 2)

    def test_a_new_version_of_a_reviewed_skill_comes_up_again(self):
        self.review("skill 1: keep - fine\nnote 1: keep - true\n")
        later = int(time.time() * 1000) + 5_000
        # The author saved new code and it passed its check again.
        self.db.execute("UPDATE skills SET status = 'verified', version = 2, code = 'return 2', updated_at = ? WHERE id = 1", (later,))
        self.review("skill 1: reject - now it digs through a house\n")
        self.assertEqual(self.status("skills"), "rejected")
        self.assertEqual(self.reviews()[-1], ("skill", "caretaker", "reject", "v2: now it digs through a house"))

    def test_a_verdict_about_a_revision_that_changed_meanwhile_is_dropped(self):
        changed = int(time.time() * 1000) + 5_000
        result = self.review("skill 1: reject - bad\nnote 1: keep - true\n",
                             meanwhile=f"UPDATE skills SET version = 2, status = 'draft', code = 'return 3', updated_at = {changed} WHERE id = 1;")
        self.assertEqual(self.status("skills"), "draft")  # the author's new draft is untouched
        self.assertEqual(self.reviews(), [("note", "caretaker", "keep", "true")])
        self.assertIn("SKIPPED", result.stdout)

    def test_a_person_who_reviewed_meanwhile_is_not_overridden(self):
        at = int(time.time() * 1000) + 5_000
        self.review("note 1: reject - false\nskill 1: comment - ok\n",
                    meanwhile=f"UPDATE shared_notes SET status = 'curated', updated_at = {at} WHERE id = 1; INSERT INTO reviews (kind, target_id, reviewer, verdict, text, at) VALUES ('note', 1, 'spesk01', 'keep', '', {at});")
        self.assertEqual(self.status("shared_notes"), "curated")
        self.assertEqual([row[1] for row in self.reviews() if row[0] == "note"], ["spesk01"])
        self.assertEqual(self.status("skills"), "verified")  # a comment changes no status


if __name__ == "__main__":
    unittest.main()
