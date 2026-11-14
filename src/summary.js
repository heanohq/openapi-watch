// Builds a structured, human-readable summary of what changed between two
// OpenAPI documents (OpenAPI 3.x, with best-effort support for Swagger 2.0).

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MAX_DEPTH = 12;

/** Resolve a local `$ref` (`#/components/...`). External refs are left as-is. */
function deref(doc, node, seen = new Set()) {
  let current = node;
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) return current;
    seen.add(ref);
    let target = doc;
    for (const raw of ref.slice(2).split('/')) {
      const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      target = target?.[part];
    }
    if (target === undefined) return current;
    current = target;
  }
  return current;
}

function operations(doc) {
  const ops = new Map();
  for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
    const item = deref(doc, rawItem) ?? {};
    for (const method of METHODS) {
      if (item[method]) {
        ops.set(`${method.toUpperCase()} ${path}`, { path, method, item, op: item[method] });
      }
    }
  }
  return ops;
}

function schemaType(doc, schema) {
  const s = deref(doc, schema) ?? {};
  let type = Array.isArray(s.type) ? s.type.join('|') : s.type;
  if (!type) {
    if (s.properties) type = 'object';
    else if (s.items) type = 'array';
    else if (s.allOf) type = 'allOf';
    else if (s.oneOf) type = 'oneOf';
    else if (s.anyOf) type = 'anyOf';
    else type = 'any';
  }
  if (type === 'array' && s.items) {
    type = `array of ${schemaType(doc, s.items)}`;
  }
  const bits = [s.format ? `${type} (${s.format})` : type];
  if (s.nullable) bits.push('nullable');
  if (Array.isArray(s.enum)) {
    const values = s.enum.map((v) => JSON.stringify(v));
    bits.push(`enum ${values.length > 8 ? `${values.slice(0, 8).join(', ')}, …` : values.join(', ')}`);
  }
  if (s.deprecated) bits.push('deprecated');
  return bits.join(', ');
}

/** Flatten a schema into `{ 'a.b[].c': 'string, required' }`. */
function flattenSchema(doc, schema, prefix = '', out = {}, depth = 0, stack = new Set()) {
  const s = deref(doc, schema);
  if (!s || typeof s !== 'object' || depth > MAX_DEPTH || stack.has(s)) return out;
  stack = new Set(stack).add(s);

  for (const part of [...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? [])]) {
    flattenSchema(doc, part, prefix, out, depth + 1, stack);
  }

  const required = new Set(Array.isArray(s.required) ? s.required : []);
  for (const [name, prop] of Object.entries(s.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    out[path] = `${schemaType(doc, prop)}${required.has(name) ? ', required' : ''}`;
    flattenSchema(doc, prop, path, out, depth + 1, stack);
  }

  if (s.items) {
    const items = deref(doc, s.items);
    flattenSchema(doc, items, `${prefix}[]`, out, depth + 1, stack);
  }

  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    flattenSchema(doc, s.additionalProperties, `${prefix}{*}`, out, depth + 1, stack);
  }
  return out;
}

function parameters(doc, entry) {
  const out = {};
  const list = [...(entry.item.parameters ?? []), ...(entry.op.parameters ?? [])];
  for (const raw of list) {
    const p = deref(doc, raw);
    if (!p || !p.name || p.in === 'body') continue;
    const type = p.schema ? schemaType(doc, p.schema) : schemaType(doc, p);
    const bits = [type];
    if (p.required) bits.push('required');
    if (p.deprecated && !type.includes('deprecated')) bits.push('deprecated');
    out[`${p.name} (${p.in})`] = bits.join(', ');
  }
  return out;
}

function mediaLabel(type) {
  return type === 'application/json' ? '' : ` (${type})`;
}

function requestFields(doc, entry) {
  const out = {};
  const body = deref(doc, entry.op.requestBody);
  for (const [type, media] of Object.entries(body?.content ?? {})) {
    for (const [k, v] of Object.entries(flattenSchema(doc, media.schema))) {
      out[`${k}${mediaLabel(type)}`] = v;
    }
  }
  // Swagger 2.0 body parameter
  for (const raw of [...(entry.item.parameters ?? []), ...(entry.op.parameters ?? [])]) {
    const p = deref(doc, raw);
    if (p?.in === 'body') Object.assign(out, flattenSchema(doc, p.schema));
  }
  return out;
}

function responses(doc, entry) {
  const out = new Map();
  for (const [status, raw] of Object.entries(entry.op.responses ?? {})) {
    const resp = deref(doc, raw) ?? {};
    const fields = {};
    if (resp.content) {
      for (const [type, media] of Object.entries(resp.content)) {
        for (const [k, v] of Object.entries(flattenSchema(doc, media.schema))) {
          fields[`${k}${mediaLabel(type)}`] = v;
        }
      }
    } else if (resp.schema) {
      Object.assign(fields, flattenSchema(doc, resp.schema));
    }
    out.set(String(status), fields);
  }
  return out;
}

function compareMaps(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added.push({ name: k, now: v });
    else if (before[k] !== v) changed.push({ name: k, was: before[k], now: v });
  }
  for (const [k, v] of Object.entries(before)) {
    if (!(k in after)) removed.push({ name: k, was: v });
  }
  return { added, removed, changed };
}

const stable = (v) => JSON.stringify(v);

/** Top-level keys of an operation whose value changed, ignoring the ones reported in detail. */
function otherOperationChanges(a, b) {
  const skip = new Set(['parameters', 'requestBody', 'responses']);
  const keys = new Set([...Object.keys(a.op), ...Object.keys(b.op)]);
  return [...keys].filter((k) => !skip.has(k) && stable(a.op[k]) !== stable(b.op[k])).sort();
}

