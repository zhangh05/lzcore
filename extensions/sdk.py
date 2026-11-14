"""Small stable SDK exposed to extension backends."""

from __future__ import annotations

import re
import json
from pathlib import Path
from typing import Any, Callable

from extensions.manifest import extension_storage_key
from storage.records import (
    atomic_save_json,
    delete_json_record,
    list_json_records,
    read_json_record,
    workspace_record_dir,
)


def _segment(extension_id: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_-]+", "_", extension_id).strip("_")
    if not value:
        raise ValueError("invalid extension_id")
    return value


class ExtensionDataStore:
    """Workspace-scoped JSON record storage owned by one extension."""

    def __init__(self, extension_id: str, workspace_id: str):
        self.extension_id = extension_id
        self.workspace_id = workspace_id
        self.namespace = extension_storage_key(extension_id)

    def root(self) -> Path:
        return workspace_record_dir(self.workspace_id, "extensions", self.namespace)

    def save(self, collection: str, record_id: str, value: dict[str, Any]) -> dict[str, Any]:
        return atomic_save_json(
            self.workspace_id,
            ("extensions", self.namespace, _segment(collection), f"{_segment(record_id)}.json"),
            value,
        )

    def get(self, collection: str, record_id: str) -> dict[str, Any] | None:
        return read_json_record(
            self.workspace_id,
            ("extensions", self.namespace, _segment(collection), f"{_segment(record_id)}.json"),
        )

    def list(self, collection: str, *, limit: int | None = 200) -> list[dict[str, Any]]:
        return list_json_records(
            self.workspace_id,
            ("extensions", self.namespace, _segment(collection)),
            limit=limit,
        )

    def delete(self, collection: str, record_id: str) -> bool:
        return delete_json_record(
            self.workspace_id,
            ("extensions", self.namespace, _segment(collection), f"{_segment(record_id)}.json"),
        )


class _ScopedSecretOperation:
    """Keep the existing class API while instances also enforce their scope."""

    def __init__(self, operation):
        self.operation = operation

    def __get__(self, instance, owner):
        def execute(reference: str):
            if not reference:
                return "" if self.operation == "get" else False
            from storage import secret_store
            secret_store.check_extension_secret_reference(
                reference,
                workspace_id=instance.workspace_id if instance is not None else None,
                extension_id=instance.extension_id if instance is not None else None,
            )
            return getattr(secret_store, self.operation + "_secret")(reference)
        return execute


class ExtensionSecretStore:
    """Encrypted secret references; plaintext never enters extension records."""

    def __init__(self, extension_id: str, workspace_id: str):
        from storage.ids import validate_workspace_id
        if not isinstance(extension_id, str) or not extension_id:
            raise ValueError("invalid extension_id")
        self.extension_id = extension_id
        self.workspace_id = validate_workspace_id(workspace_id)

    def set(self, name: str, value: str) -> str:
        from storage.secret_store import extension_secret_id, set_secret
        return set_secret(extension_secret_id(self.workspace_id, self.extension_id, name), value)

    get = _ScopedSecretOperation("get")
    delete = _ScopedSecretOperation("delete")


def run_migrations(
    extension_id: str,
    workspace_id: str,
    migrations: list[tuple[int, Callable[[ExtensionDataStore], None]]],
) -> int:
    from storage.atomic_io import atomic_write_json
    from storage.locking import FileLock

    store = ExtensionDataStore(extension_id, workspace_id)
    # The marker and lock follow the exact principal-scoped business data root.
    # Legacy global versions cannot prove that this principal was migrated.
    root = store.root()
    with FileLock(root / ".migrations.lock"):
        marker = root / ".schema-version.json"
        try:
            state = json.loads(marker.read_text(encoding="utf-8"))
        except FileNotFoundError:
            state = {"version": 0}
        current = state["version"]
        if type(current) is not int or current < 0:
            raise ValueError("invalid extension schema version")
        for version, migration in sorted(migrations, key=lambda item: item[0]):
            if version <= current:
                continue
            migration(store)
            atomic_write_json(marker, {"version": version})
            current = version
        return current


_LEGACY_SECRET_REF = re.compile(r"^(?:secret://)?extension/([A-Za-z0-9_-]+)/([^/]+)/([^/]+)$")


def _legacy_refs(value, path=()):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _legacy_refs(item, (*path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _legacy_refs(item, (*path, index))
    elif isinstance(value, str) and _LEGACY_SECRET_REF.match(value):
        yield path, value


def _replace_at(value, path, new):
    for step in path[:-1]:
        value = value[step]
    value[path[-1]] = new


def migrate_legacy_extension_secrets() -> dict[str, int]:
    """Re-key pre-isolation ``extension/<ns>/<ws>/<name>`` secret references.

    Old secret IDs carried no owner, so two principals using the same workspace
    ID, extension and secret name shared (and overwrote) one stored value.
    A reference is re-keyed into the owner-bound ``extension-v2`` namespace
    only when records of exactly one principal reference it and the ID's
    workspace matches the record's workspace. Shared or foreign references are
    left untouched; reads keep refusing them and the user must re-enter them.
    """
    from extensions.registry import ExtensionRegistry
    from storage import secret_store
    from storage.principal import known_storage_principals, storage_principal
    from storage.workspace_store import list_workspace_ids

    _, manifests = ExtensionRegistry().validate_all()
    by_namespace = {extension_storage_key(m.extension_id): m.extension_id for m in manifests}
    workspace_ids = list_workspace_ids(include_system=False) or ["default"]
    found: dict[str, list[tuple[str, str, str, str, str, tuple]]] = {}
    for principal in known_storage_principals() or [""]:
        with storage_principal(principal):
            for workspace_id in workspace_ids:
                for namespace, extension_id in by_namespace.items():
                    root = ExtensionDataStore(extension_id, workspace_id).root()
                    if not root.is_dir():
                        continue
                    for record_path in root.glob("*/*.json"):
                        try:
                            record = json.loads(record_path.read_text(encoding="utf-8"))
                        except (OSError, json.JSONDecodeError):
                            continue
                        for path, reference in _legacy_refs(record):
                            ref_ns, ref_ws, _ = _LEGACY_SECRET_REF.match(reference).groups()
                            if ref_ns != namespace or ref_ws != workspace_id:
                                continue
                            found.setdefault(reference.removeprefix("secret://"), []).append(
                                (principal, workspace_id, extension_id, record_path.parent.name, record_path.stem, path))
    result = {"migrated": 0, "ambiguous": 0, "failed": 0}
    for legacy_id, uses in found.items():
        if len({use[0] for use in uses}) != 1:
            result["ambiguous"] += 1
            continue
        principal = uses[0][0]
        name = legacy_id.split("/", 3)[3]
        try:
            with storage_principal(principal):
                value = secret_store._read_secret(legacy_id)
                if not value:
                    result["failed"] += 1
                    continue
                _, workspace_id, extension_id, _, _, _ = uses[0]
                new_ref = secret_store.set_secret(
                    secret_store.extension_secret_id(workspace_id, extension_id, name), value)
                for _, ws, ext, collection, record_id, path in uses:
                    store = ExtensionDataStore(ext, ws)
                    record = store.get(collection, record_id)
                    if record is None:
                        continue
                    _replace_at(record, path, new_ref)
                    store.save(collection, record_id, record)
                secret_store._delete_secret(legacy_id)
            result["migrated"] += 1
        except Exception:
            result["failed"] += 1
    return result
