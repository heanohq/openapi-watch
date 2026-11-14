import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/main.js';
import { createClient, upsertIssue } from '../src/github.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/** A fake GitHub API holding issues, refs, files and pull requests in memory. */
function fakeGitHub() {
  const state = { issues: [], comments: [], refs: { main: 'base-sha' }, files: {}, pulls: [], calls: [] };
  const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status });
  const fetchImpl = async (url, { method, body }) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace('/repos/acme/app', '');
    const data = body ? JSON.parse(body) : null;
    state.calls.push(`${method} ${path}`);
    let m;
    if (method === 'GET' && path === '/issues') {
      const page = Number(searchParams.get('page'));
      return json(200, page === 1 ? state.issues.filter((i) => i.state === 'open') : []);
    }
    if (method === 'POST' && path === '/issues') {
      const issue = { number: state.issues.length + 1, state: 'open', html_url: `https://github.com/acme/app/issues/${state.issues.length + 1}`, ...data };
      state.issues.push(issue);
      return json(201, issue);
    }
    if ((m = path.match(/^\/issues\/(\d+)$/)) && method === 'PATCH') {
      const issue = state.issues[Number(m[1]) - 1];
      Object.assign(issue, data);
      return json(200, issue);
    }
    if ((m = path.match(/^\/issues\/(\d+)\/comments$/))) {
      state.comments.push({ issue: Number(m[1]), ...data });
      return json(201, {});
    }
    if ((m = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const sha = state.refs[decodeURIComponent(m[1])];
      return sha ? json(200, { object: { sha } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && path === '/git/refs') {
      state.refs[data.ref.replace('refs/heads/', '')] = data.sha;
      return json(201, {});
    }
    if ((m = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
      state.refs[decodeURIComponent(m[1])] = data.sha;
      return json(200, {});
    }
    if ((m = path.match(/^\/contents\/(.+)$/))) {
      const key = `${searchParams.get('ref') ?? data?.branch}:${decodeURIComponent(m[1])}`;
      if (method === 'GET') return state.files[key] ? json(200, { sha: 'file-sha' }) : json(404, {});
      state.files[`${data.branch}:${decodeURIComponent(m[1])}`] = Buffer.from(data.content, 'base64').toString('utf8');
      return json(200, {});
    }
    if (method === 'GET' && path === '/pulls') {
      const head = searchParams.get('head').split(':')[1];
      return json(200, state.pulls.filter((p) => p.head === head));
    }
    if (method === 'POST' && path === '/pulls') {
      const pr = { number: 100 + state.pulls.length, html_url: `https://github.com/acme/app/pull/${100 + state.pulls.length}`, ...data };
      state.pulls.push(pr);
      return json(201, pr);
    }
    if ((m = path.match(/^\/pulls\/(\d+)$/))) {
      const pr = state.pulls.find((p) => p.number === Number(m[1]));
      Object.assign(pr, data);
      return json(200, pr);
    }
    return json(500, { message: `unexpected ${method} ${path}` });
  };
  const clientFactory = (opts) => createClient({ ...opts, fetchImpl });
  return { state, clientFactory };
}

function env(overrides = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'openapi-watch-test-'));
  const output = join(tmp, 'output');
  const summary = join(tmp, 'summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  return {
    output,
    summary,
    env: {
      GITHUB_WORKSPACE: root,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_RUN_ID: '42',
      RUNNER_TEMP: tmp,
      'INPUT_SPEC-URL': 'test/fixtures/upstream.yaml',
      'INPUT_BASELINE-PATH': 'test/fixtures/baseline.yaml',
      'INPUT_GITHUB-TOKEN': 'test-token',
      ...overrides,
    },
  };
}

const quiet = () => {};

function outputs(file) {
  const out = {};
  const re = /^(.+?)<<(ghadelim_\w+)\n([\s\S]*?)\n\2\n/gm;
  for (const [, name, , value] of readFileSync(file, 'utf8').matchAll(re)) out[name] = value;
  return out;
}

test('no change: outputs changed=false and opens nothing', async () => {
  const gh = fakeGitHub();
  const e = env({ 'INPUT_SPEC-URL': 'test/fixtures/baseline-reformatted.json' });
  const result = await run({ env: e.env, log: quiet, clientFactory: gh.clientFactory });
  assert.equal(result.changed, false);
  assert.equal(outputs(e.output).changed, 'false');
  assert.deepEqual(gh.state.issues, []);
});

