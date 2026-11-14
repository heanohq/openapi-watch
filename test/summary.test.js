import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalize, parseSpec, toCanonicalYaml } from '../src/normalize.js';
import { isEmpty, renderMarkdown, summarize } from '../src/summary.js';

const fixture = (name) => parseSpec(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'), name);
const baseline = normalize(fixture('baseline.yaml'));
const upstream = normalize(fixture('upstream.yaml'));

test('formatting, key order and required order do not count as changes', () => {
  const reformatted = normalize(fixture('baseline-reformatted.json'));
  assert.equal(toCanonicalYaml(reformatted), toCanonicalYaml(baseline));
  assert.ok(isEmpty(summarize(baseline, reformatted)));
});

test('ignore drops keywords but keeps schema properties of the same name', () => {
  const doc = normalize(fixture('baseline.yaml'), ['description']);
  const form = doc.components.schemas.Form;
  assert.ok('description' in form.properties, 'the "description" property is kept');
  assert.equal(form.properties.description.description, undefined, 'its description keyword is dropped');
  assert.equal(doc.paths['/forms/{id}'].get.responses['404'].description, undefined);
});

test('parseSpec rejects documents that are not mappings', () => {
  assert.throws(() => parseSpec('- a\n- b\n', 'x'), /not an OpenAPI document/);
  assert.throws(() => parseSpec('a: [', 'x'), /Could not parse x/);
  assert.deepEqual(parseSpec(''), {});
});

test('endpoints added and removed', () => {
  const s = summarize(baseline, upstream);
  assert.deepEqual(s.added.map((e) => e.key), ['POST /forms']);
  assert.deepEqual(s.removed.map((e) => e.key), ['DELETE /forms/{id}']);
  assert.deepEqual(s.versions, { before: '1.0', after: '1.1' });
});

test('parameters added and changed', () => {
  const list = summarize(baseline, upstream).changed.find((e) => e.key === 'GET /forms');
  assert.deepEqual(list.params.added, [{ name: 'search (query)', now: 'string' }]);
  assert.deepEqual(list.params.changed, [{ name: 'per_page (query)', was: 'integer', now: 'string' }]);
  assert.deepEqual(list.params.removed, []);
});

test('response fields are followed through $ref and arrays', () => {
  const list = summarize(baseline, upstream).changed.find((e) => e.key === 'GET /forms');
  const fields = list.responses.find((r) => r.status === '200');
  assert.deepEqual(fields.added.map((f) => f.name), ['forms[].tags']);
  assert.deepEqual(fields.removed.map((f) => f.name), ['forms[].legacy_flag']);
  assert.deepEqual(fields.changed, [{ name: 'forms[].name', was: 'string, required', now: 'string, nullable, required' }]);
});

test('response status codes added and removed', () => {
  const get = summarize(baseline, upstream).changed.find((e) => e.key === 'GET /forms/{id}');
  assert.deepEqual(
    get.responses.filter((r) => r.kind !== 'fields').map((r) => `${r.status} ${r.kind}`),
    ['404 removed', '410 added'],
  );
});

test('request body fields', () => {
  const before = normalize(parseSpec(`
paths:
  /x:
    post:
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { a: { type: string } } }
      responses: { '200': { description: ok } }
`));
  const after = normalize(parseSpec(`
paths:
  /x:
    post:
      requestBody:
        content:
          application/json:
            schema: { type: object, required: [a], properties: { a: { type: string }, b: { type: integer } } }
      responses: { '200': { description: ok } }
`));
  const [op] = summarize(before, after).changed;
  assert.deepEqual(op.request.added, [{ name: 'b', now: 'integer' }]);
  assert.deepEqual(op.request.changed, [{ name: 'a', was: 'string', now: 'string, required' }]);
});

test('recursive schemas do not loop', () => {
  const doc = normalize(parseSpec(`
paths:
  /tree:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Node' }
components:
  schemas:
    Node:
      type: object
      properties:
        children: { type: array, items: { $ref: '#/components/schemas/Node' } }
`));
  assert.ok(isEmpty(summarize(doc, doc)));
});

test('Swagger 2.0 body parameters and response schemas', () => {
  const v2 = (extra) => normalize(parseSpec(`
swagger: '2.0'
paths:
  /x:
    post:
      parameters:
        - { name: body, in: body, schema: { type: object, properties: { a: { type: string } ${extra} } } }
      responses:
        '200': { description: ok, schema: { type: object, properties: { id: { type: integer } ${extra} } } }
`));
  const [op] = summarize(v2(''), v2(', z: { type: boolean }')).changed;
  assert.deepEqual(op.request.added.map((f) => f.name), ['z']);
  assert.deepEqual(op.responses[0].added.map((f) => f.name), ['z']);
});

test('description-only changes in an operation are reported', () => {
  const a = normalize(parseSpec('paths: { /x: { get: { description: one, responses: {} } } }'));
  const b = normalize(parseSpec('paths: { /x: { get: { description: two, responses: {} } } }'));
  assert.deepEqual(summarize(a, b).changed[0].other, ['description']);
});

test('markdown rendering', () => {
  const md = renderMarkdown(summarize(baseline, upstream));
  assert.match(md, /Spec version: `1.0` → `1.1`/);
  assert.match(md, /\*\*1 endpoint added, 1 removed, 2 changed\*\*/);
  assert.match(md, /### Endpoints added\n\n- `POST \/forms` — Create a form/);
  assert.match(md, /- Parameter changed: `per_page \(query\)`: integer → string/);
  assert.match(md, /- Response `410` added/);
  assert.match(md, /- `info.version` changed/);
});
