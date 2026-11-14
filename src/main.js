import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { normalize, parseSpec, toCanonicalYaml } from './normalize.js';
import { isEmpty, renderMarkdown, summarize } from './summary.js';
import { closeIssue, createClient, upsertIssue, upsertPullRequest } from './github.js';

// GitHub allows 65,536 characters in an issue or PR body.
const BODY_LIMIT = 60000;

export function getInput(name, env = process.env) {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

const truthy = (v) => ['true', 'yes', '1', 'on'].includes(String(v).toLowerCase());
const list = (v) => v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

export function readInputs(env = process.env) {
  const get = (n) => getInput(n, env);
  const specUrl = get('spec-url');
  const baselinePath = get('baseline-path');
  if (!specUrl) throw new Error('Input "spec-url" is required.');
  if (!baselinePath) throw new Error('Input "baseline-path" is required.');
  return {
    specUrl,
    baselinePath,
    token: get('github-token'),
    ignore: list(get('ignore')),
    openIssue: get('issue') === '' ? true : truthy(get('issue')),
    issueTitle: get('issue-title'),
    issueLabels: list(get('issue-labels') || 'openapi-watch'),
    closeResolved: get('close-issue-when-unchanged') === '' ? true : truthy(get('close-issue-when-unchanged')),
    createPr: truthy(get('create-pr')),
    prBranch: get('pr-branch'),
    baseBranch: get('base-branch'),
    dryRun: truthy(get('dry-run')),
    failOnChange: truthy(get('fail-on-change')),
  };
}

async function loadSpec(source, workspace) {
  if (/^https?:\/\//i.test(source)) {
    let res;
    try {
      res = await fetch(source, { headers: { 'user-agent': 'openapi-watch' }, redirect: 'follow' });
    } catch (err) {
      throw new Error(`Downloading ${source} failed: ${err.cause?.message ?? err.message}`);
    }
    if (!res.ok) throw new Error(`Downloading ${source} failed: ${res.status} ${res.statusText}`);
    return res.text();
  }
  const path = resolve(workspace, source);
  if (!existsSync(path)) throw new Error(`Spec file not found: ${source}`);
  return readFileSync(path, 'utf8');
}

/** Unified diff of two canonical YAML strings, via git (present on every runner). */
export function unifiedDiff(before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'openapi-watch-'));
  writeFileSync(join(dir, 'baseline.yaml'), before);
  writeFileSync(join(dir, 'upstream.yaml'), after);
  const args = ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', 'baseline.yaml', 'upstream.yaml'];
  let res = spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    res = spawnSync('diff', ['-u', 'baseline.yaml', 'upstream.yaml'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  }
  if (res.error) throw res.error;
  if (res.status > 1) throw new Error(`diff failed: ${res.stderr}`);
  // Drop git's "diff --git" / "index" header lines; keep ---/+++ and hunks.
  return res.stdout.replace(/^diff --git .*\n(index .*\n)?/, '');
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf('\n', limit);
  return `${text.slice(0, cut > 0 ? cut : limit)}\n… (truncated)\n`;
}

export function buildBody({ summaryMd, diff, specUrl, baselinePath, runUrl, prUrl, marker, hashMarker }) {
  const links = [`- Upstream spec: ${specUrl}`, `- Baseline: \`${baselinePath}\``];
  if (runUrl) links.push(`- Full raw diff: [workflow run summary](${runUrl})`);
  if (prUrl) links.push(`- Baseline update: ${prUrl}`);
  const head = [
    marker,
    hashMarker,
    'The upstream OpenAPI spec no longer matches the baseline in this repository.',
    '',
    ...links,
    '',
    summaryMd,
  ].join('\n');
  const room = BODY_LIMIT - head.length - 200;
  const diffBlock = room > 500
    ? ['', '<details><summary>Normalised diff</summary>', '', '```diff', truncate(diff, room).trimEnd(), '```', '', '</details>', ''].join('\n')
    : '';
  return truncate(head, BODY_LIMIT) + diffBlock;
}

function setOutput(name, value, env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `ghadelim_${createHash('sha1').update(String(Math.random())).digest('hex')}`;
  appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
}

function writeSummary(text, env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
}

