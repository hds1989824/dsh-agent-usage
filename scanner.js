/**
 * Host-side scanner for local agent-client session logs.
 *
 * Reads the session logs written by the agent clients installed on this
 * machine (Claude desktop, Qwen Work, WorkBuddy, MiniMax Code, and DeepSeek
 * Harness itself) and aggregates, for one local day, how many sessions were
 * active and how many tokens each platform reported.
 *
 * The scanner is read-only: it never writes to a session file. It only reads
 * files whose modification time falls inside the requested day, then filters
 * individual events by their own timestamp, so a long-running session that
 * started on an earlier day still contributes only the events of the day in
 * question. All filesystem access is asynchronous so a large session log never
 * blocks the Host event loop.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';

const zstdDecompressAsync = promisify(zstdDecompress);

const SKIP_DIRS = new Set(['node_modules', '.git', 'Cache', 'GPUCache', 'Code Cache']);

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}

function addUsage(dst, src) {
  dst.input += src.input || 0;
  dst.output += src.output || 0;
  dst.cacheRead += src.cacheRead || 0;
  dst.cacheCreation += src.cacheCreation || 0;
  dst.total += src.total || 0;
}

/**
 * Aggregate one usage record into a per-model bucket. `<synthetic>` is not a
 * real model and is dropped; an absent label is kept as `(unknown)` so its
 * tokens still appear in the model breakdown.
 */
function addModelUsage(byModel, model, usage) {
  let key;
  if (model === undefined || model === null) {
    key = '(unknown)';
  } else {
    const s = String(model).trim();
    if (!s) key = '(unknown)';
    else if (s === '<synthetic>') return;
    else key = s;
  }
  const dst = byModel[key] || (byModel[key] = emptyUsage());
  addUsage(dst, usage);
}

/** Merge one scan's per-model buckets into an aggregate map. */
function mergeModels(dst, src) {
  if (!src) return;
  for (const [model, usage] of Object.entries(src)) {
    addUsage(dst[model] || (dst[model] = emptyUsage()), usage);
  }
}

/** The model label carried by one log line, per platform. */
function modelOf(kind, o) {
  if (kind === 'claude') return o?.message?.model;
  if (kind === 'workbuddy') return o?.providerData?.model;
  return null;
}

/** Recursively collect every `.jsonl` file below `dir`. */
async function walkJsonl(dir, out = []) {
  return walkSuffix(dir, '.jsonl', out);
}

/** Recursively collect files whose name ends with `suffix` below `dir`. */
async function walkSuffix(dir, suffix, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkSuffix(p, suffix, out);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Claude Code / Claude desktop keep their sessions under a directory named
 * `projects`, at a depth that differs between the two layouts. Find every such
 * directory below `root` and collect the JSONL files inside it. Files such as
 * `logs/cli-diagnostics.jsonl` or `audit.jsonl` are not session logs and are
 * ignored because they live outside a `projects` directory.
 */
async function claudeProjectFiles(root) {
  const out = [];
  try {
    if (!(await stat(root)).isDirectory()) return out;
  } catch {
    return out;
  }
  const stack = [[root, 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop();
    if (depth > 8) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const p = join(dir, entry.name);
      if (entry.name === 'projects') out.push(...await walkJsonl(p));
      else stack.push([p, depth + 1]);
    }
  }
  return out;
}

/**
 * Friendly labels for Qwen Work's model tiers. The local session data only
 * stores the tier key (`flash`, `pro`, ...); the display names come from
 * Qwen's own chat-modes catalog.
 */
const QWEN_MODE_LABELS = {
  flash: '千问·标准 (flash)',
  pro: '千问·高级 (pro)',
  'qwen4-max': '千问·Qwen4-Max',
  'deepseek-v4-pro': '千问·Deepseek-V4-Pro',
  'glm-5.3': '千问·GLM-5.3',
};

function qwenModelLabel(id) {
  if (id === undefined || id === null) return null;
  const s = String(id).trim();
  return s ? QWEN_MODE_LABELS[s] || s : null;
}

/**
 * Current Qwen Work releases keep their sessions in a SQLite database under
 * `~/.qwenworkcn/.harness` tree, instead of the older
 * `~/.qwenworkcn/projects` JSONL layout. Find the database, preferring the
 * known path and falling back to a bounded search.
 */
async function findQwenDb(home) {
  const known = join(home, '.qwenworkcn', '.harness', 'flash-cli', 'qwenwork', 'qwenwork.db');
  try {
    if ((await stat(known)).isFile()) return known;
  } catch {
    // fall through to the search
  }
  const stack = [[join(home, '.qwenworkcn'), 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop();
    if (depth > 6) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isFile() && entry.name === 'qwenwork.db') return p;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) stack.push([p, depth + 1]);
    }
  }
  return null;
}

