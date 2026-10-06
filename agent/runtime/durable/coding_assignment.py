"""Task coding data is execution input only; lifecycle facts live in Store."""
FIELDS = frozenset({"schema", "phase_id", "project_dir", "responsibilities", "generated_paths",
    "depends_on", "validation_commands", "review_subtask_id", "revision_subtask_id",
    "branch_workspace", "parent_contract_refs"})


def execution_parameters(value):
    if not value:
        return {}
    return {**{key: item for key, item in value.items() if key in FIELDS}, "schema": "coding.assignment.v2"}