/** Changed locations outside `paths`, as dotted paths at most `depth` levels deep. */
function otherChanges(before, after, depth = 3) {
  const results = [];
  (function visit(a, b, path) {
    if (stable(a) === stable(b)) return;
    const objects = a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b);
    if (!objects || path.length >= depth) {
      const kind = a === undefined ? 'added' : b === undefined ? 'removed' : 'changed';
      results.push({ path: path.join('.'), kind });
      return;
    }
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      visit(a[k], b[k], [...path, k]);
    }
  })(
    { ...before, paths: undefined },
    { ...after, paths: undefined },
    [],
  );
  return results;
}

/**
 * Compare two parsed (and normalised) OpenAPI documents.
 * Returns a plain object; see `renderMarkdown` for presentation.
 */
export function summarize(before, after) {
  const a = operations(before);
  const b = operations(after);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, entry] of b) {
    if (!a.has(key)) added.push({ key, summary: entry.op.summary ?? '', deprecated: !!entry.op.deprecated });
  }
  for (const [key, entry] of a) {
    if (!b.has(key)) removed.push({ key, summary: entry.op.summary ?? '' });
  }

  for (const [key, newEntry] of b) {
    const oldEntry = a.get(key);
    if (!oldEntry) continue;

    const params = compareMaps(parameters(before, oldEntry), parameters(after, newEntry));
    const request = compareMaps(requestFields(before, oldEntry), requestFields(after, newEntry));

    const oldResponses = responses(before, oldEntry);
    const newResponses = responses(after, newEntry);
    const responseChanges = [];
    for (const [status, fields] of newResponses) {
      if (!oldResponses.has(status)) {
        responseChanges.push({ status, kind: 'added' });
      } else {
        const diff = compareMaps(oldResponses.get(status), fields);
        if (diff.added.length || diff.removed.length || diff.changed.length) {
          responseChanges.push({ status, kind: 'fields', ...diff });
        }
      }
    }
    for (const status of oldResponses.keys()) {
      if (!newResponses.has(status)) responseChanges.push({ status, kind: 'removed' });
    }
    responseChanges.sort((x, y) => x.status.localeCompare(y.status));

    const other = otherOperationChanges(oldEntry, newEntry);
    const anyDetail =
      params.added.length || params.removed.length || params.changed.length ||
      request.added.length || request.removed.length || request.changed.length ||
      responseChanges.length;

    // Changes inside the operation we could not attribute (e.g. examples or descriptions
    // nested in responses) still deserve a mention.
    if (!anyDetail && !other.length && stable(oldEntry.op) !== stable(newEntry.op)) {
      other.push('details');
    }

    if (anyDetail || other.length) {
      changed.push({ key, params, request, responses: responseChanges, other });
    }
  }

  const byKey = (x, y) => x.key.localeCompare(y.key);
  return {
    added: added.sort(byKey),
    removed: removed.sort(byKey),
    changed: changed.sort(byKey),
    other: otherChanges(before, after),
    versions: { before: before.info?.version ?? null, after: after.info?.version ?? null },
  };
}

export function isEmpty(summary) {
  return !summary.added.length && !summary.removed.length && !summary.changed.length && !summary.other.length;
}

const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

function fieldLines(label, diff) {
  const lines = [];
  for (const f of diff.added) lines.push(`- ${label} added: ${code(f.name)} (${f.now})`);
  for (const f of diff.removed) lines.push(`- ${label} removed: ${code(f.name)} (was ${f.was})`);
  for (const f of diff.changed) lines.push(`- ${label} changed: ${code(f.name)}: ${f.was} → ${f.now}`);
  return lines;
}

/** Render the summary as GitHub-flavoured Markdown. */
export function renderMarkdown(summary) {
  const out = [];
  const { added, removed, changed, other, versions } = summary;

  if (versions.before !== versions.after) {
    out.push(`Spec version: ${code(versions.before ?? 'none')} → ${code(versions.after ?? 'none')}`, '');
  }

  const counts = [
    `${added.length} endpoint${added.length === 1 ? '' : 's'} added`,
    `${removed.length} removed`,
    `${changed.length} changed`,
  ];
  out.push(`**${counts.join(', ')}**`, '');

  if (added.length) {
    out.push('### Endpoints added', '');
    for (const e of added) out.push(`- ${code(e.key)}${e.summary ? ` — ${e.summary}` : ''}${e.deprecated ? ' (deprecated)' : ''}`);
    out.push('');
  }
  if (removed.length) {
    out.push('### Endpoints removed', '');
    for (const e of removed) out.push(`- ${code(e.key)}${e.summary ? ` — ${e.summary}` : ''}`);
    out.push('');
  }
  if (changed.length) {
    out.push('### Endpoints changed', '');
    for (const e of changed) {
      out.push(`#### ${code(e.key)}`, '');
      out.push(...fieldLines('Parameter', e.params));
      out.push(...fieldLines('Request field', e.request));
      for (const r of e.responses) {
        if (r.kind === 'added') out.push(`- Response ${code(r.status)} added`);
        else if (r.kind === 'removed') out.push(`- Response ${code(r.status)} removed`);
        else out.push(...fieldLines(`Response ${code(r.status)} field`, r));
      }
      if (e.other.length) out.push(`- Other changes: ${e.other.map(code).join(', ')}`);
      out.push('');
    }
  }
  if (other.length) {
    out.push('### Other changes', '');
    for (const o of other.slice(0, 50)) out.push(`- ${code(o.path || '(root)')} ${o.kind}`);
    if (other.length > 50) out.push(`- …and ${other.length - 50} more`);
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}
