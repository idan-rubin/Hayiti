import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { journalSchemaVersion } from '../src/domain/journal-schema.ts';
import {
  persistedSchemaSignatures, portableSchemaRoots, requirePublishedSchema, shapeDigest,
  type SchemaHistory
} from './schema-shape.ts';

const history = JSON.parse(readFileSync(new URL('./fixtures/journal-schema-versions.json', import.meta.url), 'utf8')) as SchemaHistory;
const portableHistory = JSON.parse(readFileSync(new URL('./fixtures/portable-schema-versions.json', import.meta.url), 'utf8')) as SchemaHistory;
const corePath = fileURLToPath(new URL('../src/domain/core.ts', import.meta.url));
const core = readFileSync(corePath, 'utf8');

await test('published journal fields require a matching schema version and an append-only signature entry', () => {
  assert.equal(shapeDigest(history[1]), '3fcd617b13181f849270cd6e34e37bae3ca2faae944d2d9a08cebce1b777f18c', 'The published v1 schema signatures must not be rewritten.');
  requirePublishedSchema(persistedSchemaSignatures(), history, journalSchemaVersion);
});

await test('the isolated portable record has its own versioned persisted schema signature', () => {
  assert.equal(shapeDigest(portableHistory[1]), '6d3997c94d1a906e0ad43d460d34a4485238cca56dceecaa979c982b6c76c6b4', 'The published portable v1 schema signature must not be rewritten.');
  requirePublishedSchema(persistedSchemaSignatures(new Map(), portableSchemaRoots), portableHistory, journalSchemaVersion);
});

await test('an optional persisted field added in the AST fails without both a version bump and its new entry', () => {
  const source = ts.createSourceFile(corePath, core, ts.ScriptTarget.Latest, true);
  const transformed = ts.transform(source, [context => root => {
    const visit: ts.Visitor = node => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'Stop') {
        return ts.factory.updateInterfaceDeclaration(node, node.modifiers, node.name, node.typeParameters, node.heritageClauses, [
          ...node.members,
          ts.factory.createPropertySignature(undefined, 'futureEvidence', ts.factory.createToken(ts.SyntaxKind.QuestionToken), ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword))
        ]);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  }]);
  const changed = ts.createPrinter().printFile(transformed.transformed[0]);
  transformed.dispose();
  const actual = persistedSchemaSignatures(new Map([[corePath, changed]]));
  const nextVersion = journalSchemaVersion + 1;
  const baseline = { [journalSchemaVersion]: persistedSchemaSignatures() };
  assert.throws(() => requirePublishedSchema(actual, history, journalSchemaVersion), /Persisted fields changed/);
  assert.throws(() => requirePublishedSchema(actual, baseline, nextVersion), /Add a schema signature entry/);
  requirePublishedSchema(actual, { ...baseline, [nextVersion]: actual }, nextVersion);
});

await test('nested aliases, enum values, optionality, nullability and literal widths cannot bypass the schema guard', () => {
  const mutations = [
    ['nested record', 'export interface SourceCheck {', 'export interface SourceCheck { expiresAt?: string;'],
    ['optional marker', 'photoAnchor?: Point;', 'photoAnchor: Point;'],
    ['nullable field', 'xy: Point | null;', 'xy: Point;'],
    ['literal width', 'edited?: true;', 'edited?: boolean;'],
    ['type alias', 'export type Source = typeof sources[number];', "export type Source = typeof sources[number] | 'new-source';"],
    ['typeof enum', "['card', 'email',", "['card', 'email', 'sms',"],
    ['spread enum', "'partial'] as const;", "'partial', 'pending'] as const;"],
    ['tuple alias', 'longitude: number];', 'longitude: number, altitude?: number];'],
    ['index value', 'dayNotes: Record<string, string>;', 'dayNotes: Record<string, string | number>;']
  ];
  for (const [name, before, after] of mutations) {
    assert.ok(core.includes(before), 'Missing mutation target: ' + name);
    const actual = persistedSchemaSignatures(new Map([[corePath, core.replace(before, after)]]));
    assert.throws(() => requirePublishedSchema(actual, history, journalSchemaVersion), /Persisted fields changed/, name);
  }
});

await test('persisted guest metadata is guarded even when an enclosing property is typed unknown', () => {
  for (const [file, before, after] of [
    ['guest-storage.ts', 'export interface GuestRecord extends GuestDraft {', 'export interface GuestRecord extends GuestDraft { importedAt?: string;'],
    ['guest-draft.ts', 'interface Attempt {', 'interface Attempt { retryToken?: string;']
  ]) {
    const path = fileURLToPath(new URL('../src/web/' + file, import.meta.url));
    const source = readFileSync(path, 'utf8');
    assert.ok(source.includes(before));
    assert.throws(() => requirePublishedSchema(persistedSchemaSignatures(new Map([[path, source.replace(before, after)]])), history, journalSchemaVersion), /Persisted fields changed/);
  }
});

await test('the portable envelope also rejects an added optional field under its existing version', () => {
  const path = fileURLToPath(new URL('../src/web/portable-storage.ts', import.meta.url));
  const source = readFileSync(path, 'utf8');
  const before = 'interface PortableRecord extends PortableDraft {';
  assert.ok(source.includes(before));
  const actual = persistedSchemaSignatures(new Map([[path, source.replace(before, before + ' expiresAt?: string;')]]), portableSchemaRoots);
  assert.throws(() => requirePublishedSchema(actual, portableHistory, journalSchemaVersion), /Persisted fields changed/);
});

await test('formatting, comments and alias names do not change persisted schema signatures', () => {
  const source = ts.createSourceFile(corePath, core, ts.ScriptTarget.Latest, true);
  const formatted = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.CarriageReturnLineFeed }).printFile(source)
    .replaceAll(/\bPoint\b/g, 'RenamedCoordinates');
  requirePublishedSchema(persistedSchemaSignatures(new Map([[corePath, formatted]])), history, journalSchemaVersion);
});

await test('unresolved and any persisted types fail closed instead of disappearing from the signature', () => {
  for (const type of ['MissingPersistedType', 'any']) {
    const changed = core.replace('export interface Stop {', 'export interface Stop { future?: ' + type + ';');
    assert.throws(() => persistedSchemaSignatures(new Map([[corePath, changed]])), /Unresolved or any persisted type/);
  }
});
