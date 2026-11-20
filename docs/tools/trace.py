#!/usr/bin/env python3
"""Trace the provenance chain: interview → decision → spec → issue → commit → completion.

The chain and its record formats are SPEC-02
(docs/specs/agentic-sdlc-2026-11/SPEC-02-PROVENANCE-CHAIN.md). Git and Markdown are canonical;
Linear is read from a cached snapshot; the trace is derived and never edited. Standard library
only, so it runs before ``pnpm install``. Copied from Mission Control's canonical
``docs/tools/trace.py`` (AS-D65, AS-D67, SPEC-03 K1) for Knowledge Services; the differences are
marked "Knowledge Services:" below. Ids recorded outside this repository (Mission Control's ``AS``
answers, the AI Engineer review workspace's ``B08-S<n>``) resolve against the sibling checkout
when it exists and are reported as notes, never as gaps, when it does not.

Usage:
  python -X utf8 docs/tools/trace.py show OVE-225       # the chain around any id
  python -X utf8 docs/tools/trace.py show AS-S3 --json
  python -X utf8 docs/tools/trace.py build              # .sdlc/trace/trace.json + COVERAGE.md
  python -X utf8 docs/tools/trace.py check              # records, issues, commits since cutover
  python -X utf8 docs/tools/trace.py check --message-file .git/COMMIT_EDITMSG   # commit-msg hook
  python -X utf8 docs/tools/trace.py check --range origin/main..HEAD          # CI
  python -X utf8 docs/tools/trace.py linear pull        # snapshot via GraphQL (LINEAR_API_KEY)
  python -X utf8 docs/tools/trace.py sources            # which external record sources are present

Ids: OVE-n (issue), <FAM>-S<n> (session), <FAM>-D<n> (decision), ADR-NNNN, ID-n (idea), a commit
SHA or a path. ``check`` reports and exits 0 under SDLC_TRACE=warn (the default) and exits 1 on a
problem under SDLC_TRACE=block.
Exit codes: 0 ok, 1 problems (block mode), 2 usage, 3 id not found, 4 Linear unreachable or no key.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
REPO_KEY = "knowledge-services"
CUTOVER = "2026-11-18"
# Knowledge Services: no goals document of its own yet. Issue `Goal:` anchors resolve against
# Mission Control's goals page when the sibling checkout is present; with neither file the goal
# check is skipped.
GOALS = Path("docs") / "knowledge" / "goals.md"
SIBLING_GOALS = Path("..") / "mission-control" / "docs" / "knowledge" / "goals.md"
ADR_DIR = "docs/architecture/"
TRACE_DIR = Path(".sdlc") / "trace"
LINEAR_URL = "https://api.linear.app/graphql"
LINEAR_TEAM = "OVE"

ISSUE = re.compile(r"^OVE-\d+$")
SESSION = re.compile(r"^[A-Z][A-Z0-9]*-S\d+$")
DECISION = re.compile(r"^[A-Z][A-Z0-9]*-D\d+$")
ADR = re.compile(r"^ADR-\d{4}$")
IDEA = re.compile(r"^ID-\d+$")
SHA = re.compile(r"^[0-9a-f]{7,40}$")
ANY_ID = re.compile(r"(?<![\w-])(?:OVE-\d+|ADR-\d{4}|ID-\d+|[A-Z][A-Z0-9]*-[SD]\d+)(?![\w-])")
SUBJECT_ISSUE = re.compile(r"\((OVE-\d+)\)\s*$")
TRAILER = re.compile(r"^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$")
TABLE_DECISION = re.compile(r"^\|\s*\**([A-Z][A-Z0-9]*-D\d+)\**\s*\|")
MD_LINK = re.compile(r"\]\(<?([^)\s>]+)>?\)")
MD_NAME = re.compile(r"(?<![\w/(-])([\w.-]+\.md)\b")
ANCHOR = re.compile(r'<a id="([^"]+)"></a>')
CELL_SPLIT = re.compile(r"(?<!\\)\|")
PROVENANCE_KEYS = ("Session", "Decisions", "Spec", "ADR", "Idea", "Conversation", "Terms")
COMPLETION_KEYS = ("Commits", "Checks", "Evidence", "Level", "Verified-by")
LEVELS = ("implemented", "tested", "integrated", "qualified")
OTHER_REPO_GOALS = re.compile(r"^(?:IG[1-6]|CP[1-7]|K[1-5])$")
WEAK_EDGES = {"child_of", "tracks"}
CHAIN_ORDER = ("idea", "session", "decision", "spec", "adr", "issue", "commit", "doc")
# Knowledge Services: records that live outside this repository (SPEC-03 §3). Each source names
# the id families it answers for; `None` means "any family not defined here".
EXTERNAL_SOURCES: tuple[dict[str, Any], ...] = (
    {
        "name": "mission-control",
        "root": Path("..") / "mission-control",
        "answers_glob": "docs/specs/*/answers/*.md",
        "families": None,
    },
    {
        "name": "ai-engineer-review-workspace",
        "root": Path("..") / "ai-engineer-research-2026-11-02" / "schema-units",
        "families": re.compile(r"^(?:B\d{2}|WS|VER)$"),
    },
)


def kind_of(ident: str) -> str:
    for kind, pattern in (
        ("issue", ISSUE),
        ("session", SESSION),
        ("decision", DECISION),
        ("adr", ADR),
        ("idea", IDEA),
    ):
        if pattern.match(ident):
            return kind
    return "doc"


def today() -> str:
    return dt.datetime.now(dt.UTC).date().isoformat()


def trace_dir() -> Path:
    return REPO_ROOT / TRACE_DIR


def git(*args: str) -> str:
    done = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if done.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {done.stderr.strip()}")
    return done.stdout


# ------------------------------------------------------------------------------------- graph


class Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: list[tuple[str, str, str]] = []
        self.snapshot: dict[str, Any] | None = None
        self.goal_anchors: set[str] = set()
        self.goals_known = False
        self.external: dict[str, dict[str, Any]] = {}
        self.notes: list[str] = []

    def node(self, ident: str, kind: str, **attrs: Any) -> dict[str, Any]:
        current = self.nodes.get(ident)
        if current is None or current.get("stub"):
            current = {"kind": kind, **attrs}
            self.nodes[ident] = current
        else:
            for key, value in attrs.items():
                current.setdefault(key, value)
        return current

    def ref(self, ident: str) -> str:
        if ident not in self.nodes:
            self.nodes[ident] = {"kind": kind_of(ident), "stub": True}
        return ident

    def edge(self, src: str, kind: str, dst: str) -> None:
        if src != dst and (src, kind, dst) not in self.edges:
            self.ref(dst)
            self.edges.append((src, kind, dst))

    def defined(self, ident: str) -> bool:
        return ident in self.nodes and not self.nodes[ident].get("stub")

    def resolves(self, ident: str) -> bool:
        kind = kind_of(ident)
        if kind == "idea":
            return True  # ideas lived outside this repository (agentic-sdlc, deleted 2026-11-17)
        if kind == "issue":
            snap = self.snapshot
            if snap and snap.get("complete"):
                return any(i["identifier"] == ident for i in snap["issues"])
            return True
        if self.defined(ident):
            return True
        source = external_source_for(self, ident)
        if source is None:
            return False
        if not source["present"]:
            note = (
                f"{ident} is recorded in {source['name']} ({source['root']}), which is not checked "
                "out here; not verified"
            )
            if note not in self.notes:
                self.notes.append(note)
            return True  # unverifiable here is a note, never a gap (SPEC-03 §3)
        return ident in source["ids"]


# ---------------------------------------------------------------------------------- markdown


def frontmatter(text: str) -> dict[str, Any]:
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or lines[0] != "---" or "---" not in lines[1:]:
        return {}
    out: dict[str, Any] = {}
    key = ""
    for line in lines[1 : lines.index("---", 1)]:
        if line.startswith(("  - ", "- ")) and key:
            out.setdefault(key, [])
            if isinstance(out[key], list):
                out[key].append(line.split("- ", 1)[1].strip().strip("\"'"))
            continue
        name, sep, value = line.partition(":")
        if not sep or name.startswith(" "):
            continue
        key, value = name.strip(), value.strip()
        if value.startswith("[") and value.endswith("]"):
            out[key] = [v.strip().strip("\"'") for v in value[1:-1].split(",") if v.strip()]
        else:
            out[key] = value.strip("\"'")
    return out


def markdown_files() -> list[Path]:
    listed = git("ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md")
    return sorted({REPO_ROOT / line for line in listed.splitlines() if line.strip()})


def rel(path: Path) -> str:
    return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()


def table_cells(line: str) -> list[str]:
    return [c.strip() for c in CELL_SPLIT.split(line.strip().strip("|"))]


def decision_rows(text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    header: list[str] = []
    in_decisions = False
    for line in text.replace("\r\n", "\n").split("\n"):
        if line.startswith("## "):
            in_decisions = line[3:].strip().lower() == "decisions"
            header = []
            continue
        if not (in_decisions and line.startswith("|")):
            continue
        cells = table_cells(line)
        if set(cells[0]) <= {"-", " ", ":"}:
            continue
        if not header:
            header = [c.lower() for c in cells]
            continue
        row = dict(zip(header, cells, strict=False))
        if DECISION.match(row.get("id", "").strip("* ")):
            row["id"] = row["id"].strip("* ")
            rows.append(row)
    return rows


class Targets:
    """Resolves the documents a Becomes or Folded cell names: links, bare file names, ids."""

    def __init__(self, files: list[Path]) -> None:
        self.by_name: dict[str, list[str]] = defaultdict(list)
        for path in files:
            self.by_name[path.name].append(rel(path))
        for names in self.by_name.values():
            names.sort(key=lambda p: ("/archive/" in p, p))

    def __call__(self, cell: str, base: Path) -> tuple[list[str], list[str]]:
        ids = ANY_ID.findall(cell)
        paths: list[str] = []
        for target in MD_LINK.findall(cell):
            target = target.split("#", 1)[0]
            if not target or "://" in target:
                continue
            candidate = (base / target).resolve()
            if candidate.is_file() and REPO_ROOT.resolve() in candidate.parents:
                paths.append(rel(candidate))
        stripped = MD_LINK.sub("]()", cell)
        for name in MD_NAME.findall(stripped):
            if self.by_name.get(name):
                paths.append(self.by_name[name][0])
        return ids, list(dict.fromkeys(paths))


def collect_markdown(graph: Graph) -> None:
    files = markdown_files()
    targets = Targets(files)
    texts = {path: path.read_text(encoding="utf-8", errors="replace") for path in files}
    answers = {p: t for p, t in texts.items() if frontmatter(t).get("type") == "Interview Answers"}
    for path, text in answers.items():
        meta = frontmatter(text)
        path_rel = rel(path)
        session = (
            meta.get("id") if SESSION.match(str(meta.get("id", ""))) else f"answers:{path_rel}"
        )
        graph.node(
            session,
            "session",
            path=path_rel,
            title=meta.get("title", ""),
            date=meta.get("date", ""),
            status=meta.get("status", ""),
            family=meta.get("family", ""),
            harness_session=meta.get("harness_session", ""),
            has_id=SESSION.match(str(meta.get("id", ""))) is not None,
        )
        if IDEA.match(str(meta.get("idea", ""))):
            graph.edge(session, "serves", meta["idea"])
        for row in decision_rows(text):
            ident = row["id"]
            graph.node(
                ident,
                "decision",
                path=path_rel,
                session=session,
                question=row.get("question", ""),
                answer=row.get("answer", ""),
                date=row.get("date", ""),
                becomes=row.get("becomes", ""),
                folded=row.get("folded", ""),
            )
            graph.edge(ident, "asked_in", session)
            source = row.get("source", "")
            if IDEA.match(source):
                graph.edge(session, "serves", source)
            for column, kind in (("becomes", "becomes"), ("folded", "folded_into")):
                ids, paths = targets(row.get(column, ""), path.parent)
                for target in ids:
                    graph.edge(ident, kind, target)
                for target in paths:
                    if target != path_rel:
                        doc(graph, target, texts)
                        graph.edge(ident, kind, target)
    for path, text in texts.items():
        if path in answers:
            continue
        meta = frontmatter(text)
        decided = [d for d in as_list(meta.get("decisions")) if DECISION.match(d)]
        tracked = [i for i in as_list(meta.get("linear")) if ISSUE.match(i)]
        if decided or tracked:
            spec = doc(graph, rel(path), texts)
            spec["kind"] = "spec"
            for ident in decided:
                graph.edge(rel(path), "decides", ident)
            for ident in tracked:
                graph.edge(rel(path), "tracks", ident)
        path_rel = rel(path)
        if path_rel.startswith(ADR_DIR) and re.match(r"\d{4}-", path.name):
            graph.node(f"ADR-{path.name[:4]}", "adr", path=path_rel, title=first_heading(text))
        for line in text.split("\n"):
            match = TABLE_DECISION.match(line)
            if match and not graph.defined(match.group(1)):
                graph.node(match.group(1), "decision", path=path_rel, table_only=True)
    for goals in (REPO_ROOT / GOALS, REPO_ROOT / SIBLING_GOALS):
        if goals.is_file():
            text = goals.read_text(encoding="utf-8", errors="replace")
            graph.goals_known = True
            graph.goal_anchors |= set(ANCHOR.findall(text)) | {
                slug(line.lstrip("#").strip()) for line in text.split("\n") if line.startswith("#")
            }


# ---------------------------------------------------------- external records (Knowledge Services)


def family_of(ident: str) -> str:
    return ident.split("-", 1)[0]


def collect_external(graph: Graph) -> None:
    """Index the session and decision ids that sibling checkouts record (read-only)."""

    for spec in EXTERNAL_SOURCES:
        root = (REPO_ROOT / spec["root"]).resolve()
        entry: dict[str, Any] = {
            "name": spec["name"],
            "root": spec["root"].as_posix(),
            "present": root.is_dir(),
            "families": spec["families"],
            "ids": set(),
        }
        graph.external[spec["name"]] = entry
        if not entry["present"]:
            continue
        if spec.get("answers_glob"):
            for path in sorted(root.glob(spec["answers_glob"])):
                text = path.read_text(encoding="utf-8", errors="replace")
                meta = frontmatter(text)
                if meta.get("type") != "Interview Answers":
                    continue
                if SESSION.match(str(meta.get("id", ""))):
                    entry["ids"].add(meta["id"])
                entry["ids"].update(row["id"] for row in decision_rows(text))
        else:
            entry["ids"] = review_workspace_ids(root)


def review_workspace_ids(root: Path) -> set[str]:
    """``B08-S29`` is section 29 of ``provenance/records/BUILD-08-*.md`` (``<a id="s29">``);
    ``B08-D80`` is a ``| D-80 |`` row there or in ``provenance/records/REVIEW-LEDGER.md``. A session
    id such as ``WS-S1`` or ``VER-S1`` is the ``id:`` of an ``Interview Answers`` file under
    ``provenance/records/`` or ``units/*/sessions/*/``."""

    ids: set[str] = set()
    records = root / "provenance" / "records"  # the frozen records since the 2026-11-20 per-unit layout
    ledger = records / "REVIEW-LEDGER.md"
    ledger_text = ledger.read_text(encoding="utf-8", errors="replace") if ledger.is_file() else ""
    answers = sorted(records.glob("**/*ANSWERS*.md")) + sorted(root.glob("units/*/sessions/*/ANSWERS.md"))
    for path in answers:
        text = path.read_text(encoding="utf-8", errors="replace")
        meta = frontmatter(text)
        if meta.get("type") == "Interview Answers" and SESSION.match(str(meta.get("id", ""))):
            ids.add(meta["id"])
    for path in sorted(records.glob("BUILD-[0-9][0-9]-*.md")):
        build = path.name[len("BUILD-") : len("BUILD-") + 2]
        text = path.read_text(encoding="utf-8", errors="replace")
        ids.update(f"B{build}-S{n}" for n in re.findall(r'<a id="s(\d+)"></a>', text))
        rows = re.findall(r"^\|\s*\**D-(\d+)\**\s*\|", text + "\n" + ledger_text, re.M)
        ids.update(f"B{build}-D{n}" for n in rows)
    return ids


def external_source_for(graph: Graph, ident: str) -> dict[str, Any] | None:
    if kind_of(ident) not in ("session", "decision"):
        return None
    family = family_of(ident)
    for entry in graph.external.values():
        if entry["families"] is not None and entry["families"].match(family):
            return entry
    for entry in graph.external.values():
        if entry["families"] is None:
            return entry
    return None


def sources() -> int:
    graph = Graph()
    collect_external(graph)
    print(
        json.dumps(
            {
                name: {"root": e["root"], "present": e["present"], "ids": len(e["ids"])}
                for name, e in graph.external.items()
            },
            indent=2,
        )
    )
    return 0


def as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    return [v.strip() for v in str(value or "").split(",") if v.strip()]


def first_heading(text: str) -> str:
    for line in text.split("\n"):
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def doc(graph: Graph, path_rel: str, texts: dict[Path, str]) -> dict[str, Any]:
    text = texts.get(REPO_ROOT / path_rel, "")
    meta = frontmatter(text)
    return graph.node(
        path_rel,
        "doc",
        path=path_rel,
        title=meta.get("title") or first_heading(text),
        status=meta.get("status", ""),
    )


def slug(heading: str) -> str:
    text = re.sub(r"[^\w\- ]", "", heading.lower()).strip()
    return re.sub(r" ", "-", text)


# ----------------------------------------------------------------------------------- commits


def parse_trailers(message: str) -> dict[str, list[str]]:
    paragraphs = [p for p in re.split(r"\n\s*\n", message.strip()) if p.strip()]
    if len(paragraphs) < 2:
        return {}
    out: dict[str, list[str]] = defaultdict(list)
    last = ""
    for line in paragraphs[-1].split("\n"):
        match = TRAILER.match(line)
        if match:
            last = match.group(1).lower()
            out[last].append(match.group(2).strip())
        elif line.startswith((" ", "\t")) and last:
            out[last][-1] += " " + line.strip()
        else:
            return {}
    return dict(out)


def commit_refs(subject: str, trailers: dict[str, list[str]]) -> dict[str, Any]:
    refs: list[str] = []
    none_reason = ""
    unnamed: list[str] = []
    for value in trailers.get("refs", []):
        if value.lower().startswith("none"):
            none_reason = value[4:].strip() or "(no reason)"
            continue
        found = ANY_ID.findall(value)
        if not found:
            unnamed.append(value)
        refs.extend(found)
    legacy = SUBJECT_ISSUE.search(subject)
    if legacy:
        refs.append(legacy.group(1))
    decisions = [d for v in trailers.get("decisions", []) for d in ANY_ID.findall(v)]
    return {
        "refs": list(dict.fromkeys(refs)),
        "decisions": list(dict.fromkeys(decisions)),
        "refs_none": none_reason,
        "refs_unnamed": unnamed,
        "docs": trailers.get("docs", []),
    }


def collect_commits(graph: Graph, revision: str = "HEAD") -> None:
    try:
        log = git("log", "--format=%H%x1f%aI%x1f%s%x1f%B%x1e", revision)
    except RuntimeError:
        return  # an empty repository has no commits yet
    for record in log.split("\x1e"):
        parts = record.strip("\n").split("\x1f")
        if len(parts) < 4:
            continue
        sha, date, subject, body = parts[0].strip(), parts[1], parts[2], parts[3]
        info = commit_refs(subject, parse_trailers(body))
        graph.node(
            sha,
            "commit",
            short=sha[:8],
            date=date,
            subject=subject,
            since_cutover=date[:10] >= CUTOVER,
            **info,
        )
        for ident in info["refs"]:
            graph.edge(sha, "implements", ident)
        for ident in info["decisions"]:
            graph.edge(sha, "decides", ident)


def find_commit(graph: Graph, prefix: str) -> str | None:
    matches = [i for i, n in graph.nodes.items() if n["kind"] == "commit" and i.startswith(prefix)]
    return matches[0] if len(matches) == 1 else None


# ------------------------------------------------------------------------------------ linear


def snapshot_path() -> Path:
    return trace_dir() / "linear-snapshot.json"


def load_snapshot() -> dict[str, Any] | None:
    path = snapshot_path()
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def keyed_lines(text: str, heading: str, keys: tuple[str, ...]) -> dict[str, str]:
    """``Key: value`` lines under ``## <heading>`` (bullets tolerated), up to the next heading."""

    out: dict[str, str] = {}
    inside = False
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if line.startswith("#"):
            inside = line.lstrip("#").strip().lower() == heading.lower()
            continue
        if not inside:
            continue
        line = re.sub(r"^[-*]\s+", "", line)
        name, sep, value = line.partition(":")
        if sep and name.strip() in keys:
            out[name.strip()] = value.strip()
    return out


