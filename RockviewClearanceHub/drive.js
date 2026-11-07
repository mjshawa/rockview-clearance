// drive.js - Google Drive backup for Rockview Clearance Hub.
// Photos and PDFs are saved on the phone first; this file pushes them to the student's own Google Drive.
// Setup (Web client ID in src/config.js): see GOOGLE_DRIVE_SETUP.md
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as FileSystem from 'expo-file-system';
import * as Docs from './documents';
import { WEB_CLIENT_ID, ROOT_FOLDER_NAME } from './src/config';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SNAPSHOT_NAME = 'rockview_hub_backup.json';

const configured = () => !!WEB_CLIENT_ID && !WEB_CLIENT_ID.startsWith('PASTE');

// ---------- Auth ----------
export function configure() {
  if (!configured()) return;
  GoogleSignin.configure({
    webClientId: WEB_CLIENT_ID,
    scopes: ['https://www.googleapis.com/auth/drive.file'], // app only sees files it created itself
  });
}

export async function isSignedIn() {
  if (!configured()) return false;
  try { return !!GoogleSignin.hasPreviousSignIn(); } catch { return false; }
}

export async function signIn() {
  if (!configured()) throw new Error('Google Drive is not set up yet. Paste the Web client ID into src/config.js (see GOOGLE_DRIVE_SETUP.md) and rebuild.');
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const res = await GoogleSignin.signIn();
  if (res?.type === 'cancelled') throw new Error('Sign-in was cancelled.');
}

export async function signOut() { try { await GoogleSignin.signOut(); } catch {} }

const token = async () => (await GoogleSignin.getTokens()).accessToken;

// ---------- Drive helpers ----------
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const clean = (s) => String(s || 'untitled').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80);

