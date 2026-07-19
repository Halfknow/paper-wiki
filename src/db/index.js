const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { migrateStore, emptyStore } = require('../core/store');
const { hasCjk } = require('../core/search');

/**
 * PostgreSQL 持久化层：createDb（连接池 + 编号 migration）+ createRepository（registry/store/texts）。
 *
 * 关键约定（对应 AGENTS.md 陷阱）：
 * - jsonb 参数一律 JSON.stringify 后传：node-pg 会把 JS 数组序列化成 PG 数组字面量（{a,b}）而非 JSON，
 *   直接传数组必写坏 jsonb 列。
 * - 时间戳/数值列用 DOUBLE PRECISION（ms 时间戳 < 2^53 精确），避免 BIGINT 经驱动回来变字符串。
 * - papers.extra 兜底列：PAPER_COLS 未覆盖的未来字段进 extra，读取时合并回 paper，防字段静默丢失。
 * - filepath / fulltextPath 是运行时派生字段，不落库、不参与 hash-diff（绑定 desync 根因修复）。
 * - saveSpaceStore 语义仍是「整库保存」，repository 用 hash-diff 只把变化行放进一个事务，
 *   写放大 O(变更行数)；进程内串行写锁（writeChain）语义保留。
 */

function createDb({ connectionString, createPool } = {}) {
  const pool = createPool ? createPool() : new (require('pg').Pool)({ connectionString });

  async function query(text, params) {
    return pool.query(text, params);
  }

  /** 幂等执行 migrations/*.sql（按文件名排序，schema_migrations 记账） */
  async function migrate() {
    // 先探测再建表：pg-mem 的 Pool 适配器对「已存在表」的 CREATE TABLE IF NOT EXISTS 会报错
    let hasMigrations = true;
    try {
      await query('SELECT 1 FROM schema_migrations LIMIT 1');
    } catch {
      hasMigrations = false;
    }
    if (!hasMigrations) {
      await query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at DOUBLE PRECISION)');
    }
    const dir = path.join(__dirname, 'migrations');
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.sql$/.test(f))
      .sort();
    for (const f of files) {
      const done = await query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (done.rows.length) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // 逐条执行（pg-mem 不支持多语句一次 query）：先剥离 -- 注释行，再按 ";\n" 切分（纯 DDL 文件足够）
        const noComments = sql
          .split(/\r?\n/)
          .filter((l) => !l.trim().startsWith('--'))
          .join('\n');
        const stmts = noComments
          .split(/;\s*(?:\r?\n|$)/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const stmt of stmts) await client.query(stmt);
        await client.query('INSERT INTO schema_migrations(name, applied_at) VALUES($1,$2)', [f, Date.now()]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        // .optional. 迁移（如 tsvector GIN 索引）：pg-mem 等不支持的后端跳过不记账（下次仍会尝试），
        // 功能侧自带降级路径（searchFulltext → ILIKE），不影响正确性
        if (/\.optional\./.test(f)) {
          console.error(`[db] 可选 migration 跳过（当前后端不支持）: ${f}: ${e.message}`);
          continue;
        }
        throw new Error(`migration ${f} 失败: ${e.message}`);
      } finally {
        client.release();
      }
    }
  }

  return { query, pool, migrate, close: () => pool.end() };
}

// ---------------------------------------------------------------------------
// 列映射
// ---------------------------------------------------------------------------

