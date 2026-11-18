#!/usr/bin/env python3
"""./dev: one front door for a coding agent working on Knowledge Services.

Not the service CLIs: ``knowledge``, ``knowledge-verify``, ``ks`` and ``jev`` stay the product
surfaces (features/README.md). ``./dev`` wraps what exists (the pnpm scripts, the .agent-docs
checker, the retrieval checks, docs/tools/trace.py) behind one grammar copied from Mission
Control's ``scripts/dev/dev_cli.py`` (SPEC-03 K2): every input is a flag, ``--help`` everywhere,
JSON on stdout where a result is data, typed exit codes, and an error names the fix. Standard
library only, so ``./dev status`` and ``./dev doctor`` work before ``pnpm install``.

  ./dev status                          orient in one call (JSON): branch, ahead/behind, dirty
                                        files, contract pin, hooks, which local services answer
  ./dev doctor                          read-only readiness (JSON); each failure prints its fix
  ./dev check [--full]                  the fast gate (each step named below), or --full: what CI
                                        runs (pnpm verify + maintenance tests + the fast gate)
  ./dev test TARGET [FILE..]            one package's vitest files (TARGET = package directory
                                        name or @aiengineer/* name), or maintenance | context | trace
  ./dev trace show|build|check|linear|sources   the provenance chain (docs/tools/trace.py)
  ./dev planes list|show P|check        the data-plane registry config/planes.toml (no network)
  ./dev db status|schema|query --plane P   read-only database sessions (scripts/dev/planes.py,
                                        copied from Mission Control); --plane is always required

Fast gate (``./dev check``), in order: format (biome format ., EOL-only differences re-checked
the way the pre-commit hook does), lint (tools/quality/lint-ratchet.mjs), boundaries
(dependency-cruiser), docs (.agent-docs check), retrieval (.agent-docs/retrieval.test.mjs plus
the retrieval benchmark on the live knowledge bundle), trace (docs/tools tests and a warn-only
trace check). Not in the fast gate: typecheck, the vitest suites, build, the verification
examples and the maintenance tests (minutes, not seconds); ``--full`` runs them.

Exit codes: 0 ok, 1 a check or test failed, 2 usage error, 3 the environment is not ready.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
TRACE = ROOT / "docs" / "tools" / "trace.py"
DOCS_CLI = ROOT / ".agent-docs" / "cli.mjs"
MAINTENANCE_CLI = ROOT / "tools" / "maintenance" / "cli.mjs"
ENTRYPOINTS = [
    "AGENTS.md",
    "features/README.md",
    "docs/ENVIRONMENT.md",
    "../mission-control/docs/specs/agentic-sdlc-2026-11/SPEC-03-REPO-KIT.md",
]
# Local services an agent might expect (name, port). Probed on 127.0.0.1 only, never a remote host.
SERVICES = [
    ("api or mcp (PORT, default 4100)", 4100),
    ("verification executor (knowledge-verify serve, VERIFY_PORT 4310)", 4310),
    ("jev (JEV_PORT 4318)", 4318),
    ("postgres 5432 (CI and the verify workflow)", 5432),
    ("postgres 55433 (sprint-v-pg17 disposable container)", 55433),
    ("supabase local db 54322", 54322),
    ("supabase local api 54321", 54321),
]
DB_VARIABLE = re.compile(r"^KS_(AIENG|BIOTECH)_DB_(URL|ADMIN_DSN|RUNTIME_DSN|COMPONENT_DSN)$")
LOOPBACK = re.compile(r"^(?:|localhost|.+\.localhost|::1|127(?:\.\d{1,3}){3})$")
SPECIAL_TESTS = {
    "maintenance": [
        ["node", "--test", "tools/maintenance/*.test.mjs", ".github/maintenance/*.test.mjs"]
    ],
    "context": [["node", "--test", ".agent-docs/retrieval.test.mjs"]],
    "trace": [
        [sys.executable, "-X", "utf8", "-m", "unittest", "discover", "-s", "docs/tools", "-p",
         "test_*.py"]
    ],
}  # fmt: skip


def git(*args: str) -> str:
    done = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return done.stdout.strip() if done.returncode == 0 else ""


def emit(data: object) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def fail(message: str, fix: str, code: int = 2) -> int:
    print(f"dev: {message}\n  fix: {fix}", file=sys.stderr)
    return code


def pnpm() -> list[str] | None:
    if shutil.which("corepack"):
        return [shutil.which("corepack") or "corepack", "pnpm"]
    if shutil.which("pnpm"):
        return [shutil.which("pnpm") or "pnpm"]
    return None


def node() -> str | None:
    return shutil.which("node")


def run(command: list[str], label: str | None = None) -> int:
    print(f"$ {' '.join(command)}" + (f"   # {label}" if label else ""), file=sys.stderr, flush=True)
    expanded: list[str] = []
    for part in command:  # expand test globs the way a POSIX shell would (Windows has none)
        if "*" in part and not part.startswith("-"):
            expanded += sorted(p.relative_to(ROOT).as_posix() for p in ROOT.glob(part)) or [part]
        else:
            expanded.append(part)
    return subprocess.run(expanded, cwd=ROOT, check=False).returncode


# ------------------------------------------------------------------------------------- status


def hooks_path() -> Path | None:
    configured = git("config", "--get", "core.hooksPath")
    if not configured:
        return None
    path = Path(configured)
    return path if path.is_absolute() else ROOT / path


def contract_pin() -> dict[str, object]:
    tarballs = sorted(p.name for p in (ROOT / "vendor").glob("aiengineer-database-contract-*.tgz"))
    pins: dict[str, str] = {}
    for manifest in sorted(ROOT.glob("*/*/package.json")) + sorted(ROOT.glob("*/*/*/package.json")):
        if "node_modules" in manifest.parts:
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for group in ("dependencies", "devDependencies"):
            spec = (data.get(group) or {}).get("@aiengineer/database-contract")
            if spec:
                pins[manifest.parent.relative_to(ROOT).as_posix()] = spec
    versions = sorted({m.group(1) for s in pins.values() if (m := re.search(r"-(\d+\.\d+\.\d+)\.tgz", s))})
    return {
        "package": "@aiengineer/database-contract",
        "vendored": tarballs,
        "versions_pinned": versions,
        "consistent": len(versions) == 1 and any(versions[0] in t for t in tarballs),
        "pinned_by": sorted(pins),
    }


def answers(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


def status() -> int:
    upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    ahead = behind = None
    if upstream:
        counts = git("rev-list", "--left-right", "--count", f"{upstream}...HEAD").split()
        if len(counts) == 2:
            behind, ahead = int(counts[0]), int(counts[1])
    porcelain = [line for line in git("status", "--porcelain").splitlines() if line]
    hooks = hooks_path()
    commit_msg = bool(hooks and (hooks / "commit-msg").is_file())
    snapshot = ROOT / ".sdlc" / "trace" / "linear-snapshot.json"
    fetched = None
    if snapshot.is_file():
        try:
            fetched = json.loads(snapshot.read_text(encoding="utf-8")).get("fetched_at")
        except (OSError, json.JSONDecodeError):
            fetched = "unreadable"
    pin = contract_pin()
    hints = []
    if ahead:
        hints.append(f"{ahead} commit(s) not pushed to {upstream}")
    if not commit_msg:
        hints.append("the commit-msg hook is missing: `node tools/maintenance/cli.mjs install-hooks`")
    if not pin["consistent"]:
        hints.append("the database-contract pin is not one vendored version; see features/README.md")
    if fetched is None:
        hints.append("no Linear snapshot: `./dev trace linear pull` (LINEAR_API_KEY in the environment)")
    emit(
        {
            "repo": "knowledge-services",
            "branch": git("branch", "--show-current"),
            "head": git("log", "-1", "--format=%h %s"),
            "upstream": upstream or None,
            "ahead": ahead,
            "behind": behind,
            "dirty": [line[3:] for line in porcelain if not line.startswith("??")],
            "untracked": [line[3:] for line in porcelain if line.startswith("??")],
            "contract": pin,
            "hooks": {
                "core.hooksPath": str(hooks) if hooks else None,
                "commit-msg": commit_msg,
                "pre-commit": bool(hooks and (hooks / "pre-commit").is_file()),
            },
            "local_services": {name: answers(port) for name, port in SERVICES},
            "application": "KS_APPLICATION set (remote plane allowed)"
            if os.environ.get("KS_APPLICATION", "").strip()
            else "unset: loopback only (local by default)",
            "trace": {"snapshot_fetched_at": fetched},
            "entrypoints": ENTRYPOINTS,
            "hints": hints,
        }
    )
    return 0


# ------------------------------------------------------------------------------------- doctor


def version_of(command: list[str]) -> str:
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return (done.stdout or done.stderr).strip().splitlines()[0] if done.returncode == 0 else ""


def env_posture() -> dict[str, str]:
    """Names of the database variables set in this shell and whether each is loopback or remote.
    Never prints a value."""

    out: dict[str, str] = {}
    for name in sorted(os.environ):
        if not DB_VARIABLE.match(name) or not os.environ[name].strip():
            continue
        try:
            host = (urlsplit(os.environ[name].strip()).hostname or "").lower()
        except ValueError:
            out[name] = "unparseable"
            continue
        out[name] = "loopback" if LOOPBACK.match(host) else "remote"
    return out


def doctor() -> int:
    checks: list[dict[str, object]] = []

    def record(name: str, ok: bool, detail: str, fix: str, required: bool = True) -> None:
        checks.append(
            {"name": name, "ok": ok, "required": required, "detail": detail, "fix": None if ok else fix}
        )

    node_version = version_of(["node", "--version"]) if node() else ""
    major = int(node_version.lstrip("v").split(".")[0]) if node_version[1:2].isdigit() else 0
    record("node", major >= 24, node_version or "not on PATH", "install Node 24 (package.json engines)")
    record("git", bool(shutil.which("git")), shutil.which("git") or "not on PATH", "install Git")
    manager = pnpm()
    record(
        "pnpm",
        manager is not None,
        " ".join(manager) if manager else "neither corepack nor pnpm on PATH",
        "enable corepack (`corepack enable`); packageManager pins pnpm 10.34.5",
    )
    record(
        "python",
        sys.version_info >= (3, 12),
        sys.version.split()[0],
        "use Python 3.12 or newer (the trace tool and ./dev)",
    )
    modules = ROOT / "node_modules"
    record(
        "node_modules",
        modules.is_dir(),
        "present" if modules.is_dir() else "absent",
        "corepack pnpm install --frozen-lockfile",
    )
    dist = ROOT / "packages" / "host" / "dist"
    record(
        "built dist",
        dist.is_dir(),
        "packages/host/dist present" if dist.is_dir() else "absent",
        "corepack pnpm build (package exports point at dist; tests need ^build)",
    )
    hooks = hooks_path()
    for hook in ("pre-commit", "commit-msg"):
        present = bool(hooks and (hooks / hook).is_file())
        record(
            f"hook {hook}",
            present,
            str(hooks / hook) if hooks else "core.hooksPath unset",
            "node tools/maintenance/cli.mjs install-hooks",
        )
    env_file = ROOT / ".env"
    record(
        ".env",
        True,
        "present (owner-managed; values not read)" if env_file.is_file() else "absent (fine: local by default)",
        "",
        required=False,
    )
    posture = env_posture()
    application = os.environ.get("KS_APPLICATION", "").strip()
    remote = [name for name, kind in posture.items() if kind == "remote"]
    record(
        "database posture",
        not remote or bool(application),
        json.dumps({"KS_APPLICATION": application or None, "variables": posture}),
        f"{', '.join(remote)} point at a remote host and KS_APPLICATION is unset: processes will refuse "
        "them (KS_DB_REMOTE_REQUIRES_APPLICATION). Unset them or use loopback values; set "
        "KS_APPLICATION only for a process meant to reach that plane",
        required=False,
    )
    docker = shutil.which("docker")
    record(
        "docker",
        docker is not None,
        docker or "not on PATH",
        "install Docker Desktop; only the disposable PostgreSQL integration suites need it",
        required=False,
    )
    failed = [c for c in checks if not c["ok"] and c["required"]]
    emit({"ok": not failed, "checks": checks})
    return 3 if failed else 0


# ---------------------------------------------------------------------------- check and test


def format_step(manager: list[str]) -> int:
    """biome format . ; on Windows a checkout mixes CRLF and LF working copies, so a file the
    formatter flags is re-checked through stdin with line endings normalized (the pre-commit rule)."""

    command = [*manager, "exec", "biome", "format", "."]
    print(f"$ {' '.join(command)}   # format", file=sys.stderr, flush=True)
    done = subprocess.run(
        command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if done.returncode == 0:
        return 0
    flagged = sorted(
        set(re.findall(r"^(\S+\.(?:ts|tsx|mts|cts|js|mjs|cjs)) format ", done.stdout + done.stderr, re.M))
    )
    if not flagged:
        print(done.stdout[-4000:] + done.stderr[-2000:], file=sys.stderr)
        return 1
    real: list[str] = []
    for path in flagged:
        source = (ROOT / path).read_bytes().decode("utf-8")
        formatted = subprocess.run(
            [*manager, "exec", "biome", "format", f"--stdin-file-path={path}"],
            cwd=ROOT,
            input=source,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout
        if formatted.replace("\r\n", "\n") != source.replace("\r\n", "\n"):
            real.append(path)
    if real:
        print("dev: needs formatting (`corepack pnpm exec biome format --write <path>`):", file=sys.stderr)
        for path in real:
            print(f"  {path}", file=sys.stderr)
        return 1
    print(f"dev: format ok ({len(flagged)} file(s) differ only in line endings)", file=sys.stderr)
    return 0


def retrieval_step() -> int:
    code = run(["node", "--test", ".agent-docs/retrieval.test.mjs"], "retrieval ranking tests")
    done = subprocess.run(
        ["node", ".agent-docs/retrieval-benchmark.mjs", "--repo", "."],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if done.returncode != 0:
        print(done.stderr[-2000:], file=sys.stderr)
        return 1
    report = json.loads(done.stdout)
    summary = {}
    critical: list[str] = []
    for partition in ("screening", "heldout"):
        current = report["current"][partition]
        summary[partition] = {
            "recall_at_3": round(current["recallAt3"], 3),
            "mrr": round(current["mrr"], 3),
            "abstentions": f"{current['correctAbstentions']}/{current['negativeCount']}",
        }
        critical += current["criticalFailures"]
    print(
        f"dev: retrieval on the live knowledge bundle: {json.dumps(summary)}; "
        f"critical failures: {critical or 'none'}",
        file=sys.stderr,
    )
    return code or (1 if critical else 0)


def fast_gate() -> int:
    manager = pnpm()
    if manager is None or not node():
        return fail("node or pnpm is not on PATH", "run `./dev doctor`", 3)
    if not (ROOT / "node_modules").is_dir():
        return fail("dependencies are not installed", "corepack pnpm install --frozen-lockfile", 3)
    results: dict[str, int] = {}
    started = time.monotonic()
    results["format"] = format_step(manager)
    results["lint"] = run([*manager, "lint"], "lint ratchet")
    results["boundaries"] = run([*manager, "boundaries"], "dependency-cruiser")
    results["docs"] = run(["node", str(DOCS_CLI.relative_to(ROOT)), "check", "--repo", "."], "docs")
    results["retrieval"] = retrieval_step()
    results["planes"] = run([sys.executable, "-X", "utf8", str(PLANES), "planes", "check"], "data-plane registry")
    results["trace"] = run(SPECIAL_TESTS["trace"][0], "trace tests") or run(
        [sys.executable, "-X", "utf8", str(TRACE), "check"], "provenance, warn-only"
    )
    print(
        json.dumps(
            {
                "gate": "fast",
                "seconds": round(time.monotonic() - started, 1),
                "steps": {k: "passed" if v == 0 else "failed" for k, v in results.items()},
                "not_run": ["typecheck", "vitest suites", "build", "examples:verification", "maintenance tests"],
            }
        )
    )
    return 1 if any(results.values()) else 0


def check(full: bool) -> int:
    code = fast_gate()
    if not full or code == 3:
        return code
    manager = pnpm() or ["pnpm"]
    full_code = run([*manager, "verify"], "pnpm verify (format, lint, typecheck, test, build, boundaries, examples)")
    maintenance = run(SPECIAL_TESTS["maintenance"][0], "maintenance tests")
    upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    trace_code = run(
        [sys.executable, "-X", "utf8", str(TRACE), "check", "--range", f"{upstream}..HEAD" if upstream else "HEAD~1..HEAD"],
        "provenance of unpushed commits, warn-only",
    )
    return 1 if (code or full_code or maintenance or trace_code) else 0


def packages() -> dict[str, str]:
    found: dict[str, str] = {}
    for manifest in sorted(ROOT.glob("apps/*/package.json")) + sorted(ROOT.glob("packages/**/package.json")):
        if "node_modules" in manifest.parts or "dist" in manifest.parts:
            continue
        try:
            name = json.loads(manifest.read_text(encoding="utf-8")).get("name")
        except (OSError, json.JSONDecodeError):
            continue
        if name:
            found[name] = manifest.parent.relative_to(ROOT).as_posix()
    return found


def test(target: str, files: list[str]) -> int:
    if target in SPECIAL_TESTS:
        return 1 if any(run(command, target) for command in SPECIAL_TESTS[target]) else 0
    manager = pnpm()
    if manager is None:
        return fail("pnpm is not on PATH", "run `./dev doctor`", 3)
    known = packages()
    matches = [n for n, d in known.items() if target in (n, d, d.rsplit("/", 1)[-1])]
    if len(matches) != 1:
        choices = ", ".join(sorted({d.rsplit("/", 1)[-1] for d in known.values()}))
        return fail(
            f"{target!r} names {'no' if not matches else 'more than one'} package",
            f"use a package directory name ({choices}), a path when two share a name "
            "(apps/jev, packages/jev), an @aiengineer/* name, or maintenance | context | trace",
        )
    name = matches[0]
    command = [*manager, "--filter", name, "exec", "vitest", "run", *files]
    print(
        f"dev: package files are relative to {known[name]}; tests import built dist (`corepack pnpm build` first)",
        file=sys.stderr,
    )
    return 1 if run(command, name) else 0


def trace(args: list[str]) -> int:
    if not args:
        args = ["--help"]
    return subprocess.run([sys.executable, "-X", "utf8", str(TRACE), *args], cwd=ROOT, check=False).returncode


PLANES = ROOT / "scripts" / "dev" / "planes.py"


def planes(group: str, args: list[str]) -> int:
    """`planes` runs here (standard library); `db` needs psycopg, so it runs through
    `uv run --with psycopg[binary]` unless this interpreter has it. Credentials resolve inside
    planes.py, never here."""

    command = [sys.executable, "-X", "utf8", str(PLANES), group, *args]
    if group == "db":
        try:
            import psycopg  # noqa: F401
        except ImportError:
            if not shutil.which("uv"):
                return fail("`./dev db` needs psycopg", "install uv (it supplies psycopg per run)", 3)
            command = [
                "uv", "run", "--no-project", "--quiet", "--with", "psycopg[binary]",
                "python", "-X", "utf8", str(PLANES), group, *args,
            ]  # fmt: skip
    return subprocess.run(command, cwd=ROOT, check=False).returncode


# --------------------------------------------------------------------------------------- main


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    parser = argparse.ArgumentParser(
        prog="./dev", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    sub.add_parser("status", help="orient in one call (JSON)", description="Example: ./dev status")
    sub.add_parser(
        "doctor",
        help="read-only readiness (JSON); each failure names its fix",
        description="Example: ./dev doctor",
    )
    p_check = sub.add_parser(
        "check",
        help="the fast gate, or --full for what CI runs",
        description="Examples: ./dev check   ./dev check --full",
    )
    p_check.add_argument("--full", action="store_true", help="pnpm verify + maintenance tests + trace range")
    p_test = sub.add_parser(
        "test",
        help="one package's vitest files, or maintenance | context | trace",
        description="Examples: ./dev test host src/config/database.test.ts   ./dev test trace",
    )
    p_test.add_argument("target", help="package directory name, @aiengineer/* name, maintenance, context or trace")
    p_test.add_argument("files", nargs="*", help="test files relative to the package")
    sub.add_parser(
        "trace",
        help="the provenance chain: show ID | build | check | linear pull | sources",
        description="Examples: ./dev trace show OVE-243   ./dev trace check   ./dev trace sources",
        add_help=False,
    )
    sub.add_parser("planes", help="the data-plane registry: list | show PLANE | check", add_help=False)
    sub.add_parser("db", help="read-only database sessions: status | schema | query --plane P", add_help=False)
    argv = sys.argv[1:]
    if argv and argv[0] == "trace":
        return trace(argv[1:])
    if argv and argv[0] in {"planes", "db"}:
        return planes(argv[0], argv[1:] or ["--help"])
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 2
    if args.command == "status":
        return status()
    if args.command == "doctor":
        return doctor()
    if args.command == "check":
        return check(args.full)
    return test(args.target, args.files)


if __name__ == "__main__":
    sys.exit(main())
