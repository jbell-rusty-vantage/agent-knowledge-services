#!/usr/bin/env python3
"""Data-plane access, local by default: the registry view and read-only database sessions.

The shared module of the repository kit's K3 part (SPEC-03). One registry of identities,
``config/planes.toml``, names every plane, its posture, its endpoints and the NAMES of the
variables that hold its credentials; this module never stores or prints a credential value.

  planes list                       every plane: kind, location, posture (JSON)
  planes show PLANE                 one plane; each credential name with present/absent, no value
  planes check                      registry parses, postures valid, no values, agree-checks
  db status --plane P               reachability, server, login, read-only state, migration heads
  db schema --plane P [--schema S] [--table T]   schemas, tables, columns and grants
  db query  --plane P (--sql Q | --file F) [--limit N] [--write --confirm REF] [--yes-remote]

Rules, enforced before any connection is opened:

- ``--plane`` is always required: there is no default plane and no inference from a variable.
- Every session is read-only (``default_transaction_read_only`` on and ``BEGIN READ ONLY``)
  with the registry's statement timeout. Writes need ``--write --confirm <project_ref or
  container>``, are refused on ``protected`` and ``retired`` planes, and on a remote plane also
  need ``--yes-remote``. DDL is always refused and pointed at the registry's installer.
- A retired plane is refused by every access command. A remote read uses the reader login;
  while none exists the owner to-do is printed and ``--yes-remote`` falls back to the admin
  login inside a read-only transaction.
- One statement per call; session and transaction control statements are refused.
- A local plane is reached only on loopback at its registered port; a remote login must carry
  the plane's project ref in its host or user name, and TLS is required.
- Credentials resolve by name inside this process (``<workspace>/.secrets/<file>.env``, a
  repository file, or a local container's environment via ``docker inspect``) and go to the
  driver as arguments; never to argv, stdout or a log. Every remote call appends one line to
  the registry's audit log: time, command, plane, role, mode, SQL sha256, row count, outcome.

The ``planes`` commands are standard library only. The ``db`` commands need ``psycopg``
(the repository environment: ``./dev db`` runs this file through ``uv run`` when needed).

Exit codes: 0 ok, 1 a check or query failed, 2 usage error, 3 not ready (driver, credential
or container missing), 4 refused by policy.

To adopt in another repository: copy this file and ``config/planes.toml`` (keep the planes it
reaches, set ``[registry] workspace``, ``installer`` and ``heads``), then wire ``planes`` and
``db`` into its ``./dev``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

DEFAULT_REGISTRY = Path(__file__).resolve().parents[2] / "config" / "planes.toml"

KINDS = {"postgres", "storage", "neo4j"}
LOCATIONS = {"local", "remote"}
POSTURES = {"disposable", "protected", "protected-local", "retired"}
ROLES = ("reader", "runtime", "admin")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}

EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_NOT_READY, EXIT_REFUSED = 0, 1, 2, 3, 4

# Value-shaped strings that must never appear in the registry.
VALUE_PATTERNS = {
    "a URL with an embedded password": re.compile(r"[a-z][a-z0-9+.-]*://[^\s/:@'\"]+:[^\s@'\"]+@"),
    "a Supabase access token": re.compile(r"\bsbp_[A-Za-z0-9]{8,}"),
    "a Supabase secret key": re.compile(r"\bsb_secret_[A-Za-z0-9_-]{8,}"),
    "a JWT": re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
    "a private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "a provider API key": re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
}
SECRET_KEY = re.compile(
    r"^(password|passwd|token|secret|dsn|api_?key)$|_(password|token|secret|dsn|key)$"
)
NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")

DDL = {
    "ALTER",
    "ANALYZE",
    "CLUSTER",
    "COMMENT",
    "CREATE",
    "DO",
    "DROP",
    "GRANT",
    "IMPORT",
    "REASSIGN",
    "REFRESH",
    "REINDEX",
    "REVOKE",
    "SECURITY",
    "TRUNCATE",
    "VACUUM",
}
WRITE = {"CALL", "COPY", "DELETE", "INSERT", "LOCK", "MERGE", "UPDATE"}
READ = {"EXPLAIN", "SELECT", "SHOW", "TABLE", "VALUES", "WITH"}
CONTROL = {
    "ABORT",
    "BEGIN",
    "CHECKPOINT",
    "CLOSE",
    "COMMIT",
    "DEALLOCATE",
    "DECLARE",
    "DISCARD",
    "END",
    "EXECUTE",
    "FETCH",
    "LISTEN",
    "LOAD",
    "MOVE",
    "NOTIFY",
    "PREPARE",
    "RELEASE",
    "RESET",
    "ROLLBACK",
    "SAVEPOINT",
    "SET",
    "START",
    "UNLISTEN",
}
# Functions a read must not call: they act on the server, its files or other sessions.
DENIED_FUNCTIONS = re.compile(
    r"\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_read_file|"
    r"pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink\w*|set_config|"
    r"pg_promote|pg_switch_wal|pg_create_restore_point)\s*\(",
    re.IGNORECASE,
)


# ------------------------------------------------------------------------------------ errors


class PlaneError(Exception):
    """A failure that names its fix; ``code`` is the exit code."""

    exit_code = EXIT_FAILED

    def __init__(self, reason: str, message: str, fix: str) -> None:
        super().__init__(message)
        self.reason, self.message, self.fix = reason, message, fix


class Refused(PlaneError):
    exit_code = EXIT_REFUSED


class NotReady(PlaneError):
    exit_code = EXIT_NOT_READY


class Usage(PlaneError):
    exit_code = EXIT_USAGE


# ---------------------------------------------------------------------------------- registry


@dataclass(frozen=True)
class Registry:
    path: Path
    data: dict[str, Any]

    @property
    def repo_root(self) -> Path:
        return self.path.resolve().parent.parent

    @property
    def settings(self) -> dict[str, Any]:
        return self.data.get("registry", {})

    @property
    def planes(self) -> dict[str, dict[str, Any]]:
        return self.data.get("plane", {})

    @property
    def workspace(self) -> Path:
        return (self.repo_root / self.settings.get("workspace", ".")).resolve()

    @property
    def audit_log(self) -> Path:
        return self.repo_root / self.settings.get("audit_log", ".scratch/planes/audit.jsonl")

    def plane(self, name: str) -> dict[str, Any]:
        if name not in self.planes:
            raise Usage(
                "UNKNOWN_PLANE",
                f"no plane named {name!r} in {self.path.name}",
                f"name one of: {', '.join(sorted(self.planes))} (`./dev planes list`)",
            )
        return self.planes[name]


def load(path: Path | None = None) -> Registry:
    path = path or DEFAULT_REGISTRY
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise NotReady("NO_REGISTRY", f"{path} does not exist", "add config/planes.toml") from None
    except tomllib.TOMLDecodeError as error:
        raise PlaneError(
            "REGISTRY_INVALID", f"{path.name} is not valid TOML: {error}", "fix the file"
        ) from None
    return Registry(path, data)


def value_findings(text: str, data: dict[str, Any]) -> list[str]:
    """Value-shaped strings in the registry text, and secret-named keys holding non-names."""
    found = [f"the file holds {what}" for what, rx in VALUE_PATTERNS.items() if rx.search(text)]

    def walk(node: Any, trail: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                here = f"{trail}.{key}" if trail else key
                if (
                    SECRET_KEY.search(key.lower())
                    and isinstance(value, str)
                    and not NAME.match(value)
                ):
                    found.append(f"{here} holds a value; it must name a variable")
                walk(value, here)
        elif isinstance(node, list):
            for item in node:
                walk(item, trail)

    walk(data, "")
    return found


def _dig(data: dict[str, Any], dotted: str) -> Any:
    node: Any = data
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def check(reg: Registry) -> list[str]:
    """Every problem in the registry; empty when it is sound."""
    problems = value_findings(reg.path.read_text(encoding="utf-8"), reg.data)
    if not reg.planes:
        problems.append("no [plane.*] tables")
    for name, plane in sorted(reg.planes.items()):
        for key, allowed in (("kind", KINDS), ("location", LOCATIONS), ("posture", POSTURES)):
            if plane.get(key) not in allowed:
                problems.append(f"{name}: {key} {plane.get(key)!r} is not one of {sorted(allowed)}")
        if plane.get("location") == "remote" and not (
            plane.get("project_ref") or plane.get("aura_instance_id")
        ):
            problems.append(f"{name}: a remote plane needs project_ref or aura_instance_id")
        if plane.get("location") == "local" and plane.get("kind") == "postgres":
            if not isinstance(plane.get("port"), int):
                problems.append(f"{name}: a local postgres plane needs an integer port")
        for role, spec in plane.get("roles", {}).items():
            if role not in ROLES:
                problems.append(f"{name}: role {role!r} is not one of {list(ROLES)}")
            sources = [k for k in ("secrets", "file", "container", "containers") if k in spec]
            if len(sources) != 1:
                problems.append(f"{name}.{role}: name exactly one of secrets, file, container(s)")
            if ("secrets" in spec or "file" in spec) and not (
                spec.get("name") or spec.get("names")
            ):
                problems.append(f"{name}.{role}: a file source needs name or names")
            for variable in [spec.get("name"), *spec.get("names", [])]:
                if variable is not None and not NAME.match(variable):
                    problems.append(f"{name}.{role}: {variable!r} is not a variable name")
    for agree in reg.settings.get("agree", []):
        target = reg.repo_root / agree["file"]
        plane = reg.planes.get(agree["plane"])
        if plane is None:
            problems.append(f"agree {agree['file']}: unknown plane {agree['plane']}")
            continue
        if not target.is_file():
            problems.append(f"agree: {agree['file']} does not exist")
            continue
        other = tomllib.loads(target.read_text(encoding="utf-8"))
        for theirs, ours in agree.get("pairs", {}).items():
            if _dig(other, theirs) != plane.get(ours):
                problems.append(f"{agree['plane']}.{ours} disagrees with {agree['file']} {theirs}")
    return problems


# ------------------------------------------------------------------------------- credentials


def read_env_file(path: Path) -> dict[str, str]:
    """A minimal dotenv reader: NAME=value lines, optional `export`, quotes stripped."""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def source_path(reg: Registry, spec: dict[str, Any]) -> Path | None:
    if "secrets" in spec:
        return reg.workspace / ".secrets" / spec["secrets"]
    if "file" in spec:
        return reg.repo_root / spec["file"]
    return None


def role_names(spec: dict[str, Any]) -> list[str]:
    return [spec["name"]] if spec.get("name") else list(spec.get("names", []))


def role_view(reg: Registry, spec: dict[str, Any]) -> dict[str, Any]:
    """Where a role's credential lives and whether each name is set; never the value."""
    path = source_path(reg, spec)
    if path is None:
        containers = spec.get("containers") or [spec["container"]]
        return {
            "source": "container environment (docker inspect, at run time)",
            "containers": containers,
        }
    values = read_env_file(path)
    shown = path.relative_to(reg.workspace) if path.is_relative_to(reg.workspace) else path
    view: dict[str, Any] = {
        "source": shown.as_posix(),
        "names": {n: bool(values.get(n)) for n in role_names(spec)},
    }
    if spec.get("missing") and not all(view["names"].values()):
        view["owner_todo"] = spec["missing"]
    return view


