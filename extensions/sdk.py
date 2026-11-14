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
