import YAML from 'yaml';

/**
 * Parse an OpenAPI document from YAML or JSON text.
 * JSON is valid YAML, so one parser covers both.
 */
export function parseSpec(text, label = 'spec') {
  if (text == null || text.trim() === '') {
    return {};
  }
  let doc;
  try {
    doc = YAML.parse(text, { maxAliasCount: 1000 });
  } catch (err) {
    throw new Error(`Could not parse ${label} as YAML or JSON: ${err.message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${label} is not an OpenAPI document (expected a mapping at the top level).`);
  }
  return doc;
}

const PARAM_ORDER = (p) => `${p?.in ?? ''}:${p?.name ?? ''}:${p?.$ref ?? ''}`;

/**
 * Return a canonical copy of the document:
 * - object keys sorted at every level
 * - `required` lists sorted (their order has no meaning)
 * - `parameters` lists sorted by location and name
 * - keys named in `ignore` removed (but never a schema property of that name)
 */
export function normalize(value, ignore = [], parentKey = null) {
  const ignored = new Set(ignore);
  return walk(value, parentKey);

  function walk(node, key) {
    if (Array.isArray(node)) {
      let items = node.map((item) => walk(item, null));
      if (key === 'required' && items.every((i) => typeof i === 'string')) {
        items = [...items].sort();
      } else if (key === 'parameters' && items.every((i) => i && typeof i === 'object')) {
        items = [...items].sort((a, b) => PARAM_ORDER(a).localeCompare(PARAM_ORDER(b)));
      }
      return items;
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const k of Object.keys(node).sort()) {
        // Inside `properties` the keys are field names, not OpenAPI keywords.
        if (key !== 'properties' && ignored.has(k)) continue;
        out[k] = walk(node[k], k);
      }
      return out;
    }
    return node;
  }
}

/** Serialise a normalised document as stable YAML, for diffing. */
export function toCanonicalYaml(doc) {
  return YAML.stringify(doc, { lineWidth: 0, sortMapEntries: true, aliasDuplicateObjects: false });
}