@dataclass
class Credential:
    role: str
    source: str
    connect: dict[str, Any]
    secrets: list[str] = field(default_factory=list)


def _from_url(url: str, role: str, source: str) -> Credential:
    parts = urlsplit(url)
    if parts.scheme not in {"postgres", "postgresql"}:
        raise NotReady(
            "NOT_A_POSTGRES_URL",
            f"the {role} credential from {source} is not a PostgreSQL URL",
            "store a postgresql:// URL under that name",
        )
    connect: dict[str, Any] = {
        "host": parts.hostname or "",
        "port": parts.port or 5432,
        "user": unquote(parts.username or ""),
        "dbname": unquote(parts.path.lstrip("/")) or "postgres",
    }
    if parts.password:
        connect["password"] = unquote(parts.password)
    connect.update(dict(parse_qsl(parts.query)))
    return Credential(role, source, connect, [url, connect.get("password", "")])


def _from_container(names: list[str], port: int, role: str) -> Credential:
    if not shutil.which("docker"):
        raise NotReady(
            "NO_DOCKER",
            "docker is not on PATH; a container plane resolves its login from docker inspect",
            "start Docker Desktop",
        )
    for name in names:
        done = subprocess.run(
            ["docker", "inspect", "--format", "{{json .}}", name],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
        if done.returncode != 0:
            continue
        info = json.loads(done.stdout)
        if not info.get("State", {}).get("Running"):
            continue
        published = {
            int(b["HostPort"])
            for bindings in (info.get("NetworkSettings", {}).get("Ports") or {}).values()
            for b in bindings or []
            if b.get("HostPort")
        }
        if port not in published:
            raise Refused(
                "PORT_MISMATCH",
                f"container {name} does not publish the registered port {port}",
                "fix config/planes.toml or the container; the registry is the identity",
            )
        env = dict(item.partition("=")[::2] for item in info.get("Config", {}).get("Env", []))
        password = env.get("POSTGRES_PASSWORD", "")
        if not password:
            raise NotReady(
                "NO_CONTAINER_LOGIN",
                f"container {name} sets no POSTGRES_PASSWORD",
                "name a file source for this plane's role",
            )
        connect = {
            "host": "127.0.0.1",
            "port": port,
            "user": env.get("POSTGRES_USER", "postgres"),
            "password": password,
            "dbname": env.get("POSTGRES_DB", "postgres"),
        }
        return Credential(role, f"container {name}", connect, [password])
    raise NotReady(
        "CONTAINER_NOT_RUNNING",
        f"none of {', '.join(names)} is running",
        "start the plane (its `up` recipe in `./dev planes show`); mind the memory headroom",
    )


def resolve(reg: Registry, plane_name: str, role: str) -> Credential:
    plane = reg.plane(plane_name)
    spec = plane.get("roles", {}).get(role)
    if spec is None:
        raise NotReady(
            "NO_ROLE",
            f"{plane_name} declares no {role} login",
            f"use one of: {', '.join(plane.get('roles', {}))}",
        )
    path = source_path(reg, spec)
    if path is None:
        return _from_container(
            spec.get("containers") or [spec["container"]], int(plane["port"]), role
        )
    name = spec["name"]
    value = read_env_file(path).get(name, "")
    if not value:
        todo = spec.get("missing") or f"set {name} in {path.name}"
        raise NotReady("CREDENTIAL_MISSING", f"{name} is not set in {path.name}", todo)
    return _from_url(value, role, f"{path.name}:{name}")


def guard_identity(plane_name: str, plane: dict[str, Any], cred: Credential) -> None:
    """Refuse a resolved login that does not point at the registered plane."""
    host, port = str(cred.connect.get("host", "")), int(cred.connect.get("port", 5432))
    if plane["location"] == "local":
        if host not in LOOPBACK or port != plane["port"]:
            raise Refused(
                "NOT_LOOPBACK",
                f"{plane_name} is local but its {cred.role} login points at another host or port",
                f"point {cred.source} at 127.0.0.1:{plane['port']}",
            )
        cred.connect.setdefault("sslmode", "disable")
        return
    ref = plane.get("project_ref", "")
    if ref and ref not in host and ref not in str(cred.connect.get("user", "")):
        raise Refused(
            "PROJECT_REF_MISMATCH",
            f"the {cred.role} login from {cred.source} does not carry {plane_name}'s project ref",
            "the credential belongs to another project; fix the secrets file",
        )
    if cred.connect.get("sslmode") in {"disable", "allow", "prefer"}:
        raise Refused(
            "TLS_REQUIRED", f"a remote login must use TLS ({cred.source})", "set sslmode=require"
        )
    cred.connect["sslmode"] = cred.connect.get("sslmode", "require")


# ------------------------------------------------------------------------------------ policy


def confirm_token(plane: dict[str, Any]) -> str:
    return str(
        plane.get("project_ref")
        or plane.get("container")
        or (plane.get("containers") or [""])[0]
        or ""
    )


def guard_access(
    plane_name: str, plane: dict[str, Any], *, write: bool, confirm: str | None, yes_remote: bool
) -> None:
    """Refusals that need no connection: retired, non-postgres, protected writes, confirmation."""
    if plane.get("posture") == "retired":
        raise Refused(
            "PLANE_RETIRED",
            f"{plane_name} is retired; every access command refuses it",
            "use another plane (`./dev planes list`)",
        )
    if plane.get("kind") != "postgres":
        raise Refused(
            "PLANE_KIND",
            f"{plane_name} is a {plane.get('kind')} plane; `./dev db` reaches postgres planes only",
            "graph and storage commands are not built yet (DATA-ACCESS §5.3)",
        )
    if not write:
        return
    if plane.get("posture") == "protected":
        raise Refused(
            "PLANE_PROTECTED",
            f"{plane_name} is protected; writes are refused",
            "write through the owning installer, with the owner's approval",
        )
    token = confirm_token(plane) or plane_name
    if confirm != token:
        raise Refused(
            "CONFIRM_MISMATCH",
            f"a write on {plane_name} needs --confirm {token}",
            f"add --confirm {token}",
        )
    if plane.get("location") == "remote" and not yes_remote:
        raise Refused(
            "REMOTE_WRITE",
            f"{plane_name} is remote; a write also needs --yes-remote",
            "add --yes-remote, with the owner's approval",
        )


def choose_role(
    reg: Registry, plane_name: str, *, write: bool, role: str | None, yes_remote: bool
) -> tuple[str, str | None]:
    """(role, notice): the reader for remote reads; the admin fallback only with --yes-remote."""
    plane = reg.plane(plane_name)
    roles = plane.get("roles", {})
    remote = plane.get("location") == "remote"
    if role:
        if remote and role != "reader" and not yes_remote:
            raise Refused(
                "REMOTE_NEEDS_YES",
                f"the {role} login on remote {plane_name} needs --yes-remote",
                "add --yes-remote, or drop --role to use the reader",
            )
        return role, None
    if write:
        return ("admin" if "admin" in roles else next(iter(roles), "admin")), None
    reader = roles.get("reader")
    if reader is not None:
        path = source_path(reg, reader)
        present = path is None or all(read_env_file(path).get(n) for n in role_names(reader))
        if present:
            return "reader", None
    if not remote:
        return ("admin" if "admin" in roles else next(iter(roles), "admin")), None
    todo = (reader or {}).get("missing") or f"declare and create a reader login for {plane_name}"
    if not yes_remote:
        raise Refused(
            "REMOTE_READ_NEEDS_READER",
            f"{plane_name} has no reader login yet. Owner to-do: {todo}",
            "add --yes-remote to read through the admin login inside a read-only transaction",
        )
    return (
        "admin",
        f"no reader login on {plane_name}: reading as admin inside a read-only transaction. "
        f"Owner to-do: {todo}",
    )


def _code_only(sql: str) -> str:
    """The SQL with comments, string literals, quoted identifiers and dollar quotes blanked."""
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        if sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j == -1 else j
        elif sql.startswith("/*", i):
            depth, i = 1, i + 2
            while i < n and depth:
                if sql.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif sql.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
            out.append(" ")
        elif c in "'\"":
            j = i + 1
            while j < n:
                doubled = sql[j] == c and j + 1 < n and sql[j + 1] == c
                escaped = sql[j] == "\\" and c == "'" and i > 0 and sql[i - 1] in "eE"
                if doubled or escaped:
                    j += 2
                elif sql[j] == c:
                    break
                else:
                    j += 1
            out.append(" '' " if c == "'" else ' "x" ')
            i = j + 1
        elif c == "$" and (m := re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])):
            tag = m.group(0)
            j = sql.find(tag, i + len(tag))
            out.append(" '' ")
            i = n if j == -1 else j + len(tag)
        else:
            out.append(c)
            i += 1
    return "".join(out)


