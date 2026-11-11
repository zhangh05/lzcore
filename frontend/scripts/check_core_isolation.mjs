#!/usr/bin/env node
/**
 * 核心隔离检查：
 *  1. src/ 不得 import `extensions/**`（仓库根扩展目录）或旧 `frontend/` 源码。
 *  2. 源码与配置不得出现真实后端端口 8011 / 审计端口 5273 作为目标（守卫与测试里的禁用断言除外）。
 *  3. 核心源码不得写死 "default" 工作区（迁入的旧拓扑画布只检查工作区回落写法，见下）。
 *  4. 登录文案不得出现「运维」。
 *  5. 扩展前端模块（src/extension-modules/<id>/）只能由注册表 registry.tsx 引用，核心页面不得直接 import。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|css)$/.test(name)) files.push(p);
  }
}
walk(join(root, "src"));

const problems = [];
for (const file of files) {
  const rel = relative(root, file);
  const text = readFileSync(file, "utf8");
  const isTest = /\.test\.tsx?$/.test(rel) || rel.startsWith("src/test/");
  if (/from\s+["'][^"']*\.\.\/(\.\.\/)*extensions\//.test(text) || /from\s+["'][^"']*\/frontend\/src\//.test(text)) problems.push(`${rel}: imports extensions/** or old frontend/`);
  if (!isTest && /(8011|5273)/.test(text)) problems.push(`${rel}: mentions forbidden port 8011/5273`);
  // 旧拓扑画布原样迁入（src/extension-modules/network-operations/topology/）：其中 "default" 是按钮样式 / 光标 / 外观来源等 UI 取值，
  // 这里只拦「工作区回落 default」这一类写法；其余目录仍然禁止任何 "default" 字面量。
  // Arc UI 第三方组件（src/components/arc/）同理："default" 是组件内部的取值（如复制反馈的 key），只拦工作区回落写法。
  const isMigratedLegacy = rel.startsWith("src/extension-modules/network-operations/topology/") || rel.startsWith("src/components/arc/");
  const workspaceDefault = { test: (t) => t.split("\n").some((line) => /["']default["']/.test(line) && /workspace|\bws\b|\bws_/i.test(line)) };
  if (!isTest && (isMigratedLegacy ? workspaceDefault.test(text) : /["']default["']/.test(text))) problems.push(`${rel}: hard-coded "default"`);
  const inExtModules = rel.startsWith("src/extension-modules/");
  if (!isTest && !inExtModules && /from\s+["'][^"']*extension-modules\/(?!registry["'])[^"']+["']/.test(text)) problems.push(`${rel}: core imports an extension module directly (use registry)`);
  if (!isTest && /LoginPage|contracts\/auth/.test(rel) && /运维/.test(text)) problems.push(`${rel}: login copy mentions 运维`);
}
if (problems.length) {
  console.error("core isolation check FAILED:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`core isolation check passed (${files.length} files)`);
