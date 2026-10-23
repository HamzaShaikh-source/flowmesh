'use strict';
/**
 * Councils: several coding agents think together, read-only, and FlowMesh reports what they said.
 * Port of council.py (debate and blind judge panel); read that file's header for the rules. The
 * prompts, rubric and limits come from council_text.js, which is generated from the Python source.
 */

const fs = require('node:fs');
const path = require('node:path');

const text = require('./council_text.js');

const {
  PROPOSE, CRITIQUE, REBUT, VOTE, RUBRIC, SCALE, JUDGE_SYSTEM, CRIT, CRITERIA, LIMITS,
} = text;
const KINDS = ['debate', 'judge'];
const KEYS = CRITERIA.map((c) => c[0]);
const WEIGHT = Object.fromEntries(CRITERIA.map((c) => [c[0], c[2]]));
const LABEL = Object.fromEntries(CRITERIA.map((c) => [c[0], c[1]]));

class Cancelled extends Error {}

// ---------------------------------------------------------------- shared helpers

/** Every complete JSON object starting at a '{' in `source`, tolerating raw control characters in strings. */
function* objectsIn(source) {
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let out = '';
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) { out += ch; escaped = false; continue; }
        if (ch === '\\') { out += ch; escaped = true; continue; }
        if (ch === '"') { inString = false; out += ch; continue; }
        const code = ch.charCodeAt(0);
        if (code < 32) { out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ' '; continue; }
        out += ch;
        continue;
      }
      out += ch;
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            yield JSON.parse(out);
          } catch { /* not an object at this position */ }
          break;
        }
      }
    }
  }
}

/** The last JSON object in noisy CLI output that holds `key` (banners and an echoed example come first). */
function extractObject(source, key) {
  let found = null;
  for (const value of objectsIn(typeof source === 'string' ? source : '')) {
    if (value && typeof value === 'object' && !Array.isArray(value) && key in value) found = value;
  }
  return found;
}

const clean = (value, limit) => {
  const t = String(value === null || value === undefined || value === false || value === 0 ? '' : value).trim();
  return t === '...' ? '' : t.slice(0, limit);
};

function num(value, low = 0, high = 10) {
  let v = value;
  if (v && typeof v === 'object' && !Array.isArray(v)) v = v.score;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(low, Math.min(high, v));
}

