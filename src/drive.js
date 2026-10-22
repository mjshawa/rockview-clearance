import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as FileSystem from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import { WEB_CLIENT_ID, ROOT_FOLDER_NAME, COPY_FOLDER_NAME } from './config';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DB_NAME = 'rockview_backup.db';
export const PHOTO_DIR = `${FileSystem.documentDirectory}photos/`;

export const isConfigured = () => !!WEB_CLIENT_ID && !WEB_CLIENT_ID.startsWith('PASTE');
export const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;

// ---------- Auth ----------
export function configureGoogle() {
  if (!isConfigured()) return;
  GoogleSignin.configure({
    webClientId: WEB_CLIENT_ID,
    // drive.file = the app can only see/manage files and folders it created itself.
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
}

export function currentUser() {
  try {
    if (!GoogleSignin.hasPreviousSignIn()) return null;
    return GoogleSignin.getCurrentUser()?.user ?? null;
  } catch { return null; }
}

export async function signIn() {
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const res = await GoogleSignin.signIn();
  if (res?.type === 'cancelled') return null;
  return res?.data?.user ?? currentUser();
}

export async function signOut() {
  try { await GoogleSignin.signOut(); } catch {}
}

async function token() {
  return (await GoogleSignin.getTokens()).accessToken;
}

// ---------- Drive helpers ----------
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function call(path, { method = 'GET', body, query } = {}) {
  const res = await fetch(`${API}${path}${query ? '?' + qs(query) : ''}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const e = new Error(`Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function findFolder(name, parentId) {
  const q = `mimeType='${FOLDER_MIME}' and name='${esc(name)}' and trashed=false` +
    (parentId ? ` and '${parentId}' in parents` : '');
  const r = await call('/files', { query: { q, fields: 'files(id,name)', pageSize: '1' } });
  return r.files?.[0] ?? null;
}

async function ensureFolder(ctx, name, parentId) {
  const key = `${parentId || 'root'}/${name}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  let f = await findFolder(name, parentId);
  let created = false;
  if (!f) {
    f = await call('/files', {
      method: 'POST',
      query: { fields: 'id' },
      body: { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) },
    });
    created = true;
  }
  const out = { id: f.id, created };
  ctx.cache.set(key, out);
  return out;
}

async function findFile(name, parentId) {
  const q = `name='${esc(name)}' and '${parentId}' in parents and trashed=false`;
  const r = await call('/files', { query: { q, fields: 'files(id,name)', pageSize: '1' } });
  return r.files?.[0] ?? null;
}

async function putContent(fileId, localUri, mime) {
  const up = await FileSystem.uploadAsync(`${UPLOAD}/files/${fileId}?uploadType=media`, localUri, {
    httpMethod: 'PATCH',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': mime },
  });
  if (up.status < 200 || up.status >= 300) throw new Error(`Upload failed (${up.status})`);
}

async function uploadNew(localUri, name, parentId, mime) {
  const meta = await call('/files', { method: 'POST', query: { fields: 'id' }, body: { name, parents: [parentId], mimeType: mime } });
  try {
    await putContent(meta.id, localUri, mime);
  } catch (e) {
    try { await call(`/files/${meta.id}`, { method: 'DELETE' }); } catch {}
    throw e;
  }
  return meta.id;
}

const clean = (s) => String(s || 'untitled').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80);

// ---------- Local tables ----------
export function initDriveTables(db) {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS drive_ledger (
      local_uri TEXT, kind TEXT, drive_file_id TEXT,
      PRIMARY KEY (local_uri, kind)
    );
  `);
}
export const getSetting = (db, k, d = '') => db.getFirstSync('SELECT value FROM settings WHERE key=?', [k])?.value ?? d;
export const setSetting = (db, k, v) => db.runSync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, String(v)]);

function collectPhotos(db) {
  const items = [];
  for (const r of db.getAllSync('SELECT * FROM receipts')) {
    if (!r.image_uri) continue;
    const period = r.period_type === 'semester' ? 'Semester' : 'Term';
    const label = r.receipt_type === 'annual_other' ? r.category_title : `${period}${r.term}_Instalment${r.slot}`;
    items.push({ uri: r.image_uri, folders: ['Receipts'], name: `${clean(label)}_${clean(r.receipt_number)}.jpg` });
  }
  for (const p of db.getAllSync('SELECT * FROM past_papers')) {
    let pages = [];
    try { pages = JSON.parse(p.image_uris_json || '[]'); } catch {}
    pages.forEach((uri, i) => items.push({
      uri,
      folders: ['Past Papers', clean(p.course_code)],
      name: `${clean(p.course_code)}_${clean(p.exam_year)}_${clean(p.term_or_semester)}_page${i + 1}.jpg`,
    }));
  }
  return items;
}

// ---------- Backup ----------
export async function backupToDrive({ db, duplicate, onProgress = () => {} }) {
  const ctx = { cache: new Map() };
  const kinds = [{ kind: 'main', root: ROOT_FOLDER_NAME }];
  if (duplicate) kinds.push({ kind: 'copy', root: COPY_FOLDER_NAME });

  const items = collectPhotos(db);
  let uploaded = 0, missing = 0, n = 0;
  const total = items.length * kinds.length;
  let mainRootId = null;

  for (const k of kinds) {
    const root = await ensureFolder(ctx, k.root, null);
    if (k.kind === 'main') mainRootId = root.id;
    // Folder was deleted/never existed -> everything must be uploaded again
    if (root.created) db.runSync('DELETE FROM drive_ledger WHERE kind=?', [k.kind]);

    for (const item of items) {
      n++;
      onProgress(`Uploading photos ${n}/${total}`);
      const known = db.getFirstSync('SELECT 1 AS x FROM drive_ledger WHERE local_uri=? AND kind=?', [item.uri, k.kind]);
      if (known) continue;
      const info = await FileSystem.getInfoAsync(item.uri);
      if (!info.exists) { missing++; continue; }

      let parent = root.id;
      for (const seg of item.folders) parent = (await ensureFolder(ctx, seg, parent)).id;

      let id = null;
      if (k.kind === 'copy') {
        const m = db.getFirstSync("SELECT drive_file_id FROM drive_ledger WHERE local_uri=? AND kind='main'", [item.uri]);
        if (m) {
          try {
            id = (await call(`/files/${m.drive_file_id}/copy`, { method: 'POST', query: { fields: 'id' }, body: { name: item.name, parents: [parent] } })).id;
          } catch { id = null; }
        }
      }
      if (!id) id = await uploadNew(item.uri, item.name, parent, 'image/jpeg');
      db.runSync('INSERT OR REPLACE INTO drive_ledger (local_uri, kind, drive_file_id) VALUES (?, ?, ?)', [item.uri, k.kind, id]);
      uploaded++;
    }
  }

  // Database last, so the uploaded ledger inside it is up to date
  onProgress('Backing up records…');
  try { db.execSync('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
  const dbPath = `${FileSystem.documentDirectory}SQLite/rockview_hub.db`;
  for (const k of kinds) {
    const root = await ensureFolder(ctx, k.root, null);
    const bf = await ensureFolder(ctx, 'Backup', root.id);
    const existing = await findFile(DB_NAME, bf.id);
    if (existing) await putContent(existing.id, dbPath, 'application/octet-stream');
    else await uploadNew(dbPath, DB_NAME, bf.id, 'application/octet-stream');
  }

  return { uploaded, missing, folderId: mainRootId };
}

// ---------- Restore ----------
export async function restoreFromDrive({ db, onProgress = () => {} }) {
  const root = await findFolder(ROOT_FOLDER_NAME, null);
  const bf = root && (await findFolder('Backup', root.id));
  const file = bf && (await findFile(DB_NAME, bf.id));
  if (!file) return { found: false };

  onProgress('Downloading records…');
  const tmpPath = `${FileSystem.documentDirectory}SQLite/restore_tmp.db`;
  await FileSystem.deleteAsync(tmpPath, { idempotent: true });
  const dl = await FileSystem.downloadAsync(`${API}/files/${file.id}?alt=media`, tmpPath, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
  if (dl.status !== 200) throw new Error(`Download failed (${dl.status})`);

  const tmp = SQLite.openDatabaseSync('restore_tmp.db');
  const map = {};
  let photos = 0, receipts = 0, papers = 0, profile = false;
  try {
    await FileSystem.makeDirectoryAsync(PHOTO_DIR, { intermediates: true }).catch(() => {});
    let ledger = [];
    try { ledger = tmp.getAllSync('SELECT * FROM drive_ledger'); } catch {}

    const mainRows = ledger.filter((l) => l.kind === 'main');
    for (let i = 0; i < mainRows.length; i++) {
      onProgress(`Restoring photos ${i + 1}/${mainRows.length}`);
      const l = mainRows[i];
      const dest = `${PHOTO_DIR}restored_${l.drive_file_id}.jpg`;
      try {
        const info = await FileSystem.getInfoAsync(dest);
        if (!info.exists) {
          const r = await FileSystem.downloadAsync(`${API}/files/${l.drive_file_id}?alt=media`, dest, {
            headers: { Authorization: `Bearer ${await token()}` },
          });
          if (r.status !== 200) { await FileSystem.deleteAsync(dest, { idempotent: true }); continue; }
        }
        map[l.local_uri] = dest;
        photos++;
      } catch {}
    }

    for (const r of tmp.getAllSync('SELECT * FROM receipts')) {
      const res = db.runSync(
        'INSERT OR IGNORE INTO receipts (receipt_type, period_type, term, slot, category_title, receipt_number, amount, is_cleared, image_uri) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [r.receipt_type, r.period_type || 'term', r.term, r.slot, r.category_title, r.receipt_number, r.amount, r.is_cleared, map[r.image_uri] ?? r.image_uri ?? '']
      );
      if (res.changes > 0) receipts++;
    }
    for (const p of tmp.getAllSync('SELECT * FROM past_papers')) {
      const exists = db.getFirstSync(
        'SELECT 1 AS x FROM past_papers WHERE course_code=? AND exam_year=? AND term_or_semester=? AND course_title=?',
        [p.course_code, p.exam_year, p.term_or_semester, p.course_title]
      );
      if (exists) continue;
      let pages = [];
      try { pages = JSON.parse(p.image_uris_json || '[]'); } catch {}
      db.runSync(
        'INSERT INTO past_papers (course_code, course_title, exam_year, term_or_semester, image_uris_json) VALUES (?, ?, ?, ?, ?)',
        [p.course_code, p.course_title, p.exam_year, p.term_or_semester, JSON.stringify(pages.map((u) => map[u] ?? u))]
      );
      papers++;
    }
    // Restore the student's profile + Terms/Semesters choice if this phone has none yet
    try {
      const mine = db.getFirstSync("SELECT 1 AS x FROM settings WHERE key='profile'");
      if (!mine) {
        const rows = tmp.getAllSync("SELECT key, value FROM settings WHERE key IN ('profile', 'period_mode')");
        rows.forEach((row) => setSetting(db, row.key, row.value));
        profile = rows.length > 0;
      }
    } catch {}
    for (const l of ledger) {
      const uri = map[l.local_uri];
      if (uri) db.runSync('INSERT OR REPLACE INTO drive_ledger (local_uri, kind, drive_file_id) VALUES (?, ?, ?)', [uri, l.kind, l.drive_file_id]);
    }
  } finally {
    try { tmp.closeSync(); } catch {}
    try { await SQLite.deleteDatabaseAsync('restore_tmp.db'); } catch {}
  }
  return { found: true, receipts, papers, photos, profile, folderId: root.id };
}
