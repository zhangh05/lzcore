"""Filesystem-backed extension registry."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

from .manifest import ExtensionManifest, ExtensionValidationError, extension_storage_key


class ExtensionRegistry:
    def __init__(self, roots: Iterable[str | Path] | None = None):
        if roots is None:
            project_root = Path(__file__).resolve().parent.parent
            roots = (project_root / "extensions", project_root / "plugins")
        self.roots = tuple(Path(root) for root in roots)

    def discover(self) -> list[ExtensionManifest]:
        errors, manifests = self.validate_all()
        if errors:
            raise ExtensionValidationError("; ".join(errors))
        return manifests

    @staticmethod
    def load(path: str | Path) -> ExtensionManifest:
        manifest_path = Path(path)
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            return ExtensionManifest.from_dict(data)
        except (OSError, json.JSONDecodeError, TypeError, ExtensionValidationError) as exc:
            raise ExtensionValidationError(f"invalid extension manifest: {manifest_path}: {exc}") from exc

    def validate_all(self) -> tuple[list[str], list[ExtensionManifest]]:
        errors: list[str] = []
        valid: list[ExtensionManifest] = []
        for root in self.roots:
            if not root.is_dir():
                continue
            for path in sorted(root.glob("*/extension.json")):
                try:
                    valid.append(self.load(path))
                except ExtensionValidationError as exc:
                    errors.append(str(exc))
        ids = [item.extension_id for item in valid]
        if len(ids) != len(set(ids)):
            errors.append("duplicate extension_id")
        owners: dict[str, set[str]] = {}
        for item in valid:
            owners.setdefault(extension_storage_key(item.extension_id), set()).add(item.extension_id)
        collisions = {key: values for key, values in owners.items() if len(values) > 1}
        for key, values in sorted(collisions.items()):
            errors.append(f"extension storage namespace collision: {key}: {', '.join(sorted(values))}")
        # Neither participant may escape validation through callers that inspect
        # the returned manifests even when errors are present.
        duplicates = {extension_id for extension_id in ids if ids.count(extension_id) > 1}
        valid = [item for item in valid if extension_storage_key(item.extension_id) not in collisions
                 and item.extension_id not in duplicates]
        return errors, valid
