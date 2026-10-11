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
        'Inspect exit status, stderr and requested side effects. Treat calculations as derived evidence with inputs and assumptions.',
        '',
        'exec.run',
    ),
    (
        'browser.manage', 'browser', 'automation', 'multi', '浏览器自动化', 'browser.manage',
        'Use rendered state and current element refs; verify the resulting page, URL, network or console evidence.',
        '',
        'browser.manage',
    ),
    (
        'web.manage', 'web', 'research', 'multi', 'Web 搜索/网页', 'web.manage',
        'Cite returned titles/URLs; distinguish snippets from verified content, degraded evidence and correlation from causation.',
        '',
        'web.manage',
    ),
    (
        'location.manage', 'web', 'location', 'multi', '位置解析', 'location.manage',
        'Preserve canonical identity, provider, candidates, confidence and unresolved ambiguity when passing coordinates forward.',
        '',
        'location.manage',
    ),
    (
        'data.manage', 'data', 'table', 'multi', '数据处理', 'data.manage',
        'Preview rows may be truncated: use the original text/rows or source_filepath for full-data analysis.',
        '',
        'data.manage',
    ),
    (
        'report.manage', 'data', 'report', 'multi', '报告渲染', 'report.manage',
        'Saving a report proves persisted content, not the truth of its claims.',
        '',
        'report.manage',
    ),
    (
        'knowledge.manage', 'knowledge', 'kb', 'multi', '知识库', 'knowledge.manage',
        'Search discovers supporting chunks; read verifies content and source version. Indexed knowledge can be stale.',
        '',
        'knowledge.manage',
    ),
    (
        'memory.manage', 'memory', 'record', 'multi', '记忆', 'memory.manage',
        'Distinguish pending revisions from active memory; verify time-sensitive facts with current evidence.',
        '',
        'memory.manage',
    ),
    (
        'skill.manage', 'agent', 'skill', 'multi', '技能', 'skill.manage',
        'Use the published MCP name and schema. Connected tool results remain evidence to verify.',
        '',
        'skill.manage',
    ),
    (
        'agent.review', 'agent', 'qa_review', 'single', '独立 QA 裁决', 'agent.review',
        'Candidate identity is server-bound; final prose has no required presentation format.',
        '',
        'agent.review',
    ),
    (
        'agent.manage', 'agent', 'subagent', 'multi', 'Agent 管理', 'agent.manage',
        'Reconcile omissions and failures before integration; do not treat child prose as authority.',
        '',
        'agent.manage',
    ),
    (
        'system.manage', 'system', 'health', 'multi', '系统自省', 'system.manage',
        'Retain exact resource ids and observation times; historical records are not current health.',
        '',
        'system.manage',
    ),
    (
        'text.analyze', 'text', 'analysis', 'multi', '文本分析', 'text.analyze',
        'Entity candidates are deterministic patterns, not semantic recognition; validate ambiguous identities in context.',
        '',
        'text.analyze',
    ),
    (
        'workspace.file', 'workspace', 'file', 'multi', '工作区文件', 'workspace.file',
        'For writes/edits/patches/deletes, preserve scope and verify by reread, relist, or relevant validation.',
        '',
        'workspace.file',
    ),
    (
        'workspace.artifact', 'workspace', 'artifact', 'multi', '工作区制品', 'workspace.artifact',
        'Retain artifact id, version, provenance and lifecycle; use FileStore for original binary bytes.',
        '',
        'workspace.artifact',
    ),
    (
        'workspace.filestore', 'workspace', 'filestore', 'multi', 'FileStore', 'workspace.filestore',
        'Choose file_id for managed records and filepath for source/working copies. Returned capabilities describe supported processing.',
        '',
        'workspace.filestore',
    ),
    (
        'workspace.metadata.get', 'workspace', 'metadata', 'get', '工作区元数据', 'workspace.metadata.get',
        'Metadata is not file-content evidence.',
        '',
        'workspace.metadata.get',
    ),
    (
        'workspace.document.pdf.extract_text', 'workspace', 'document', 'pdf_extract_text', 'PDF 文本提取', 'workspace.document.pdf.extract_text',
        'Text extraction does not preserve visual layout; use render_page for page image evidence.',
        '',
        'workspace.document.pdf.extract_text',
    ),
]