/**
 * Aggregate one day from the Qwen Work session database. Sessions are counted
 * when they have a message in the day window; tokens are summed from each
 * assistant message's `tokens` object, so a session spanning several days only
 * contributes the messages of the requested day.
 */
async function scanQwenDb(dbPath, start, end) {
  const empty = { details: [], usage: emptyUsage(), models: {} };
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return empty;
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return empty;
  }
  try {
    const startMs = start * 1000;
    const endMs = end * 1000;
    const sessionRows = db.prepare(`
      select s.id as id, s.title as title,
             min(m.time_created) as first, max(m.time_created) as last,
             count(m.id) as msgs
      from session s join message m on m.session_id = s.id
      where m.time_created >= ? and m.time_created < ?
      group by s.id
    `).all(startMs, endMs);
    const messageRows = db.prepare(`
      select m.session_id as session_id, m.data as data, s.model as session_model
      from message m left join session s on s.id = m.session_id
      where m.time_created >= ? and m.time_created < ?
    `).all(startMs, endMs);

    const models = {};
    const bySession = {};
    for (const row of sessionRows) {
      bySession[row.id] = {
        session: row.id,
        title: row.title,
        first: row.first / 1000,
        last: row.last / 1000,
        usage: emptyUsage(),
      };
    }
    for (const row of messageRows) {
      let o;
      try {
        o = JSON.parse(row.data);
      } catch {
        continue;
      }
      const t = o && o.tokens;
      if (!t) continue;
      const rec = bySession[row.session_id];
      if (!rec) continue;
      const input = t.input || 0;
      const output = (t.output || 0) + (t.reasoning || 0);
      const cacheRead = (t.cache && t.cache.read) || 0;
      const cacheCreation = (t.cache && t.cache.write) || 0;
      const u = { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
      addUsage(rec.usage, u);
      let modelId = o.modelID;
      if (!modelId && row.session_model) {
        try {
          modelId = JSON.parse(row.session_model).id;
        } catch {
          // keep the message-level model id
        }
      }
      addModelUsage(models, qwenModelLabel(modelId), u);
    }
    const details = Object.values(bySession);
    details.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
    const usage = emptyUsage();
    for (const d of details) addUsage(usage, d.usage);
    return { details, usage, models };
  } catch {
    return empty;
  } finally {
    try {
      db.close();
    } catch {
      // ignore close failures
    }
  }
}

/** Recursively collect files with an exact name below `dir`. */
async function walkNamed(dir, name, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkNamed(p, name, out);
    } else if (entry.isFile() && entry.name === name) {
      out.push(p);
    }
  }
  return out;
}

/** Find the MiniMax Code runtime database under `~/.minimax`. */
async function findMiniMaxDb(home) {
  const known = join(home, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  try {
    if ((await stat(known)).isFile()) return known;
  } catch {
    // fall through to the search
  }
  const stack = [[join(home, '.minimax'), 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop();
    if (depth > 6) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isFile() && entry.name === 'runtime-state.sqlite') return p;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) stack.push([p, depth + 1]);
    }
  }
  return null;
}

/**
 * Aggregate one day from the MiniMax Code runtime database. Sessions are
 * counted when they have a token-usage row in the day window; tokens are summed
 * per session from `local_runtime_token_usage`.
 */
async function scanMiniMaxDb(dbPath, start, end) {
  const empty = { details: [], usage: emptyUsage(), models: {} };
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return empty;
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return empty;
  }
  try {
    const startMs = start * 1000;
    const endMs = end * 1000;
    const rows = db.prepare(`
      select u.session_id as id, s.title as title,
             min(u.ts) as first, max(u.ts) as last,
             sum(u.input_tokens) as input,
             sum(u.output_tokens + u.reasoning_tokens) as output,
             sum(u.cache_read_tokens) as cache_read,
             sum(u.cache_write_tokens) as cache_write
      from local_runtime_token_usage u
      left join local_runtime_sessions s on s.session_id = u.session_id
      where u.ts >= ? and u.ts < ?
      group by u.session_id
    `).all(startMs, endMs);
    const details = rows.map((row) => {
      const input = row.input || 0;
      const output = row.output || 0;
      const cacheRead = row.cache_read || 0;
      const cacheCreation = row.cache_write || 0;
      return {
        session: row.id,
        title: row.title || '',
        first: row.first / 1000,
        last: row.last / 1000,
        usage: { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation },
      };
    });
    details.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
    const usage = emptyUsage();
    for (const d of details) addUsage(usage, d.usage);

    const modelRows = db.prepare(`
      select model,
             sum(input_tokens) as input,
             sum(output_tokens + reasoning_tokens) as output,
             sum(cache_read_tokens) as cache_read,
             sum(cache_write_tokens) as cache_write
      from local_runtime_token_usage
      where ts >= ? and ts < ?
      group by model
    `).all(startMs, endMs);
    const models = {};
    for (const row of modelRows) {
      const input = row.input || 0;
      const output = row.output || 0;
      const cacheRead = row.cache_read || 0;
      const cacheCreation = row.cache_write || 0;
      addModelUsage(models, row.model, { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation });
    }
    return { details, usage, models };
  } catch {
    return empty;
  } finally {
    try {
      db.close();
    } catch {
      // ignore close failures
    }
  }
}

