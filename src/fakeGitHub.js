import { createHash } from 'crypto';
const sha = s => createHash('sha1').update(s).digest('hex');
export function makeFakeGitHub() {
  const blobs = new Map(), trees = new Map(), commits = new Map(); const refs = new Map();
  let n = 0;
  const addBlob = (b64) => { const id = sha('blob' + b64); blobs.set(id, b64); return id; };
  const addTree = (entries) => { // entries: [{path, sha}] full tree
    const id = sha('tree' + JSON.stringify(entries)); trees.set(id, entries); return id; };
  const addCommit = (tree, parents, message='c') => { const id = sha('commit' + tree + parents + message + (n++)); commits.set(id, { tree, parents, message }); return id; };
  const ancestors = (c) => { const s = new Set(); const st=[c]; while(st.length){const x=st.pop(); if(s.has(x))continue; s.add(x); st.push(...(commits.get(x)?.parents??[]));} return s; };
  // seed helper: files: Map path -> utf8 string
  const commitFiles = (files, parents, message) => {
    const entries = [...files].map(([path, text]) => ({ path, sha: addBlob(Buffer.from(text).toString('base64')), type:'blob', mode:'100644' }));
    return addCommit(addTree(entries), parents, message);
  };
  const treeToFiles = (treeSha) => new Map(trees.get(treeSha).map(e => [e.path, Buffer.from(blobs.get(e.sha),'base64').toString('utf8')]));
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  async function fetchImpl(url, { method='GET', body } = {}) {
    const u = new URL(url); const p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, ''); const b = body ? JSON.parse(body) : null;
    let m;
    if ((m = p.match(/^\/git\/ref\/heads\/(.+)$/))) { const r = refs.get(m[1]); return r ? json(200,{object:{sha:r}}) : json(404,{}); }
    if ((m = p.match(/^\/git\/refs\/heads\/(.+)$/)) && method==='PATCH') {
      const cur = refs.get(m[1]); if (!b.force && !ancestors(b.sha).has(cur)) return json(422,{}); refs.set(m[1], b.sha); return json(200,{}); }
    if (p === '/git/blobs' && method==='POST') { const c = b.encoding==='base64'? b.content : Buffer.from(b.content).toString('base64'); return json(201,{sha:addBlob(c)}); }
    if ((m = p.match(/^\/git\/blobs\/(.+)$/))) return json(200,{content:blobs.get(m[1]),encoding:'base64'});
    if (p === '/git/trees' && method==='POST') {
      const base = new Map((trees.get(b.base_tree)??[]).map(e=>[e.path,e]));
      for (const e of b.tree) { if (e.sha===null) base.delete(e.path); else base.set(e.path,{path:e.path,sha:e.sha,type:'blob',mode:e.mode}); }
      return json(201,{sha:addTree([...base.values()])}); }
    if ((m = p.match(/^\/git\/trees\/(.+)$/))) return json(200,{tree:trees.get(m[1])});
    if (p === '/git/commits' && method==='POST') return json(201,{sha:addCommit(b.tree,b.parents,b.message)});
    if ((m = p.match(/^\/git\/commits\/(.+)$/))) { const c = commits.get(m[1]); return json(200,{tree:{sha:c.tree},parents:c.parents.map(sha=>({sha}))}); }
    if ((m = p.match(/^\/compare\/(.+)\.\.\.(.+)$/))) {
      if (!commits.has(m[1])) return json(404,{});
      const a = ancestors(m[1]), h = ancestors(m[2]); let mb = null;
      // nearest common ancestor: BFS from head
      const q=[m[2]], seen=new Set(); while(q.length){const x=q.shift(); if(seen.has(x))continue; seen.add(x); if(a.has(x)){mb=x;break;} q.push(...commits.get(x).parents);} 
      return mb? json(200,{ahead_by:0,behind_by:0,merge_base_commit:{sha:mb}}) : json(404,{}); }
    throw new Error('unhandled '+method+' '+url);
  }
  return { fetchImpl, refs, commitFiles, treeToFiles, commits, addBlob, addTree, addCommit, headFiles: (br='main') => treeToFiles(commits.get(refs.get(br)).tree) };
}