function shuffleSeeded(items, seed) {
  // Anonymity only needs an unpredictable-to-the-agents order; the Python twin uses its own generator.
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (values) => { let total = 0; for (const v of values) total += v; return total / values.length; };
// Python's round() works on the exact value of the double and breaks exact ties to the even digit; match it.
function pyRound(value, digits) {
  const negative = value < 0;
  const [whole, frac] = Math.abs(value).toFixed(digits + 20).split('.');
  const kept = BigInt(whole + frac.slice(0, digits));
  const rest = frac.slice(digits);
  let n = kept;
  if (rest[0] > '5' || (rest[0] === '5' && /[1-9]/.test(rest.slice(1)))) n += 1n;
  else if (rest[0] === '5' && n % 2n === 1n) n += 1n; // an exact tie goes to the even neighbour
  const text = n.toString().padStart(digits + 1, '0');
  const out = Number(digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text);
  return negative ? -out : out;
}

// ---------------------------------------------------------------- debate

function tally(ideas, votes, reviews, voteScores) {
  const live = ideas.filter((i) => !i.withdrawn);
  const count = Object.fromEntries(live.map((i) => [i.id, 0]));
  for (const voted of Object.values(votes)) if (voted in count) count[voted] += 1;
  const scores = Object.fromEntries(live.map((i) => [i.id, []]));
  for (const review of reviews) {
    const values = CRIT.filter((c) => typeof (review.scores || {})[c] === 'number').map((c) => review.scores[c]);
    if (values.length && review.id in scores) scores[review.id].push(mean(values));
  }
  for (const [iid, values] of Object.entries(voteScores)) if (iid in scores) scores[iid].push(...values);
  const ranking = live.map((i) => ({ id: i.id, title: i.title, votes: count[i.id], score: scores[i.id].length ? pyRound(mean(scores[i.id]), 2) : 0 }));
  ranking.sort((a, b) => b.votes - a.votes || b.score - a.score || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return { ranking, winner: ranking.length ? ranking[0].id : '' };
}

// ---------------------------------------------------------------- judge

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', '.idea', '.vscode', 'release', 'release-electron']);
const SOURCE_EXT = new Set(['.py', '.js', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cpp', '.cs', '.kt', '.swift', '.html', '.css']);
const SECRET = /AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{32,}|xox[bap]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const TODO = /\bTODO\b|\bFIXME\b|lorem ipsum|placeholder text/i;
const STRAY = /(^|\/)(\.DS_Store|Thumbs\.db|npm-debug\.log|.*\.log|.*\.pyc|.*\.swp)$/;
const TEST = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)(test_[^/]*|[^/]*_test\.[a-z]+|[^/]*\.(test|spec)\.[a-z]+)$/i;
const README_NAMES = ['readme.md', 'readme.rst', 'readme.txt', 'readme'];

/** Deterministic facts about a project folder. Reads only; never follows links out of the folder. */
function auditFolder(root, maxFiles = 600) {
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
    for (const name of names) {
      if (files.length >= maxFiles) return;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      files.push(rel ? `${rel}/${name}` : name);
    }
    const dirs = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name).sort();
    for (const name of dirs) {
      if (files.length >= maxFiles) return;
      const full = path.join(dir, name);
      try {
        if (fs.lstatSync(full).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      walk(full, rel ? `${rel}/${name}` : name);
    }
  };
  walk(root, '');
  const audit = {
    files, count: files.length, loc: 0, test_files: 0, secrets: [], todos: [], stray: [], big: [], samples: {}, readme: '',
    has_gitignore: files.includes('.gitignore'), has_license: files.some((f) => /^(LICENSE|COPYING)/i.test(f)),
  };
  const sized = [];
  for (const rel of files) {
    const full = path.join(root, rel);
    let size;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (TEST.test(rel)) audit.test_files += 1;
    if (STRAY.test(rel)) audit.stray.push(rel);
    if (size > 1_000_000) { audit.big.push(rel); continue; }
    const ext = path.extname(rel).toLowerCase();
    if (SOURCE_EXT.has(ext) || rel.toLowerCase().startsWith('readme')) {
      let body;
      try {
        body = fs.readFileSync(full, 'utf8').replace(/\r\n?/g, '\n'); // the Python twin reads with universal newlines
      } catch {
        continue;
      }
      if (SECRET.test(body)) { audit.secrets.push(rel); continue; } // reported as a fact; the text is never shown to a judge
      if (SOURCE_EXT.has(ext)) {
        audit.loc += body.split('\n').length;
        if (TODO.test(body)) audit.todos.push(rel);
        sized.push([size, rel]);
      }
      if (README_NAMES.includes(rel.toLowerCase())) audit.readme = body.slice(0, 3500);
    }
  }
  sized.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  const tests = sized.filter(([, r]) => TEST.test(r)).slice(0, 2).map(([, r]) => r);
  const code = sized.filter(([, r]) => !TEST.test(r)).slice(0, 3).map(([, r]) => r);
  for (const rel of [...code, ...tests]) {
    try {
      audit.samples[rel] = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/g, '\n').slice(0, 1400);
    } catch { /* unreadable */ }
  }
  const readme = audit.readme.toLowerCase();
  audit.readme_len = audit.readme.length;
  audit.readme_has_run = /\b(run|usage|install|start|getting started)\b/.test(readme);
  audit.readme_has_test = /\btests?\b/.test(readme);
  audit.has_tests = audit.test_files > 0;
  return audit;
}

function capsFromAudit(a) {
  const caps = {};
  if (!a.has_tests) caps.testing = [3.0, 'no automated tests were found'];
  if (a.secrets && a.secrets.length) caps.security = [3.0, 'a possible secret is committed'];
  if ((a.readme_len || 0) < 200) caps.docs = [3.0, 'the README is missing or nearly empty'];
  else if (!a.readme_has_run || !a.readme_has_test) caps.docs = [6.0, 'the README does not explain how to run and test it'];
  if ((a.stray && a.stray.length) || (a.todos && a.todos.length)) caps.quality = [7.0, 'stray files or TODO/placeholder text remain'];
  return caps;
}

function evidence(brief, a) {
  const measurements = `files=${a.count} source_lines=${a.loc} test_files=${a.test_files} has_gitignore=${a.has_gitignore ? 'True' : 'False'} `
    + `has_license=${a.has_license ? 'True' : 'False'} stray_files=${a.stray.length} possible_secrets=${a.secrets.length} `
    + `files_with_todo_or_placeholder=${a.todos.length} files_over_1MB=${a.big.length}`;
  const samples = Object.entries(a.samples).map(([name, body]) => `--- ${name} ---\n${body}`).join('\n\n');
  return `BRIEF:\n${brief}\n\nOBJECTIVE MEASUREMENTS: ${measurements}\n\nREADME:\n${a.readme || '(missing)'}\n\n`
    + `FILE LIST:\n${a.files.slice(0, 120).join('\n')}\n\nSAMPLE SOURCE AND TESTS:\n${samples}`;
}

function judgeSystem() {
  const criteria = CRITERIA.map(([k, , w, d]) => `- ${k} (${w} points): ${d}`).join('\n');
  return JUDGE_SYSTEM.replace('{criteria}', criteria).replace('{scale}', SCALE);
}

function parseJudge(source) {
  const obj = extractObject(source, 'scores');
  const scores = obj && obj.scores;
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return null;
  const out = {};
  for (const key of KEYS) {
    const n = num(scores[key]);
    if (n === null) return null;
    const row = scores[key];
    out[key] = { score: pyRound(n, 1), evidence: row && typeof row === 'object' && !Array.isArray(row) ? clean(row.evidence, 300) : '' };
  }
  const improvements = [];
  for (const item of (Array.isArray(obj.improvements) ? obj.improvements : []).slice(0, 5)) {
    if (item && typeof item === 'object' && clean(item.title, 100)) {
      const severity = ['blocker', 'major', 'minor'].includes(item.severity) ? item.severity : 'minor';
      improvements.push({ title: clean(item.title, 100), detail: clean(item.detail, 600), severity });
    }
  }
  const strengths = (Array.isArray(obj.strengths) ? obj.strengths : []).map((s) => clean(s, 160)).filter(Boolean).slice(0, 4);
  return { scores: out, strengths, improvements, summary: clean(obj.summary, 400) };
}

function grade(overall) {
  for (const [cut, letter] of [[90, 'A+'], [80, 'A'], [70, 'B'], [60, 'C'], [50, 'D']]) if (overall >= cut) return letter;
  return 'F';
}

function aggregate(judges, caps) {
  const criteria = [];
  const disagree = [];
  for (const key of KEYS) {
    const raw = judges.map((j) => j.scores[key].score);
    const capped = raw.map((x) => (key in caps ? Math.min(x, caps[key][0]) : x));
    const row = { key, label: LABEL[key], weight: WEIGHT[key], score: pyRound(median(capped), 1), scores: raw };
    if (key in caps && raw.some((x) => x > caps[key][0])) row.cap = caps[key][1];
    const notes = judges.map((j) => j.scores[key].evidence).filter(Boolean);
    row.note = notes.length ? notes[0] : '';
    if (raw.length > 1 && Math.max(...raw) - Math.min(...raw) >= 2.5) {
      disagree.push(`${LABEL[key]}: judges ranged from ${Math.min(...raw).toFixed(1)} to ${Math.max(...raw).toFixed(1)}`);
    }
    criteria.push(row);
  }
  const overall = pyRound(criteria.reduce((sum, c) => sum + c.score * c.weight, 0) / 10, 1);
  const order = { blocker: 0, major: 1, minor: 2 };
  const seen = new Set();
  const improvements = [];
  const all = judges.flatMap((j) => j.improvements).map((item, index) => ({ item, index }));
  all.sort((a, b) => order[a.item.severity] - order[b.item.severity] || a.index - b.index);
  for (const { item } of all) {
    const key = item.title.toLowerCase().slice(0, 40);
    if (!seen.has(key)) { seen.add(key); improvements.push(item); }
  }
  const strengths = [];
  for (const j of judges) for (const s of j.strengths) if (!strengths.includes(s)) strengths.push(s);
  return {
    overall, grade: grade(overall), criteria, improvements: improvements.slice(0, 8), strengths: strengths.slice(0, 6), disagreement: disagree,
    caps: Object.entries(caps).map(([k, v]) => ({ criterion: LABEL[k], max: v[0], why: v[1] })),
  };
}

// ---------------------------------------------------------------- running

const sub = (template, pairs) => pairs.reduce((acc, [k, v]) => acc.split(k).join(v), template);
const lines = (value) => value.join('\n');

/** Runs a council with an injected `ask(agentId, prompt) -> Promise<text | null>`, so it is testable without any agent. */
class Council {
  constructor({ ask, labels, log, cancelled, seed = 'flowmesh' }) {
    Object.assign(this, { ask, labels, log, cancelled, seed });
  }

  check() {
    if (this.cancelled()) throw new Cancelled();
  }

  /** Ask every agent in parallel (at most three at once). Resolves to {agentId: raw text or null}. */
  async all(agentIds, make) {
    this.check();
    const prompts = Object.fromEntries(agentIds.map((a) => [a, make(a)]));
    const out = Object.fromEntries(agentIds.map((a) => [a, null]));
    const queue = agentIds.filter((a) => prompts[a]);
    const worker = async () => {
      while (queue.length) {
        const a = queue.shift();
        try {
          out[a] = await this.ask(a, prompts[a]);
        } catch {
          out[a] = null; // one agent failing must not stop the council
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, agentIds.length)) }, worker));
    this.check();
    return out;
  }

  async debate(problem, agentIds) {
    const n = agentIds.length;
    const name = (a) => this.labels[a] || a;
    const result = { kind: 'debate', problem, ideas: [], reviews: [], votes: [], ranking: [], winner: '', silent: [] };
    const k = n <= 3 ? 2 : 1;

    this.log(`Round 1 of 4: ${n} agents study the problem and propose approaches`);
    const raw = await this.all(agentIds, () => `${sub(PROPOSE, [['{n}', String(n)], ['{k}', String(k)]])}\n\nPROBLEM:\n${problem}`);
    const proposals = [];
    for (const a of agentIds) {
      const obj = extractObject(raw[a] || '', 'ideas');
      let got = 0;
      for (const item of ((obj && Array.isArray(obj.ideas)) ? obj.ideas : []).slice(0, k)) {
        if (item && typeof item === 'object' && clean(item.title, 100) && clean(item.pitch, 600)) {
          proposals.push({
            author: a, title: clean(item.title, 100), pitch: clean(item.pitch, 600),
            research: (Array.isArray(item.research) ? item.research : []).map((x) => clean(x, 200)).filter(Boolean).slice(0, 4),
            stack: clean(item.stack, 200), mvp: clean(item.mvp, 400), risks: clean(item.risks, 300),
          });
          got += 1;
        }
      }
      if (!got) {
        result.silent.push(a);
        this.log(`${name(a)} could not propose anything; continuing without it`);
      }
    }
    if (!proposals.length) throw new Error('no agent produced a usable proposal');
    const ideas = shuffleSeeded(proposals, this.seed).map((p, i) => ({ id: `I${i + 1}`, ...p }));
    result.ideas = ideas;
    this.log(`${ideas.length} approaches on the table: ${ideas.map((i) => `${i.id} ${i.title}`).join('; ')}`);

    const board = () => ideas.filter((i) => !i.withdrawn).map((i) => `${i.id}: ${i.title}\nPitch: ${i.pitch}\nStack: ${i.stack}\nMVP: ${i.mvp}\nRisks: ${i.risks}\nResearch: ${i.research.join(' | ')}`).join('\n\n');

    if (ideas.length === 1) {
      result.winner = ideas[0].id;
      result.ranking = [{ id: ideas[0].id, title: ideas[0].title, votes: 0, score: 0 }];
      this.log('Only one approach was proposed: it wins by default');
      return result;
    }
    const mine = (a, liveOnly = false) => ideas.filter((i) => i.author === a && !(liveOnly && i.withdrawn));

    this.log("Round 2 of 4: agents critique each other's approaches, anonymously");
    const critRaw = await this.all(agentIds, (a) => `${sub(CRITIQUE, [['{rubric}', RUBRIC], ['{mine}', mine(a).length ? `Your own approaches are ${mine(a).map((i) => i.id).join(', ')} (do not review those). ` : '']])}\n\nPROBLEM:\n${problem}\n\nAPPROACHES:\n${board()}`);
    const reviews = [];
    for (const a of agentIds) {
      const obj = extractObject(critRaw[a] || '', 'reviews');
      for (const r of (obj && Array.isArray(obj.reviews)) ? obj.reviews : []) {
        if (!r || typeof r !== 'object' || !ideas.some((i) => i.id === r.id && i.author !== a)) continue;
        const sc = r.scores && typeof r.scores === 'object' && !Array.isArray(r.scores) ? r.scores : {};
        const scores = {};
        for (const c of CRIT) if (num(sc[c], 1, 10) !== null) scores[c] = num(sc[c], 1, 10);
        reviews.push({ id: r.id, strengths: clean(r.strengths, 400), weaknesses: clean(r.weaknesses, 400), scores });
      }
    }
    result.reviews = reviews;
    this.log(`${reviews.length} reviews written`);

    this.log('Round 3 of 4: authors answer the critique and improve their approaches');
    const critiqueFor = (iid) => reviews.filter((r) => r.id === iid).map((r) => `- strengths: ${r.strengths} | weaknesses: ${r.weaknesses}`).join('\n') || '(no reviews)';
    const rebRaw = await this.all(agentIds, (a) => (mine(a).length
      ? `${REBUT}\n\nPROBLEM:\n${problem}\n\nYOUR APPROACHES AND THEIR REVIEWS:\n${mine(a).map((i) => `${i.id}: ${i.title}\nPitch: ${i.pitch}\nMVP: ${i.mvp}\nREVIEWS:\n${critiqueFor(i.id)}`).join('\n\n')}`
      : null));
    for (const a of agentIds) {
      const obj = extractObject(rebRaw[a] || '', 'revisions');
      for (const rv of (obj && Array.isArray(obj.revisions)) ? obj.revisions : []) {
        const item = mine(a).find((i) => rv && typeof rv === 'object' && i.id === rv.id);
        if (!item) continue;
        if (rv.withdraw === true && ideas.filter((i) => !i.withdrawn).length > 2) { item.withdrawn = true; continue; }
        item.response = clean(rv.response, 500);
        item.pitch = clean(rv.pitch, 600) || item.pitch;
        item.mvp = clean(rv.mvp, 400) || item.mvp;
      }
    }
    const live = ideas.filter((i) => !i.withdrawn);
    this.log(`${live.length} approaches remain`);

    this.log('Round 4 of 4: every agent votes, never for its own approach');
    const summary = live.map((i) => `${i.id}: ${i.title}\nPitch: ${i.pitch}\nMVP: ${i.mvp}\nAuthor's answer: ${i.response || '-'}\nReviews:\n${critiqueFor(i.id)}`).join('\n\n');
    const voteRaw = await this.all(agentIds, (a) => `${sub(VOTE, [['{mine}', mine(a, true).length ? `Your own approaches are ${mine(a, true).map((i) => i.id).join(', ')}: you may not vote for them. ` : '']])}\n\nPROBLEM:\n${problem}\n\nSURVIVING APPROACHES:\n${summary}`);
    const votes = {};
    const voteScores = {};
    for (const a of agentIds) {
      const obj = extractObject(voteRaw[a] || '', 'vote');
      if (!obj) { this.log(`${name(a)} did not vote`); continue; }
      const valid = new Set(live.filter((i) => i.author !== a).map((i) => i.id));
      let choice = String(obj.vote === undefined || obj.vote === null ? '' : obj.vote).trim();
      const scored = [];
      for (const x of Array.isArray(obj.scores) ? obj.scores : []) {
        if (x && typeof x === 'object' && valid.has(x.id) && num(x.score, 1, 10) !== null) scored.push([num(x.score, 1, 10), x.id]);
      }
      if (!valid.has(choice)) {
        scored.sort((p, q) => q[0] - p[0] || (p[1] < q[1] ? 1 : p[1] > q[1] ? -1 : 0));
        choice = scored.length ? scored[0][1] : '';
      }
      if (!choice) { this.log(`${name(a)}'s vote was invalid and was ignored`); continue; }
      votes[a] = choice;
      for (const [s, iid] of scored) (voteScores[iid] = voteScores[iid] || []).push(s);
      result.votes.push({ voter: a, vote: choice, reason: clean(obj.reason, 300) });
    }
    const outcome = tally(ideas, votes, reviews, voteScores);
    result.ranking = outcome.ranking;
    result.winner = outcome.winner;
    this.log(`Votes: ${result.ranking.map((r) => `${r.id} ${r.title} (${r.votes})`).join(', ')}`);
    return result;
  }

  async judge(brief, audit, agentIds) {
    const caps = capsFromAudit(audit);
    const prompt = `${judgeSystem()}\n\n${evidence(brief, audit)}`;
    this.log(`${agentIds.length} judges score the project blind: no authors, no history`);
    const raw = await this.all(agentIds, () => prompt);
    const good = [];
    const failed = [];
    for (const a of agentIds) {
      const parsed = parseJudge(raw[a] || '');
      (parsed ? good : failed).push([a, parsed]);
    }
    if (!good.length) throw new Error('no judge produced a complete scorecard');
    const card = aggregate(good.map(([, j]) => j), caps);
    card.kind = 'judge';
    card.judges = good.map(([a, j]) => ({
      agent: a, overall: pyRound(KEYS.reduce((sum, k) => sum + j.scores[k].score * WEIGHT[k], 0) / 10, 1), summary: j.summary,
    }));
    card.failed_judges = failed.map(([a]) => a);
    card.measurements = { count: audit.count, loc: audit.loc, test_files: audit.test_files, possible_secrets: audit.secrets.length };
    return card;
  }
}