def classify(sql: str, *, write: bool, installer: str) -> str:
    """'read' or 'write'; raises Refused for DDL, control, several statements or a denied call."""
    code = _code_only(sql)
    statements = [s.strip() for s in code.split(";") if s.strip()]
    if not statements:
        raise Usage(
            "EMPTY_SQL", "no SQL statement given", 'pass --sql "select ..." or --file f.sql'
        )
    if len(statements) > 1:
        raise Refused(
            "ONE_STATEMENT",
            f"{len(statements)} statements given; one per call",
            "split the SQL into separate calls",
        )
    words = re.findall(r"[A-Za-z_]+", statements[0].upper())
    first = words[0] if words else ""
    if first in DDL or (first == "SELECT" and "INTO" in words):  # SELECT INTO creates a table
        raise Refused(
            "DDL_REFUSED",
            "schema changes never go through `./dev db`",
            f"use the installer: {installer}",
        )
    if first in CONTROL:
        raise Refused(
            "CONTROL_REFUSED",
            f"{first} controls the session or transaction; `./dev db` owns both",
            "send the statement alone, without session or transaction control",
        )
    if first not in READ | WRITE:
        raise Refused(
            "UNKNOWN_STATEMENT",
            f"{first or 'the statement'} is not a recognised read or write",
            "send one SELECT, WITH, SHOW, EXPLAIN, VALUES or DML statement",
        )
    # A data-modifying CTE or EXPLAIN of a write counts as a write.
    is_write = first in WRITE or bool({"INSERT", "UPDATE", "DELETE", "MERGE"} & set(words))
    if is_write and not write:
        raise Refused(
            "WRITE_NEEDS_FLAG",
            "this statement writes; the session is read-only",
            "add --write --confirm <ref> (refused on protected and retired planes)",
        )
    if not is_write and DENIED_FUNCTIONS.search(code):
        raise Refused(
            "FUNCTION_REFUSED",
            "the statement calls a server-side function `./dev db` refuses",
            "read data only; operate the server through its owner",
        )
    return "write" if is_write else "read"