async function call(path, { method = 'GET', body, query } = {}) {
  const res = await fetch(`${API}${path}${query ? '?' + qs(query) : ''}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Drive error ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.status === 204 ? null : res.json();
}

async function findOne(q) {
  const r = await call('/files', { query: { q, fields: 'files(id,name)', pageSize: '1' } });
  return r.files?.[0] ?? null;
}

const folderCache = new Map();
async function ensureFolder(name, parentId) {
  const key = `${parentId || 'root'}/${name}`;
  if (folderCache.has(key)) {
    // a cached folder may have been deleted from Drive meanwhile; verify cheaply
    return folderCache.get(key);
  }
  let f = await findOne(`mimeType='${FOLDER_MIME}' and name='${esc(name)}' and trashed=false` + (parentId ? ` and '${parentId}' in parents` : ''));
  if (!f) f = await call('/files', { method: 'POST', query: { fields: 'id' }, body: { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) } });
  folderCache.set(key, f.id);
  return f.id;
}
async function ensurePath(segments) {
  let id = await ensureFolder(ROOT_FOLDER_NAME, null);
  for (const s of segments) id = await ensureFolder(clean(s), id);
  return id;
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
  try { await putContent(meta.id, localUri, mime); }
  catch (e) { try { await call(`/files/${meta.id}`, { method: 'DELETE' }); } catch {} throw e; }
  return meta.id;
}

async function downloadTo(fileId, dest) {
  const r = await FileSystem.downloadAsync(`${API}/files/${fileId}?alt=media`, dest, { headers: { Authorization: `Bearer ${await token()}` } });
  if (r.status !== 200) { await FileSystem.deleteAsync(dest, { idempotent: true }); throw new Error(`Download failed (${r.status})`); }
}

// ---------- Where each photo goes, and what it is called ----------
const ext = (mime) => (String(mime).includes('png') ? 'png' : 'jpg');

function describePhoto(db, img, index) {
  if (img.owner_type === 'paper') {
    const p = db.getFirstSync('SELECT * FROM past_papers WHERE id=?', [img.owner_id]);
    if (!p) return null;
    const code = clean(p.course_code);
    return { folders: ['Past Papers', String(p.exam_year || 'Unknown year'), code],
      name: `${code}_${clean(p.exam_year)}_${clean(p.term_or_semester)}_page${index}.${ext(img.mime)}` };
  }
  const r = db.getFirstSync('SELECT * FROM receipts WHERE id=?', [img.owner_id]);
  if (!r) return null;
  const year = String(r.academic_year || new Date().getFullYear());
  const kind = r.receipt_type === 'annual_other' ? 'Annual fees' : r.receipt_type === 'clearance' ? 'Clearance' : 'Tuition';
  const label = r.receipt_type === 'annual_other' ? `${r.period_label || 'Intake'}_${r.category_title}` : `${r.period_label || 'Period ' + r.term}_${kind}_slot${r.slot}`;
  return { folders: ['Receipts', year, kind], name: `${clean(label)}_${clean(r.receipt_number)}_photo${index}.${ext(img.mime)}` };
}

// ---------- Sync: photos ----------
export async function syncPending(db) {
  const all = db.getAllSync('SELECT id, owner_type, owner_id, mime, drive_file_id, drive_name, sync_status FROM images ORDER BY owner_type, owner_id, id');
  const counter = {};
  for (const img of all) {
    const k = img.owner_type + ':' + img.owner_id;
    counter[k] = (counter[k] || 0) + 1;
    const d = describePhoto(db, img, counter[k]);
    if (!d) continue;
    const fullName = `${d.folders.join('/')}/${d.name}`;

    if (img.sync_status === 'synced' && img.drive_file_id) {
      // already uploaded: only move/rename if the receipt changed year or details
      if (img.drive_name !== fullName) {
        try {
          const parent = await ensurePath(d.folders);
          const cur = await call(`/files/${img.drive_file_id}`, { query: { fields: 'parents' } });
          await call(`/files/${img.drive_file_id}`, {
            method: 'PATCH',
            query: { addParents: parent, removeParents: (cur.parents || []).join(','), fields: 'id' },
            body: { name: d.name },
          });
          db.runSync('UPDATE images SET drive_name=? WHERE id=?', [fullName, img.id]);
        } catch (e) { console.log('Rename skipped:', e.message); }
      }
      continue;
    }

    const row = db.getFirstSync('SELECT data FROM images WHERE id=?', [img.id]);
    if (!row?.data) continue;
    const tmp = `${FileSystem.cacheDirectory}up_${img.id}.${ext(img.mime)}`;
    await FileSystem.writeAsStringAsync(tmp, row.data, { encoding: FileSystem.EncodingType.Base64 });
    try {
      const parent = await ensurePath(d.folders);
      const id = await uploadNew(tmp, d.name, parent, img.mime || 'image/jpeg');
      db.runSync("UPDATE images SET drive_file_id=?, drive_name=?, sync_status='synced' WHERE id=?", [id, fullName, img.id]);
    } finally { await FileSystem.deleteAsync(tmp, { idempotent: true }); }
  }
}

// ---------- Sync: PDFs and books ----------
export async function syncDocuments(db) {
  const pending = db.getAllSync("SELECT * FROM documents WHERE sync_status IS NOT 'synced'");
  for (const d of pending) {
    const uri = Docs.DIR + d.file_name;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) continue;
    const parent = await ensurePath(['PDFs & Books', d.category === 'important' ? 'Important' : 'Other']);
    const name = `${clean(d.title)}_${d.id}.pdf`;
    const id = await uploadNew(uri, name, parent, 'application/pdf');
    db.runSync("UPDATE documents SET drive_file_id=?, drive_name=?, sync_status='synced' WHERE id=?", [id, name, d.id]);
  }
}

// ---------- Backup of the records (so a new phone can restore) ----------
const TABLES = ['receipts', 'past_papers', 'documents', 'app_profile'];

export async function uploadSnapshot(db) {
  const snap = { version: 1, savedAt: new Date().toISOString() };
  for (const t of TABLES) { try { snap[t] = db.getAllSync(`SELECT * FROM ${t}`); } catch { snap[t] = []; } }
  snap.images = db.getAllSync('SELECT id, owner_type, owner_id, mime, drive_file_id, drive_name, sync_status, created_at FROM images');
  const tmp = `${FileSystem.cacheDirectory}${SNAPSHOT_NAME}`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(snap));
  const folder = await ensurePath(['Backup']);
  const existing = await findOne(`name='${SNAPSHOT_NAME}' and '${folder}' in parents and trashed=false`);
  if (existing) await putContent(existing.id, tmp, 'application/json');
  else await uploadNew(tmp, SNAPSHOT_NAME, folder, 'application/json');
  await FileSystem.deleteAsync(tmp, { idempotent: true });
}

function insertRow(db, table, row) {
  const cols = db.getAllSync(`PRAGMA table_info(${table})`).map(c => c.name);
  const keys = Object.keys(row).filter(k => cols.includes(k));
  db.runSync(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
}

// Only runs when this phone has no records yet. Returns true if anything was restored.
export async function restoreIfEmpty(db) {
  const count = (t) => { try { return db.getFirstSync(`SELECT COUNT(*) AS n FROM ${t}`).n; } catch { return 0; } };
  if (count('receipts') + count('past_papers') + count('documents') > 0) return false;

  const root = await findOne(`mimeType='${FOLDER_MIME}' and name='${esc(ROOT_FOLDER_NAME)}' and trashed=false`);
  const bf = root && await findOne(`mimeType='${FOLDER_MIME}' and name='Backup' and '${root.id}' in parents and trashed=false`);
  const file = bf && await findOne(`name='${SNAPSHOT_NAME}' and '${bf.id}' in parents and trashed=false`);
  if (!file) return false;

  const tmp = `${FileSystem.cacheDirectory}restore_snapshot.json`;
  await downloadTo(file.id, tmp);
  const snap = JSON.parse(await FileSystem.readAsStringAsync(tmp));
  await FileSystem.deleteAsync(tmp, { idempotent: true });

  for (const t of ['receipts', 'past_papers', 'app_profile']) (snap[t] || []).forEach(r => insertRow(db, t, r));

  await FileSystem.makeDirectoryAsync(Docs.DIR, { intermediates: true }).catch(() => {});
  for (const d of snap.documents || []) {
    try { await downloadTo(d.drive_file_id, Docs.DIR + d.file_name); insertRow(db, 'documents', { ...d, sync_status: 'synced' }); }
    catch (e) { console.log('PDF restore skipped:', e.message); }
  }
  for (const im of snap.images || []) {
    if (!im.drive_file_id) continue;
    const t = `${FileSystem.cacheDirectory}restore_${im.id}`;
    try {
      await downloadTo(im.drive_file_id, t);
      const data = await FileSystem.readAsStringAsync(t, { encoding: FileSystem.EncodingType.Base64 });
      insertRow(db, 'images', { ...im, data, sync_status: 'synced' });
    } catch (e) { console.log('Photo restore skipped:', e.message); }
    finally { await FileSystem.deleteAsync(t, { idempotent: true }); }
  }
  return true;
}