// ---------------------------------------------------------------- reports (plain text for the receipt)

function reportDebate(result, labels) {
  const name = (a) => labels[a] || a;
  const ideas = Object.fromEntries(result.ideas.map((i) => [i.id, i]));
  const out = [`Debate among ${new Set(result.ideas.map((i) => i.author)).size} agents on: ${result.problem.slice(0, 300)}`, ''];
  const win = ideas[result.winner];
  if (win) out.push(`WINNER ${win.id}: ${win.title}  (proposed by ${name(win.author)})`, `  Pitch: ${win.pitch}`, `  MVP: ${win.mvp}`, `  Stack: ${win.stack}`, `  Risk: ${win.risks}`, '');
  out.push(`Ranking: ${result.ranking.map((r) => `${r.id} ${r.title} (${r.votes} vote${r.votes !== 1 ? 's' : ''}, mean ${r.score.toFixed(2)})`).join('; ')}`);
  for (const v of result.votes) out.push(`  ${name(v.voter)} voted ${v.vote}: ${v.reason}`);
  if (result.silent.length) out.push(`Did not propose: ${result.silent.map(name).join(', ')}`);
  out.push('', 'These are opinions of AI agents. FlowMesh has not checked any of them; the winner is the most-voted proposal, not a verified answer.');
  return lines(out);
}