# ----------------------------------------------------------------------------- audit, output


def audit(reg: Registry, plane: dict[str, Any], record: dict[str, Any]) -> None:
    if plane.get("location") != "remote":
        return
    path = reg.audit_log
    path.parent.mkdir(parents=True, exist_ok=True)
    line = {"time": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"), **record}
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(line, sort_keys=True) + "\n")


def redact(text: str, secrets: list[str]) -> str:
    for secret in sorted((s for s in secrets if s), key=len, reverse=True):
        text = text.replace(secret, "***")
    return re.sub(r"(://[^:/@\s]+:)[^@\s]+@", r"\1***@", text)


def emit(data: object) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False, default=str))


# ------------------------------------------------------------------------------- db sessions


def _driver() -> Any:
    try:
        import psycopg
    except ImportError:
        raise NotReady(
            "NO_DRIVER",
            "psycopg is not importable in this interpreter",
            "run `./dev db ...` (it uses `uv run`), or `make install`",
        ) from None
    return psycopg


@dataclass
class Session:
    reg: Registry
    plane_name: str
    plane: dict[str, Any]
    cred: Credential
    write: bool
    conn: Any = None

    def __enter__(self) -> Session:  # noqa: PYI034 (a dataclass, never subclassed)
        psycopg = _driver()
        timeout = int(self.reg.settings.get("statement_timeout_ms", 10000))
        try:
            self.conn = psycopg.connect(
                **self.cred.connect,
                connect_timeout=int(self.reg.settings.get("connect_timeout_s", 10)),
                application_name="dev-planes",
                autocommit=True,
            )
            self.conn.execute("SELECT set_config('statement_timeout', %s, false)", (str(timeout),))
            if not self.write:
                self.conn.execute("SET default_transaction_read_only = on")
            self.conn.read_only = not self.write
        except psycopg.Error as error:
            if self.conn is not None:
                self.conn.close()
            raise NotReady(
                "CONNECT_FAILED",
                redact(f"{self.plane_name}: {error}".strip(), self.cred.secrets),
                "check the plane is up (`./dev db status`) and its login",
            ) from None
        return self

    def __exit__(self, *_: object) -> None:
        if self.conn is not None:
            self.conn.close()

    def rows(
        self, query: Any, params: tuple[Any, ...] = (), limit: int | None = None
    ) -> tuple[list[str], list[list[Any]], bool, int]:
        """(columns, rows, truncated, rowcount) of one statement in its own transaction."""
        with self.conn.transaction(), self.conn.cursor() as cur:
            cur.execute(query, params or None)
            if cur.description is None:
                return [], [], False, cur.rowcount
            columns = [c.name for c in cur.description]
            fetched = cur.fetchmany(limit + 1) if limit is not None else cur.fetchall()
            truncated = limit is not None and len(fetched) > limit
            data = [list(r) for r in (fetched[:limit] if limit is not None else fetched)]
            return columns, data, truncated, len(data)


