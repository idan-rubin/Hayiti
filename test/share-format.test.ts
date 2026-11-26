import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portableDocument, withParts, withoutParts } from '../src/domain/share-format.ts';

const source = '<html><head><style data-part="look">a{color:red}</style></head><body>'
  + '<script data-part="worker" type="text/plain">self.onmessage = () => "<\\/script>";</script>'
  + '<script data-part="app">const price = "$1 & $&";</script><script>unnamed()</script></body></html>';

await test('the portable file stores each named part once and its pristine copy leaves their text out', () => {
  const compact = withoutParts(source);
  assert.equal(compact, '<html><head><style data-part="look"></style></head><body>'
    + '<script data-part="worker" type="text/plain"></script><script data-part="app"></script><script>unnamed()</script></body></html>');
  const file = portableDocument(source);
  assert.equal(file.split('const price').length, 2);
  assert.ok(file.includes(JSON.stringify(compact).replaceAll('<', '\\u003c')));
});

await test('a new file takes the text of each part from the running document, character for character', () => {
  const parts: Record<string, string> = {
    look: 'a{color:red}',
    worker: 'self.onmessage = () => "<\\/script>";',
    app: 'const price = "$1 & $&";'
  };
  assert.equal(withParts(withoutParts(source), name => parts[name]), source);
});

await test('a document that lost a part cannot make a new file', () => {
  assert.throws(() => withParts(withoutParts(source), name => name === 'app' ? null : 'text'), /Missing part app/);
});