export async function run({ env = process.env, log = console.log, clientFactory = createClient } = {}) {
  const inputs = readInputs(env);
  const workspace = env.GITHUB_WORKSPACE || process.cwd();

  log(`${/^https?:/i.test(inputs.specUrl) ? 'Downloading' : 'Reading'} ${inputs.specUrl}`);
  const upstreamText = await loadSpec(inputs.specUrl, workspace);
  const upstream = parseSpec(upstreamText, 'upstream spec');

  const baselineFile = resolve(workspace, inputs.baselinePath);
  const baselineExists = existsSync(baselineFile);
  const baselineText = baselineExists ? readFileSync(baselineFile, 'utf8') : '';
  if (!baselineExists) log(`Baseline ${inputs.baselinePath} does not exist yet; treating it as empty.`);
  const baseline = parseSpec(baselineText, 'baseline');

  const before = normalize(baseline, inputs.ignore);
  const after = normalize(upstream, inputs.ignore);
  const beforeYaml = toCanonicalYaml(before);
  const afterYaml = toCanonicalYaml(after);
  const changed = beforeYaml !== afterYaml;

  const tmp = env.RUNNER_TEMP || tmpdir();
  const diffFile = join(tmp, 'openapi-watch.diff');
  const diff = changed ? unifiedDiff(beforeYaml, afterYaml) : '';
  writeFileSync(diffFile, diff);

  const summary = summarize(before, after);
  let summaryMd = renderMarkdown(summary);
  if (changed && isEmpty(summary)) {
    summaryMd += '\nThe documents differ, but not in endpoints, parameters or fields. See the diff for details.\n';
  }

  setOutput('changed', String(changed), env);
  setOutput('diff-file', diffFile, env);
  setOutput('summary', changed ? summaryMd : '', env);

  const marker = `<!-- openapi-watch:${inputs.baselinePath} -->`;
  const label = inputs.issueLabels[0];

  if (!changed) {
    log('No changes: the upstream spec matches the baseline.');
    writeSummary(`## OpenAPI watch\n\nNo changes: ${inputs.specUrl} matches \`${inputs.baselinePath}\`.\n`, env);
    if (!inputs.dryRun && inputs.openIssue && inputs.closeResolved && inputs.token && env.GITHUB_REPOSITORY) {
      const client = clientFactory({ token: inputs.token, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
      const closed = await closeIssue(client, { marker, label });
      if (closed) log(`Closed resolved issue #${closed.number}.`);
    }
    return { changed, summary, diff };
  }

  log(summaryMd);
  const runUrl = env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : '';
  writeSummary(
    [`## OpenAPI watch: changes found`, '', `${inputs.specUrl} differs from \`${inputs.baselinePath}\`.`, '', summaryMd,
      '', '### Normalised diff', '', '```diff', truncate(diff, 900000).trimEnd(), '```', ''].join('\n'),
    env,
  );

  const result = { changed, summary, diff };
  if (inputs.dryRun) {
    log('Dry run: not opening an issue or pull request.');
  } else {
    if (!inputs.token || !env.GITHUB_REPOSITORY) throw new Error('A github-token and GITHUB_REPOSITORY are needed to open issues or pull requests.');
    const client = clientFactory({ token: inputs.token, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
    const hash = createHash('sha256').update(afterYaml).digest('hex').slice(0, 16);
    const hashMarker = `<!-- openapi-watch-hash:${hash} -->`;
    const title = inputs.issueTitle || `OpenAPI spec changed: ${upstream.info?.title ?? inputs.specUrl}`;

    let prUrl = '';
    if (inputs.createPr) {
      const slug = inputs.baselinePath.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      const { action, pr } = await upsertPullRequest(client, {
        branch: inputs.prBranch || `openapi-watch/${slug}`,
        baseBranch: inputs.baseBranch,
        path: inputs.baselinePath,
        content: upstreamText,
        title: `Update ${inputs.baselinePath} from upstream`,
        commitMessage: `Update ${inputs.baselinePath} from upstream`,
        body: [`Updates \`${inputs.baselinePath}\` to the current version of ${inputs.specUrl}.`, '', summaryMd].join('\n'),
      });
      prUrl = pr.html_url;
      result.pr = pr;
      setOutput('pr-url', prUrl, env);
      log(`Pull request ${action}: ${prUrl}`);
    }

    if (inputs.openIssue) {
      const body = buildBody({ summaryMd, diff, specUrl: inputs.specUrl, baselinePath: inputs.baselinePath, runUrl, prUrl, marker, hashMarker });
      const { action, issue } = await upsertIssue(client, { marker, hashMarker, title, body, labels: inputs.issueLabels });
      result.issue = issue;
      setOutput('issue-url', issue.html_url, env);
      log(`Issue ${action}: ${issue.html_url}`);
    }
  }

  if (inputs.failOnChange) {
    const err = new Error('The upstream OpenAPI spec differs from the baseline.');
    err.result = result;
    throw err;
  }
  return result;
}