def open_session(
    reg: Registry, args: argparse.Namespace, *, write: bool = False
) -> tuple[Session, str | None]:
    plane = reg.plane(args.plane)
    guard_access(
        args.plane,
        plane,
        write=write,
        confirm=getattr(args, "confirm", None),
        yes_remote=args.yes_remote,
    )
    role, notice = choose_role(
        reg, args.plane, write=write, role=args.role, yes_remote=args.yes_remote
    )
    cred = resolve(reg, args.plane, role)
    guard_identity(args.plane, plane, cred)
    if getattr(args, "database", None):
        if plane["location"] != "local":
            raise Refused(
                "DATABASE_REMOTE", "--database applies to local planes only", "drop --database"
            )
        cred.connect["dbname"] = args.database
    return Session(reg, args.plane, plane, cred, write), notice


def _run(
    reg: Registry,
    args: argparse.Namespace,
    command: str,
    sql_text: str,
    work: Any,
    *,
    write: bool = False,
) -> int:
    session, notice = open_session(reg, args, write=write)
    if notice:
        print(f"dev: {notice}", file=sys.stderr)
    record = {
        "command": command,
        "plane": args.plane,
        "role": session.cred.role,
        "mode": "write" if write else "read",
        "sql_sha256": hashlib.sha256(sql_text.encode("utf-8")).hexdigest(),
    }
    psycopg = _driver()
    try:
        with session:
            result = work(session)
    except psycopg.Error as error:
        audit(reg, session.plane, {**record, "rows": None, "outcome": type(error).__name__})
        raise PlaneError(
            "QUERY_FAILED",
            redact(f"{type(error).__name__}: {error}".strip(), session.cred.secrets),
            "fix the SQL; `./dev db schema` lists names",
        ) from None
    except NotReady:
        audit(reg, session.plane, {**record, "rows": None, "outcome": "connect_failed"})
        raise
    audit(reg, session.plane, {**record, "rows": result.get("row_count"), "outcome": "ok"})
    emit(
        {
            "plane": args.plane,
            "role": session.cred.role,
            "location": session.plane["location"],
            **result,
        }
    )
    return EXIT_OK


