import {createRequire} from 'node:module';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const publicRoot = /^\/(?:data|maps|custom-map|terrain|terrain-regions|api|offline-map|_offline|_next|assets|fonts|downloads|regions|routes|guides|trips|community|account|moderation|about|safety|sources|privacy|terms|android|search|planner|offline-fonts\.css|offline-safety(?:\.(?:html|js|css))?|offline(?:-viewer\.html|\.js|\.css)?|preview|sw\.js|manifest\.webmanifest|favicon\.svg|og-cover\.png|icon-(?:192|512)\.png)(?:[/?#.]|$)/;
const storagePrefixes = ['tropnik-shell-', 'tropnik-staging-', 'tropnik-hike-plans-', 'tropa-local-', 'tropa-auth-change', 'tropa-requests', 'tropnik-checklist', 'tropnik-download-map', 'tropnik-offline-map-change'];
// Map cache names are constructed from this exact prefix. The broad
// "tropnik-map-" family also contains DOM classes and the native bridge type;
// those are runtime contracts, not storage keys, and must keep their spelling.
const mapStorageNames = new Set(['tropnik-map-', 'tropnik-map-attribution-seen']);

export function normalizeBase(value = '/tropnik/') {
  if (!/^\/[a-z0-9][a-z0-9-]*\/$/i.test(value)) throw new Error('Pages base must be one project directory, for example /tropnik/.');
  return value;
}

export function pagesPath(value, base, root = false) {
  if (value.startsWith(base) || value.startsWith('//')) return value;
  if (publicRoot.test(value) || value.startsWith('/?') || (root && value === '/')) return base + value.slice(1);
  return value;
}

function storageName(value, namespace) {
  return mapStorageNames.has(value) || storagePrefixes.some(prefix => value.startsWith(prefix)) ? namespace + '-' + value : value;
}

function isNavigationRoot(node) {
  const parent = node.parent;
  if (ts.isJsxAttribute(parent)) return ['href', 'src', 'action'].includes(parent.name.text);
  if (ts.isBinaryExpression(parent)) {
    const comparison = [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind);
    return comparison && /\blocation\.pathname\b/.test(parent.getText());
  }
  if (ts.isConditionalExpression(parent)) return /(?:history\.|location\.|href)/.test(parent.parent?.getText() || '');
  if (ts.isCallExpression(parent)) return /(?:history\.(?:pushState|replaceState)|location\.(?:assign|replace))/.test(parent.expression.getText());
  if (ts.isPropertyAssignment(parent)) return ['href', 'start_url', 'scope', 'id'].includes(parent.name.getText().replace(/["']/g, ''));
  return false;
}

/** Change project URL literals only. Separators, regexes, shaders and package/relative imports stay untouched. */
export function rewriteScript(code, filename, {base, namespace = base.slice(1, -1)}) {
  const kind = /\.[jt]sx$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, kind);
  const edits = [];
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) {
      if ((ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) && node.parent.moduleSpecifier === node && !publicRoot.test(node.text)) return;
      const before = node.text;
      const rewrite = value => storageName(pagesPath(value, base, isNavigationRoot(node)), namespace);
      // The shared production bundle can pack URL arrays into a literal split.
      // Rewrite every resulting URL, preserving the exact separator and values.
      const member=node.parent,call=member?.parent;
      const separator=member&&ts.isPropertyAccessExpression(member)&&member.expression===node&&member.name.text==='split'
        &&call&&ts.isCallExpression(call)&&call.expression===member&&call.arguments.length===1?call.arguments[0]:null;
      const split=separator&&(ts.isStringLiteral(separator)||ts.isNoSubstitutionTemplateLiteral(separator))&&separator.text;
      const after = split ? before.split(split).map(rewrite).join(split) : rewrite(before);
      if (before !== after) {
        const start = node.getStart(source) + 1;
        const end = node.end - (ts.isTemplateHead(node) ? 2 : 1);
        edits.push([start, end, after]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) code = code.slice(0, start) + value + code.slice(end);
  return code;
}

export function rewriteJSON(value, base) {
  if (typeof value === 'string') return pagesPath(value, base, true);
  if (Array.isArray(value)) return value.map(item => rewriteJSON(item, base));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteJSON(item, base)]));
  return value;
}

export function rewriteHTML(value, base) {
  return value.replace(/\b(href|src|action|poster|content)=(['"])(\/[^'"\s]*)\2/g, (match, attr, quote, url) => `${attr}=${quote}${pagesPath(url, base, true)}${quote}`);
}

export function rewriteCSS(value, base) {
  return value.replace(/url\(\s*(['"]?)(\/[^)\s'"]+)\1\s*\)/g, (match, quote, url) => `url(${quote}${pagesPath(url, base)}${quote})`);
}

export {ts};