def goal_line(text: str) -> list[str]:
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if line.startswith("Goal:"):
            return [v.strip() for v in line[5:].split(",") if v.strip()]
    return []


def collect_linear(graph: Graph) -> None:
    snap = load_snapshot()
    graph.snapshot = snap
    if not snap:
        return
    for issue in snap.get("issues", []):
        ident = issue["identifier"]
        description = issue.get("description") or ""
        completion: dict[str, str] = {}
        for body in issue.get("comments", []):
            found = keyed_lines(body, "Completion", COMPLETION_KEYS)
            if found:
                completion = found
        provenance = keyed_lines(description, "Provenance", PROVENANCE_KEYS)
        graph.node(
            ident,
            "issue",
            title=issue.get("title", ""),
            state=issue.get("state", ""),
            state_type=issue.get("state_type", ""),
            created_at=issue.get("created_at", ""),
            completed_at=issue.get("completed_at") or "",
            url=issue.get("url", ""),
            goal=goal_line(description),
            provenance=provenance,
            completion=completion,
        )
        if issue.get("parent"):
            graph.edge(ident, "child_of", issue["parent"])
        for key, value in provenance.items():
            if key in ("Conversation", "Terms"):
                continue
            for target in ANY_ID.findall(value):
                graph.edge(ident, "provenance", target)
            if key == "Spec":
                for item in value.split(","):
                    path = item.strip().removeprefix(f"{REPO_KEY}:").split("#", 1)[0]
                    if path and (REPO_ROOT / path).is_file():
                        graph.node(path, "doc", path=path)
                        graph.edge(ident, "provenance", path)
        for sha in re.findall(r"@([0-9a-f]{7,40})", completion.get("Commits", "")):
            full = find_commit(graph, sha)
            if full:
                graph.edge(ident, "completes", full)


