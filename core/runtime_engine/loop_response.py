"""Evidence-based terminal response projection without new execution."""

from __future__ import annotations

from typing import Any

from .evidence import evidence_manifest
from .loop_messages import StreamingToolResult
from .models import StatelessContext
from .tracking import extract_tracking_payload, normalize_tracking_payload


class LoopResponseProjection:
    """Evidence-based terminal response projection without new execution. Shared context belongs to the QueryLoop driver."""

    def _build_tool_result_fallback(
        self,
        ctx: StatelessContext,
        results: list[StreamingToolResult],
    ) -> str:
        """Build a useful final answer when the LLM returns empty text.
        Produces a human-readable report, not raw JSON dumps.
        """
        lines: list[str] = []
        ok_count = 0
        warn_count = 0
        fail_count = 0

        for r in results:
            output = r.output if isinstance(r.output, dict) else {}
            exit_code = output.get("exit_code")

            # Classify by exit_code for exec.run tools
            if not r.ok:
                fail_count += 1
            elif exit_code is not None and exit_code != 0:
                warn_count += 1
            else:
                ok_count += 1

        # Prefer the canonical evidence ledger over a generic retry message.
        # This path is deterministic and intentionally avoids inventing a
        # semantic conclusion, but still returns every verified observation
        # and durable reference when both synthesis attempts fail.
        manifest = evidence_manifest(ctx.extras) if ctx is not None else []
        if manifest and not all(
            r.tool_name.replace("__", ".") == "web.manage" for r in results
        ):
            lines = [
                "本次证据采集已完成，但模型未能生成综合分析。以下为系统保留的可核验结果：",
                "",
            ]
            for index, item in enumerate(manifest, 1):
                coverage = (
                    item.get("coverage")
                    if isinstance(item.get("coverage"), dict)
                    else {}
                )
                status = str(coverage.get("status") or "succeeded")
                summary = str(
                    item.get("summary") or item.get("source_tool") or "工具结果"
                )
                reference = (
                    item.get("reference")
                    if isinstance(item.get("reference"), dict)
                    else {}
                )
                ref = str(
                    reference.get("artifact_id")
                    or reference.get("call_id")
                    or item.get("evidence_id")
                    or ""
                )
                lines.append(
                    f"{index}. [{status}] {summary}"
                    + (f"（证据：{ref}）" if ref else "")
                )
            if fail_count:
                lines.extend(
                    ["", f"另有 {fail_count} 项工具观察失败，未据此推断外部状态。"]
                )
            lines.extend(
                [
                    "",
                    "原始大型结果已保存为证据制品，可在后续请求中继续分析，无需重复执行已成功的操作。",
                ]
            )
            return "\n".join(lines)

        # No typed evidence exists (for example an old producer contract).
        # Keep this bounded rather than exposing raw commands or paths.
        if not (
            results
            and all(r.tool_name.replace("__", ".") == "web.manage" for r in results)
        ):
            if fail_count:
                return "本次处理未能形成可靠答复，系统已停止重复尝试。"
            return "工具已执行，但未形成可供综合分析的证据记录。"

        if results and all(
            r.tool_name.replace("__", ".") == "web.manage" for r in results
        ):
            lines.append("联网处理结果：")
        else:
            lines.append(
                f"工具调用：成功 {ok_count} 个"
                + (f"，警告 {warn_count} 个" if warn_count else "")
                + f"，失败 {fail_count} 个"
            )

        for r in results:
            output = r.output if isinstance(r.output, dict) else {}
            exit_code = output.get("exit_code")
            ec_mark = (
                "⚠️ " if (r.ok and exit_code is not None and exit_code != 0) else ""
            )
            status_mark = "❌" if not r.ok else (ec_mark or "✅")

            if r.tool_name.replace("__", ".") == "web.manage":
                web_summary = self._build_web_result_fallback_line(r, output)
                if web_summary:
                    lines.append(web_summary)
                    continue

            lines.append(f"\n### {status_mark} {r.tool_name}")

            # ── exec.run: show command, exit_code, stdout, stderr ──
            if r.tool_name in ("exec.run", "exec__run", "exec__background"):
                desc = output.get("description") or output.get("command", "")
                if desc:
                    lines.append(f"> `{str(desc)}`")
                if exit_code is not None:
                    ec_str = f"exit_code={exit_code}"
                    if exit_code != 0:
                        lines.append(f"Exit code: **{ec_str}**")
                    else:
                        lines.append(f"Exit: {ec_str}")
                stdout = output.get("stdout", "")
                stderr = output.get("stderr", "")
                if stdout.strip():
                    lines.append(f"```\n{str(stdout)}\n```")
                if stderr.strip():
                    lines.append(f"```\n{str(stderr)}\n```")

            # ── other tools: compact summary ──
            else:
                summary = str(output.get("summary") or output.get("message") or "")
                if summary:
                    lines.append(summary)
                elif not r.ok:
                    lines.append(f"error: {r.error}")

            # Error message if any
            if r.error:
                hint = self._canonical_tool_hint(r.tool_name)
                if hint:
                    lines.append(
                        f"错误: `{r.tool_name}` 不存在: {r.error}；应使用 `{hint}`"
                    )
                else:
                    lines.append(f"错误: `{r.tool_name}` 调用失败: {r.error}")

        # Tracking info
        tracking_items: list[dict[str, Any]] = []
        for r in results:
            tracking = extract_tracking_payload(r.output)
            if tracking:
                tracking_items.append(normalize_tracking_payload(tracking))

        if tracking_items:
            lines.append("")
            latest = tracking_items[-1]
            task_id = latest.get("task_id") or ""
            status = latest.get("status") or "unknown"
            done = bool(latest.get("done"))
            progress = latest.get("progress") or {}
            completed = progress.get("completed")
            total = progress.get("total")
            lines.append(
                f"跟踪任务 `{task_id}`：{status}，{'已完成' if done else '进行中'}"
            )
            if completed is not None and total is not None:
                lines.append(f"进度：{completed}/{total}")
            report_url = (
                latest.get("report_url")
                or latest.get("html_url")
                or latest.get("artifact_url")
            )
            if report_url:
                lines.append(f"报告链接：{report_url}")

        return "\n".join(lines)

    def _build_web_result_fallback_line(
        self, result: StreamingToolResult, output: dict[str, Any]
    ) -> str:
        payload = (
            output.get("output") if isinstance(output.get("output"), dict) else output
        )
        provider = str(payload.get("provider") or "")
        status = str(payload.get("status") or "")
        summary = str(payload.get("summary") or result.error or "")
        web_results = (
            payload.get("results") if isinstance(payload.get("results"), list) else []
        )

        if result.ok and web_results:
            lines = ["\n### 🌐 联网结果"]
            if status == "partial" or provider == "curated_official_fallback":
                lines.append(
                    "搜索引擎暂时不可用，我先拿到了可继续读取的官方来源候选；这还不是完整搜索摘要。"
                )
            else:
                lines.append(f"已拿到 {len(web_results)} 条网页结果。")
            for item in web_results[:5]:
                title = str(item.get("title") or "网页结果")
                url = str(item.get("url") or "")
                snippet = str(item.get("snippet") or "")
                line = f"- {title}"
                if url:
                    line += f"：{url}"
                if snippet:
                    line += f" — {snippet[:220]}"
                lines.append(line)
            hint = str(payload.get("answer_hint") or "")
            if hint:
                lines.append(f"\n说明：{hint}")
            return "\n".join(lines)

        if not result.ok:
            lines = ["\n### 🌐 联网搜索未完成"]
            if summary:
                lines.append(summary)
            lines.append(
                "当前失败发生在搜索服务侧，不代表服务器完全无法访问互联网；可以稍后重试，或改用更具体的官方 URL 让我直接读取。"
            )
            return "\n".join(lines)

        return ""

    def _canonical_tool_hint(self, tool_name: str) -> str:
        """Suggest the canonical tool id for a category-like hallucination.

        This is a hint only; it does not execute aliases or widen the public
        tool namespace.
        """
        name = (tool_name or "").strip()
        if not name or self._tool_runtime.has_tool(name):
            return ""
        prefix = name + "."
        matches = sorted(t for t in self._tool_registry if t.startswith(prefix))
        return matches[0] if len(matches) == 1 else ""
