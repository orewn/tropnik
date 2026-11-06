/** Read only the catalogue's static id/shape mapping; never execute content.ts. */
import ts from 'typescript';

export function readRegionDefinitions(text, readJSON) {
  const source = ts.createSourceFile('content.ts', text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error('The region catalogue has invalid TypeScript syntax');
  const declarations = new Map(), imports = new Map();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, {
          initializer: declaration.initializer,
          constant: !!(statement.declarationList.flags & ts.NodeFlags.Const),
        });
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause?.name && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.set(statement.importClause.name.text, statement.moduleSpecifier.text);
    }
  }
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  };
  const fail = message => {throw new Error(message);};
  const checked = value => {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id || !Array.isArray(value.shapeNames)
      || !value.shapeNames.length || !value.shapeNames.every(name => typeof name === 'string' && !!name)) fail('Region id and shapeNames must be nonempty literal strings');
    return {id: value.id, shapeNames: [...value.shapeNames]};
  };
  const fromObject = node => {
    if (!ts.isObjectLiteralExpression(node) || node.properties.some(ts.isSpreadAssignment)) fail('Invalid static region definition');
    const property = name => node.properties.find(item => ts.isPropertyAssignment(item)
      && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name)?.initializer;
    const id = unwrap(property('id')), aliases = unwrap(property('shapeNames'));
    if (!id || !ts.isStringLiteral(id) || !aliases || !ts.isArrayLiteralExpression(aliases) || !aliases.elements.every(ts.isStringLiteral)) fail('Region id and shapeNames must be literal strings');
    return checked({id: id.text, shapeNames: aliases.elements.map(item => item.text)});
  };
  const jsonCache = new Map();
  const importedValue = node => {
    node = unwrap(node);
    if (ts.isPropertyAccessExpression(node)) {
      const object = importedValue(node.expression);
      if (!object || typeof object !== 'object' || !Object.hasOwn(object, node.name.text)) fail('Missing imported region catalogue property');
      return object[node.name.text];
    }
    if (!ts.isIdentifier(node) || !imports.has(node.text)) fail('Region imports must be static JSON properties');
    const specifier = imports.get(node.text);
    if (!specifier.startsWith('./') || !specifier.endsWith('.json') || specifier.split('/').some(part => part === '..')) fail('Region imports must be relative local JSON files');
    if (!jsonCache.has(specifier)) jsonCache.set(specifier, readJSON(specifier));
    return jsonCache.get(specifier);
  };
  const resolving = new Set();
  const array = expression => {
    const node = unwrap(expression);
    if (!node) fail('Missing region catalogue initializer');
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => ts.isSpreadElement(element) ? array(element.expression) : [fromObject(unwrap(element))]);
    if (ts.isIdentifier(node) && declarations.has(node.text)) {
      const declaration = declarations.get(node.text);
      if (!declaration.constant || resolving.has(node.text)) fail('Region catalogue references must be acyclic constants');
      resolving.add(node.text);
      const result = array(declaration.initializer);
      resolving.delete(node.text);
      return result;
    }
    if (ts.isIdentifier(node) && imports.has(node.text) || ts.isPropertyAccessExpression(node)) {
      const value = importedValue(node);
      if (!Array.isArray(value)) fail('Imported region catalogue must be an array');
      return value.map(checked);
    }
    fail('The region catalogue must contain only static arrays, spreads and JSON imports');
  };
  const entry = declarations.get('regions');
  if (!entry?.constant) fail('The region catalogue must be a constant');
  resolving.add('regions');
  const definitions = array(entry.initializer);
  if (!definitions.length) fail('The region catalogue cannot be empty');
  if (new Set(definitions.map(item => item.id)).size !== definitions.length) fail('Duplicate region ids');
  return definitions;
}
