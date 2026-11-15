from core.tools.canonical_registry import CANONICAL_REGISTRY, MEMORY_TYPES
from storage.memory_governance import SUPPORTED_MEMORY_TYPES


def test_memory_type_enum_matches_storage():
    assert set(MEMORY_TYPES) == set(SUPPORTED_MEMORY_TYPES)
    prop = CANONICAL_REGISTRY["memory.manage"].input_schema["properties"]["memory_type"]
    assert set(prop["enum"]) == set(SUPPORTED_MEMORY_TYPES)
    assert prop["default"] in SUPPORTED_MEMORY_TYPES