/** papers 表列映射：paper 字段（camelCase）→ 列名（snake_case）。j=true 表示 jsonb 列。 */
const PAPER_COLS = [
  ['filename', 'filename'],
  ['fileMtime', 'file_mtime'],
  ['fileSize', 'file_size'],
  ['addedAt', 'added_at'],
  ['updatedAt', 'updated_at'],
  ['title', 'title'],
  ['year', 'year'],
  ['abstract', 'abstract'],
  ['arxivId', 'arxiv_id'],
  ['arxivUrl', 'arxiv_url'],
  ['primaryCategory', 'primary_category'],
  ['metaSource', 'meta_source'],
  ['metaConfidence', 'meta_confidence'],
  ['fulltextChars', 'fulltext_chars'],
  ['summary', 'summary'],
  ['summaryModel', 'summary_model'],
  ['summaryAt', 'summary_at'],
  ['notes', 'notes'],
  ['rating', 'rating'],
  ['starred', 'starred'],
  ['readStatus', 'read_status'],
  ['status', 'status'],
  ['error', 'error'],
  ['authors', 'authors', true],
  ['tags', 'tags', true],
  ['topics', 'topics', true],
  ['conceptIds', 'concept_ids', true],
  ['folders', 'folders', true],
  ['readProgress', 'read_progress', true],
  ['annotations', 'annotations', true],
  ['chat', 'chat', true],
];
const PAPER_KEYS = new Set(PAPER_COLS.map(([k]) => k));
/** 派生/废弃字段：不落库、不参与 diff */
const DERIVED_KEYS = new Set(['filepath', 'fulltextPath']);

/** paper → 规范行对象（undefined 统一 null，保证 hash 稳定） */
function paperToRow(p) {
  const row = { id: p.id };
  for (const [key, col] of PAPER_COLS) {
    row[col] = p[key] === undefined ? null : p[key];
  }
  const extra = {};
  for (const k of Object.keys(p)) {
    if (k === 'id' || PAPER_KEYS.has(k) || DERIVED_KEYS.has(k)) continue;
    extra[k] = p[k];
  }
  row.extra = Object.keys(extra).length ? extra : null;
  return row;
}

