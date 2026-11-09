import {APK_FILE, validateApkManifest} from './apk-artifact.mjs';
import {pagesPath, ts} from './paths.mjs';

/** Read the real download anchor without executing page code or treating its query as a file path. */
export function androidPageDownload(code, metadata, {base = ''} = {}) {
  validateApkManifest(metadata);
  const source = ts.createSourceFile('android/page.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const manifestImport = source.statements.find(node => ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@/public/downloads/android-manifest.json');
  const manifestName = !manifestImport?.importClause?.isTypeOnly && manifestImport?.importClause?.name?.text;
  const path = `/downloads/${APK_FILE}`;
  const expected = `${base ? pagesPath(path, base) : path}?sha256=${metadata.sha256}`;
  const downloads = [];
  function visit(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'a') {
      const attributes = node.attributes.properties;
      if (attributes.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'download')) {
        if (attributes.some(ts.isJsxSpreadAttribute)) throw new Error('Android download attributes must be explicit.');
        const hrefs = attributes.filter(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'href');
        if (hrefs.length !== 1) throw new Error('Android download must have exactly one href.');
        let value = hrefs[0].initializer;
        if (value && ts.isJsxExpression(value)) value = value.expression;
        let href;
        if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) href = value.text;
        else if (value && ts.isTemplateExpression(value) && value.templateSpans.length === 1) {
          const span = value.templateSpans[0];
          const expression = span.expression;
          if (span.literal.text === '' && ts.isPropertyAccessExpression(expression) &&
              ts.isIdentifier(expression.expression) && expression.expression.text === manifestName && expression.name.text === 'sha256') {
            href = value.head.text + metadata.sha256;
          }
        }
        downloads.push(href);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (downloads.length !== 1 || downloads[0] !== expected) {
    throw new Error('Android page must advertise exactly one ARM64 APK with the manifest SHA256 cache key.');
  }
  return {path, downloadHref: downloads[0]};
}
