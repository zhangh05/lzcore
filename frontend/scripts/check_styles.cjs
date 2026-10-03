/** Parse every product/extension stylesheet; never let browser error recovery
 * hide an unclosed layer or an unlayered rule that outranks the whole system. */
const fs = require('node:fs');
const path = require('node:path');
const { transform } = require('lightningcss');
const postcss = require('postcss'); // supplied by the existing Vite toolchain
const root = path.resolve(__dirname, '../..');
const known = new Set(['runtime', 'base', 'shell', 'console', 'workbench', 'typography', 'pages', 'extension', 'responsive']);
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.css')) files.push(file);
  }
}
walk(path.join(root, 'frontend/src'));
walk(path.join(root, 'extensions/network_operations/frontend'));
const failures = [];
for (const file of files) {
  if (fs.statSync(file).size > 16 * 1024) {
    failures.push(`${file}: stylesheet exceeds 16 KiB; split by component ownership`);
  }
  let ast;
  try {
    const source = fs.readFileSync(file);
    transform({ filename: file, code: source, errorRecovery: false });
    ast = postcss.parse(source.toString('utf8'), { from: file });
  }
  catch (error) { failures.push(error.message); continue; }
  ast.walkAtRules('layer', rule => {
    for (const name of rule.params.split(',').map(value => value.trim())) {
      if (!known.has(name)) failures.push(`${file}:${rule.source.start.line}: unknown layer ${name}`);
    }
  });
  ast.walkRules(rule => {
    let layered = false;
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule' && parent.name === 'layer') layered = true;
    }
    if (!layered) failures.push(`${file}:${rule.source.start.line}: rule outside declared layer: ${rule.selector}`);
  });
}
if (process.argv.includes('--built')) {
  const dist = path.join(root, 'frontend/dist');
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const href = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/);
  if (!href) throw new Error('Production entry stylesheet missing');
  const declaration = postcss.parse(fs.readFileSync(path.join(root, 'frontend/src/styles/layers.css'), 'utf8'))
    .nodes.find(node => node.type === 'atrule' && node.name === 'layer');
  const expected = declaration.params.split(',').map(name => name.trim());
  const seen = [];
  const built = postcss.parse(fs.readFileSync(path.join(dist, href[1].replace(/^\//, '')), 'utf8'));
  built.walkAtRules('layer', rule => {
    for (const name of rule.params.split(',').map(value => value.trim())) {
      if (!seen.includes(name)) seen.push(name);
    }
  });
  if (JSON.stringify(seen) !== JSON.stringify(expected)) {
    failures.push(`Production cascade order differs from layers.css: ${seen.join(', ')}`);
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`CSS syntax and cascade ownership verified: ${files.length} stylesheets.`);
