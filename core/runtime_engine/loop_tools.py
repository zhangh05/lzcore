"""Streaming graph execution; delegates read retries to the independent retry policy."""

from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Any

from agent.llm.schemas import LLMToolCall

from .loop_messages import StreamingToolResult, _redact_tool_error
from .models import ExecutionNode, SSOTRuntimeConfig, StatelessContext, ToolResult

_LOG = logging.getLogger(__name__)
from .loop_retry import ReadRetryPolicy


class StreamingToolExecutor(ReadRetryPolicy):
    """Graph execution with governed bindings, operation lifecycle and cancellation."""

    def __init__(
        self,
        tool_runtime,
        config: SSOTRuntimeConfig | None = None,
        emitter=None,
        tool_registry: dict[str, dict[str, Any]] | None = None,
    ):
        self._runtime = tool_runtime
        self._config = config or SSOTRuntimeConfig()
        self._emitter = emitter
        self._tool_registry = tool_registry or {}
        self.max_parallel_width = 0

    def _is_read_only_call(self, tool_call: LLMToolCall) -> bool:
        """Classify concurrency from the canonical tool action.

        Merged tools contain both read and write actions, so tool-id-only
        classification is unsafe. Unknown or missing actions are serialized.
        """
        from .contracts import is_read_only_call

        return is_read_only_call(
            tool_call.name,
            tool_call.arguments,
            self._tool_registry.get(tool_call.name.replace("__", ".")),
        )

    @staticmethod
    def _result_may_continue(result: StreamingToolResult) -> bool:
        """Read structured uncertainty without parsing error text."""
        if result.execution_may_continue:
            return True
        output = result.output if isinstance(result.output, dict) else {}
        metadata = (
            output.get("metadata") if isinstance(output.get("metadata"), dict) else {}
        )
        return bool(
            output.get("execution_may_continue")
            or metadata.get("execution_may_continue")
        )

    @staticmethod
    def _is_reliable_network_readback(
        result: StreamingToolResult,
        tool_call: LLMToolCall,
        pending: dict[str, Any],
    ) -> bool:
        """Require live, complete evidence before settling an unknown write.

        Domain adapters intentionally return ``ok=True`` for an unavailable
        device so the LLM can continue with other targets.  That conversational
        status must never be confused with a successful reconciliation.
        """
        if not result.ok:
            return False
        output = result.output if isinstance(result.output, dict) else {}
        if output.get("connection_ok") is not True:
            return False
        connection_id = str((tool_call.arguments or {}).get("connection_id") or "")
        if not connection_id or connection_id != str(
            pending.get("connection_id") or ""
        ):
            return False
        claims = output.get("evidence_claims")
        if not isinstance(claims, list) or not claims:
            return False
        return any(
            isinstance(claim, dict)
            and str(claim.get("status") or "").lower() == "collected"
            and str((claim.get("target") or {}).get("connection_id") or "")
            == connection_id
            for claim in claims
        )

    def _mark_unknown_write_outcome(
        self,
        ctx: StatelessContext | None,
        tool_call: LLMToolCall,
        result: StreamingToolResult,
    ) -> dict[str, Any]:
        """Record an external outcome that remains uncertain for model context."""
        output = result.output if isinstance(result.output, dict) else {}
        record = {
            "status": "unknown",
            "tool_id": tool_call.name.replace("__", "."),
            "call_id": tool_call.id,
            "error_code": str(
                result.error_code
                or output.get("error_code")
                or "TOOL_TIMEOUT_UNCERTAIN"
            ),
            "error": str(
                result.error
                or output.get("error")
                or "tool outcome may still be running"
            ),
            "occurred_at": time.time(),
            "execution_may_continue": True,
            "connection_id": str(
                (tool_call.arguments or {}).get("connection_id") or ""
            ),
            # finish_operation() has already projected this id into the tool
            # result by the time an uncertain write reaches this method.  It
            # makes the runtime read-back and the durable ledger one state
            # machine instead of two unrelated warnings.
            "operation_id": str(output.get("operation_id") or ""),
        }
        if ctx is not None:
            current = ctx.extras.get("unknown_outcome")
            if isinstance(current, dict) and current:
                return dict(current)
            ctx.extras["unknown_outcome"] = record
        if self._emitter:
            self._emitter.emit("unknown_outcome", record)
        return record

    async def execute(
        self,
        tool_calls: list[LLMToolCall],
        *,
        ctx: StatelessContext | None = None,
        budget=None,
    ) -> list[StreamingToolResult]:
        """Execute one incremental dependency graph and preserve call order."""
        from .orchestration import (
            OrchestrationError,
            StepEvidence,
            binding_source_allowed,
            binding_target_allowed,
            resolve_bindings,
            validate_incremental_graph,
        )

        prior = dict((ctx.extras.get("orchestration_evidence") or {}) if ctx else {})
        try:
            layers = validate_incremental_graph(
                tool_calls,
                prior,
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
            return [
                StreamingToolResult(
                    tool_name=tc.name,
                    call_id=tc.id,
                    output={
                        "ok": False,
                        "executed": False,
                        "error_code": "ORCHESTRATION_INVALID",
                        "error": _redact_tool_error(exc),
                        "retryable": True,
                    },
                    ok=False,
                    error=_redact_tool_error(exc),
                )
                for tc in tool_calls
            ]

        calls_by_step = {str(tc.step_id or tc.id): tc for tc in tool_calls}
        prior_depths = dict(
            (ctx.extras.get("orchestration_depths") or {}) if ctx else {}
        )
        step_depths = dict(prior_depths)
        for layer in layers:
            for step_id in layer:
                step_depths[step_id] = 1 + max(
                    (
                        int(step_depths.get(dependency, 0))
                        for dependency in calls_by_step[step_id].depends_on
                    ),
                    default=0,
                )
        parallel_steps_by_layer = {
            index: self._parallel_step_ids(layer, calls_by_step)
            for index, layer in enumerate(layers, start=1)
        }
        if budget is not None:
            budget.reserve_execution_batch(
                node_count=len(tool_calls),
                depth=max(
                    (step_depths[step_id] for step_id in calls_by_step),
                    default=0,
                ),
                parallel_width=max(
                    (
                        min(
                            self._parallel_width(layer, calls_by_step),
                            max(1, int(self._config.max_layer_concurrency or 1)),
                            max(1, int(self._config.max_global_concurrency or 1)),
                        )
                        for layer in layers
                    ),
                    default=0,
                )
                or min(1, len(tool_calls)),
            )

        if self._emitter:
            self._emitter.emit(
                "orchestration_planned",
                {
                    "step_count": len(tool_calls),
                    "layer_count": len(layers),
                    "parallel_layers": sum(
                        1 for steps in parallel_steps_by_layer.values() if steps
                    ),
                },
            )

        evidence: dict[str, StepEvidence] = dict(prior)
        result_by_id: dict[str, StreamingToolResult] = {}
        executed_parallel_steps_by_layer: dict[int, set[str]] = {
            index: set() for index in range(1, len(layers) + 1)
        }

        for layer_index, layer in enumerate(layers, start=1):
            parallel_step_ids = parallel_steps_by_layer[layer_index]
            if self._emitter:
                self._emitter.emit(
                    "orchestration_layer_started",
                    {
                        "layer": layer_index,
                        "steps": list(layer),
                        "parallel": bool(parallel_step_ids),
                    },
                )
            runnable: list[LLMToolCall] = []
            for step_id in layer:
                tc = calls_by_step[step_id]
                failed_dependencies = [
                    dep
                    for dep in tc.depends_on
                    if dep in evidence and not evidence[dep].ok
                ]
                if failed_dependencies:
                    error = f"failed dependencies: {failed_dependencies}"
                    result = StreamingToolResult(
                        tool_name=tc.name,
                        call_id=tc.id,
                        output={
                            "ok": False,
                            "executed": False,
                            "error_code": "DEPENDENCY_FAILED",
                            "error": error,
                            "failed_dependencies": failed_dependencies,
                            "_orchestration": {
                                "step_id": step_id,
                                "depends_on": list(tc.depends_on),
                                "layer": layer_index,
                                "parallel": False,
                                "failure_policy": tc.failure_policy,
                            },
                        },
                        ok=False,
                        error=error,
                    )
                    result_by_id[tc.id] = result
                    evidence[step_id] = StepEvidence(
                        step_id,
                        tc.id,
                        tc.name,
                        False,
                        result.output,
                        error,
                        str((tc.arguments or {}).get("action") or ""),
                    )
                    continue
                try:
                    resolved_args = resolve_bindings(
                        tc.arguments,
                        tc.result_bindings,
                        evidence,
                    )
                except OrchestrationError as exc:
                    result = StreamingToolResult(
                        tool_name=tc.name,
                        call_id=tc.id,
                        output={
                            "ok": False,
                            "executed": False,
                            "error_code": "RESULT_BINDING_FAILED",
                            "error": _redact_tool_error(exc),
                            "_orchestration": {
                                "step_id": step_id,
                                "depends_on": list(tc.depends_on),
                                "layer": layer_index,
                                "parallel": False,
                                "failure_policy": tc.failure_policy,
                            },
                        },
                        ok=False,
                        error=_redact_tool_error(exc),
                    )
                    result_by_id[tc.id] = result
                    evidence[step_id] = StepEvidence(
                        step_id,
                        tc.id,
                        tc.name,
                        False,
                        result.output,
                        str(exc),
                        str((tc.arguments or {}).get("action") or ""),
                    )
                    continue
                binding_error = self._validate_resolved_call(tc, resolved_args)
                if binding_error:
                    result = StreamingToolResult(
                        tool_name=tc.name,
                        call_id=tc.id,
                        output={
                            "ok": False,
                            "executed": False,
                            "error_code": "RESULT_BINDING_INVALID",
                            "error": binding_error,
                            "_orchestration": {
                                "step_id": step_id,
                                "depends_on": list(tc.depends_on),
                                "layer": layer_index,
                                "parallel": False,
                                "failure_policy": tc.failure_policy,
                            },
                        },
                        ok=False,
                        error=binding_error,
                    )
                    result_by_id[tc.id] = result
                    evidence[step_id] = StepEvidence(
                        step_id,
                        tc.id,
                        tc.name,
                        False,
                        result.output,
                        binding_error,
                        str((tc.arguments or {}).get("action") or ""),
                    )
                    continue
                runnable.append(
                    LLMToolCall(
                        id=tc.id,
                        name=tc.name,
                        arguments=resolved_args,
                        step_id=step_id,
                        depends_on=list(tc.depends_on),
                        result_bindings=dict(tc.result_bindings),
                        failure_policy=tc.failure_policy,
                        goal_ids=list(tc.goal_ids),
                    )
                )

            runnable_by_step = {str(tc.step_id or tc.id): tc for tc in runnable}
            actual_parallel_steps = self._parallel_step_ids(
                [str(tc.step_id or tc.id) for tc in runnable],
                runnable_by_step,
            )
            executed_parallel_steps_by_layer[layer_index] = actual_parallel_steps
            layer_results = await self._execute_independent_calls(
                runnable,
                ctx=ctx,
                budget=budget,
            )
            for tc, result in zip(runnable, layer_results):
                step_id = str(tc.step_id or tc.id)
                result.output = {
                    **(result.output or {}),
                    "_orchestration": {
                        "step_id": step_id,
                        "depends_on": list(tc.depends_on),
                        "layer": layer_index,
                        "parallel": step_id in actual_parallel_steps,
                        "failure_policy": tc.failure_policy,
                    },
                }
                result_by_id[tc.id] = result
                evidence_output = dict(result.output or {})
                evidence[step_id] = StepEvidence(
                    step_id,
                    tc.id,
                    tc.name,
                    result.ok,
                    evidence_output,
                    result.error or "",
                    str((tc.arguments or {}).get("action") or ""),
                )
            if self._emitter:
                self._emitter.emit(
                    "orchestration_layer_completed",
                    {
                        "layer": layer_index,
                        "steps": list(layer),
                        "succeeded": sum(
                            1
                            for step_id in layer
                            if step_id in evidence and evidence[step_id].ok
                        ),
                    },
                )

        if ctx is not None:
            ctx.extras["orchestration_evidence"] = evidence
            ctx.extras["orchestration_depths"] = step_depths
            ctx.extras.setdefault("orchestration_batches", []).append(
                {
                    "layers": [list(layer) for layer in layers],
                    "parallel_steps": [
                        sorted(executed_parallel_steps_by_layer[index])
                        for index in range(1, len(layers) + 1)
                    ],
                    "step_count": len(tool_calls),
                }
            )
        return [result_by_id[tc.id] for tc in tool_calls]

    def _parallel_step_ids(
        self,
        layer: list[str],
        calls_by_step: dict[str, LLMToolCall],
    ) -> set[str]:
        """Return steps that truly execute in a concurrent read group."""
        parallel: set[str] = set()
        read_group: list[str] = []

        def flush() -> None:
            if len(read_group) > 1:
                parallel.update(read_group)
            read_group.clear()

        for step_id in layer:
            if self._is_read_only_call(calls_by_step[step_id]):
                read_group.append(step_id)
            else:
                flush()
        flush()
        return parallel

    def _parallel_width(
        self,
        layer: list[str],
        calls_by_step: dict[str, LLMToolCall],
    ) -> int:
        """Return actual peak concurrency, not total topological width."""
        peak = 0
        current_reads = 0
        for step_id in layer:
            if self._is_read_only_call(calls_by_step[step_id]):
                current_reads += 1
                peak = max(peak, current_reads)
            else:
                current_reads = 0
                peak = max(peak, 1)
        return peak

    def _validate_resolved_call(
        self,
        tool_call: LLMToolCall,
        resolved_args: dict[str, Any],
    ) -> str:
        """Revalidate the final arguments after dependency bindings resolve."""
        if not tool_call.result_bindings:
            return ""
        from .semantic_validator import SemanticValidator

        node = ExecutionNode(
            id=tool_call.id,
            tool=tool_call.name.replace("__", "."),
            args=dict(resolved_args or {}),
        )
        validation = SemanticValidator(self._tool_registry).validate([node])
        if validation.valid:
            return ""
        return "; ".join(
            f"{error.code}: {error.message}" for error in validation.errors
        )

    async def _execute_independent_calls(
        self,
        tool_calls: list[LLMToolCall],
        *,
        ctx: StatelessContext | None = None,
        budget=None,
    ) -> list[StreamingToolResult]:
        """Execute a dependency-free layer: reads parallel, writes barriers."""
        # Build result map keyed by call_id so we can return in original order.
        # Consecutive reads may run together, but every write is an ordering
        # barrier. Executing all reads before all writes changes semantics for
        # batches such as [read, write, read].
        result_by_id: dict[str, StreamingToolResult] = {}

        async def execute_read_group(group: list[LLMToolCall]) -> None:
            if not group:
                return
            concurrency_limit = min(
                max(1, int(self._config.max_layer_concurrency or 1)),
                max(1, int(self._config.max_global_concurrency or 1)),
            )
            self.max_parallel_width = max(
                self.max_parallel_width,
                min(len(group), concurrency_limit),
            )
            semaphore = asyncio.Semaphore(concurrency_limit)

            async def bounded(tc: LLMToolCall) -> StreamingToolResult:
                async with semaphore:
                    return await self._execute_one(tc, ctx=ctx, budget=budget)

            tasks = [bounded(tc) for tc in group]
            # return_exceptions=True: collect every result, even if some fail
            gather = asyncio.gather(*tasks, return_exceptions=True)
            timeout_seconds = self._config.parallel_layer_timeout_ms / 1000.0
            if budget is not None:
                timeout_seconds = min(
                    timeout_seconds,
                    max(0.001, budget.remaining_execution_seconds()),
                )
            try:
                ro_results = await asyncio.wait_for(gather, timeout=timeout_seconds)
            except asyncio.TimeoutError:
                ro_results = [
                    StreamingToolResult(
                        tool_name=tc.name,
                        call_id=tc.id,
                        output={
                            "ok": False,
                            "error_code": "PARALLEL_LAYER_TIMEOUT",
                            "error": "parallel read-only tool layer exceeded its execution budget",
                            "retryable": False,
                            "execution_may_continue": False,
                        },
                        ok=False,
                        error="parallel read-only tool layer exceeded its execution budget",
                        error_code="PARALLEL_LAYER_TIMEOUT",
                        execution_may_continue=False,
                    )
                    for tc in group
                ]
            for tc, r in zip(group, ro_results):
                if isinstance(r, Exception):
                    result_by_id[tc.id] = StreamingToolResult(
                        tool_name=tc.name,
                        call_id=tc.id,
                        output={},
                        ok=False,
                        error=str(r),
                    )
                else:
                    result_by_id[tc.id] = r
                result = result_by_id[tc.id]
                if self._result_may_continue(result):
                    output = dict(result.output or {})
                    output["read_only"] = True
                    result.output = output
                # Once one same-connection read-back reconciles an uncertain
                # write, later read-only calls in this batch must observe that
                # terminal reconciliation.  Looking only at unknown_outcome
                # made every subsequent valid read-back try to settle the same
                # ledger entry again, which raised operation_not_resolvable and
                # aborted the entire agent turn.
                pending = (
                    (
                        ctx.extras.get("unknown_outcome_reconciliation")
                        or ctx.extras.get("unknown_outcome")
                    )
                    if ctx is not None
                    else None
                )
                if (
                    isinstance(pending, dict)
                    and self._is_reliable_network_readback(result, tc, pending)
                    and str(pending.get("status") or "") == "unknown"
                    and tc.name.replace("__", ".") == str(pending.get("tool_id") or "")
                    # A reachability probe proves neither the command state
                    # nor the intended configuration.  Only the network
                    # extension's explicit evidence-producing operations may
                    # reconcile that prior record.
                    and str((tc.arguments or {}).get("action") or "")
                    in {"read", "collect"}
                    and str((tc.arguments or {}).get("connection_id") or "")
                    and str((tc.arguments or {}).get("connection_id") or "")
                    == str(pending.get("connection_id") or "")
                ):
                    reconciliation = {
                        **pending,
                        "status": "reconciled",
                        "reconciled_by_call_id": tc.id,
                    }
                    ctx.extras["unknown_outcome_reconciliation"] = reconciliation
                    operation_id = str(pending.get("operation_id") or "")
                    if operation_id:
                        from .operation_ledger import settle_operation

                        settle_operation(
                            ctx.workspace_id,
                            operation_id,
                            status="reconciled",
                            resolved_by="network_readback",
                            result_summary="同连接只读回读已完成；写入结果以回读证据为准",
                            resolution_reason=(f"same_connection_readback:{tc.id}"),
                            require_unresolved=True,
                        )

        read_group: list[LLMToolCall] = []
        for tc in tool_calls:
            if self._is_read_only_call(tc):
                read_group.append(tc)
                continue
            await execute_read_group(read_group)
            read_group = []
            # Extensions may defer one concrete side-effecting invocation
            # before an operation ledger entry or handler can begin.  This is
            # intentionally a neutral runtime seam: the core neither knows nor
            # decides why outside input is needed.  Later calls in the same
            # model round are still prepared independently so one deferred
            # target never silently erases the rest of the proposed plan.
            from .execution_interceptors import (
                ExecutionInterceptionError,
                before_tool_execution,
            )

            try:
                interception = before_tool_execution(
                    tool_id=tc.name.replace("__", "."),
                    call_id=tc.id,
                    arguments=tc.arguments,
                    ctx=ctx,
                )
            except ExecutionInterceptionError:
                result_by_id[tc.id] = StreamingToolResult(
                    tool_name=tc.name,
                    call_id=tc.id,
                    ok=False,
                    error="execution_interceptor_failed",
                    error_code="EXECUTION_INTERCEPTOR_FAILED",
                    output={
                        "ok": False,
                        "executed": False,
                        "error": "execution_interceptor_failed",
                        "error_code": "EXECUTION_INTERCEPTOR_FAILED",
                        "retryable": False,
                    },
                )
                continue
            if interception is not None:
                output = interception.as_tool_output()
                result_by_id[tc.id] = StreamingToolResult(
                    tool_name=tc.name,
                    call_id=tc.id,
                    output=output,
                    ok=True,
                    summary=interception.summary,
                )
                continue
            operation = None
            if ctx is not None:
                from .operation_ledger import plan_operation

                operation = plan_operation(
                    ctx, tc.name.replace("__", "."), tc.id, tc.arguments
                )
            if budget is not None and budget.remaining_execution_seconds() <= 0:
                result_by_id[tc.id] = self._execution_budget_timeout(
                    tc,
                    may_continue=False,
                )
            else:
                self.max_parallel_width = max(self.max_parallel_width, 1)
                if operation is not None and ctx is not None:
                    from .operation_ledger import start_operation

                    start_operation(ctx.workspace_id, operation["operation_id"])
                operation_token = None
                execution_task: asyncio.Task | None = None
                try:
                    if operation is not None and ctx is not None:
                        from core.tools.context import bind_runtime_operation_context

                        operation_token = bind_runtime_operation_context(
                            ctx.workspace_id,
                            operation["operation_id"],
                            tc.id,
                        )
                    execution = self._execute_one(tc, ctx=ctx, budget=budget)
                    if budget is None:
                        result_by_id[tc.id] = await execution
                    else:
                        execution_task = asyncio.create_task(execution)
                        execution_task.add_done_callback(self._consume_detached_task)
                        remaining_seconds = budget.remaining_execution_seconds()
                        if math.isfinite(remaining_seconds):
                            result_by_id[tc.id] = await asyncio.wait_for(
                                asyncio.shield(execution_task),
                                timeout=max(0.001, remaining_seconds),
                            )
                        else:
                            result_by_id[tc.id] = await asyncio.shield(execution_task)
                except asyncio.TimeoutError:
                    if (
                        operation is not None
                        and ctx is not None
                        and execution_task is not None
                    ):
                        execution_task.add_done_callback(
                            lambda done, workspace_id=ctx.workspace_id, op_id=operation["operation_id"]: (
                                self._settle_budget_detached_operation(
                                    done, workspace_id, op_id
                                )
                            )
                        )
                    result_by_id[tc.id] = self._execution_budget_timeout(
                        tc, may_continue=True
                    )
                finally:
                    if operation_token is not None:
                        from core.tools.context import reset_runtime_operation_context

                        reset_runtime_operation_context(operation_token)
            result = result_by_id[tc.id]
            if operation is not None and ctx is not None:
                from .operation_ledger import finish_operation

                final_operation = finish_operation(
                    ctx.workspace_id, operation["operation_id"], result
                )
                output = dict(result.output or {})
                output["operation_id"] = final_operation["operation_id"]
                result.output = output
            if self._result_may_continue(result) and not self._is_read_only_call(tc):
                self._mark_unknown_write_outcome(ctx, tc, result)
        await execute_read_group(read_group)

        # Return in original order
        return [result_by_id[tc.id] for tc in tool_calls]

    @staticmethod
    def _execution_budget_timeout(
        tool_call: LLMToolCall,
        *,
        may_continue: bool,
    ) -> StreamingToolResult:
        error = (
            "tool execution exceeded the remaining request budget; outcome may be uncertain"
            if may_continue
            else "tool execution was not started because the remaining request budget was exhausted"
        )
        error_code = (
            "TOOL_BUDGET_TIMEOUT_UNCERTAIN" if may_continue else "TOOL_BUDGET_EXHAUSTED"
        )
        return StreamingToolResult(
            tool_name=tool_call.name,
            call_id=tool_call.id,
            output={
                "ok": False,
                "executed": False if not may_continue else True,
                "error_code": error_code,
                "error": error,
                "retryable": False,
                "execution_may_continue": may_continue,
            },
            ok=False,
            error=error,
            error_code=error_code,
            execution_may_continue=may_continue,
        )

    @staticmethod
    def _consume_detached_task(task: asyncio.Task) -> None:
        if task.cancelled():
            return
        try:
            task.exception()
        except asyncio.CancelledError:
            return

    @staticmethod
    def _settle_budget_detached_operation(
        task: asyncio.Task,
        workspace_id: str,
        operation_id: str,
    ) -> None:
        """Persist eventual truth when the request budget expires first."""
        if task.cancelled():
            return
        try:
            result = task.result()
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001 -- detached tool tasks may raise any registered-handler exception
            return
        if not isinstance(result, StreamingToolResult) or result.execution_may_continue:
            return
        output = result.output if isinstance(result.output, dict) else {}
        tracking = (
            output.get("tracking") if isinstance(output.get("tracking"), dict) else {}
        )
        resource_id = str(
            output.get("subtask_id")
            or output.get("task_id")
            or output.get("job_id")
            or ""
        )
        resource_kind = str(tracking.get("domain") or "")
        if not resource_kind and output.get("subtask_id"):
            resource_kind = "subagent"
        elif not resource_kind and output.get("job_id"):
            resource_kind = "job"
        try:
            from .operation_ledger import settle_operation

            settle_operation(
                workspace_id,
                operation_id,
                status=(
                    "blocked"
                    if output.get("executed") is False
                    else "succeeded"
                    if result.ok
                    else "failed"
                ),
                resolved_by="request_budget_handler",
                error_code=result.error_code,
                error=str(result.error or ""),
                result_summary=str(output.get("summary") or result.summary or ""),
                resource_kind=resource_kind,
                resource_id=resource_id,
            )
        except (FileNotFoundError, OSError, RuntimeError, TypeError, ValueError):
            return

    async def _execute_one(
        self,
        tc: LLMToolCall,
        *,
        ctx: StatelessContext | None = None,
        budget=None,
    ) -> StreamingToolResult:
        """Execute a single tool call via the tool runtime client."""
        tool_id = tc.name.replace("__", ".")
        if self._emitter:
            try:
                action = str((tc.arguments or {}).get("action") or "")
                self._emitter.emit(
                    "execution_started",
                    {
                        "stage": "execution_started",
                        "tool": tool_id,
                        "action": action,
                        "call_id": tc.id,
                    },
                )
            except Exception:
                pass
        if ctx is not None and hasattr(self._runtime, "execute_node"):
            node = ExecutionNode(
                id=tc.id,
                tool=tool_id,
                args=dict(tc.arguments or {}),
            )
            result = await self._runtime.execute_node(node, ctx, {})
            result = self._normalize_read_timeout_for_retry(node, result)
            if not result.success:
                if self._has_safe_read_recovery(node, result):
                    # A registered handler can declare one typed, read-only
                    # fallback. It is deterministic evidence, not a transient
                    # failure, so the unchanged call is never retried.
                    ctx.extras.setdefault("retry_events", []).append(
                        {
                            "tool_id": node.tool,
                            "node_id": node.id,
                            "retry_allowed": False,
                            "reason": "safe_read_recovery_requires_changed_call",
                            "error_code": "SAFE_READ_RECOVERY",
                        }
                    )
                else:
                    result = await self._maybe_retry_node(node, ctx, result, budget)
            return self._from_tool_result(result, fallback_call_id=tc.id)

        # Context-free fallback: only reached in isolated unit test harnesses or when
        # runtime lacks execute_node. Production agent turns always provide StatelessContext
        # and invoke through execute_node with full contracts, retry budget, and audit trails.
        _LOG.debug("Invoking raw tool %s (context-free test fallback)", tool_id)
        try:
            # Map LLM name (dots → underscores) back to canonical tool_id
            _t0 = time.monotonic()
            result = await asyncio.to_thread(
                self._runtime.invoke_raw, tool_id, tc.arguments
            )
            _latency = (time.monotonic() - _t0) * 1000
            return StreamingToolResult(
                tool_name=tool_id,
                call_id=tc.id,
                output=result,
                ok=result.get("ok", False),
                error=result.get("error"),
                latency_ms=float(_latency),
                error_code=str(result.get("error_code") or ""),
                execution_may_continue=bool(result.get("execution_may_continue")),
            )
        except Exception as e:
            return StreamingToolResult(
                tool_name=tc.name,
                call_id=tc.id,
                output={},
                ok=False,
                error=_redact_tool_error(e),
            )

    @staticmethod
    def _from_tool_result(
        result: ToolResult, *, fallback_call_id: str
    ) -> StreamingToolResult:
        output = result.data if isinstance(result.data, dict) else {"data": result.data}
        if not result.success and result.error:
            output = {**(output or {}), "error": result.error}
        metadata = dict(result.metadata or {})
        if result.retry_count:
            metadata["retry_count"] = result.retry_count
        if metadata:
            output = {**(output or {}), "metadata": metadata}
        may_continue = bool(
            metadata.get("execution_may_continue")
            or output.get("execution_may_continue")
        )
        error_code = str(result.error_code or "")
        return StreamingToolResult(
            tool_name=result.tool,
            call_id=result.node_id or fallback_call_id,
            output=output or {},
            ok=bool(result.success),
            error=result.error,
            latency_ms=float(result.latency_ms or 0.0),
            error_code=error_code,
            execution_may_continue=may_continue,
            summary=str(getattr(result, "summary", "") or ""),
        )