function reportJudge(card, labels) {
  const name = (a) => labels[a] || a;
  const out = [`Judge panel score: ${card.overall.toFixed(1)} / 100 (${card.grade}), median of ${card.judges.length} judge(s)`, ''];
  for (const c of card.criteria) out.push(`  ${c.label} (${c.weight}): ${c.score.toFixed(1)}  judges [${c.scores.map((x) => x.toFixed(1)).join(', ')}]${c.cap ? `  [capped: ${c.cap}]` : ''}`);
  if (card.strengths.length) out.push('', 'Strengths:', ...card.strengths.map((s) => `  - ${s}`));
  if (card.improvements.length) out.push('', 'Improvements:', ...card.improvements.map((i) => `  - [${i.severity}] ${i.title}: ${i.detail}`));
  if (card.disagreement.length) out.push('', 'Disagreement:', ...card.disagreement.map((d) => `  - ${d}`));
  out.push('', `Judges: ${card.judges.map((j) => `${name(j.agent)} ${j.overall.toFixed(1)}`).join('; ')}`);
  if (card.failed_judges.length) out.push(`No usable scorecard from: ${card.failed_judges.map(name).join(', ')}`);
  const m = card.measurements;
  out.push('', `Measured: ${m.count} files, ${m.loc} source lines, ${m.test_files} test files, ${m.possible_secrets} possible secrets.`,
    'These scores are opinions of AI agents on a fixed rubric. FlowMesh has not run the project or checked them.');
  return lines(out);
}

module.exports = {
  KINDS, LIMITS, Cancelled, Council, extractObject, tally, auditFolder, capsFromAudit, evidence, judgeSystem, parseJudge, aggregate, grade,
  reportDebate, reportJudge, shuffleSeeded, pyRound,
};
