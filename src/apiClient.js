const BASE = 'https://api.github.com';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function request(url, { token, method = 'GET', body, okStatuses = [] } = {}) {
  const res = await fetch(url, {
    method,
    headers: headers(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !okStatuses.includes(res.status)) {
    const err = new Error(`GitHub API request failed: ${method} ${url} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { status: res.status, json: res.ok || okStatuses.includes(res.status) ? await res.json() : null };
}

export async function getRepo({ repo, token }) {
  const { json } = await request(`${BASE}/repos/${repo}`, { token });
  return { defaultBranch: json.default_branch, private: json.private, permissions: json.permissions };
}

export async function getRef({ repo, token, branch }) {
  const { status, json } = await request(`${BASE}/repos/${repo}/git/ref/heads/${branch}`, {
    token,
    okStatuses: [404],
  });
  if (status === 404) return null;
  return { sha: json.object.sha };
}

export async function updateRef({ repo, token, branch, sha, force }) {
  const { status } = await request(`${BASE}/repos/${repo}/git/refs/heads/${branch}`, {
    token,
    method: 'PATCH',
    body: { sha, force },
    okStatuses: [422, 409],
  });
  return status === 200 ? { ok: true } : { ok: false, status };
}

export async function createRef({ repo, token, branch, sha }) {
  await request(`${BASE}/repos/${repo}/git/refs`, {
    token,
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha },
  });
}

export async function createBlob({ repo, token, content, encoding }) {
  const { json } = await request(`${BASE}/repos/${repo}/git/blobs`, {
    token,
    method: 'POST',
    body: { content, encoding },
  });
  return { sha: json.sha };
}

export async function getBlob({ repo, token, sha }) {
  const { json } = await request(`${BASE}/repos/${repo}/git/blobs/${sha}`, { token });
  return { content: json.content, encoding: json.encoding };
}

export async function createTree({ repo, token, baseTree, entries }) {
  const { json } = await request(`${BASE}/repos/${repo}/git/trees`, {
    token,
    method: 'POST',
    body: { base_tree: baseTree, tree: entries },
  });
  return { sha: json.sha };
}

export async function getTree({ repo, token, sha }) {
  const { json } = await request(`${BASE}/repos/${repo}/git/trees/${sha}?recursive=1`, { token });
  return json.tree.map(entry => ({ path: entry.path, type: entry.type, sha: entry.sha }));
}

export async function createCommit({ repo, token, message, tree, parents, author }) {
  const { json } = await request(`${BASE}/repos/${repo}/git/commits`, {
    token,
    method: 'POST',
    body: { message, tree, parents, ...(author ? { author } : {}) },
  });
  return { sha: json.sha };
}

export async function getCommit({ repo, token, sha }) {
  const { json } = await request(`${BASE}/repos/${repo}/git/commits/${sha}`, { token });
  return { tree: { sha: json.tree.sha }, parents: json.parents.map(p => p.sha) };
}

export async function compareCommits({ repo, token, base, head }) {
  const { status, json } = await request(`${BASE}/repos/${repo}/compare/${base}...${head}`, {
    token,
    okStatuses: [404],
  });
  if (status === 404) return null;
  return {
    aheadBy: json.ahead_by,
    behindBy: json.behind_by,
    mergeBaseSha: json.merge_base_commit.sha,
  };
}

export async function bootstrapEmptyRepo({ repo, token, branch, path, content }) {
  const base64 = typeof btoa === 'function' ? btoa(content) : Buffer.from(content, 'utf-8').toString('base64');
  const { json } = await request(`${BASE}/repos/${repo}/contents/${path}`, {
    token,
    method: 'PUT',
    body: { message: 'bootstrap: initial commit', content: base64, branch },
  });
  return { commitSha: json.commit.sha };
}
