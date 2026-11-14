// Minimal GitHub REST client: just what the action needs, on top of fetch.

export function createClient({ token, repository, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  const [owner, repo] = repository.split('/');
  const base = `${apiUrl.replace(/\/$/, '')}/repos/${owner}/${repo}`;

  async function request(method, path, body) {
    const res = await fetchImpl(path.startsWith('http') ? path : `${base}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'openapi-watch',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  return { owner, repo, request };
}

/**
 * Find the open issue this watcher created earlier, by its hidden marker.
 * Looks in issues with the label first, then in all open issues, in case the
 * label was removed or never applied.
 */
export async function findIssue(client, { marker, label }) {
  return (label && (await searchIssues(client, marker, label))) || searchIssues(client, marker, null);
}

async function searchIssues(client, marker, label) {
  const query = new URLSearchParams({ state: 'open', per_page: '100' });
  if (label) query.set('labels', label);
  for (let page = 1; page <= 10; page++) {
    query.set('page', String(page));
    const issues = await client.request('GET', `/issues?${query}`);
    if (!issues?.length) return null;
    const hit = issues.find((i) => !i.pull_request && (i.body ?? '').includes(marker));
    if (hit) return hit;
    if (issues.length < 100) return null;
  }
  return null;
}

/**
 * Open a new issue, or update the existing one. If the existing issue already
 * describes this exact upstream version, nothing is changed.
 */
export async function upsertIssue(client, { marker, hashMarker, title, body, labels }) {
  const existing = await findIssue(client, { marker, label: labels[0] });
  if (!existing) {
    const created = await client.request('POST', '/issues', { title, body, labels });
    return { action: 'created', issue: created };
  }
  if ((existing.body ?? '').includes(hashMarker)) {
    return { action: 'unchanged', issue: existing };
  }
  const updated = await client.request('PATCH', `/issues/${existing.number}`, { title, body });
  await client.request('POST', `/issues/${existing.number}/comments`, {
    body: 'The upstream spec has changed again. The issue description now shows the latest differences.',
  });
  return { action: 'updated', issue: updated };
}

export async function closeIssue(client, { marker, label }) {
  const existing = await findIssue(client, { marker, label });
  if (!existing) return null;
  await client.request('POST', `/issues/${existing.number}/comments`, {
    body: 'The upstream spec now matches the baseline, so this is resolved.',
  });
  await client.request('PATCH', `/issues/${existing.number}`, { state: 'closed', state_reason: 'completed' });
  return existing;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/**
 * Point `branch` at the tip of `baseBranch`, commit `content` to `path` on it,
 * and open (or update) a pull request. The branch is reset on every run, so it
 * always holds exactly one commit on top of the base.
 */
export async function upsertPullRequest(client, { branch, baseBranch, path, content, title, body, commitMessage }) {
  let base = baseBranch;
  if (!base) {
    const repo = await client.request('GET', '');
    base = repo.default_branch;
  }
  const baseRef = await client.request('GET', `/git/ref/heads/${encodePath(base)}`);
  if (!baseRef) throw new Error(`Base branch "${base}" not found.`);
  const sha = baseRef.object.sha;

  const headRef = await client.request('GET', `/git/ref/heads/${encodePath(branch)}`);
  if (headRef) {
    await client.request('PATCH', `/git/refs/heads/${encodePath(branch)}`, { sha, force: true });
  } else {
    await client.request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
  }

  const current = await client.request('GET', `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
  await client.request('PUT', `/contents/${encodePath(path)}`, {
    message: commitMessage,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
    ...(current?.sha ? { sha: current.sha } : {}),
  });

  const open = await client.request(
    'GET',
    `/pulls?state=open&head=${encodeURIComponent(`${client.owner}:${branch}`)}&base=${encodeURIComponent(base)}`,
  );
  if (open?.length) {
    const pr = await client.request('PATCH', `/pulls/${open[0].number}`, { title, body });
    return { action: 'updated', pr };
  }
  const pr = await client.request('POST', '/pulls', { title, body, head: branch, base });
  return { action: 'created', pr };
}