test('dry run: summary and diff, but no API calls', async () => {
  const gh = fakeGitHub();
  const e = env({ 'INPUT_DRY-RUN': 'true' });
  const result = await run({ env: e.env, log: quiet, clientFactory: gh.clientFactory });
  assert.equal(result.changed, true);
  const out = outputs(e.output);
  assert.equal(out.changed, 'true');
  assert.match(out.summary, /1 endpoint added/);
  assert.match(readFileSync(out['diff-file'], 'utf8'), /^--- a\/baseline.yaml\n\+\+\+ b\/upstream.yaml\n@@/);
  assert.match(readFileSync(e.summary, 'utf8'), /```diff/);
  assert.deepEqual(gh.state.calls, []);
});

test('opens one issue, then leaves it alone while upstream stays the same', async () => {
  const gh = fakeGitHub();
  await run({ env: env().env, log: quiet, clientFactory: gh.clientFactory });
  await run({ env: env().env, log: quiet, clientFactory: gh.clientFactory });
  assert.equal(gh.state.issues.length, 1);
  const [issue] = gh.state.issues;
  assert.equal(issue.title, 'OpenAPI spec changed: Example API');
  assert.deepEqual(issue.labels, ['openapi-watch']);
  assert.match(issue.body, /<!-- openapi-watch:test\/fixtures\/baseline.yaml -->/);
  assert.match(issue.body, /\[workflow run summary\]\(https:\/\/github.com\/acme\/app\/actions\/runs\/42\)/);
  assert.match(issue.body, /`POST \/forms` — Create a form/);
  assert.equal(gh.state.comments.length, 0);
});

test('updates the same issue when upstream changes again, then closes it once resolved', async () => {
  const gh = fakeGitHub();
  await run({ env: env().env, log: quiet, clientFactory: gh.clientFactory });

  const tmp = mkdtempSync(join(tmpdir(), 'openapi-watch-test-'));
  const newer = join(tmp, 'newer.yaml');
  writeFileSync(newer, readFileSync(join(root, 'test/fixtures/upstream.yaml'), 'utf8').replace("version: '1.1'", "version: '1.2'"));
  await run({ env: env({ 'INPUT_SPEC-URL': newer }).env, log: quiet, clientFactory: gh.clientFactory });

  assert.equal(gh.state.issues.length, 1);
  assert.match(gh.state.issues[0].body, /`1.0` → `1.2`/);
  assert.equal(gh.state.comments.length, 1);

  await run({ env: env({ 'INPUT_SPEC-URL': 'test/fixtures/baseline.yaml' }).env, log: quiet, clientFactory: gh.clientFactory });
  assert.equal(gh.state.issues[0].state, 'closed');
});

test('create-pr commits the upstream file to a branch and links the PR from the issue', async () => {
  const gh = fakeGitHub();
  const e = env({ 'INPUT_CREATE-PR': 'true', 'INPUT_BASE-BRANCH': 'main' });
  await run({ env: e.env, log: quiet, clientFactory: gh.clientFactory });
  await run({ env: env({ 'INPUT_CREATE-PR': 'true', 'INPUT_BASE-BRANCH': 'main' }).env, log: quiet, clientFactory: gh.clientFactory });

  const branch = 'openapi-watch/test-fixtures-baseline.yaml';
  assert.equal(gh.state.refs[branch], 'base-sha');
  assert.equal(
    gh.state.files[`${branch}:test/fixtures/baseline.yaml`],
    readFileSync(join(root, 'test/fixtures/upstream.yaml'), 'utf8'),
  );
  assert.equal(gh.state.pulls.length, 1, 'the second run updates the PR instead of opening another');
  assert.equal(gh.state.pulls[0].base, 'main');
  assert.match(gh.state.issues[0].body, /Baseline update: https:\/\/github.com\/acme\/app\/pull\/100/);
  assert.equal(outputs(e.output)['pr-url'], 'https://github.com/acme/app/pull/100');
});

test('fail-on-change fails after reporting', async () => {
  const gh = fakeGitHub();
  await assert.rejects(
    run({ env: env({ 'INPUT_FAIL-ON-CHANGE': 'true' }).env, log: quiet, clientFactory: gh.clientFactory }),
    /differs from the baseline/,
  );
  assert.equal(gh.state.issues.length, 1);
});

test('a missing baseline is treated as empty', async () => {
  const e = env({ 'INPUT_BASELINE-PATH': 'spec/does-not-exist.yaml', 'INPUT_DRY-RUN': 'true' });
  const result = await run({ env: e.env, log: quiet });
  assert.equal(result.changed, true);
  assert.equal(result.summary.added.length, 3);
});

test('finds its issue even when the label was removed', async () => {
  const gh = fakeGitHub();
  gh.state.issues.push({ number: 1, state: 'open', labels: [], body: '<!-- openapi-watch:x -->', html_url: 'u' });
  const client = gh.clientFactory({ token: 't', repository: 'acme/app' });
  const res = await upsertIssue(client, { marker: '<!-- openapi-watch:x -->', hashMarker: '<!-- openapi-watch-hash:new -->', title: 't', body: 'b', labels: ['openapi-watch'] });
  assert.equal(res.action, 'updated');
  assert.equal(gh.state.issues.length, 1);
});

test('required inputs', async () => {
  await assert.rejects(run({ env: { 'INPUT_BASELINE-PATH': 'x' }, log: quiet }), /"spec-url" is required/);
});
