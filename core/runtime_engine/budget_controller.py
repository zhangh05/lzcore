"""Structural execution budgets for the SSOT Runtime Engine.

Aggregate wall-clock limits are opt-in (a value greater than zero). The agent
loop must not be stopped merely because useful work spans a long-running task;
individual provider and tool transports retain their own timeout contracts.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .models import ExecutionBudget, SSOTRuntimeConfig


@dataclass
class BudgetStatus:
    """Current budget consumption status."""
    ok: bool = True
    exceeded: str = ""
    elapsed_total_ms: float = 0.0
    llm_calls_used: int = 0
    nodes_used: int = 0


class BudgetController:
    """Enforces execution budget across all pipeline stages."""

    def __init__(self, config: SSOTRuntimeConfig | None = None):
        cfg = config or SSOTRuntimeConfig()
        self._budget = ExecutionBudget(
            max_total_seconds=cfg.max_total_seconds,
            max_planner_seconds=cfg.planner_timeout_ms // 1000,
            max_tool_seconds=cfg.max_tool_seconds,
            max_nodes=cfg.max_nodes,
            max_depth=cfg.max_depth,
            max_parallel_width=cfg.max_layer_concurrency,
            max_llm_calls=cfg.max_llm_calls,
        )
        self._start_time = time.monotonic()
        self._llm_calls = 0
        self._nodes_used = 0
        self._tool_elapsed_ms = 0.0
        self._tool_stage_started_at: float | None = None
        self.exceeded = ""

    @property
    def budget(self) -> ExecutionBudget:
        return self._budget

    def check_planner(self) -> BudgetStatus:
        """Check budget before planner call."""
        elapsed = (time.monotonic() - self._start_time) * 1000
        limit_ms = self._budget.max_planner_seconds * 1000
        if limit_ms > 0 and elapsed > limit_ms:
            return BudgetStatus(ok=False, exceeded="PLANNER_TIMEOUT", elapsed_total_ms=elapsed)
        return BudgetStatus(ok=True, elapsed_total_ms=elapsed)

    def check_llm_call(self) -> BudgetStatus:
        """Reserve one call; zero retains the unbounded telemetry contract."""
        status = self.check_execution()
        if not status.ok:
            return status
        if self._budget.max_llm_calls > 0 and self._llm_calls >= self._budget.max_llm_calls:
            return self._exhausted("MAX_LLM_CALLS")
        self._llm_calls += 1
        return BudgetStatus(ok=True, elapsed_total_ms=status.elapsed_total_ms, llm_calls_used=self._llm_calls)

    def _exhausted(self, reason: str) -> BudgetStatus:
        self.exceeded = self.exceeded or reason
        return BudgetStatus(ok=False, exceeded=self.exceeded,
                            elapsed_total_ms=self.elapsed_ms(),
                            llm_calls_used=self._llm_calls, nodes_used=self._nodes_used)

    def check_execution(self) -> BudgetStatus:
        """Check budget mid-execution."""
        elapsed = (time.monotonic() - self._start_time) * 1000
        tool_elapsed = self._tool_elapsed_ms
        if self._tool_stage_started_at is not None:
            tool_elapsed += (time.monotonic() - self._tool_stage_started_at) * 1000

        if self.exceeded:
            return self._exhausted(self.exceeded)
        if self._budget.max_total_seconds > 0 and elapsed >= self._budget.max_total_seconds * 1000:
            return self._exhausted("MAX_TOTAL_SECONDS")
        if self._budget.max_tool_seconds > 0 and tool_elapsed >= self._budget.max_tool_seconds * 1000:
            return self._exhausted("MAX_TOOL_SECONDS")
        return BudgetStatus(ok=True, elapsed_total_ms=elapsed)

    def reserve_execution_batch(
        self,
        *,
        node_count: int,
        depth: int,
        parallel_width: int,
    ) -> BudgetStatus:
        """Atomically reserve one validated graph batch before execution."""
        status = self.check_execution()
        if not status.ok:
            status.nodes_used = self._nodes_used
            return status
        node_count = max(0, int(node_count))
        depth = max(0, int(depth))
        parallel_width = max(0, int(parallel_width))
        for limit, used, reason in (
            (self._budget.max_nodes, self._nodes_used + node_count, "MAX_NODES"),
            (self._budget.max_depth, depth, "MAX_DEPTH"),
            (self._budget.max_parallel_width, parallel_width, "MAX_PARALLEL_WIDTH"),
        ):
            if limit > 0 and used > limit:
                return self._exhausted(reason)
        self._nodes_used += node_count
        return BudgetStatus(
            ok=True,
            elapsed_total_ms=status.elapsed_total_ms,
            nodes_used=self._nodes_used,
        )

    def remaining_execution_seconds(self) -> float:
        """Return active aggregate time remaining, or infinity when unbounded."""
        if not self.check_execution().ok:
            return 0.0
        remaining = [float("inf")]
        if self._budget.max_total_seconds > 0:
            remaining.append(self._budget.max_total_seconds - self.elapsed_ms() / 1000)
        if self._budget.max_tool_seconds > 0 and self._tool_stage_started_at is not None:
            remaining.append(self._budget.max_tool_seconds - self.tool_elapsed_ms / 1000)
        return max(0.0, min(remaining))

    def remaining_node_capacity(self) -> int:
        """Return how many execution nodes may still be reserved this turn."""
        if self._budget.max_nodes > 0:
            return max(0, self._budget.max_nodes - self._nodes_used)
        return 2_147_483_647

    def begin_execution(self) -> None:
        """Start a tool stage without charging prior LLM/context time."""
        if self._tool_stage_started_at is None:
            self._tool_stage_started_at = time.monotonic()

    def end_execution(self) -> None:
        """Accumulate the current tool stage exactly once."""
        if self._tool_stage_started_at is None:
            return
        self._tool_elapsed_ms += (time.monotonic() - self._tool_stage_started_at) * 1000
        self._tool_stage_started_at = None

    @property
    def tool_elapsed_ms(self) -> float:
        elapsed = self._tool_elapsed_ms
        if self._tool_stage_started_at is not None:
            elapsed += (time.monotonic() - self._tool_stage_started_at) * 1000
        return elapsed

    def elapsed_ms(self) -> float:
        return (time.monotonic() - self._start_time) * 1000

    @property
    def llm_calls(self) -> int:
        return self._llm_calls

    @property
    def nodes_used(self) -> int:
        return self._nodes_used
