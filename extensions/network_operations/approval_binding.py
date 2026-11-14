"""Trusted, invocation-local approval binding; never populated by tool arguments."""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass


class ApprovalBindingError(ValueError):
    pass


@dataclass
class ApprovalBinding:
    workspace_id: str
    connection: dict
    commands: tuple[str, ...]
    consumed: bool = False

    def check(self, workspace_id, connection, commands, *, read, configure):
        if (self.consumed or workspace_id != self.workspace_id
                or not self.connection.get("revision")
                or not self.connection.get("identity_digest")
                or connection != self.connection
                or tuple(commands or ()) != self.commands or read or not configure):
            raise ApprovalBindingError("approved_connection_or_call_changed")


_binding: ContextVar[ApprovalBinding | None] = ContextVar("network_approval_binding", default=None)


def current_approval_binding():
    return _binding.get()


@contextmanager
def bind_approved_execution(record):
    """Carry a claimed operation through the synchronous ToolRuntime pipeline.

    Scope is reset on all exits. The mutable consumed flag prevents a second
    transport call (including one in a copied context) from reusing this claim.
    """
    if record.get("status") != "executing" or not record.get("execution", {}).get("execution_nonce"):
        raise ValueError("operation_not_executing")
    token = _binding.set(ApprovalBinding(
        workspace_id=record["workspace_id"],
        connection=dict(record["target"]["connection"]),
        commands=tuple(record["commands"]),
    ))
    try:
        yield
    finally:
        _binding.reset(token)
