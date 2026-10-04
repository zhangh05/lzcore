"""Tool schema repair, graph construction and complete model feedback."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import asdict
from typing import Any

from agent.llm.schemas import LLMMessage, LLMResponse, LLMToolCall
from core.tools.redaction import redact_tool_output

from .loop_messages import StreamingToolResult, _json_compact, _model_tool_payload
from .models import ExecutionNode, ExecutionStatus, StatelessContext


class LoopToolPreparation:
    """Tool schema repair, graph construction and complete model feedback. Shared context belongs to the QueryLoop driver."""

    def _prepare_tool_calls(
        self,
        ctx: StatelessContext,
        tool_calls: list[LLMToolCall],
    ) -> dict[str, Any]:
        """Run QueryLoop's pre-execution hard boundaries.

        QueryLoop is the execution path. It keeps schema, resource-identity and
        orchestration boundaries directly on the current call batch.
        """
        nodes = self._tool_calls_to_nodes(tool_calls)
        from .pre_execution_repair import (
            REPAIRABLE_ERROR_CODES,
            PreExecutionRepairEngine,
        )
        from .semantic_validator import SemanticValidator

        self._fill_delete_paths_from_verified_history(ctx, nodes)

        from .orchestration import (
            OrchestrationError,
            binding_source_allowed,
            binding_target_allowed,
            validate_incremental_graph,
        )

        try:
            validate_incremental_graph(
                tool_calls,
                dict(ctx.extras.get("orchestration_evidence") or {}),
                binding_target_validator=lambda tool_id, action, target: (
                    binding_target_allowed(
                        self._tool_registry,
                        tool_id,
                        action,
                        target,
                    )
                ),
                binding_source_validator=lambda tool_id, action, path: (
                    binding_source_allowed(
                        self._tool_registry,
                        tool_id,
                        action,
                        path,
                    )
                ),
            )
        except OrchestrationError as exc:
            message = str(exc)
            return {
                "ok": False,
                "error": "orchestration_validation_failed",
                "errors": [message],
                "validation_errors": [
                    {
                        "node_id": "plan",
                        "code": "ORCHESTRATION_INVALID",
                        "message": message,
                        "details": {},
                    }
                ],
                "hard_block": False,
                "risk_level": "low",
                "message": f"工具编排校验失败：{message}",
            }

        # Normalize supported topology aliases before validating their shapes.
        for node in nodes:
            if node.tool == "network.operations.topology":
                t_args = dict(node.args or {})
                if "nodes" in t_args and not t_args.get("node_updates"):
                    t_args["node_updates"] = t_args.get("nodes")
                if "links" in t_args and not t_args.get("link_updates"):
                    t_args["link_updates"] = t_args.get("links")
                if "groups" in t_args and not t_args.get("group_updates"):
                    t_args["group_updates"] = t_args.get("groups")
                if "zones" in t_args and not t_args.get("group_updates"):
                    t_args["group_updates"] = t_args.get("zones")
                if "canvas_items" in t_args and not t_args.get("canvas_item_updates"):
                    t_args["canvas_item_updates"] = t_args.get("canvas_items")
                if not t_args.get("action"):
                    if any(
                        t_args.get(k)
                        for k in (
                            "nodes",
                            "node_updates",
                            "links",
                            "link_updates",
                            "groups",
                            "group_updates",
                            "zones",
                            "canvas_items",
                            "canvas_item_updates",
                            "remove_node_ids",
                            "remove_link_ids",
                            "remove_group_ids",
                            "remove_canvas_item_ids",
                        )
                    ) or any(
                        k in t_args
                        for k in ("name", "title", "description", "summary", "comment")
                    ):
                        t_args["action"] = "patch"
                    else:
                        t_args["action"] = "read"
                node.args = t_args

        validator = SemanticValidator(self._tool_registry)
        validation = validator.validate(nodes)
        if not validation.valid:
            repair = PreExecutionRepairEngine().try_repair(nodes, validation.errors)
            self._record_pre_exec_repair(ctx, repair)
            if repair.repaired and repair.repaired_nodes is not None:
                nodes = repair.repaired_nodes
                validation = validator.validate(nodes)

        if not validation.valid:
            for node in nodes:
                if any(e.node_id == node.id for e in validation.errors):
                    node.status = ExecutionStatus.SKIPPED
                    node.error = "Blocked by semantic validation"
            errors = [f"{e.node_id}:{e.code}:{e.message}" for e in validation.errors]
            validation_errors = [
                {
                    "node_id": e.node_id,
                    "code": e.code,
                    "message": e.message,
                    "details": dict(getattr(e, "details", {}) or {}),
                }
                for e in validation.errors
            ]
            self._record_blocked_audit_nodes(ctx, nodes)
            # Repairable semantic errors remain recoverable by the LLM when
            # deterministic repair could not resolve them. The repair engine
            # owns this code set so validation and retry cannot drift apart.
            is_hard = any(
                e.code not in REPAIRABLE_ERROR_CODES for e in validation.errors
            )
            return {
                "ok": False,
                "error": "semantic_validation_failed",
                "errors": errors,
                "validation_errors": validation_errors,
                "hard_block": is_hard,
                "risk_level": "high" if is_hard else "low",
                "message": "工具调用校验失败：\n" + "\n".join(f"- {e}" for e in errors),
            }

        repaired_calls = [
            LLMToolCall(
                id=n.id,
                name=n.tool,
                arguments=dict(n.args or {}),
                step_id=n.step_id,
                depends_on=list(n.depends_on),
                result_bindings=dict(n.result_bindings),
                failure_policy=n.failure_policy,
                goal_ids=list(getattr(n, "goal_ids", None) or []),
            )
            for n in nodes
        ]
        return {
            "ok": True,
            "tool_calls": repaired_calls,
            "risk_level": validation.risk_level,
        }

    @staticmethod
    def _fill_delete_paths_from_verified_history(
        ctx: StatelessContext, nodes: list[ExecutionNode]
    ) -> None:
        """Repair a missing delete filepath only from a uniquely named, verified write.

        A prior write result proves that a path exists, but does not by itself prove
        that the user intended to delete it.  For a destructive call the user input
        must explicitly name the same logical filename.  Ambiguous or unnamed
        requests remain schema-blocked and are returned to the model for correction.
        """
        from pathlib import PurePosixPath

        history = ctx.extras.get("tool_call_history") or []
        request = str(ctx.user_input or "")
        candidates: dict[str, set[str]] = {}
        for item in history:
            if (
                not isinstance(item, dict)
                or item.get("ok") is not True
                or item.get("tool") != "workspace.file"
                or str((item.get("arguments") or {}).get("action") or "").lower()
                not in {"write", "write_artifact"}
                or not isinstance(item.get("output"), dict)
            ):
                continue
            filepath = str(item["output"].get("filepath") or "").strip()
            if not filepath:
                continue
            aliases = {PurePosixPath(filepath).name}
            filename = str((item.get("arguments") or {}).get("filename") or "").strip()
            if filename:
                aliases.add(PurePosixPath(filename).name)
            # Managed workspace paths contain an opaque prefix before ``__``.
            basename = PurePosixPath(filepath).name
            if "__" in basename:
                aliases.add(basename.split("__", 1)[1])
            candidates.setdefault(filepath, set()).update(
                alias for alias in aliases if alias
            )

        def _is_explicitly_named(alias: str) -> bool:
            return bool(
                re.search(
                    r"(?<![A-Za-z0-9_.-])" + re.escape(alias) + r"(?![A-Za-z0-9_.-])",
                    request,
                )
            )

        matched = [
            filepath
            for filepath, aliases in candidates.items()
            if any(_is_explicitly_named(alias) for alias in aliases)
        ]
        if len(matched) != 1:
            return
        filepath = matched[0]
        for node in nodes:
            if (
                node.tool == "workspace.file"
                and str(node.args.get("action") or "").lower() == "delete"
                and not str(node.args.get("filepath") or "").strip()
            ):
                node.args["filepath"] = filepath
                ctx.extras.setdefault("pre_exec_repair_events", []).append(
                    {
                        "node_id": node.id,
                        "code": "MISSING_REQUIRED_ARG",
                        "field": "filepath",
                        "value": filepath,
                        "source": "verified_prior_workspace_write_named_by_user",
                    }
                )

    @staticmethod
    def _tool_calls_to_nodes(tool_calls: list[LLMToolCall]) -> list[ExecutionNode]:
        from .action_alias import resolve_action_alias

        nodes: list[ExecutionNode] = []
        for idx, tc in enumerate(tool_calls):
            args = dict(tc.arguments or {})
            action_original = ""
            action_normalized_from_alias = False
            raw_action = args.get("action")
            if isinstance(raw_action, str) and raw_action:
                resolution = resolve_action_alias(
                    tc.name.replace("__", "."), raw_action
                )
                if resolution.matched:
                    args["action"] = resolution.canonical_action
                    if resolution.operation:
                        args["operation"] = resolution.operation
                    action_original = resolution.original_action
                    action_normalized_from_alias = True
            nodes.append(
                ExecutionNode(
                    id=tc.id or f"call_{idx}",
                    tool=tc.name.replace("__", "."),
                    args=args,
                    action_original=action_original,
                    action_normalized_from_alias=action_normalized_from_alias,
                    step_id=tc.step_id,
                    depends_on=list(tc.depends_on),
                    result_bindings=dict(tc.result_bindings),
                    failure_policy=tc.failure_policy,
                    goal_ids=list(tc.goal_ids),
                )
            )
        return nodes

    @staticmethod
    def _record_blocked_audit_nodes(
        ctx: StatelessContext, nodes: list[ExecutionNode]
    ) -> None:
        blocked = []
        for node in nodes:
            if node.status != ExecutionStatus.SKIPPED:
                continue
            blocked.append(
                {
                    "node_id": node.id,
                    "tool": node.tool,
                    "args": dict(node.args or {}),
                    "status": node.status.value,
                    "latency_ms": node.latency_ms,
                    "error": node.error or "blocked",
                }
            )
        if blocked:
            ctx.extras["audit_blocked_nodes"] = blocked

    @staticmethod
    def _record_pre_exec_repair(ctx: StatelessContext, repair) -> None:
        events = []
        for event in getattr(repair, "repair_events", []) or []:
            try:
                events.append(asdict(event))
            except Exception:
                events.append(dict(getattr(event, "__dict__", {}) or {}))
        if events:
            ctx.extras["pre_exec_repair_events"] = events
        ctx.extras["pre_exec_repair_applied"] = bool(getattr(repair, "repaired", False))

    def _append_turn_nudge(
        self,
        messages: list[LLMMessage],
        nudge_text: str,
    ) -> list[LLMMessage]:
        """Append a user nudge to guide the LLM toward a final answer.

        Used when the LLM returns empty text after tools have produced
        results, then nudge the same runtime loop to produce the response
        to produce the answer directly.
        """
        new_msgs = list(messages)
        new_msgs.append(LLMMessage(role="user", content=nudge_text))
        return new_msgs

    @staticmethod
    def _extract_fallback_tool_calls(
        content: str,
        tool_registry: Mapping[str, Any],
    ) -> tuple[list[dict[str, Any]], str]:
        """Extract tool calls emitted as Markdown JSON blocks or raw JSON in text."""
        if not content or not isinstance(content, str):
            return [], content

        blocks = re.findall(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
        candidates = []
        for b in blocks:
            b_clean = b.strip()
            if (b_clean.startswith("{") and b_clean.endswith("}")) or (
                b_clean.startswith("[") and b_clean.endswith("]")
            ):
                candidates.append(b_clean)

        c_clean = content.strip()
        if (c_clean.startswith("{") and c_clean.endswith("}")) or (
            c_clean.startswith("[") and c_clean.endswith("]")
        ):
            if c_clean not in candidates:
                candidates.append(c_clean)

        if not candidates:
            return [], content

        canonical_reg = {k.replace("__", "."): k for k in tool_registry.keys()}
        extracted_calls: list[dict[str, Any]] = []

        for c in candidates:
            try:
                data = json.loads(c)
            except Exception:
                continue
            items = data if isinstance(data, list) else [data]
            for idx, item in enumerate(items):
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name") or item.get("tool") or "").strip()
                args = item.get("arguments") or item.get("parameters")
                if args is None and "action" in item:
                    if "network.operations.topology" in canonical_reg:
                        name = "network.operations.topology"
                        args = {
                            k: v for k, v in item.items() if k not in ("name", "tool")
                        }
                norm_name = name.replace("__", ".")
                if norm_name in canonical_reg and isinstance(args, dict):
                    actual_name = canonical_reg[norm_name]
                    extracted_calls.append(
                        {
                            "id": f"fallback_call_{len(extracted_calls) + 1}",
                            "name": actual_name,
                            "arguments": args,
                        }
                    )

        if extracted_calls:
            cleaned = re.sub(r"```(?:json)?\s*[\s\S]*?\s*```", "", content).strip()
            return extracted_calls, cleaned
        return [], content

    def _append_tool_round(
        self,
        messages: list[LLMMessage],
        tool_calls: list[LLMToolCall],
        results: list[StreamingToolResult],
        response: LLMResponse | None = None,
    ) -> list[LLMMessage]:
        """Append assistant tool_calls + tool results to messages.

        IMPORTANT: assistant message uses __ names (LLM format), tool results
        use cross-referenced call_id to match tool definitions.
        """
        new_msgs = list(messages)

        # Assistant message with tool calls (MUST use __ names to match tool defs)
        assistant_tool_calls = [
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": (tc.name or "").replace(".", "__"),  # dots → __ for API
                    "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                },
            }
            for tc in tool_calls
        ]
        new_msgs.append(
            response.assistant_message(assistant_tool_calls)
            if response
            else LLMMessage(
                role="assistant",
                content="",
                tool_calls=assistant_tool_calls,
            )
        )

        original_call_ids = {tc.id for tc in tool_calls}
        extra_results: list[StreamingToolResult] = []

        # Tool result messages for model-requested calls only. Auto-tracking
        # polls are internal and do not have matching assistant tool_calls.
        for r in results:
            if r.call_id not in original_call_ids:
                extra_results.append(r)
                continue
            tool_payload = _model_tool_payload(r)
            canonical_tool_name = r.tool_name.replace("__", ".")
            is_complete_text_artifact = (
                tool_payload.get("content_complete") is True
                and tool_payload.get("artifact_type")
                in {
                    "input_data",
                    "output_data",
                    "report",
                }
                and (
                    canonical_tool_name == "workspace.artifact"
                    or (
                        canonical_tool_name == "agent.manage"
                        and tool_payload.get("subagent_result_complete") is True
                    )
                )
            )
            output_str = _json_compact(tool_payload)
            new_msgs.append(
                LLMMessage(
                    role="tool",
                    content=output_str,
                    tool_call_id=r.call_id,
                )
            )

        if extra_results:
            payload = [
                {
                    "tool": r.tool_name,
                    "tool_id": r.tool_name,
                    "call_id": r.call_id,
                    "ok": r.ok,
                    "error": r.error,
                    "output": _model_tool_payload(r),
                }
                for r in extra_results
            ]
            payload = redact_tool_output(payload)
            output_str = _json_compact(payload)
            from .prompt_contract import _escape_data

            new_msgs.append(
                LLMMessage(
                    role="user",
                    content=(
                        '<auto_tracking_results data_only="true" trust="untrusted_data">\n'
                        + _escape_data(output_str)
                        + "\n</auto_tracking_results>"
                    ),
                )
            )

        return new_msgs