/**
 * Fallback for MiniMax Code installations without the runtime database: read
 * the per-message `usage` objects from the v2 dated session transcripts.
 */
async function scanMiniMaxJsonl(home, start, end) {
  const root = join(home, '.minimax', 'v2', 'sessions');
  const files = await walkNamed(root, 'messages.jsonl');
  const bySession = {};
  const models = {};
  for (const fp of files) {
    let mtime;
    try {
      mtime = (await stat(fp)).mtimeMs / 1000;
    } catch {
      continue;
    }
    if (mtime < start) continue;
    const dir = dirname(fp);
    let sid = null;
    let title = '';
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      sid = manifest.sessionId || null;
      title = manifest.title || '';
    } catch {
      // fall back to the directory name
    }
    if (!sid) sid = basename(dir);
    let text;
    try {
      text = await readFile(fp, 'utf8');
    } catch {
      continue;
    }
    let first = null;
    let last = null;
    let today = false;
    const usage = emptyUsage();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const m = o && o.message;
      if (!m) continue;
      const ts = toEpoch(m.timestamp);
      if (ts !== null) {
        if (first === null || ts < first) first = ts;
        if (last === null || ts > last) last = ts;
        if (ts >= start && ts < end) today = true;
      }
      if (ts === null || ts < start || ts >= end) continue;
      const u = m.usage;
      if (!u) continue;
      const input = u.input || 0;
      const output = (u.output || 0) + (u.reasoning || 0);
      const cacheRead = u.cacheRead || 0;
      const cacheCreation = u.cacheWrite || 0;
      const record = { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
      addUsage(usage, record);
      addModelUsage(models, m.model, record);
    }
    if (!today) continue;
    const rec = bySession[sid] || (bySession[sid] = { session: sid, title, first, last, usage: emptyUsage() });
    if (first !== null && (rec.first === null || first < rec.first)) rec.first = first;
    if (last !== null && (rec.last === null || last > rec.last)) rec.last = last;
    addUsage(rec.usage, usage);
  }
  const details = Object.values(bySession);
  details.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
  const usage = emptyUsage();
  for (const d of details) addUsage(usage, d.usage);
  return { details, usage, models };
}

/** Aggregate a set of JSONL session files for one day. */
const ZSTD_MAGIC = 4247762216;

/**
 * Locate complete zstd frames in a concatenated-frame buffer without
 * decompressing them. DSH appends one independently decodable frame per write,
 * so a session log is a sequence of frames rather than a single frame.
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    let torn = false;
    for (;;) {
      if (buffer.length - offset < 3) {
        torn = true;
        break;
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        torn = true;
        break;
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (torn) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/** Decompress a concatenated-frame zstd buffer (one frame per write). */
async function decompressZstdFrames(buffer) {
  const frames = scanZstdFrames(buffer);
  if (frames.length === 0) return Buffer.alloc(0);
  const parts = [];
  for (const frame of frames) {
    parts.push(await zstdDecompressAsync(buffer.subarray(frame.start, frame.end)));
  }
  return Buffer.concat(parts);
}

/**
 * Scan one DeepSeek Harness session file (`session.v4.jsonl.zstd`). DSH stores
 * one event per line; `assistant/message` events carry `data.usage` with
 * inputTokens / outputTokens / reasoningTokens / cacheReadTokens. Some streaming
 * rows report `totalTokens: 0`, so the total is recomputed from the fields.
 */