/** 行 → paper 对象（extra 先铺底，已知列覆盖；fulltextPath 固定 null） */
function rowToPaper(row) {
  const p = { ...(row.extra && typeof row.extra === 'object' ? row.extra : {}) };
  p.id = row.id;
  for (const [key, col] of PAPER_COLS) {
    p[key] = row[col] === undefined ? null : row[col];
  }
  p.fulltextPath = null;
  return p;
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}
function hashOf(obj) {
  return sha1(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

function createRepository(db) {
  // 进程内串行写锁（与旧 store.js writeChain 同语义；单容器单进程下足够）
  let writeChain = Promise.resolve();
  // per-space 快照：上次 load/save 时各行的 hash，用于 diff
  const snapshots = new Map(); // spaceId -> {papers:Map, concepts:Map, folders:Map, tags, topics, settings}
  const stats = { rowsWritten: 0 };

  function jstr(v) {
    return v === undefined || v === null ? null : JSON.stringify(v);
  }

  // ---- registry ----

  async function loadRegistry() {
    const r = await db.query(
      'SELECT id, name, papers_dir, scan_interval_minutes, last_scan_at, created_at FROM spaces ORDER BY created_at, id',
    );
    if (!r.rows.length) return null;
    const a = await db.query("SELECT value FROM app_state WHERE key='activeSpaceId'");
    const activeSpaceId = a.rows.length ? a.rows[0].value : null;
    return {
      activeSpaceId: typeof activeSpaceId === 'string' ? activeSpaceId : null,
      spaces: r.rows.map((row) => ({
        id: row.id,
        name: row.name,
        papersDir: row.papers_dir,
        scanIntervalMinutes: Number(row.scan_interval_minutes),
        lastScanAt: Number(row.last_scan_at),
        createdAt: Number(row.created_at),
      })),
    };
  }

  /** 只写 meta 列（name/papers_dir/间隔/lastScan/createdAt），不碰 tags/topics/settings（store 字段） */
  async function upsertSpaceMeta(sp) {
    await db.query(
      `INSERT INTO spaces (id, name, papers_dir, scan_interval_minutes, last_scan_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, papers_dir=EXCLUDED.papers_dir,
         scan_interval_minutes=EXCLUDED.scan_interval_minutes,
         last_scan_at=EXCLUDED.last_scan_at, created_at=EXCLUDED.created_at`,
      [sp.id, sp.name, sp.papersDir, sp.scanIntervalMinutes || 0, sp.lastScanAt || 0, sp.createdAt || 0],
    );
  }

  async function setActiveSpaceId(id) {
    await db.query(
      `INSERT INTO app_state (key, value) VALUES ('activeSpaceId', $1)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [jstr(id)],
    );
  }

  /** 删空间：五表级联（spaces/papers/paper_texts/concepts/folders）+ 清快照 */
  async function deleteSpaceRow(id) {
    const run = writeChain.then(async () => {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM paper_texts WHERE space_id=$1', [id]);
        await client.query('DELETE FROM papers WHERE space_id=$1', [id]);
        await client.query('DELETE FROM concepts WHERE space_id=$1', [id]);
        await client.query('DELETE FROM folders WHERE space_id=$1', [id]);
        await client.query('DELETE FROM spaces WHERE id=$1', [id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      snapshots.delete(id);
    });
    writeChain = run.catch(() => {});
    await run;
  }

  // ---- store 组装 / 保存 ----

  function buildSnapshot(store) {
    const snap = {
      papers: new Map(),
      concepts: new Map(),
      folders: new Map(),
      tags: hashOf(store.tags || []),
      topics: hashOf(store.topics || []),
      settings: hashOf(store.settings || {}),
    };
    for (const p of Object.values(store.papers || {})) snap.papers.set(p.id, hashOf(paperToRow(p)));
    for (const c of store.concepts || []) snap.concepts.set(c.id, hashOf(c));
    for (const f of store.folders || []) snap.folders.set(f.id, hashOf(f));
    return snap;
  }

  /** 组装完整 v2 store（含 migrateStore 规范化，保证与上层内存形状一致 + hash 稳定） */
  async function loadSpaceStore(spaceId) {
    const sp = await db.query('SELECT tags, topics, settings FROM spaces WHERE id=$1', [spaceId]);
    const meta = sp.rows[0] || {};
    const papersR = await db.query('SELECT * FROM papers WHERE space_id=$1', [spaceId]);
    const conceptsR = await db.query(
      'SELECT id, term, definition, paper_ids, created_at, updated_at FROM concepts WHERE space_id=$1 ORDER BY created_at, id',
      [spaceId],
    );
    const foldersR = await db.query(
      'SELECT id, name, color, created_at FROM folders WHERE space_id=$1 ORDER BY created_at, id',
      [spaceId],
    );
    const store = emptyStore();
    store.tags = Array.isArray(meta.tags) ? meta.tags : [];
    store.topics = Array.isArray(meta.topics) ? meta.topics : [];
    store.settings = meta.settings && typeof meta.settings === 'object' ? meta.settings : {};
    store.concepts = conceptsR.rows.map((r) => ({
      id: r.id,
      term: r.term,
      definition: r.definition,
      paperIds: Array.isArray(r.paper_ids) ? r.paper_ids : [],
      createdAt: Number(r.created_at) || 0,
      updatedAt: Number(r.updated_at) || 0,
    }));
    store.folders = foldersR.rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      createdAt: Number(r.created_at) || 0,
    }));
    for (const row of papersR.rows) store.papers[row.id] = rowToPaper(row);
    migrateStore(store); // normalizePaper 补默认值，保证内存形状与旧版一致
    snapshots.set(spaceId, buildSnapshot(store));
    return store;
  }

  /** hash-diff 事务保存：只写变化行；papers 删除连带 paper_texts */
  async function saveSpaceStore(spaceId, store) {
    const run = writeChain.then(async () => {
      const prev = snapshots.get(spaceId) || buildSnapshot(emptyStore());
      const next = buildSnapshot(store);

      const paperUpserts = [];
      for (const p of Object.values(store.papers || {})) {
        if (prev.papers.get(p.id) !== next.papers.get(p.id)) paperUpserts.push(paperToRow(p));
      }
      const paperDeletes = [...prev.papers.keys()].filter((id) => !next.papers.has(id));
      const conceptUpserts = (store.concepts || []).filter((c) => prev.concepts.get(c.id) !== next.concepts.get(c.id));
      const conceptDeletes = [...prev.concepts.keys()].filter((id) => !next.concepts.has(id));
      const folderUpserts = (store.folders || []).filter((f) => prev.folders.get(f.id) !== next.folders.get(f.id));
      const folderDeletes = [...prev.folders.keys()].filter((id) => !next.folders.has(id));
      const dictChanged = prev.tags !== next.tags || prev.topics !== next.topics || prev.settings !== next.settings;

      const nothing =
        !paperUpserts.length &&
        !paperDeletes.length &&
        !conceptUpserts.length &&
        !conceptDeletes.length &&
        !folderUpserts.length &&
        !folderDeletes.length &&
        !dictChanged;
      if (nothing) {
        snapshots.set(spaceId, next);
        return;
      }

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of paperUpserts) {
          const cols = ['space_id', 'id', ...PAPER_COLS.map(([, c]) => c), 'extra'];
          const vals = [
            spaceId,
            row.id,
            ...PAPER_COLS.map(([, c, isJson]) => (isJson ? jstr(row[c]) : row[c])),
            jstr(row.extra),
          ];
          const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
          const updates = cols
            .filter((c) => c !== 'space_id' && c !== 'id')
            .map((c) => `${c}=EXCLUDED.${c}`)
            .join(', ');
          await client.query(
            `INSERT INTO papers (${cols.join(',')}) VALUES (${ph})
             ON CONFLICT (space_id, id) DO UPDATE SET ${updates}`,
            vals,
          );
          stats.rowsWritten++;
        }
        for (const id of paperDeletes) {
          await client.query('DELETE FROM papers WHERE space_id=$1 AND id=$2', [spaceId, id]);
          await client.query('DELETE FROM paper_texts WHERE space_id=$1 AND paper_id=$2', [spaceId, id]);
          stats.rowsWritten++;
        }
        for (const c of conceptUpserts) {
          await client.query(
            `INSERT INTO concepts (space_id, id, term, definition, paper_ids, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (space_id, id) DO UPDATE SET
               term=EXCLUDED.term, definition=EXCLUDED.definition, paper_ids=EXCLUDED.paper_ids,
               created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at`,
            [
              spaceId,
              c.id,
              c.term || '',
              c.definition || '',
              jstr(c.paperIds || []),
              c.createdAt || 0,
              c.updatedAt || 0,
            ],
          );
          stats.rowsWritten++;
        }
        for (const id of conceptDeletes) {
          await client.query('DELETE FROM concepts WHERE space_id=$1 AND id=$2', [spaceId, id]);
          stats.rowsWritten++;
        }
        for (const f of folderUpserts) {
          await client.query(
            `INSERT INTO folders (space_id, id, name, color, created_at) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (space_id, id) DO UPDATE SET
               name=EXCLUDED.name, color=EXCLUDED.color, created_at=EXCLUDED.created_at`,
            [spaceId, f.id, f.name || '', f.color || '', f.createdAt || 0],
          );
          stats.rowsWritten++;
        }
        for (const id of folderDeletes) {
          await client.query('DELETE FROM folders WHERE space_id=$1 AND id=$2', [spaceId, id]);
          stats.rowsWritten++;
        }
        if (dictChanged) {
          await client.query('UPDATE spaces SET tags=$2, topics=$3, settings=$4 WHERE id=$1', [
            spaceId,
            jstr(store.tags || []),
            jstr(store.topics || []),
            jstr(store.settings || {}),
          ]);
          stats.rowsWritten++;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      snapshots.set(spaceId, next);
    });
    writeChain = run.catch(() => {});
    await run;
  }

  // ---- texts ----

  async function savePaperText(spaceId, paperId, text) {
    // PostgreSQL TEXT 不接受 NUL 字节（0x00）——pdfjs 提取的全文偶发含 NUL，必须剥离否则整条 INSERT 报
    // "invalid byte sequence for encoding UTF8"（迁移真实库时踩中）
    const clean = String(text == null ? '' : text)
      .split(String.fromCharCode(0))
      .join('');
    await db.query(
      `INSERT INTO paper_texts (space_id, paper_id, fulltext) VALUES ($1,$2,$3)
       ON CONFLICT (space_id, paper_id) DO UPDATE SET fulltext=EXCLUDED.fulltext`,
      [spaceId, paperId, clean],
    );
  }

  async function getPaperText(spaceId, paperId) {
    const r = await db.query('SELECT fulltext FROM paper_texts WHERE space_id=$1 AND paper_id=$2', [spaceId, paperId]);
    return r.rows.length ? r.rows[0].fulltext : null;
  }

  async function removePaperText(spaceId, paperId) {
    await db.query('DELETE FROM paper_texts WHERE space_id=$1 AND paper_id=$2', [spaceId, paperId]);
  }

  // ---- 全文检索 ----

  /** 全文检索命中的论文（只回 id + 排序分，snippet 由上层用 lib/search.buildSnippets 生成）。
   *  英文查询走 tsvector（english 词干化，吃 002 的 GIN 索引，ts_rank 排序）；
   *  中文查询（tsquery 分词无意义）与 tsvector 不可用后端（pg-mem）降级 ILIKE 子串匹配（rank=null）。 */
  async function searchFulltext(spaceId, query, opts = {}) {
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || 30));
    const q = String(query || '').trim();
    if (!q) return [];
    // v3.2：可选 ids 子集（来自元数据筛选），实现「正文词 + 元数据筛选」交集。
    // 命中限定在该 id 集合内；空数组表示无候选（直接返回空）。
    const idSet = Array.isArray(opts.ids) ? opts.ids.filter(Boolean) : null;
    if (idSet && idSet.length === 0) return [];
    const likeSearch = async () => {
      // ILIKE 子串匹配；%/_/\ 反斜杠转义（PG 默认转义符）。已知偏差：pg-mem 不解析反斜杠转义，
      // 含字面 %/_ 的查询在单测里行为不同（真实 PG 正确），见 tests/db.test.js 注记。
      const pattern = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      if (idSet) {
        // ids 作为位置参数 $4（$1=space, $2=pattern, $3=limit, $4=ids）
        const r = await db.query(
          'SELECT paper_id FROM paper_texts WHERE space_id=$1 AND fulltext ILIKE $2 AND paper_id = ANY($4) LIMIT $3',
          [spaceId, pattern, limit, idSet],
        );
        return r.rows.map((row) => ({ paperId: row.paper_id, rank: null }));
      }
      const r = await db.query('SELECT paper_id FROM paper_texts WHERE space_id=$1 AND fulltext ILIKE $2 LIMIT $3', [
        spaceId,
        pattern,
        limit,
      ]);
      return r.rows.map((row) => ({ paperId: row.paper_id, rank: null }));
    };
    if (hasCjk(q)) return likeSearch();
    try {
      if (idSet) {
        const r = await db.query(
          `SELECT paper_id, ts_rank(to_tsvector('english', fulltext), websearch_to_tsquery('english', $2)) AS rank
           FROM paper_texts
           WHERE space_id=$1 AND to_tsvector('english', fulltext) @@ websearch_to_tsquery('english', $2)
             AND paper_id = ANY($4)
           ORDER BY rank DESC LIMIT $3`,
          [spaceId, q, limit, idSet],
        );
        return r.rows.map((row) => ({ paperId: row.paper_id, rank: Number(row.rank) }));
      }
      const r = await db.query(
        `SELECT paper_id, ts_rank(to_tsvector('english', fulltext), websearch_to_tsquery('english', $2)) AS rank
         FROM paper_texts
         WHERE space_id=$1 AND to_tsvector('english', fulltext) @@ websearch_to_tsquery('english', $2)
         ORDER BY rank DESC LIMIT $3`,
        [spaceId, q, limit],
      );
      return r.rows.map((row) => ({ paperId: row.paper_id, rank: Number(row.rank) }));
    } catch {
      return likeSearch(); // tsvector 不可用（pg-mem 等）→ ILIKE 降级
    }
  }

  return {
    loadRegistry,
    upsertSpaceMeta,
    setActiveSpaceId,
    deleteSpaceRow,
    loadSpaceStore,
    saveSpaceStore,
    savePaperText,
    getPaperText,
    removePaperText,
    searchFulltext,
    _stats: () => ({ ...stats }),
  };
}

module.exports = { createDb, createRepository, paperToRow, rowToPaper };
