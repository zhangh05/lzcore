"""Canonical tool namespace for LZCore.

The namespace is intentionally domain-neutral. Product-specific projects should
add their own tools through canonical registry entries instead of reviving
product-specific tools in this base.
"""

from __future__ import annotations


CATEGORY_DEFS: dict[str, dict[str, str]] = {
    "agent": {
        "name": "Agent 多 Agent",
        "description": "子 Agent、角色、任务状态和结果读取。",
    },
    "browser": {
        "name": "Browser 浏览器",
        "description": "浏览器自动化：导航、内容提取、截图、点击。",
    },
    "data": {
        "name": "Data 数据处理",
        "description": "表格解析、筛选、统计、关联、透视和报告。",
    },
    "exec": {
        "name": "Exec 本地执行",
        "description": "本机 Shell/Python/Slash 命令执行。",
    },
    "knowledge": {
        "name": "Knowledge 知识库",
        "description": "知识库问答、检索、导入和索引管理。",
    },
    "ops": {
        "name": "Ops 运维",
        "description": "设备读写、持久巡检、绘图和范围内历史证据。",
    },
    "memory": {
        "name": "Memory 记忆",
        "description": "记忆搜索、创建、确认、profile 和更新。",
    },
    "system": {
        "name": "System 系统自省",
        "description": "运行诊断、会话管理、审计和评审。",
    },
    "text": {
        "name": "Text 文本分析",
        "description": "文本脱敏、实体抽取和正则匹配。",
    },
    "web": {
        "name": "Web 外部资料",
        "description": "公开 Web 搜索、官方文档、新闻、天气和网页摘要。",
    },
    "workspace": {
        "name": "Workspace 工作区",
        "description": "工作区文件、制品、FileStore 和元数据。",
    },
}