async function scanDshFile(fp, start, end) {
  let buf;
  try {
    buf = await readFile(fp);
  } catch {
    return null;
  }
  let text;
  try {
    text = await decompressZstdFrames(buf);
  } catch {
    return null;
  }
  const usage = emptyUsage();
  const models = {};
  let first = null;
  let last = null;
  let inRange = false;
  let sid = null;
  let title = '';
  let model = null;
  for (const line of text.toString('utf8').split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'session' && o.id) sid = o.id;
    if (o.type === 'session/title' && o.data && o.data.title) title = o.data.title;
    if (o.type === 'request/header') model = o.data?.header?.config?.model || model;
    if (o.type === 'request/context') model = o.data?.model || model;
    const t = o.time;
    if (t) {
      const s = t / 1000;
      if (first === null || s < first) first = s;
      if (last === null || s > last) last = s;
      if (s >= start && s < end) inRange = true;
    }
    if (o.type !== 'assistant/message' || !o.data || !o.data.usage) continue;
    if (!t || t / 1000 < start || t / 1000 >= end) continue;
    const u = o.data.usage;
    const input = u.inputTokens || 0;
    const output = (u.outputTokens || 0) + (u.reasoningTokens || 0);
    const cacheRead = u.cacheReadTokens || 0;
    const record = { input, output, cacheRead, cacheCreation: 0, total: input + output + cacheRead };
    addUsage(usage, record);
    addModelUsage(models, model, record);
  }
  if (!inRange) return null;
  if (!sid) sid = basename(dirname(fp));
  return { session: sid, title, first, last, usage, models };
}

/** Run the scan strategy that fits one platform. */
async function scanPlatform(def, home, start, end) {
  if ((def.kind === 'qwen' || def.kind === 'minimax') && def.db) {
    const dbPath = await def.db();
    if (dbPath) {
      return def.kind === 'qwen'
        ? scanQwenDb(dbPath, start, end)
        : scanMiniMaxDb(dbPath, start, end);
    }
  }
  if (def.kind === 'minimax') return scanMiniMaxJsonl(home, start, end);
  if (def.kind === 'dsh') {
    let files = [];
    try {
      files = await def.files();
    } catch {
      files = [];
    }
    const scanned = [];
    for (const fp of files) {
      let mtime;
      try {
        mtime = (await stat(fp)).mtimeMs / 1000;
      } catch {
        continue;
      }
      if (mtime >= start) scanned.push(await scanDshFile(fp, start, end));
    }
    const details = scanned.filter(Boolean);
    details.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
    const usage = emptyUsage();
    const models = {};
    for (const d of details) {
      addUsage(usage, d.usage);
      mergeModels(models, d.models);
    }
    return { details, usage, models };
  }
  let files = [];
  try {
    files = await def.files();
  } catch {
    files = [];
  }
  return scanFiles(files, start, end, def.kind);
}

async function scanFiles(files, start, end, kind) {
  const candidates = [];
  for (const fp of files) {
    let mtime;
    try {
      mtime = (await stat(fp)).mtimeMs / 1000;
    } catch {
      continue;
    }
    if (mtime >= start) candidates.push(fp);
  }
  const scanned = await Promise.all(candidates.map((fp) => scanFile(fp, start, end, kind)));
  const details = scanned.filter(Boolean);
  details.sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
  const usage = emptyUsage();
  const models = {};
  for (const d of details) {
    addUsage(usage, d.usage);
    mergeModels(models, d.models);
  }
  return { details, usage, models };
}

function toEpoch(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value > 1e11 ? value / 1000 : value;
  const s = String(value).trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/**
 * Read and normalize one usage record from a log line. Claude assistant
 * messages carry `message.usage`; WorkBuddy function_call events carry
 * `message.usage` too. WorkBuddy's `input_tokens` already includes its cache
 * reads, so its cache columns are zeroed and the total is input + output;
 * Claude reports the non-cached input, so the cache fields add on top.
 */
function readUsage(o, kind) {
  const u = o?.message?.usage ?? o?.usage ?? o?.payload?.usage;
  if (!u || typeof u !== 'object') return null;
  const num = (k) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? u[k] : 0);
  const usage = {
    input: num('input_tokens'),
    output: num('output_tokens'),
    cacheRead: num('cache_read_input_tokens'),
    cacheCreation: num('cache_creation_input_tokens'),
    total: 0,
  };
  if (kind === 'workbuddy') {
    usage.cacheRead = 0;
    usage.cacheCreation = 0;
    usage.total = usage.input + usage.output;
  } else {
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
  }
  return usage;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Resolve the requested window to a local-time [start, end) pair in epoch
 * seconds. `date` pins one day; otherwise `range` selects today, the current
 * week (Monday-based, as used in China), or the current month.
 */
function resolveRange(date, range) {
  const now = new Date();
  if (date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) throw new Error(`invalid date: ${date}`);
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const start = Math.floor(d.getTime() / 1000);
    return { start, end: start + 86400, label: fmtDate(d), granularity: 'day' };
  }
  if (range === 'week') {
    const sinceMonday = (now.getDay() + 6) % 7;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday);
    const start = Math.floor(d.getTime() / 1000);
    const end = start + 7 * 86400;
    return { start, end, label: `${fmtDate(d)} ~ ${fmtDate(new Date(end * 1000 - 1))}`, granularity: 'week' };
  }
  if (range === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    const start = Math.floor(d.getTime() / 1000);
    const end = Math.floor(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000);
    return { start, end, label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, granularity: 'month' };
  }
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = Math.floor(d.getTime() / 1000);
  return { start, end: start + 86400, label: fmtDate(d), granularity: 'day' };
}

