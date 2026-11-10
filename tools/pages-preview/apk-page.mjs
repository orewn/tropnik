import {APK_FILES, apkFileName, validateApkManifest} from './apk-artifact.mjs';
import {pagesPath, ts} from './paths.mjs';

/** Inspect the real download anchor without executing page code. */
function inspectAndroidPageDownload(code, metadata, {base = ''} = {}) {
  validateApkManifest(metadata);
  const source = ts.createSourceFile('android/page.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const manifestImport = source.statements.find(node => ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@/public/downloads/android-manifest.json');
  const manifestName = !manifestImport?.importClause?.isTypeOnly && manifestImport?.importClause?.name?.text;
  const path = `/downloads/${apkFileName(metadata)}`;
  const expected = `${base ? pagesPath(path, base) : path}?sha256=${metadata.sha256}`;
  const downloads = [];
  const isManifestProperty = (node, name) => ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) && node.expression.text === manifestName && node.name.text === name;
  function pinnedHref(value, architecture) {
    const payloadPath = `/downloads/${APK_FILES[architecture]}`;
    const expectedHref = `${base ? pagesPath(payloadPath, base) : payloadPath}?sha256=${metadata.sha256}`;
    let href;
    if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) href = value.text;
    else if (value && ts.isTemplateExpression(value) && value.templateSpans.length === 1) {
      const span = value.templateSpans[0];
      if (span.literal.text === '' && isManifestProperty(span.expression, 'sha256')) href = value.head.text + metadata.sha256;
    }
    return href === expectedHref ? href : undefined;
  }
  function selectedHref(value) {
    if (!value || !ts.isConditionalExpression(value)) return pinnedHref(value, metadata.architecture);
    const condition = value.condition;
    if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
        !isManifestProperty(condition.left, 'architecture') || !ts.isStringLiteral(condition.right) || condition.right.text !== 'universal') return undefined;
    // Check both branches so a later manifest promotion cannot activate an unchecked URL.
    const universal = pinnedHref(value.whenTrue, 'universal');
    const arm64 = pinnedHref(value.whenFalse, 'arm64-v8a');
    if (!universal || !arm64) return undefined;
    return metadata.architecture === 'universal' ? universal : arm64;
  }
  function visit(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'a') {
      const attributes = node.attributes.properties;
      if (attributes.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'download')) {
        if (attributes.some(ts.isJsxSpreadAttribute)) throw new Error('Android download attributes must be explicit.');
        const hrefs = attributes.filter(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'href');
        if (hrefs.length !== 1) throw new Error('Android download must have exactly one href.');
        const initializer = hrefs[0].initializer;
        let value = initializer;
        if (value && ts.isJsxExpression(value)) value = value.expression;
        downloads.push({href: selectedHref(value), initializer});
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (downloads.length !== 1 || downloads[0].href !== expected) {
    throw new Error('Android page must advertise exactly one manifest-selected APK with its SHA256 cache key.');
  }
  return {path, downloadHref: downloads[0].href, initializer: downloads[0].initializer, source};
}

export function androidPageDownload(code, metadata, options) {
  const {path, downloadHref} = inspectAndroidPageDownload(code, metadata, options);
  return {path, downloadHref};
}

/** A static publication contains only its selected APK. Validate both source
 * branches first, then keep only that build's pinned URL in the staged page. */
export function pinAndroidPageDownload(code, metadata, options) {
  const {downloadHref, initializer, source} = inspectAndroidPageDownload(code, metadata, options);
  return code.slice(0, initializer.getStart(source)) + JSON.stringify(downloadHref) + code.slice(initializer.end);
}
