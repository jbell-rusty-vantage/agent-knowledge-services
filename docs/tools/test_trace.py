"""Tests for the Knowledge Services adaptations of trace.py (SPEC-03 K1). Standard library only.

Run: python -X utf8 -m unittest discover -s docs/tools -p "test_*.py"
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("ks_trace", HERE / "trace.py")
assert SPEC and SPEC.loader
trace = importlib.util.module_from_spec(SPEC)
sys.modules["ks_trace"] = trace
SPEC.loader.exec_module(trace)


def graph_with(sources: list[dict]) -> trace.Graph:
    graph = trace.Graph()
    for source in sources:
        graph.external[source["name"]] = source
    return graph


class ExternalRecords(unittest.TestCase):
    def test_review_workspace_sections_and_decisions(self) -> None:
        # The frozen records of the per-unit layout (2026-11-20): provenance/records/.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            records = root / "provenance" / "records"
            records.mkdir(parents=True)
            (records / "BUILD-08-KNOWLEDGE-LOOP.md").write_text(
                '<a id="s29"></a>\n## 29. Loop 8\n\n| D-80 | attribution |\n', encoding="utf-8"
            )
            (records / "REVIEW-LEDGER.md").write_text("| D-81 | later |\n", encoding="utf-8")
            ids = trace.review_workspace_ids(root)
        self.assertEqual(ids, {"B08-S29", "B08-D80", "B08-D81"})

    def test_review_workspace_answers_files_give_session_ids(self) -> None:
        answers = "---\ntype: Interview Answers\nid: {id}\n---\n\n# answers\n"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            records = root / "provenance" / "records"
            records.mkdir(parents=True)
            (records / "VER-S1-ANSWERS.md").write_text(answers.format(id="VER-S1"), encoding="utf-8")
            (records / "NOTES-ANSWERS.md").write_text("---\ntype: Note\nid: VER-S9\n---\n", encoding="utf-8")
            session = root / "units" / "RV01-example" / "sessions" / "2026-11-20"
            session.mkdir(parents=True)
            (session / "ANSWERS.md").write_text(answers.format(id="B09-S1"), encoding="utf-8")
            ids = trace.review_workspace_ids(root)
        self.assertEqual(ids, {"VER-S1", "B09-S1"})

    def test_review_workspace_answers_for_its_families_only(self) -> None:
        workspace = next(s for s in trace.EXTERNAL_SOURCES if s["name"] == "ai-engineer-review-workspace")
        for family in ("B08", "B09", "WS", "VER"):
            self.assertIsNotNone(workspace["families"].match(family), family)
        for family in ("AS", "OVE", "VERS", "B8"):
            self.assertIsNone(workspace["families"].match(family), family)
        graph = graph_with(
            [{"name": "rw", "root": "../rw", "present": True, "families": workspace["families"], "ids": {"VER-S1"}}]
        )
        self.assertEqual(trace.message_problems(graph, "feat: x\n\nRefs: VER-S1, D-117\n"), [])
        self.assertEqual(graph.notes, [])

    def test_present_source_resolves_only_recorded_ids(self) -> None:
        graph = graph_with(
            [
                {"name": "mc", "root": "../mc", "present": True, "families": None, "ids": {"AS-S9"}},
                {
                    "name": "rw",
                    "root": "../rw",
                    "present": True,
                    "families": trace.re.compile(r"^B\d{2}$"),
                    "ids": {"B08-S29"},
                },
            ]
        )
        self.assertTrue(graph.resolves("AS-S9"))
        self.assertFalse(graph.resolves("AS-S99"))
        self.assertTrue(graph.resolves("B08-S29"))
        self.assertFalse(graph.resolves("B08-S999"))
        self.assertEqual(graph.notes, [])

    def test_absent_source_is_a_note_never_a_gap(self) -> None:
        graph = graph_with(
            [
                {
                    "name": "rw",
                    "root": "../rw",
                    "present": False,
                    "families": trace.re.compile(r"^B\d{2}$"),
                    "ids": set(),
                }
            ]
        )
        problems = trace.message_problems(graph, "feat: x\n\nRefs: OVE-243, B08-S29\n")
        self.assertEqual(problems, [])
        self.assertEqual(len(graph.notes), 1)
        self.assertIn("B08-S29", graph.notes[0])

    def test_message_without_refs_warns(self) -> None:
        problems = trace.message_problems(graph_with([]), "feat: x\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("no Refs: trailer", problems[0])
        self.assertEqual(trace.report(problems, "warn"), 0)
        self.assertEqual(trace.report(problems, "block"), 1)


class Configuration(unittest.TestCase):
    def test_repository_constants(self) -> None:
        self.assertEqual(trace.REPO_KEY, "knowledge-services")
        self.assertEqual(trace.CUTOVER, "2026-11-18")
        self.assertEqual(trace.ADR_DIR, "docs/architecture/")


if __name__ == "__main__":
    unittest.main()