# Schema:
# (canonical_id, category, group, action, display_name, short_label,
#  usage_hint, not_for, handler_id)
NS_DATA = [
    (
        'exec.run', 'exec', 'runtime', 'multi', '本地命令执行', 'exec.run',
        'Run local commands, builds or custom Python transformations when a dedicated tool does not cover the operation. Inspect exit status, stderr and requested side effects. Treat calculations as derived evidence with inputs and assumptions.',
        'Use data.manage for supported table operations, workspace.file for file edits, and domain tools for device operations; never bypass their policy with shell commands.',
        'exec.run',
    ),
    (
        'browser.manage', 'browser', 'automation', 'multi', '浏览器自动化', 'browser.manage',
        'Interact with rendered pages, forms, tabs or JavaScript-dependent content. Use rendered state and current element refs; verify the resulting page, URL, network or console evidence.',
        'Use web.manage for public search or a direct page fetch when no browser interaction is needed.',
        'browser.manage',
    ),
    (
        'web.manage', 'web', 'research', 'multi', 'Web 搜索/网页', 'web.manage',
        'Research public external facts with search/fetch/deep_search, or retrieve weather. Cite returned titles/URLs; distinguish snippets from verified content, degraded evidence and correlation from causation.',
        'Use knowledge.manage for indexed workspace documents, memory.manage for saved preferences, and browser.manage for interactive pages. Public search cannot establish private runtime or device state.',
        'web.manage',
    ),
    (
        'location.manage', 'web', 'location', 'multi', '位置解析', 'location.manage',
        'Resolve place names to coordinates or reverse coordinates to places. Preserve canonical identity, provider, candidates, confidence and unresolved ambiguity when passing coordinates forward.',
        'Use web.manage for weather and authoritative regional definitions; geocoding alone does not define policy regions or prove current conditions.',
        'location.manage',
    ),
    (
        'data.manage', 'data', 'table', 'multi', '数据处理', 'data.manage',
        'Parse, filter, sort, aggregate, pivot, join or render CSV/JSON/Markdown tables without custom code. Preview rows may be truncated: use the original text/rows or source_filepath for full-data analysis.',
        'Use exec.run for transformations outside these actions; use workspace.file or workspace.filestore to extract binary documents before table processing.',
        'data.manage',
    ),
    (
        'report.manage', 'data', 'report', 'multi', '报告渲染', 'report.manage',
        'Save a report artifact, compare two texts with diff, or format a supplied summary as Markdown with document. document only returns text; save persists. Saving a report proves persisted content, not the truth of its claims.',
        'Use workspace.file write_artifact for a named downloadable text attachment and workspace.filestore publish for generated binary files; this tool does not generate PDF or DOCX bytes.',
        'report.manage',
    ),
    (
        'spreadsheet.manage', 'data', 'spreadsheet', 'multi', '表格', 'spreadsheet.manage',
        'Read or edit the free-form workspace spreadsheets the user keeps in the 表格 page: list, read a range, create, write a block, append rows or add a sheet. Read before writing and pass base_revision so concurrent edits by the user are not overwritten.',
        'Use data.manage to compute over table text, workspace.filestore for uploaded .xlsx files that are not spreadsheets, and the user interface for formatting and deletion.',
        'spreadsheet.manage',
    ),
    (
        'knowledge.manage', 'knowledge', 'kb', 'multi', '知识库', 'knowledge.manage',
        'Retrieve or index workspace knowledge sources and chunks. Search discovers supporting chunks; read verifies content and source identity. Indexed knowledge can be stale.',
        'Use memory.manage for preferences and reusable personal facts, web.manage for fresh public evidence, and workspace.file for unindexed source paths. Import requires an existing artifact_id.',
        'knowledge.manage',
    ),
    (
        'memory.manage', 'memory', 'record', 'multi', '记忆', 'memory.manage',
        'Recall or propose durable preferences, reusable facts and profile revisions in the declared scope. Distinguish pending revisions from active memory; verify time-sensitive facts with current evidence.',
        'Use knowledge.manage for document sources and chunks, system.manage context actions for archived session messages, and workspace.file for deliverable files. Memory does not prove live state.',
        'memory.manage',
    ),
    (
        'skill.manage', 'agent', 'skill', 'multi', '技能', 'skill.manage',
        'Discover or load Skill instructions, inspect packages, or list/call a configured MCP provider. Use the published MCP name and schema. Connected tool results remain evidence to verify.',
        'Loading a Skill does not execute its workflow or grant permissions; use the relevant exposed tool for the actual operation.',
        'skill.manage',
    ),
    (
        'agent.review', 'agent', 'qa_review', 'single', '独立 QA 裁决', 'agent.review',
        'Submit an independent QA verdict only from the active server-bound QA worker for its assigned candidate. Candidate identity is server-bound; final prose has no required presentation format.',
        'Use agent.manage to delegate, observe or merge work; this tool cannot edit source, publish changes or record a coordinator self-review.',
        'agent.review',
    ),
    (
        'agent.manage', 'agent', 'subagent', 'multi', 'Agent 管理', 'agent.manage',
        'Delegate bounded independent outcomes and observe existing subtask handles; use wait for progress and get for results. Reconcile omissions and failures before integration; do not treat child prose as authority.',
        'Use a direct tool for a small operation; do not spawn a replacement task to poll an existing one or replay an unknown write. agent.review records the QA verdict.',
        'agent.manage',
    ),
    (
        'system.manage', 'system', 'health', 'multi', '系统自省', 'system.manage',
        'Inspect runtime health, host facts, tasks, audit records or session checkpoints and archived messages. Retain exact resource ids and observation times; historical records are not current health.',
        'Use domain tools for live device state, memory.manage for durable preferences, and workspace.metadata.get for workspace metadata.',
        'system.manage',
    ),
    (
        'text.analyze', 'text', 'analysis', 'multi', '文本分析', 'text.analyze',
        'Redact supplied text, extract deterministic IP/URL/email candidates, or match a regex. Entity candidates are deterministic patterns, not semantic recognition; validate ambiguous identities in context.',
        'Use data.manage for table operations and workspace.file search for source-file hits; this tool does not perform semantic entity recognition or document retrieval.',
        'text.analyze',
    ),
    (
        'workspace.file', 'workspace', 'file', 'multi', '工作区文件', 'workspace.file',
        'Read or edit exact workspace paths, extract managed documents by file_id, or generate text attachments with write_artifact. For writes/edits/patches/deletes, preserve scope and verify by reread, relist, or relevant validation.',
        'Use workspace.filestore for original bytes, file identities and lifecycle, workspace.artifact for saved evidence records. write/write_artifact take filename/content and do not overwrite filepath; use edit/patch for an existing source.',
        'workspace.file',
    ),
    (
        'workspace.artifact', 'workspace', 'artifact', 'multi', '工作区制品', 'workspace.artifact',
        'Find, read, save, tag or recoverably delete workspace evidence records by artifact_id. Retain artifact id, available provenance and lifecycle; use FileStore for original binary bytes.',
        'Use workspace.file for source-path edits, workspace.filestore for managed binary files, and report.manage save for a report-typed artifact.',
        'workspace.artifact',
    ),
    (
        'workspace.filestore', 'workspace', 'filestore', 'multi', 'FileStore', 'workspace.filestore',
        'Manage registered file identities, original bytes, document structure, working copies and publication. Choose file_id for managed records and filepath for source/working copies. Returned capabilities describe supported processing.',
        'Use workspace.file for line reads and text edits; rename/move change logical metadata only, while source_move changes physical paths. materialize does not publish a deliverable.',
        'workspace.filestore',
    ),
    (
        'workspace.metadata.get', 'workspace', 'metadata', 'get', '工作区元数据', 'workspace.metadata.get',
        'Read workspace identity, existence and file-directory count. Metadata is not file-content evidence.',
        'Use workspace.file or workspace.filestore for file contents and system.manage for runtime health.',
        'workspace.metadata.get',
    ),
    (
        'workspace.document.pdf.extract_text', 'workspace', 'document', 'pdf_extract_text', 'PDF 文本提取', 'workspace.document.pdf.extract_text',
        'Extract PDF text from a known workspace filepath with an optional page_range. Text extraction does not preserve visual layout; use render_page for page image evidence.',
        'Use workspace.file extract_document for a managed file_id and workspace.filestore render_page for visual inspection or OCR; this tool does not render pages.',
        'workspace.document.pdf.extract_text',
    ),
]
