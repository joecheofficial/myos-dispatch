'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules, createRequire } = require('node:module');
const BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, '')));

// Conservative approval inventory, not a JavaScript sandbox. Audited handlers
// must declare every non-builtin module in their transitive execution closure.
function dependencyContents(recipe, approvedDependencies) {
  if (!recipe.handler) return [];
  const manifest = JSON.parse(fs.readFileSync(recipe.filePath, 'utf8'));
  const declared = new Set((approvedDependencies || manifest.executableDependencies || []).map(file => fs.realpathSync(path.resolve(path.dirname(recipe.filePath), file))));
  const queue = [fs.realpathSync(recipe.handler)], seen = new Set(), contents = [];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    contents.push([file, text]);
    if (file.endsWith('.json')) continue;
    if (/\b(?:eval|Function)\s*\(|\bimport\s*\(|\brequire\s*\(\s*[^'"\s]/.test(text)) throw new Error('dynamic_dependency_not_approved');
    const imports = [...text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bfrom\s+['"]([^'"]+)['"]/g)];
    for (const match of imports) {
      const specifier = match[1] || match[2];
      if (BUILTINS.has(specifier.replace(/^node:/,''))) continue;
      const resolved = fs.realpathSync(createRequire(file).resolve(specifier));
      if (!declared.has(resolved)) throw new Error('undeclared_executable_dependency');
      queue.push(resolved);
    }
  }
  return contents.sort(([a],[b]) => a.localeCompare(b));
}
module.exports = { dependencyContents };