def linear_key() -> str:
    # Knowledge Services: the environment only; the owner-managed `.env` is never read here.
    return os.environ.get("LINEAR_API_KEY", "")


ISSUES_QUERY = """
query($after: String) {
  issues(first: 100, after: $after, filter: {team: {key: {eq: "%s"}}}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier title url description createdAt completedAt
      state { name type } parent { identifier } comments(first: 50) { nodes { body } }
    }
  }
}
"""


def linear_pull() -> int:
    key = linear_key()
    if not key:
        print(
            "trace: no LINEAR_API_KEY in the environment; set it, or have the agent "
            f"write {TRACE_DIR.as_posix()}/linear-snapshot.json from the Linear MCP (SPEC-02 §4)",
            file=sys.stderr,
        )
        return 4
    issues: list[dict[str, Any]] = []
    after: str | None = None
    while True:
        payload = json.dumps({"query": ISSUES_QUERY % LINEAR_TEAM, "variables": {"after": after}})
        request = urllib.request.Request(
            LINEAR_URL,
            data=payload.encode("utf-8"),
            headers={"Authorization": key, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError) as error:
            print(f"trace: Linear unreachable: {error.__class__.__name__}", file=sys.stderr)
            return 4
        if data.get("errors"):
            print(
                f"trace: Linear refused the query: {data['errors'][0].get('message')}",
                file=sys.stderr,
            )
            return 4
        page = data["data"]["issues"]
        for node in page["nodes"]:
            issues.append(
                {
                    "identifier": node["identifier"],
                    "title": node["title"],
                    "url": node["url"],
                    "description": node.get("description") or "",
                    "created_at": node["createdAt"],
                    "completed_at": node.get("completedAt"),
                    "state": node["state"]["name"],
                    "state_type": node["state"]["type"],
                    "parent": (node.get("parent") or {}).get("identifier"),
                    "comments": [c["body"] for c in node["comments"]["nodes"]],
                }
            )
        if not page["pageInfo"]["hasNextPage"]:
            break
        after = page["pageInfo"]["endCursor"]
    write_snapshot(issues, source="linear-graphql", complete=True)
    print(json.dumps({"issues": len(issues), "snapshot": snapshot_path().as_posix()}))
    return 0


def write_snapshot(issues: list[dict[str, Any]], source: str, complete: bool) -> None:
    trace_dir().mkdir(parents=True, exist_ok=True)
    snapshot_path().write_text(
        json.dumps(
            {
                "fetched_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
                "source": source,
                "team": LINEAR_TEAM,
                "complete": complete,
                "issues": issues,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


# ------------------------------------------------------------------------------------- build


def load(revision: str = "HEAD") -> Graph:
    graph = Graph()
    collect_markdown(graph)
    collect_external(graph)
    collect_commits(graph, revision)
    collect_linear(graph)
    return graph


def reaches_issue(graph: Graph, sha: str) -> bool:
    """True when a commit's chain reaches an issue: directly, or through a cited record."""

    seen: set[str] = set()
    queue = deque([sha])
    while queue:
        current = queue.popleft()
        if current in seen:
            continue
        seen.add(current)
        if graph.nodes.get(current, {}).get("kind") == "issue":
            return True
        for src, kind, dst in graph.edges:
            if src == current and kind in ("implements", "decides", "becomes"):
                queue.append(dst)
            if dst == current and kind == "asked_in":
                queue.append(src)  # a cited session reaches the issues its decisions became
    return False


def summary(graph: Graph, problems: list[str]) -> dict[str, Any]:
    kinds: dict[str, int] = defaultdict(int)
    for node in graph.nodes.values():
        if not node.get("stub"):
            kinds[node["kind"]] += 1
    recent = [i for i, n in graph.nodes.items() if n["kind"] == "commit" and n["since_cutover"]]
    return {
        "nodes": dict(sorted(kinds.items())),
        "edges": len(graph.edges),
        "commits_since_cutover": len(recent),
        "with_refs": sum(
            1 for i in recent if graph.nodes[i]["refs"] or graph.nodes[i]["refs_none"]
        ),
        "reaching_an_issue": sum(1 for i in recent if reaches_issue(graph, i)),
        "legacy_commits": sum(
            1 for n in graph.nodes.values() if n["kind"] == "commit" and not n["since_cutover"]
        ),
        "snapshot": None
        if not graph.snapshot
        else {
            "fetched_at": graph.snapshot.get("fetched_at"),
            "complete": graph.snapshot.get("complete"),
            "issues": len(graph.snapshot.get("issues", [])),
        },
        "problems": len(problems),
    }


def build() -> int:
    graph = load()
    problems = check_all(graph, None)
    out = trace_dir()
    out.mkdir(parents=True, exist_ok=True)
    stats = summary(graph, problems)
    (out / "trace.json").write_text(
        json.dumps(
            {
                "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
                "repo": REPO_KEY,
                "cutover": CUTOVER,
                "summary": stats,
                "nodes": graph.nodes,
                "edges": [{"from": a, "kind": k, "to": b} for a, k, b in graph.edges],
            },
            indent=2,
            ensure_ascii=False,
            default=str,
        ),
        encoding="utf-8",
    )
    (out / "COVERAGE.md").write_text(coverage(stats, problems), encoding="utf-8")
    print(
        json.dumps(
            {
                **stats,
                "written": [
                    f"{TRACE_DIR.as_posix()}/trace.json",
                    f"{TRACE_DIR.as_posix()}/COVERAGE.md",
                ],
            }
        )
    )
    return 0


def coverage(stats: dict[str, Any], problems: list[str]) -> str:
    snap = stats["snapshot"]
    snap_line = (
        "none"
        if not snap
        else f"{snap['issues']} issues, fetched {snap['fetched_at']}, complete={snap['complete']}"
    )
    rows = [
        ("Sessions", stats["nodes"].get("session", 0)),
        ("Decisions", stats["nodes"].get("decision", 0)),
        ("Specs (frontmatter decisions/linear)", stats["nodes"].get("spec", 0)),
        ("Issues in the snapshot", stats["nodes"].get("issue", 0)),
        (f"Commits since the cutover ({CUTOVER})", stats["commits_since_cutover"]),
        ("… with Refs", stats["with_refs"]),
        ("… whose chain reaches an issue", stats["reaching_an_issue"]),
        ("Legacy commits (before the cutover, never flagged)", stats["legacy_commits"]),
    ]
    lines = [
        "# Provenance coverage",
        "",
        f"Generated {dt.datetime.now(dt.UTC).isoformat(timespec='seconds')} by "
        "`docs/tools/trace.py build` (SPEC-02, copied per SPEC-03 K1). Not committed.",
        "",
        f"Linear snapshot: {snap_line}",
        "",
        "| Measure | Count |",
        "| --- | ---: |",
        *(f"| {name} | {count} |" for name, count in rows),
        "",
        f"## Gaps ({len(problems)})",
        "",
        *(f"- {p}" for p in problems),
        "",
    ]
    return "\n".join(lines)


# ------------------------------------------------------------------------------------- check


def check_refs(graph: Graph, where: str, info: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if not (info["refs"] or info["refs_none"] or info["refs_unnamed"]):
        problems.append(
            f"{where}: no Refs: trailer (fix: end the message with `Refs: OVE-n` or a session "
            "id such as `Refs: AS-S3`; a chore says `Refs: none <reason>`)"
        )
    for value in info["refs_unnamed"]:
        problems.append(
            f"{where}: `Refs: {value}` names no id (ids look like OVE-225, AS-S3, AS-D40)"
        )
    for ident in [*info["refs"], *info["decisions"]]:
        if not graph.resolves(ident):
            problems.append(f"{where}: {ident} does not resolve ({resolve_hint(ident)})")
    return problems


def resolve_hint(ident: str) -> str:
    kind = kind_of(ident)
    if kind == "issue":
        return "not in the Linear snapshot; `./dev trace linear pull` refreshes it"
    if kind == "session":
        return "no answers file here or in a sibling record source has this `id:`; `trace sources`"
    if kind == "decision":
        return "no answers or decision table here or in a sibling record source has this row"
    if kind == "adr":
        return f"no {ADR_DIR}NNNN-*.md file (Knowledge Services ADRs only)"
    return "unknown id"


def goal_resolves(graph: Graph, value: str) -> bool:
    anchor = value.split("#", 1)[1] if "#" in value else value
    return anchor in graph.goal_anchors or OTHER_REPO_GOALS.match(anchor) is not None


def check_all(graph: Graph, revision_range: str | None) -> list[str]:
    problems: list[str] = []
    in_range: set[str] | None = None
    cited = {d for s, _, d in graph.edges if graph.nodes.get(s, {}).get("kind") != "issue"}
    if revision_range:
        in_range = set(git("rev-list", revision_range).split())
    for ident, node in graph.nodes.items():
        kind = node["kind"]
        if kind == "commit":
            # Legacy commits (before the cutover) are counted, never flagged, in a range too.
            if not node["since_cutover"] or (in_range is not None and ident not in in_range):
                continue
            if node["subject"].startswith("Merge "):
                continue
            problems += check_refs(graph, f"commit {node['short']} ({node['subject'][:60]})", node)
        if revision_range:
            continue
        if kind == "session" and not node.get("stub") and str(node.get("date", "")) >= CUTOVER:
            for field, ok in (
                ("id", node.get("has_id")),
                ("family", node.get("family") not in ("", "unassigned")),
                ("harness_session", node.get("harness_session") not in ("", "unrecorded")),
            ):
                if not ok:
                    problems.append(f"session {node['path']}: front matter `{field}` is missing")
        if kind == "decision" and graph.snapshot and graph.snapshot.get("complete"):
            for target in ANY_ID.findall(str(node.get("becomes", ""))):
                if kind_of(target) == "issue" and not graph.resolves(target):
                    problems.append(f"decision {ident}: Becomes {target}, which is not in Linear")
        # Knowledge Services: the OVE snapshot is shared by every repository; only the issues this
        # repository's commits or records cite are checked here.
        if kind == "issue" and not node.get("stub") and ident in cited:
            if str(node.get("created_at", ""))[:10] >= CUTOVER:
                goals = node.get("goal", [])
                if not goals:
                    problems.append(
                        f"issue {ident}: no `Goal:` line (fix: first line "
                        "`Goal: platform/mission-control/goals#<anchor>`)"
                    )
                for value in goals if graph.goals_known else []:
                    if not goal_resolves(graph, value):
                        problems.append(f"issue {ident}: Goal {value} names no goals.md anchor")
                targets = [d for s, k, d in graph.edges if s == ident and k == "provenance"]
                if not any(graph.resolves(t) for t in targets):
                    problems.append(
                        f"issue {ident}: no resolvable `## Provenance` key "
                        "(Session, Decisions, Spec, ADR)"
                    )
            if (
                str(node.get("completed_at", ""))[:10] >= CUTOVER
                and node.get("state_type") == "completed"
            ):
                completion = node.get("completion", {})
                if not completion.get("Commits") or not completion.get("Level"):
                    problems.append(
                        f"issue {ident}: completed without a `## Completion` comment "
                        "carrying Commits and Level"
                    )
                elif completion["Level"].split()[0].lower() not in LEVELS:
                    problems.append(
                        f"issue {ident}: Completion Level must be one of {', '.join(LEVELS)}"
                    )
    return problems


def message_problems(graph: Graph, text: str) -> list[str]:
    text = text.split("# ------------------------ >8 ------------------------", 1)[0]
    message = "\n".join(line for line in text.split("\n") if not line.startswith("#")).strip()
    if not message or message.startswith(("Merge ", "fixup!", "squash!", "amend!")):
        return []
    subject = message.split("\n", 1)[0]
    return check_refs(graph, "this commit", commit_refs(subject, parse_trailers(message)))


def report(problems: list[str], mode: str, notes: list[str] | None = None) -> int:
    for note in notes or []:
        print(f"trace [note]: {note}", file=sys.stderr)
    for problem in problems:
        print(f"trace [{mode}]: {problem}", file=sys.stderr)
    if problems and mode == "warn":
        print(
            f"trace [warn]: {len(problems)} provenance gap(s); warn-only until "
            "SDLC_TRACE=block (SPEC-02 §5)",
            file=sys.stderr,
        )
    return 1 if problems and mode == "block" else 0


# -------------------------------------------------------------------------------------- show


def resolve_start(graph: Graph, ident: str) -> str | None:
    if ident in graph.nodes and not graph.nodes[ident].get("stub"):
        return ident
    if SHA.match(ident):
        return find_commit(graph, ident)
    candidate = (Path.cwd() / ident) if not Path(ident).is_absolute() else Path(ident)
    if candidate.is_file():
        try:
            path_rel = rel(candidate)
        except ValueError:
            return None
        return path_rel if path_rel in graph.nodes else None
    return ident if ident in graph.nodes else None


def follows(graph: Graph, current: str, edge_kind: str, outgoing: bool) -> bool:
    """Which edges a record reached mid-walk may follow, so a long-lived record (a parent issue,
    a sitting with forty decisions, an ADR) is shown without pulling in its whole history."""

    kind = graph.nodes[current]["kind"]
    if kind == "issue":
        return (outgoing and edge_kind in ("provenance", "completes", "child_of")) or (
            not outgoing and edge_kind == "implements"
        )
    if kind == "decision":
        return outgoing or edge_kind == "decides"
    if kind == "commit":
        return outgoing
    return False  # sessions, specs, ideas, ADRs and documents are leaves mid-walk


def neighbourhood(graph: Graph, start: str, depth: int = 5) -> set[str]:
    seen = {start}
    frontier = deque([(start, 0, True)])
    while frontier:
        current, level, expand = frontier.popleft()
        if level >= depth or not expand or graph.nodes[current].get("stub"):
            continue
        for src, kind, dst in graph.edges:
            if src == current:
                nxt, outgoing = dst, True
            elif dst == current:
                nxt, outgoing = src, False
            else:
                continue
            if current != start and not follows(graph, current, kind, outgoing):
                continue
            if nxt not in seen:
                seen.add(nxt)
                # A parent or a tracked issue reached on the way is shown, not walked.
                weak = kind in WEAK_EDGES and current != start
                frontier.append((nxt, level + 1, not weak))
    return seen


def describe(ident: str, node: dict[str, Any]) -> list[str]:
    kind = node["kind"]
    if node.get("stub"):
        return [f"{ident}  (cited; no record in this repository, see `trace sources`)"]
    if kind == "session":
        return [
            f"{ident}  {node.get('title', '')}  [{node.get('date', '')}, {node.get('status', '')}]",
            f"    {node.get('path', '')}  harness {node.get('harness_session') or 'unrecorded'}",
        ]
    if kind == "decision":
        if node.get("table_only"):
            return [f"{ident}  (decision table in {node.get('path')})"]
        answer = node.get("answer", "")
        answer = answer if len(answer) <= 160 else answer[:157] + "..."
        return [
            f"{ident}  {node.get('question', '')}",
            f"    owner: {answer}",
            f"    becomes: {node.get('becomes', '')}",
        ]
    if kind == "issue":
        lines = [f"{ident}  [{node.get('state', 'not in snapshot')}]  {node.get('title', '')}"]
        if node.get("goal"):
            lines.append(f"    goal: {', '.join(node['goal'])}")
        completion = node.get("completion") or {}
        if completion:
            lines.append(
                "    completion: "
                + "; ".join(f"{k} {completion[k]}" for k in COMPLETION_KEYS if k in completion)
            )
        if node.get("url"):
            lines.append(f"    {node['url']}")
        return lines
    if kind == "commit":
        refs = ", ".join(node.get("refs", [])) or (
            f"none {node['refs_none']}" if node.get("refs_none") else "-"
        )
        return [f"{node['short']}  {node['date'][:10]}  {node['subject']}", f"    refs: {refs}"]
    title = node.get("title", "")
    status = f"  [{node['status']}]" if node.get("status") else ""
    return [f"{ident}  {title}{status}"]


def show(ident: str, as_json: bool) -> int:
    graph = load()
    start = resolve_start(graph, ident)
    if start is None:
        print(
            f"trace: no record named {ident!r} (ids look like OVE-225, AS-S3, AS-D40, ADR-0064, "
            "ID-1, a commit SHA or a repository path; issues need a Linear snapshot)",
            file=sys.stderr,
        )
        return 3
    members = neighbourhood(graph, start)
    if as_json:
        print(
            json.dumps(
                {
                    "start": start,
                    "nodes": {i: graph.nodes[i] for i in members},
                    "edges": [
                        {"from": a, "kind": k, "to": b}
                        for a, k, b in graph.edges
                        if a in members and b in members
                    ],
                },
                indent=2,
                ensure_ascii=False,
                default=str,
            )
        )
        return 0
    labels = {
        "idea": "Idea",
        "session": "Interview",
        "decision": "Decisions",
        "spec": "Spec",
        "adr": "ADRs",
        "issue": "Issues",
        "commit": "Commits",
        "doc": "Folded into",
    }
    print(f"Chain around {start}")
    for kind in CHAIN_ORDER:
        group = sorted(
            (i for i in members if graph.nodes[i]["kind"] == kind),
            key=lambda i: (
                str(graph.nodes[i].get("date", "")),
                [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", i)],
            ),
        )
        if not group:
            continue
        print(f"\n{labels[kind]}")
        for member in group:
            for line in describe(member, graph.nodes[member]):
                print(f"  {line}")
    if not graph.snapshot:
        print(
            "\n(no Linear snapshot: issue state and completion are not shown; "
            "`./dev trace linear pull`)"
        )
    return 0


# -------------------------------------------------------------------------------------- main


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    parser = argparse.ArgumentParser(
        prog="trace", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_show = sub.add_parser("show", help="print the chain around an id")
    p_show.add_argument("id")
    p_show.add_argument("--json", action="store_true")
    sub.add_parser("build", help="write .sdlc/trace/trace.json and COVERAGE.md")
    p_check = sub.add_parser("check", help="report provenance gaps")
    group = p_check.add_mutually_exclusive_group()
    group.add_argument(
        "--message-file", type=Path, help="check one commit message (commit-msg hook)"
    )
    group.add_argument(
        "--range",
        dest="revision_range",
        help="check the commits of a range, e.g. origin/main..HEAD",
    )
    p_check.add_argument("--mode", choices=("warn", "block"), default=None)
    p_linear = sub.add_parser("linear", help="the Linear snapshot")
    p_linear.add_argument("action", choices=("pull",))
    sub.add_parser("sources", help="the external record sources and whether they are present")
    args = parser.parse_args()

    if args.command == "show":
        return show(args.id, args.json)
    if args.command == "build":
        return build()
    if args.command == "linear":
        return linear_pull()
    if args.command == "sources":
        return sources()
    mode = args.mode or os.environ.get("SDLC_TRACE", "warn")
    if mode not in ("warn", "block"):
        print(f"trace: SDLC_TRACE={mode!r} must be warn or block", file=sys.stderr)
        return 2
    graph = load()
    if args.message_file:
        if not args.message_file.is_file():
            print(f"trace: {args.message_file} does not exist", file=sys.stderr)
            return 2
        return report(
            message_problems(
                graph, args.message_file.read_text(encoding="utf-8", errors="replace")
            ),
            mode,
            graph.notes,
        )
    problems = check_all(graph, args.revision_range)
    code = report(problems, mode, graph.notes)
    print(json.dumps(summary(graph, problems)))
    return code


if __name__ == "__main__":
    sys.exit(main())