STATUS_SQL = (
    "SELECT current_setting('server_version') AS server_version, current_user AS current_user, "
    "session_user AS session_user, current_database() AS database, "
    "current_setting('default_transaction_read_only') AS default_read_only, "
    "current_setting('transaction_read_only') AS transaction_read_only, "
    "current_setting('statement_timeout') AS statement_timeout"
)
SSL_SQL = "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()"


def db_status(reg: Registry, args: argparse.Namespace) -> int:
    def work(s: Session) -> dict[str, Any]:
        from psycopg import Error, sql

        cols, rows, _, _ = s.rows(STATUS_SQL)
        out: dict[str, Any] = {"server": dict(zip(cols, rows[0], strict=True)) if rows else {}}
        try:
            cols, rows, _, _ = s.rows(SSL_SQL)
            out["tls"] = dict(zip(cols, rows[0], strict=True)) if rows else None
        except Error as error:
            out["tls"] = {"error": type(error).__name__}
        heads = []
        for head in reg.settings.get("heads", []):
            entry: dict[str, Any] = {"name": head["name"], "table": head["table"]}
            try:
                _, found, _, _ = s.rows("SELECT to_regclass(%s)::text", (head["table"],))
                if not found or found[0][0] is None:
                    entry["present"] = False
                else:
                    schema, table = head["table"].split(".", 1)
                    query = sql.SQL(
                        "SELECT {c}::text, count(*) OVER () FROM {s}.{t} ORDER BY {o} DESC LIMIT 1"
                    ).format(
                        c=sql.Identifier(head["column"]),
                        s=sql.Identifier(schema),
                        t=sql.Identifier(table),
                        o=sql.Identifier(head["order_by"]),
                    )
                    _, latest, _, _ = s.rows(query)
                    entry.update(
                        present=True,
                        latest=latest[0][0] if latest else None,
                        rows=latest[0][1] if latest else 0,
                    )
            except Error as error:
                entry["error"] = type(error).__name__
            heads.append(entry)
        out["heads"] = heads
        out["row_count"] = len(heads)
        return out

    return _run(reg, args, "db status", STATUS_SQL, work)


