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
    // GitHub's API responses must never be served from the browser's HTTP
    // cache: pushSync's retry loop reads getRef/getCommit repeatedly in a
    // tight loop, and a stale cached response there means a retry rebuilds
    // from the wrong parent and gets legitimately rejected forever, even
    // after an earlier attempt's push already landed for real. Verified
    // live -- this is exactly what caused a real "Could not sync after 5
    // attempts" failure.
    cache: 'no-store',
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
    okStatuses: [404, 409],
  });
  // 404: this specific branch doesn't exist (but the repo may have other
  // history). 409 "Git Repository is empty": the whole repo has zero
  // commits -- verified live against the real API, not a guess (spec
  // section 9). Both mean the same thing to every caller: no ref here yet.
  if (status === 404 || status === 409) return null;
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
  // GitHub's recursive tree listing includes an entry for every intermediate
  // directory (type: 'tree'), not just the files under it -- verified live.
  // Every caller of getTree only ever deals in real files (projectBook's
  // output never contains a bare directory path like 'scenes'), so an
  // unfiltered directory entry reads as "a file that no longer exists
  // locally" and gets scheduled for deletion, wiping the whole subtree.
  return json.tree
    .filter(entry => entry.type === 'blob')
    .map(entry => ({ path: entry.path, type: entry.type, sha: entry.sha }));
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
  const base64 = btoa(content);
  const { json } = await request(`${BASE}/repos/${repo}/contents/${path}`, {
    token,
    method: 'PUT',
    body: { message: 'bootstrap: initial commit', content: base64, branch },
  });
  return { commitSha: json.commit.sha };
}