function platformDefs(home) {
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  return [
    {
      id: 'claude-desktop',
      label: 'Claude 桌面端',
      kind: 'claude',
      files: () => Promise.all([
        claudeProjectFiles(join(local, 'Claude-3p')),
        claudeProjectFiles(join(roaming, 'Claude-3p')),
        claudeProjectFiles(join(local, 'Claude')),
        claudeProjectFiles(join(roaming, 'Claude')),
      ]).then((groups) => groups.flat()),
    },
    {
      id: 'qwenwork',
      label: '千问办公',
      kind: 'qwen',
      files: () => walkJsonl(join(home, '.qwenworkcn', 'projects')),
      db: () => findQwenDb(home),
    },
    {
      id: 'workbuddy',
      label: 'WorkBuddy',
      kind: 'workbuddy',
      files: () => walkJsonl(join(home, '.workbuddy', 'projects')),
    },
    {
      id: 'minimax-code',
      label: 'MiniMax Code',
      kind: 'minimax',
      files: () => [],
      db: () => findMiniMaxDb(home),
    },
    {
      id: 'dsh',
      label: 'DeepSeek Harness',
      kind: 'dsh',
      files: () => walkSuffix(join(home, '.dsh', 'sessions'), '.jsonl.zstd'),
    },
  ];
}

/**
 * Scan one session file. Returns null when the file has no event in the day
 * window. Claude logs one response several times (one line per content block)
 * with the same `message.id` and the same usage, so usage is deduplicated by
 * that id; WorkBuddy logs one function_call per model request.
 */
async function scanFile(fp, start, end, kind) {
  let text;
  try {
    text = await readFile(fp, 'utf8');
  } catch {
    return null;
  }
  const session = basename(fp, '.jsonl');
  const seen = new Set();
  const usage = emptyUsage();
  const models = {};
  let first = null;
  let last = null;
  let today = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = toEpoch(o.timestamp);
    if (ts !== null) {
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
      if (ts >= start && ts < end) today = true;
    }
    if (ts === null || ts < start || ts >= end) continue;
    const u = readUsage(o, kind);
    if (!u) continue;
    if (kind === 'claude') {
      const id = o?.message?.id;
      const key = id ? `id:${id}` : `ts:${ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    addUsage(usage, u);
    addModelUsage(models, modelOf(kind, o), u);
  }
  if (!today) return null;
  return { session, first, last, usage, models };
}

/**
 * Aggregate one local day across every known agent client.
 *
 * @param {{ date?: string, range?: 'today' | 'week' | 'month', home?: string }} [options]
 * @returns {Promise<{date: string, range: string, granularity: string, dayStart: string, dayEnd: string, platforms: Array, totals: object}>}
 */
export async function collectAgentUsage(options = {}) {
  const { start, end, label, granularity } = resolveRange(options.date, options.range);
  const home = options.home || homedir();
  const platforms = [];
  const totals = { sessions: 0, usage: emptyUsage() };
  const byModel = {};

  for (const def of platformDefs(home)) {
    const { details, usage, models } = await scanPlatform(def, home, start, end);
    platforms.push({ id: def.id, label: def.label, sessions: details.length, usage, details });
    totals.sessions += details.length;
    addUsage(totals.usage, usage);
    mergeModels(byModel, models);
  }

  const modelList = Object.entries(byModel)
    .map(([model, usage]) => ({ model, ...usage }))
    .sort((a, b) => b.total - a.total);

  return {
    date: label,
    range: options.range || 'today',
    granularity,
    dayStart: new Date(start * 1000).toISOString(),
    dayEnd: new Date(end * 1000).toISOString(),
    platforms,
    models: modelList,
    totals,
  };
}