SCHEMAS_SQL = (
    "SELECT n.nspname AS schema, "
    "count(c.oid) FILTER (WHERE c.relkind IN ('r','p','v','m','f')) AS relations "
    "FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid "
    "WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' "
    "GROUP BY 1 ORDER BY 1"
)
TABLES_SQL = (
    "SELECT table_name, table_type FROM information_schema.tables "
    "WHERE table_schema = %s ORDER BY 1"
)
COLUMNS_SQL = (
    "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns "
    "WHERE table_schema = %s AND (%s::text IS NULL OR table_name = %s) "
    "ORDER BY table_name, ordinal_position"
)
GRANTS_SQL = (
    "SELECT grantee, privilege_type FROM information_schema.role_table_grants "
    "WHERE table_schema = %s AND table_name = %s ORDER BY 1, 2"
)


def db_schema(reg: Registry, args: argparse.Namespace) -> int:
    if args.table and not args.schema:
        raise Usage("TABLE_NEEDS_SCHEMA", "--table needs --schema", "add --schema <name>")

    def work(s: Session) -> dict[str, Any]:
        if not args.schema:
            cols, rows, _, count = s.rows(SCHEMAS_SQL)
            return {"schemas": [dict(zip(cols, r, strict=True)) for r in rows], "row_count": count}
        _, tables, _, _ = s.rows(TABLES_SQL, (args.schema,))
        _, columns, _, count = s.rows(COLUMNS_SQL, (args.schema, args.table, args.table))
        listing: dict[str, Any] = {}
        for name, kind in tables:
            if args.table is None or name == args.table:
                listing[name] = {"type": kind, "columns": []}
        for table, column, data_type, nullable in columns:
            listing.setdefault(table, {"type": None, "columns": []})["columns"].append(
                {"name": column, "type": data_type, "nullable": nullable == "YES"}
            )
        out: dict[str, Any] = {"schema": args.schema, "tables": listing, "row_count": count}
        if args.table:
            _, grants, _, _ = s.rows(GRANTS_SQL, (args.schema, args.table))
            out["grants"] = [{"grantee": g, "privilege": p} for g, p in grants]
        return out

    return _run(reg, args, "db schema", f"{SCHEMAS_SQL}|{args.schema}|{args.table}", work)


def db_query(reg: Registry, args: argparse.Namespace) -> int:
    text = args.sql if args.sql is not None else Path(args.file).read_text(encoding="utf-8")
    plane = reg.plane(args.plane)
    # Retired and non-postgres planes first, then the statement (DDL is refused on every plane),
    # then the write rules inside open_session.
    guard_access(args.plane, plane, write=False, confirm=None, yes_remote=args.yes_remote)
    mode = classify(
        text,
        write=args.write,
        installer=plane.get("installer")
        or reg.settings.get("installer", "the repository's installer"),
    )
    limit = args.limit or int(reg.settings.get("row_limit", 200))

    def work(s: Session) -> dict[str, Any]:
        columns, rows, truncated, count = s.rows(text.strip().rstrip(";"), limit=limit)
        return {
            "mode": mode,
            "columns": columns,
            "rows": rows,
            "row_count": count,
            "truncated": truncated,
        }

    return _run(reg, args, "db query", text, work, write=args.write)


