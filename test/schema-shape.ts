import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const project = fileURLToPath(new URL('../', import.meta.url));
export const schemaRoots = [
  ['src/domain/core.ts', 'Journal'],
  ['src/web/guest-storage.ts', 'GuestRecord'],
  ['src/web/guest-draft.ts', 'Attempt']
] as const;
export const portableSchemaRoots = [
  ['src/web/portable-storage.ts', 'PortableRecord']
] as const;

type Shape = string | number | boolean | null | Shape[] | { [key: string]: Shape };
export type SchemaSignatures = Record<string, string>;
export type SchemaHistory = Record<string, SchemaSignatures>;

export const shapeDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceFiles = new Map<string, ts.SourceFile>();

function compilerOptions() {
  const configPath = resolve(project, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  if (parsed.errors.length) throw Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, '\n'));
  return { ...parsed.options, strictNullChecks: true };
}

function typeShape(checker: ts.TypeChecker, type: ts.Type, path: string, active = new Map<ts.Type, string>()): Shape {
  if (type.isStringLiteral()) return { literal: 'string', value: type.value };
  if (type.isNumberLiteral()) return { literal: 'number', value: type.value };
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { literal: 'boolean', value: checker.typeToString(type) === 'true' };
  for (const [flag, name] of [
    [ts.TypeFlags.String, 'string'], [ts.TypeFlags.Number, 'number'],
    [ts.TypeFlags.Boolean, 'boolean'], [ts.TypeFlags.Null, 'null'],
    [ts.TypeFlags.Undefined, 'undefined'], [ts.TypeFlags.Unknown, 'unknown'], [ts.TypeFlags.Never, 'never']
  ] as const) if (type.flags & flag) return name;
  if (type.flags & ts.TypeFlags.Any) throw Error('Unresolved or any persisted type at ' + path);
  const previous = active.get(type);
  if (previous) return { ref: previous };
  active.set(type, path);
  try {
    const nested = (child: ts.Type, name: string) => typeShape(checker, child, path + name, active);
    if (type.isUnionOrIntersection()) {
      const parts = type.types.map(child => nested(child, '|'));
      parts.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
      return { [type.isUnion() ? 'union' : 'intersection']: parts };
    }
    if (checker.isTupleType(type)) {
      const tuple = type as ts.TypeReference;
      const target = tuple.target as ts.TupleType;
      return {
        tuple: checker.getTypeArguments(tuple).map((child, index) => ({
          flags: target.elementFlags[index], type: nested(child, '[' + index + ']')
        })),
        readonly: target.readonly
      };
    }
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type as ts.TypeReference);
      if (!element) throw Error('Missing array element at ' + path);
      return { array: nested(element, '[]'), readonly: type.getSymbol()?.getName() === 'ReadonlyArray' };
    }
    if (type.flags & ts.TypeFlags.Object) {
      if (type.getCallSignatures().length || type.getConstructSignatures().length) throw Error('Unsupported callable persisted type at ' + path);
      const properties = checker.getPropertiesOfType(type).map(property => {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        const readonly = !!declaration && ts.canHaveModifiers(declaration) && !!ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
        return {
          name: property.name,
          optional: !!(property.flags & ts.SymbolFlags.Optional),
          readonly,
          type: nested(checker.getTypeOfSymbol(property), '.' + property.name)
        };
      }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const indexes = checker.getIndexInfosOfType(type).map(index => ({
        key: nested(index.keyType, '[key]'), type: nested(index.type, '[value]'), readonly: index.isReadonly
      }));
      indexes.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
      return { properties, indexes };
    }
    throw Error('Unsupported persisted type at ' + path + ': ' + checker.typeToString(type));
  } finally {
    active.delete(type);
  }
}

export function persistedSchemaSignatures(overrides: ReadonlyMap<string, string> = new Map(), roots: ReadonlyArray<readonly [string, string]> = schemaRoots): SchemaSignatures {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, fresh) => {
    const replacement = overrides.get(name);
    if (replacement !== undefined) return ts.createSourceFile(name, replacement, version, true);
    const cached = sourceFiles.get(name);
    if (cached) return cached;
    const source = readSource(name, version, onError, fresh);
    if (source) sourceFiles.set(name, source);
    return source;
  };
  const program = ts.createProgram(roots.map(([file]) => resolve(project, file)), options, host);
  const errors = program.getSyntacticDiagnostics();
  if (errors.length) throw Error(ts.flattenDiagnosticMessageText(errors[0].messageText, '\n'));
  const checker = program.getTypeChecker();
  return Object.fromEntries(roots.map(([file, name]) => {
    const source = program.getSourceFile(resolve(project, file));
    const declaration = source?.statements.find(node => (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name.text === name);
    if (!declaration) throw Error('Missing persisted schema root ' + name + ' in ' + file);
    return [name, shapeDigest(typeShape(checker, checker.getTypeAtLocation(declaration), name))];
  }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function requirePublishedSchema(actual: SchemaSignatures, history: SchemaHistory, version: number) {
  assert.ok(Object.hasOwn(history, version), 'Add a schema signature entry for journalSchemaVersion ' + version + '. Published entries are append-only.');
  assert.deepEqual(actual, history[version], 'Persisted fields changed under journalSchemaVersion ' + version + '. Increment the version and add its signature entry; do not replace a published entry.');
}