# ---------------------------------------------------------------------------------- commands


def _shown(reg: Registry) -> str:
    path = reg.path.resolve()
    return (
        path.relative_to(reg.repo_root).as_posix()
        if path.is_relative_to(reg.repo_root)
        else path.as_posix()
    )


def planes_list(reg: Registry) -> int:
    emit(
        {
            "registry": _shown(reg),
            "planes": [
                {
                    "name": n,
                    **{k: p.get(k) for k in ("kind", "domain", "location", "posture", "mcp")},
                }
                for n, p in sorted(reg.planes.items())
            ],
        }
    )
    return EXIT_OK


def planes_show(reg: Registry, name: str) -> int:
    plane = dict(reg.plane(name))
    roles = {role: role_view(reg, spec) for role, spec in plane.pop("roles", {}).items()}
    view: dict[str, Any] = {"name": name, **plane, "roles": roles}
    if plane.get("posture") == "retired":
        view["refused"] = "retired: every access command refuses this plane"
    elif plane.get("kind") == "postgres":
        view["write_confirm"] = confirm_token(plane) or name
    emit(view)
    return EXIT_OK


def planes_check(reg: Registry) -> int:
    problems = check(reg)
    emit(
        {
            "registry": _shown(reg),
            "planes": len(reg.planes),
            "ok": not problems,
            "problems": problems,
        }
    )
    return EXIT_FAILED if problems else EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="./dev", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--registry", type=Path, default=None, help=argparse.SUPPRESS)
    groups = parser.add_subparsers(dest="group", required=True, metavar="planes|db")

    planes = groups.add_parser("planes", help="the plane registry (standard library, no network)")
    pv = planes.add_subparsers(dest="verb", required=True, metavar="list|show|check")
    pv.add_parser("list", help="every plane", description="Example: ./dev planes list")
    show = pv.add_parser(
        "show",
        help="one plane, credential names only",
        description="Example: ./dev planes show aieng-db",
    )
    show.add_argument("plane")
    pv.add_parser(
        "check",
        help="registry parses, postures valid, no credential values",
        description="Example: ./dev planes check",
    )

    db = groups.add_parser("db", help="read-only database sessions on one named plane")
    dv = db.add_subparsers(dest="verb", required=True, metavar="status|schema|query")

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--plane", required=True, help="the plane to reach; always required, never inferred"
        )
        p.add_argument(
            "--role", choices=ROLES, help="a login other than the default (remote: reader)"
        )
        p.add_argument(
            "--yes-remote",
            action="store_true",
            help="allow a remote non-reader login or a remote write",
        )
        p.add_argument("--database", help="another database on a local plane")

    status = dv.add_parser(
        "status",
        help="reachability, server, login, migration heads",
        description="Example: ./dev db status --plane lab-aieng-build04",
    )
    common(status)
    schema = dv.add_parser(
        "schema",
        help="schemas, or one schema's tables and columns",
        description="Example: ./dev db schema --plane lab-aieng-build04 --schema public",
    )
    common(schema)
    schema.add_argument("--schema")
    schema.add_argument("--table")
    query = dv.add_parser(
        "query",
        help="one statement; read-only unless --write --confirm",
        description='Example: ./dev db query --plane lab-aieng-build04 --sql "select 1"',
    )
    common(query)
    source = query.add_mutually_exclusive_group(required=True)
    source.add_argument("--sql")
    source.add_argument("--file")
    query.add_argument("--limit", type=int, help="row cap (registry default 200)")
    query.add_argument(
        "--write", action="store_true", help="run a write (refused on protected and retired planes)"
    )
    query.add_argument("--confirm", help="the plane's project ref or container, for --write")
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)
    try:
        reg = load(args.registry)
        if args.group == "planes":
            if args.verb == "list":
                return planes_list(reg)
            if args.verb == "show":
                return planes_show(reg, args.plane)
            return planes_check(reg)
        if args.verb == "status":
            return db_status(reg, args)
        if args.verb == "schema":
            return db_schema(reg, args)
        return db_query(reg, args)
    except PlaneError as error:
        label = "refused" if isinstance(error, Refused) else "error"
        print(
            f"dev: {label} ({error.reason}): {error.message}\n  fix: {error.fix}", file=sys.stderr
        )
        return error.exit_code


if __name__ == "__main__":
    sys.exit(main())
