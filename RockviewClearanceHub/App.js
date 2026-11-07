import React, { useState, useEffect, useRef } from 'react';
import { 
  StyleSheet, Text, View, ScrollView, TextInput, 
  TouchableOpacity, Alert, Modal, SafeAreaView, StatusBar, Image, AppState, ActivityIndicator, Pressable, useWindowDimensions, KeyboardAvoidingView, Platform
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { MaterialCommunityIcons, FontAwesome5, Ionicons } from '@expo/vector-icons';
import { takePhoto, chooseFromFiles } from './images';
import * as Drive from './drive';
import * as Docs from './documents';
import * as FileSystem from 'expo-file-system';

const db = SQLite.openDatabaseSync('rockview_hub.db');

// Annual fees are grouped by intake. The existing `term` column stores the intake number (1 = January, 2 = June, 3 = September; 0 = not set)
const INTAKES = ['January', 'June', 'September'];
// Study mode: 'term' students have 3 terms/yr (Jan, June, Sept intakes); 'semester' students have 2 semesters/yr (Jan, June intakes)
const MODES = {
  term: { unit: 'Term', periods: [1, 2, 3], intakes: ['January', 'June', 'September'] },
  semester: { unit: 'Semester', periods: [1, 2], intakes: ['January', 'June'] },
};
const intakeName = n => (n ? INTAKES[n - 1] + ' Intake' : 'Intake not set');
const profileIntakeNo = p => { const i = INTAKES.findIndex(n => (p.intake || '').includes(n)) + 1; return i > 0 && i <= MODES[p.mode || 'term'].intakes.length ? i : 1; };
// An intake only counts if it is one of the intakes offered by the chosen study mode (Term: Jan/June/Sept, Semester: Jan/June)
const intakeSelected = p => MODES[p.mode || 'term'].intakes.some(n => (p.intake || '').includes(n));

// Labelled input: always-visible description, hint under it, and visible feedback (focus highlight, green tick when filled, red message when missing)
function Field({ label, hint, required, value, onChangeText, placeholder, keyboardType, error, maxLength, autoCapitalize }) {
  const [focused, setFocused] = useState(false);
  const filled = String(value || '').trim().length > 0;
  return (
    <View style={{ marginBottom: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
        <Text style={styles.fieldLabel}>
          {label}
          {required ? <Text style={{ color: '#ef4444' }}> *</Text> : <Text style={{ color: '#94a3b8', fontWeight: 'normal' }}> (optional)</Text>}
        </Text>
        {filled && !error && <Ionicons name="checkmark-circle" size={15} color="#059669" style={{ marginLeft: 6 }} />}
      </View>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#94a3b8"
        keyboardType={keyboardType}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        underlineColorAndroid="transparent"
        selectionColor="#1e3a8a"
        cursorColor="#1e3a8a"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.input, { marginBottom: 0 }, filled && styles.inputFilled, focused && styles.inputFocus, !!error && styles.inputError]}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('clearance');
  const [profile, setProfile] = useState({
    fullName: 'Student User',
    studentNumber: 'RVU-2025-0892',
    programme: 'BSc Information and Communication Technology',
    academicYear: '2026',
    intake: 'January Intake',
    mode: 'term', // 'term' or 'semester'
    phone: '+260 971 234 567',
    developerEmail: 'mjshawa23@gmail.com'
  });

  const [editingProfile, setEditingProfile] = useState(false);
  const [profileDraft, setProfileDraft] = useState(null);
  const [profileErrors, setProfileErrors] = useState({});

  // Profile is stored as simple key/value rows so every field (incl. study mode and intake) survives app restarts
  const saveProfile = (next) => {
    setProfile(next);
    try {
      Object.entries(next).forEach(([k, v]) =>
        db.runSync('INSERT OR REPLACE INTO app_profile (key, value) VALUES (?, ?)', [k, String(v ?? '')]));
    } catch (e) { console.log('Profile save failed:', e); Alert.alert('Could not save', 'Your profile could not be saved. Please try again.'); }
  };
  const loadProfile = () => {
    try {
      const rows = db.getAllSync('SELECT key, value FROM app_profile');
      if (rows.length) {
        const saved = {};
        rows.forEach(r => { saved[r.key] = r.value; });
        setProfile(p => ({ ...p, ...saved }));
      }
    } catch (e) { console.log('Profile load failed:', e); }
  };
  const startEditProfile = () => { setProfileDraft({ ...profile }); setProfileErrors({}); setEditingProfile(true); };
  const commitProfile = () => {
    const d = profileDraft;
    const errs = {};
    if (!d.fullName.trim()) errs.fullName = 'Please enter your full name';
    if (!d.studentNumber.trim()) errs.studentNumber = 'Please enter your student number';
    if (!d.programme.trim()) errs.programme = 'Please enter your programme';
    if (!intakeSelected(d)) errs.intake = 'Please select your intake before saving';
    setProfileErrors(errs);
    if (Object.keys(errs).length) {
      if (errs.intake && Object.keys(errs).length === 1) Alert.alert('Select your intake', 'Choose January, June or September (Term) / January or June (Semester) to continue.');
      return;
    }
    const intakeName_ = MODES[d.mode || 'term'].intakes.find(n => (d.intake || '').includes(n));
    saveProfile({ ...profile, fullName: d.fullName.trim(), studentNumber: d.studentNumber.trim(), programme: d.programme.trim(), academicYear: (d.academicYear || '').trim(), phone: (d.phone || '').trim(), mode: d.mode || 'term', intake: intakeName_ + ' Intake' });
    setEditingProfile(false);
  };

  const cfg = MODES[profile.mode || 'term'];
  const UNIT = cfg.unit;

  const [receipts, setReceipts] = useState([]);
  const [pastPapers, setPastPapers] = useState([]);

  // ---------- Year selector: every receipt belongs to one academic year (Jan–Dec, matching the Jan / June / Sept intakes) ----------
  const thisYear = String(new Date().getFullYear());
  const [selectedYear, setSelectedYear] = useState(thisYear);   // opens on the current year
  const [extraYears, setExtraYears] = useState([]);              // years added with "+ Year" that have no receipts yet
  const [yearInput, setYearInput] = useState('');
  const yearReceipts = receipts.filter(r => r.year === selectedYear);
  const yearPapers = pastPapers.filter(p => String(p.year) === selectedYear);
  const yearList = Array.from(new Set([thisYear, selectedYear, ...extraYears, ...receipts.map(r => r.year), ...pastPapers.map(p => String(p.year))]))
    .filter(Boolean).sort((x, y) => Number(y) - Number(x));
  const [modalVisible, setModalVisible] = useState(false);
  const [modalType, setModalType] = useState(''); // 'add_receipt', 'scan_paper', 'drive_sync'

  // Form states: type can be 'term' (default 1-4 instalments) or 'annual_other' (cement, non-recurring mandatory clearance items)
  const [receiptForm, setReceiptForm] = useState({ 
    receiptType: 'term', // 'term' or 'annual_other'
    term: 1, 
    slot: 1, 
    categoryTitle: 'Cement / Building Fund', // for non-term required clearance receipts
    number: '', 
    amount: '', 
    cleared: false, 
    photos: [] 
  });

  const [documents, setDocuments] = useState([]);
  const [docForm, setDocForm] = useState({ title: '', description: '', category: 'important', file: null });
  const [paperForm, setPaperForm] = useState({ code: '', year: String(new Date().getFullYear()), title: '', semester: 'Term 1', images: [] });

  const [imgStats, setImgStats] = useState({});
  const [submitted, setSubmitted] = useState(false); // true after a failed Save → empty required fields turn red
  const [viewer, setViewer] = useState({ title: '', photos: [] });
  // Full-screen proof view (for showing account officers)
  const [fs, setFs] = useState({ visible: false, index: 0, zoom: false, controls: true });
  const { width: winW, height: winH } = useWindowDimensions();
  // ---------- Sharing (WhatsApp, email, Telegram, Drive, Bluetooth… whatever the phone offers) ----------
  const fileSafe = (t) => String(t || 'Rockview').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Rockview';

  // One photo → a JPEG file in the cache → the phone's share sheet
  const sharePhoto = async (p, title) => {
    try {
      if (!(await Sharing.isAvailableAsync())) { Alert.alert('Share', 'Sharing is not available on this device.'); return; }
      const uri = FileSystem.cacheDirectory + `${fileSafe(title)}_${p.id}.jpg`;
      await FileSystem.writeAsStringAsync(uri, p.data, { encoding: FileSystem.EncodingType.Base64 });
      await Sharing.shareAsync(uri, { mimeType: p.mime || 'image/jpeg', UTI: 'public.jpeg', dialogTitle: title });
    } catch (e) {
      Alert.alert('Share', 'Could not share this photo.');
    }
  };

  // Every photo of a receipt / paper → ONE PDF (one photo per page) → share sheet
  const sharePhotosAsPdf = async () => {
    if (!viewer.photos.length) { Alert.alert('Share', 'There are no photos to share yet.'); return; }
    try {
      if (!(await Sharing.isAvailableAsync())) { Alert.alert('Share', 'Sharing is not available on this device.'); return; }
      const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const html = `<html><body style="margin:0;font-family:Arial">${viewer.photos.map((p, i) => `
        <div style="page-break-after:always;text-align:center;padding:16px">
          <p style="font-size:12px;color:#0d233a"><b>${esc(viewer.title)}</b> — page ${i + 1} of ${viewer.photos.length}</p>
          <img src="data:${p.mime};base64,${p.data}" style="max-width:100%;max-height:900px"/>
        </div>`).join('')}</body></html>`;
      const { uri } = await Print.printToFileAsync({ html });
      const named = FileSystem.cacheDirectory + `${fileSafe(viewer.title)}.pdf`;
      await FileSystem.deleteAsync(named, { idempotent: true });
      await FileSystem.moveAsync({ from: uri, to: named });
      await Sharing.shareAsync(named, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: viewer.title });
    } catch (e) {
      Alert.alert('Share', 'Could not create the PDF to share.');
    }
  };

  const openFullScreen = (index) => {
    setModalVisible(false); // hide the sheet while the full-screen view is up
    setFs({ visible: true, index, zoom: false, controls: true });
  };
  const closeFullScreen = () => {
    setFs(f => ({ ...f, visible: false, zoom: false }));
    setModalVisible(true); // back to the receipt's photo sheet
  };
  const [signedIn, setSignedIn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('');
  const syncLock = useRef(false);

  useEffect(() => {
    initTables();
    loadProfile();
    loadData();
    Drive.configure();
    (async () => {
      const ok = await Drive.isSignedIn();
      setSignedIn(ok);
      if (ok) {
        try { if (await Drive.restoreIfEmpty(db)) loadData(); } catch (e) { console.log('Restore skipped:', e.message); }
        triggerSync();
      }
    })();
    const sub = AppState.addEventListener('change', st => { if (st === 'active') triggerSync(); });
    return () => sub.remove();
  }, []);

  const initTables = () => {
    db.execSync(`
      CREATE TABLE IF NOT EXISTS student_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_number TEXT UNIQUE,
        full_name TEXT,
        programme TEXT,
        academic_year TEXT,
        intake TEXT,
        phone TEXT
      );

      CREATE TABLE IF NOT EXISTS app_profile (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_type TEXT DEFAULT 'term',
        term INTEGER,
        slot INTEGER,
        category_title TEXT,
        receipt_number TEXT UNIQUE,
        amount TEXT,
        is_cleared INTEGER,
        image_uri TEXT
      );

      CREATE TABLE IF NOT EXISTS past_papers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_code TEXT,
        course_title TEXT,
        exam_year TEXT,
        term_or_semester TEXT,
        image_uris_json TEXT
      );

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        description TEXT,
        category TEXT DEFAULT 'important',
        file_name TEXT,
        size INTEGER,
        drive_file_id TEXT,
        drive_name TEXT,
        sync_status TEXT DEFAULT 'pending',
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_type TEXT,
        owner_id INTEGER,
        mime TEXT,
        data TEXT,
        drive_file_id TEXT,
        drive_name TEXT,
        sync_status TEXT DEFAULT 'pending',
        created_at TEXT
      );
    `);
    // Upgrade databases created by older versions (adds the save date + period wording used for Drive file names)
    ['ALTER TABLE receipts ADD COLUMN created_at TEXT', 'ALTER TABLE receipts ADD COLUMN period_label TEXT', 'ALTER TABLE past_papers ADD COLUMN created_at TEXT', 'ALTER TABLE receipts ADD COLUMN academic_year TEXT']
      .forEach(q => { try { db.execSync(q); } catch (e) { /* column already exists */ } });
    // Receipts saved before years existed: file them under the year they were saved in
    try { db.execSync(`UPDATE receipts SET academic_year = COALESCE(strftime('%Y', created_at), '${new Date().getFullYear()}') WHERE academic_year IS NULL OR academic_year = ''`); } catch (e) { console.log('Year backfill skipped:', e.message); }
  };

  const loadData = () => {
    try {
      const receiptRows = db.getAllSync('SELECT * FROM receipts');
      setReceipts(receiptRows.map(r => ({
        id: r.id,
        receiptType: r.receipt_type || 'term',
        term: r.term,
        slot: r.slot,
        categoryTitle: r.category_title,
        number: r.receipt_number,
        amount: r.amount,
        cleared: r.is_cleared === 1,
        year: r.academic_year || String(new Date().getFullYear()),
        image: r.image_uri
      })));

      const paperRows = db.getAllSync('SELECT * FROM past_papers');
      setPastPapers(paperRows.map(p => ({
        id: p.id,
        code: p.course_code,
        title: p.course_title,
        year: p.exam_year,
        semester: p.term_or_semester,
        pages: JSON.parse(p.image_uris_json || '[]')
      })));
      setDocuments(db.getAllSync('SELECT * FROM documents ORDER BY id DESC'));
      const stats = {};
      db.getAllSync("SELECT owner_type t, owner_id i, COUNT(*) total, SUM(sync_status = 'synced') synced FROM images GROUP BY owner_type, owner_id")
        .forEach(r => { stats[r.t + ':' + r.i] = { total: r.total, synced: r.synced || 0 }; });
      setImgStats(stats);
    } catch (err) {
      console.log('Error loading SQLite data:', err);
    }
  };

  const saveImages = (ownerType, ownerId, photos) =>
    photos.forEach(p => db.runSync(
      'INSERT INTO images (owner_type, owner_id, mime, data, sync_status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ownerType, ownerId, p.mime, p.base64, 'pending', new Date().toISOString()]
    ));

  const triggerSync = async () => {
    if (syncLock.current) return;
    if (!(await Drive.isSignedIn())) { setSignedIn(false); return; }
    syncLock.current = true; setSyncing(true);
    try {
      await Drive.syncPending(db);
      await Drive.syncDocuments(db);
      await Drive.uploadSnapshot(db);
      setLastSync(new Date().toLocaleString());
    } catch (e) {
      console.log('Drive sync deferred (offline or error):', e.message);
    } finally {
      syncLock.current = false; setSyncing(false); loadData();
    }
  };

  const handleSignIn = async () => {
    try {
      await Drive.signIn();
      setSignedIn(true);
      if (await Drive.restoreIfEmpty(db)) loadData();
      triggerSync();
    } catch (e) {
      Alert.alert('Google sign-in', e.message || 'Sign-in was cancelled.');
    }
  };

  const handleSignOut = async () => { await Drive.signOut(); setSignedIn(false); };

  const handleAddReceipt = () => {
    const isClr = receiptForm.receiptType === 'clearance';
    const missingRef = isClr ? !receiptForm.categoryTitle.trim() : !receiptForm.number.trim();
    const missingTitle = receiptForm.receiptType === 'annual_other' && !receiptForm.categoryTitle.trim();
    const badAmount = !isClr && !(parseFloat(receiptForm.amount) > 0);
    if (missingRef || missingTitle || badAmount) {
      setSubmitted(true);
      Alert.alert('Missing details', 'Please fill in the fields marked in red.');
      return;
    }
    const refNo = isClr ? `CLR-${UNIT[0]}${receiptForm.term}-${receiptForm.slot}-${Date.now()}` : receiptForm.number;
    try {
      db.withTransactionSync(() => {
        const res = db.runSync(
          'INSERT INTO receipts (receipt_type, term, slot, category_title, receipt_number, amount, is_cleared, image_uri, created_at, period_label, academic_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            receiptForm.receiptType,
            receiptForm.term,
            receiptForm.receiptType === 'annual_other' ? 0 : receiptForm.slot,
            receiptForm.receiptType === 'annual_other' ? receiptForm.categoryTitle.trim() : receiptForm.receiptType === 'clearance' ? receiptForm.categoryTitle.trim() : 'Term Instalment',
            refNo,
            receiptForm.amount || '0',
            receiptForm.cleared ? 1 : 0,
            '',
            new Date().toISOString(),
            receiptForm.receiptType === 'annual_other' ? intakeName(receiptForm.term) : `${UNIT} ${receiptForm.term}`,
            selectedYear
          ]
        );
        saveImages('receipt', res.lastInsertRowId, receiptForm.photos);
      });
      Alert.alert('Saved', receiptForm.photos.length
        ? `Receipt and ${receiptForm.photos.length} photo(s) saved. They will upload to Google Drive automatically.`
        : 'Receipt saved.');
      setModalVisible(false);
      setSubmitted(false);
      setReceiptForm({ receiptType: 'term', term: 1, slot: 1, categoryTitle: 'Cement / Building Fund', number: '', amount: '', cleared: false, photos: [] });
      loadData();
      triggerSync();
    } catch (e) {
      Alert.alert('Error', String(e.message).includes('UNIQUE') ? 'Receipt reference number must be unique.' : 'Could not save receipt.');
    }
  };

  const handleAddYear = () => {
    const y = yearInput.trim();
    if (!/^\d{4}$/.test(y) || Number(y) < 2000 || Number(y) > Number(thisYear) + 1) {
      setSubmitted(true);
      Alert.alert('Year', `Enter a 4-digit year between 2000 and ${Number(thisYear) + 1}.`);
      return;
    }
    setExtraYears(l => (l.includes(y) ? l : [...l, y]));
    setSelectedYear(y);
    setYearInput('');
    setSubmitted(false);
    setModalVisible(false);
  };

  // Move a saved receipt to a different year (e.g. receipts saved before years existed)
  const moveReceiptYear = (y) => {
    db.runSync('UPDATE receipts SET academic_year=? WHERE id=?', [y, viewer.id]);
    loadData();
    triggerSync(); // refreshes the Drive backup + file names
  };

  const handleAddPastPaper = () => {
    if (!paperForm.code.trim() || !paperForm.title.trim() || !/^\d{4}$/.test(String(paperForm.year).trim())) {
      setSubmitted(true);
      Alert.alert('Missing details', 'Please fill in the fields marked in red.');
      return;
    }
    try {
      db.withTransactionSync(() => {
        const res = db.runSync(
          'INSERT INTO past_papers (course_code, course_title, exam_year, term_or_semester, image_uris_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [paperForm.code.trim().toUpperCase(), paperForm.title.trim(), String(paperForm.year).trim(), (paperForm.semester || '').startsWith(UNIT) ? paperForm.semester : UNIT + ' 1', '[]', new Date().toISOString()]
        );
        saveImages('paper', res.lastInsertRowId, paperForm.images);
      });
      Alert.alert('Success', `Past paper added to ${String(paperForm.year).trim()}.`);
      setSelectedYear(String(paperForm.year).trim());
      setModalVisible(false);
      setPaperForm({ code: '', year: String(paperForm.year).trim(), title: '', semester: 'Term 1', images: [] });
      loadData();
      triggerSync();
    } catch (e) {
      Alert.alert('Error', 'Failed to save past paper.');
    }
  };

  const handlePickPdf = async () => {
    try {
      const f = await Docs.pickPdf();
      if (f) setDocForm(d => ({ ...d, file: f, title: d.title || f.name.replace(/\.pdf$/i, '') }));
    } catch (e) {
      Alert.alert('PDF file', e.message);
    }
  };

  const handleAddDocument = async () => {
    if (!docForm.title.trim() || !docForm.description.trim() || !docForm.file) {
      setSubmitted(true);
      Alert.alert('Missing details', 'Choose a PDF and fill in the fields marked in red.');
      return;
    }
    try {
      const stored = await Docs.storeFile(docForm.file.uri, docForm.file.name);
      db.runSync(
        'INSERT INTO documents (title, description, category, file_name, size, sync_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [docForm.title.trim(), docForm.description.trim(), docForm.category, stored, docForm.file.size, 'pending', new Date().toISOString()]
      );
      Alert.alert('Saved', 'PDF saved. It will upload to Google Drive automatically.');
      setModalVisible(false);
      setSubmitted(false);
      setDocForm({ title: '', description: '', category: 'important', file: null });
      loadData();
      triggerSync();
    } catch (e) {
      Alert.alert('Error', 'Could not save the PDF.');
    }
  };

  const openDocument = async (d) => {
    try {
      if (!(await Sharing.isAvailableAsync())) { Alert.alert('PDF', 'Opening files is not supported on this device.'); return; }
      await Sharing.shareAsync(Docs.DIR + d.file_name, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: d.title });
    } catch (e) {
      Alert.alert('PDF', 'Could not open this file.');
    }
  };

  const deleteDocument = (d) => {
    Alert.alert('Delete PDF', `Remove "${d.title}" from this phone? The copy already in your Google Drive folder is not deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await Docs.removeFile(d.file_name);
        db.runSync('DELETE FROM documents WHERE id=?', [d.id]);
        loadData();
        triggerSync(); // refreshes the Drive backup list
      } },
    ]);
  };

  const addPhotos = async (kind, source) => {
    try {
      const picked = source === 'camera' ? await takePhoto() : await chooseFromFiles();
      if (!picked.length) return;
      if (kind === 'receipt') setReceiptForm(f => ({ ...f, photos: [...f.photos, ...picked] }));
      else setPaperForm(f => ({ ...f, images: [...f.images, ...picked] }));
    } catch (e) {
      Alert.alert('Photo', e.message);
    }
  };

  const removePhoto = (kind, i) => {
    if (kind === 'receipt') setReceiptForm(f => ({ ...f, photos: f.photos.filter((_, x) => x !== i) }));
    else setPaperForm(f => ({ ...f, images: f.images.filter((_, x) => x !== i) }));
  };

  const renderPhotoPicker = (kind) => {
    const list = kind === 'receipt' ? receiptForm.photos : paperForm.images;
    return (
      <View>
        <View style={{ flexDirection: 'row' }}>
          <TouchableOpacity style={[styles.camBtn, { flex: 1, marginRight: 6 }]} onPress={() => addPhotos(kind, 'camera')}>
            <Text style={{ color: '#0d233a', fontWeight: 'bold' }}>Take Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.camBtn, { flex: 1 }]} onPress={() => addPhotos(kind, 'files')}>
            <Text style={{ color: '#0d233a', fontWeight: 'bold' }}>Choose Files</Text>
          </TouchableOpacity>
        </View>
        {list.length > 0 && (
          <ScrollView horizontal style={styles.thumbRow}>
            {list.map((p, i) => (
              <TouchableOpacity key={i} onPress={() => removePhoto(kind, i)} style={{ marginRight: 8 }}>
                <Image source={{ uri: `data:${p.mime};base64,${p.base64}` }} style={styles.thumb} />
                <Text style={styles.thumbX}>✕</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        {list.length > 0 && <Text style={{ fontSize: 10, color: '#64748b', marginBottom: 8 }}>{list.length} photo(s) attached — tap one to remove</Text>}
      </View>
    );
  };

  const openPhotos = (type, id, title) => {
    const rows = db.getAllSync('SELECT id, mime, data, sync_status FROM images WHERE owner_type = ? AND owner_id = ? ORDER BY id', [type, id]);
    setViewer({ title, photos: rows, type, id });
    setModalType('view_photos');
    setModalVisible(true);
  };

  // Add more photos to a receipt / paper that is already saved (works for term and annual receipts)
  const addToExisting = async (source) => {
    try {
      const picked = source === 'camera' ? await takePhoto() : await chooseFromFiles();
      if (!picked.length) return;
      saveImages(viewer.type, viewer.id, picked);
      const rows = db.getAllSync('SELECT id, mime, data, sync_status FROM images WHERE owner_type = ? AND owner_id = ? ORDER BY id', [viewer.type, viewer.id]);
      setViewer(v => ({ ...v, photos: rows }));
      loadData();
      triggerSync();
    } catch (e) {
      Alert.alert('Photo', e.message);
    }
  };

  const renderBadge = (type, id) => {
    const s = imgStats[type + ':' + id];
    if (!s) return <Text style={{ fontSize: 10, color: '#94a3b8' }}>No photo</Text>;
    const done = s.synced === s.total;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Ionicons name="camera" size={11} color="#0d233a" />
        <Text style={{ fontSize: 10, marginHorizontal: 3 }}>{s.total}</Text>
        <Ionicons name={done ? 'cloud-done' : 'cloud-offline-outline'} size={12} color={done ? '#059669' : '#d97706'} />
      </View>
    );
  };

  const pendingCount = Object.values(imgStats).reduce((a, s) => a + s.total - s.synced, 0) + documents.filter(d => d.sync_status !== 'synced').length;

  const exportClearancePDF = async () => {
    const totalPaid = yearReceipts.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
    const htmlContent = `
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            h1 { color: #0d233a; text-align: center; margin-bottom: 5px; }
            h3 { color: #555; text-align: center; margin-top: 0; }
            .note { background-color: #fef3c7; padding: 10px; border-radius: 5px; font-size: 11px; margin-bottom: 15px; color: #92400e; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th, td { border: 1px solid #ccc; padding: 8px; text-align: left; font-size: 12px; }
            th { background-color: #0d233a; color: white; }
            .footer { margin-top: 30px; font-size: 10px; color: #777; text-align: center; }
          </style>
        </head>
        <body>
          <h1>ROCKVIEW UNIVERSITY</h1>
          <h3>OFFICIAL STUDENT CLEARANCE RECEIPTS REPORT — ${selectedYear}</h3>
          
          <div class="note">
            <strong>Note:</strong> Includes mandatory clearance receipts (Tuition Instalments, Cement/Building Fund, Exam Clearance). Excludes non-clearance items like Registration and ID fees.
          </div>

          <p><strong>Student:</strong> ${profile.fullName} (${profile.studentNumber})</p>
          <p><strong>Programme:</strong> ${profile.programme}</p>
          <p><strong>Academic Year:</strong> ${selectedYear}${selectedYear === thisYear ? ' | ' + profile.intake : ''}</p>
          <p><strong>Total Clearance Payments:</strong> ZMW ${totalPaid}</p>

          <table>
            <thead>
              <tr>
                <th>Category / ${UNIT}</th>
                <th>Reference / Form Description</th>
                <th style="text-align: right;">Amount (ZMW)</th>
              </tr>
            </thead>
            <tbody>
              ${yearReceipts.map(r => `
                <tr>
                  <td>${r.receiptType === 'annual_other' ? r.categoryTitle + (r.term ? ' (' + intakeName(r.term) + ')' : '') : r.receiptType === 'clearance' ? UNIT + ' ' + r.term + ' Clearance ' + (r.slot || 1) : UNIT + ' ' + r.term + ' (Instalment ' + r.slot + ')'}</td>
                  <td>${r.receiptType === 'clearance' && r.categoryTitle !== 'Term Clearance' ? r.categoryTitle : r.number}</td>
                  <td style="text-align: right;">${r.receiptType === 'clearance' ? '—' : r.amount}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div class="footer">Developer Contact: ${profile.developerEmail}</div>
        </body>
      </html>
    `;

    try {
      const { uri } = await Print.printToFileAsync({ html: htmlContent });
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Share clearance form' });
    } catch (e) {
      Alert.alert('Error', 'Failed to generate PDF.');
    }
  };

  const clrDesc = r => (r.categoryTitle && r.categoryTitle !== 'Term Clearance') ? r.categoryTitle : r.number;
  const clearanceList = yearReceipts.filter(r => r.receiptType === 'clearance');
  const termReceiptsList = yearReceipts.filter(r => r.receiptType === 'term' || !r.receiptType);
  const termTotal = termReceiptsList.concat(clearanceList).reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
  const annualOtherReceiptsList = yearReceipts.filter(r => r.receiptType === 'annual_other');
  const totalPaid = yearReceipts.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0d233a" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTitleContainer}>
          <View style={styles.logoBadge}><Text style={styles.logoText}>R</Text></View>
          <View>
            <Text style={styles.headerTitle}>Rockview Hub</Text>
            <Text style={styles.headerSubtitle}>Clearance & Study Mobile App</Text>
          </View>
        </View>
        <View style={styles.headerIcons}>
          <TouchableOpacity onPress={() => { setModalType('drive_sync'); setModalVisible(true); }}>
            <Ionicons name="cloud-upload-outline" size={24} color="#34d399" style={{ marginRight: 15 }} />
          </TouchableOpacity>
          <TouchableOpacity onPress={exportClearancePDF}>
            <Ionicons name="share-social" size={24} color="#d4af37" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Year selector (receipt tabs only) */}
      {(activeTab === 'clearance' || activeTab === 'annual' || activeTab === 'pastpapers') && (
        <View style={styles.yearBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 12 }}>
            <Ionicons name="calendar" size={16} color="#0d233a" style={{ marginRight: 8 }} />
            {yearList.map(y => {
              const on = y === selectedYear;
              const onPapers = activeTab === 'pastpapers';
              const n = onPapers ? pastPapers.filter(p => String(p.year) === y).length : receipts.filter(r => r.year === y).length;
              const noun = onPapers ? 'paper' : 'receipt';
              return (
                <TouchableOpacity key={y} style={[styles.yearChip, on && styles.yearChipOn]} onPress={() => setSelectedYear(y)}>
                  <Text style={{ fontWeight: 'bold', fontSize: 13, color: on ? '#fff' : '#0d233a' }}>{y}</Text>
                  <Text style={{ fontSize: 9, color: on ? '#d4af37' : '#64748b' }}>{y === thisYear ? 'Current • ' : ''}{n} {noun}{n === 1 ? '' : 's'}</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity style={styles.yearChipAdd} onPress={() => { setYearInput(''); setSubmitted(false); setModalType('add_year'); setModalVisible(true); }}>
              <Ionicons name="add" size={14} color="#1e3a8a" />
              <Text style={{ fontWeight: 'bold', fontSize: 12, color: '#1e3a8a', marginLeft: 2 }}>Year</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      {/* Content Area */}
      <ScrollView style={styles.content}>
        {activeTab === 'clearance' && (
          <View>
            <View style={styles.cardBanner}>
              <Text style={{ color: '#93c5fd', fontSize: 12 }}>Total Tuition & Clearance Payments</Text>
              <Text style={styles.bannerAmount}>ZMW {termTotal}</Text>
              <Text style={{ color: '#e2e8f0', fontSize: 11, marginTop: 5 }}>Academic year: {selectedYear}{selectedYear === thisYear ? ` (current) • Intake: ${profile.intake}` : ''}</Text>
            </View>

            {/* Clearance Guidance Notice */}
            <View style={styles.noticeCard}>
              <Ionicons name="information-circle" size={18} color="#92400e" style={{ marginRight: 6 }} />
              <Text style={styles.noticeText}>
                <Text style={{ fontWeight: 'bold' }}>{UNIT} Clearance:</Text> For each {UNIT.toLowerCase()}, attach your tuition receipts (up to 4 instalments) and record your {UNIT.toLowerCase()} clearance.
              </Text>
            </View>

            {/* Term Cards */}
            {cfg.periods.map(termNum => {
              const termReceipts = termReceiptsList.filter(r => r.term === termNum);
              const clrs = clearanceList.filter(r => r.term === termNum);
              return (
                <View key={termNum} style={styles.termCard}>
                  <Text style={styles.termTitle}>{UNIT} {termNum} — Tuition Receipts ({termReceipts.length}/4 Instalments)</Text>
                  <View style={styles.grid}>
                    {[1, 2, 3, 4].map(slotNum => {
                      const rec = termReceipts.find(r => r.slot === slotNum);
                      return rec ? (
                        <TouchableOpacity key={slotNum} style={styles.slotActive} onPress={() => openPhotos('receipt', rec.id, `${UNIT} ${termNum} • Slot ${slotNum} • ${rec.number}`)}>
                          <Text style={{ fontSize: 10, color: '#64748b' }}>Slot #{slotNum}</Text>
                          <Text style={{ fontSize: 12, fontWeight: 'bold' }} numberOfLines={1}>{rec.number}</Text>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text style={{ fontSize: 10, color: '#059669' }}>ZMW {rec.amount}</Text>
                            {renderBadge('receipt', rec.id)}
                          </View>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity key={slotNum} style={styles.slotEmpty} onPress={() => {
                          setReceiptForm({ receiptType: 'term', term: termNum, slot: slotNum, categoryTitle: '', number: '', amount: '', cleared: false, photos: [] });
                          setModalType('add_receipt');
                          setModalVisible(true);
                        }}>
                          <Ionicons name="add" size={16} color="#94a3b8" />
                          <Text style={{ fontSize: 10, color: '#94a3b8' }}>Slot {slotNum}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={[styles.termTitle, { marginTop: 6 }]}>{UNIT} {termNum} Clearance ({clrs.length}/2)</Text>
                  <View style={styles.grid}>
                    {[1, 2].map(slotNum => {
                      const c = clrs.find(r => (r.slot || 1) === slotNum);
                      return c ? (
                        <TouchableOpacity key={slotNum} style={styles.slotActive2} onPress={() => openPhotos('receipt', c.id, `${UNIT} ${termNum} Clearance ${slotNum} • ${clrDesc(c)}`)}>
                          <Text style={{ fontSize: 10, color: '#64748b' }}>Clearance {slotNum}</Text>
                          <Text style={{ fontSize: 12, fontWeight: 'bold' }} numberOfLines={2}>{clrDesc(c)}</Text>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#059669' }}>✓ Cleared</Text>
                            {renderBadge('receipt', c.id)}
                          </View>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity key={slotNum} style={styles.slotEmpty} onPress={() => {
                          setReceiptForm({ receiptType: 'clearance', term: termNum, slot: slotNum, categoryTitle: '', number: '', amount: '', cleared: true, photos: [] });
                          setModalType('add_receipt');
                          setModalVisible(true);
                        }}>
                          <Ionicons name="add" size={16} color="#94a3b8" />
                          <Text style={{ fontSize: 10, color: '#94a3b8' }}>Clearance {slotNum}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {activeTab === 'annual' && (
          <View>
            <View style={styles.cardBanner}>
              <Text style={{ color: '#93c5fd', fontSize: 12 }}>Annual / Non-Recurring Clearance Fees</Text>
              <Text style={styles.bannerAmount}>ZMW {annualOtherReceiptsList.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0)}</Text>
              <Text style={{ color: '#e2e8f0', fontSize: 11, marginTop: 5 }}>{annualOtherReceiptsList.length} receipt(s) recorded in {selectedYear}</Text>
            </View>

            <View style={styles.noticeCard}>
              <Ionicons name="information-circle" size={18} color="#92400e" style={{ marginRight: 6 }} />
              <Text style={styles.noticeText}>
                <Text style={{ fontWeight: 'bold' }}>One-time clearance items:</Text> Cement / Building Fund and other mandatory non-recurring fees.
              </Text>
            </View>

            <TouchableOpacity style={styles.annualAddBtn} onPress={() => {
              setReceiptForm({ receiptType: 'annual_other', term: profileIntakeNo(profile), slot: 1, categoryTitle: 'Cement / Building Fund', number: '', amount: '', cleared: false, photos: [] });
              setModalType('add_receipt');
              setModalVisible(true);
            }}>
              <Ionicons name="add-circle" size={18} color="#d4af37" />
              <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 12, marginLeft: 8 }}>Add Annual / Non-Recurring Clearance Receipt</Text>
            </TouchableOpacity>

            {annualOtherReceiptsList.length === 0 && <Text style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>No annual receipts yet.</Text>}
            {[1, 2, 3, 0].map(t => {
              const list = annualOtherReceiptsList.filter(r => (r.term || 0) === t);
              if ((t === 0 || t > cfg.intakes.length) && list.length === 0) return null;
              const sum = list.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0);
              return (
                <View key={t} style={styles.termCard}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={styles.termTitle}>{intakeName(t)} — Annual Fees ({list.length})</Text>
                    <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#059669' }}>ZMW {sum}</Text>
                  </View>
                  {list.length === 0 && <Text style={{ fontSize: 12, color: '#64748b' }}>No annual receipts for this intake.</Text>}
                  {list.map(rec => (
                    <TouchableOpacity key={rec.id} style={styles.annualItemRow} onPress={() => openPhotos('receipt', rec.id, `${rec.categoryTitle}${rec.term ? ` • ${intakeName(rec.term)}` : ''} • ${rec.number}`)}>
                      <View>
                        <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#0d233a' }}>{rec.categoryTitle}</Text>
                        <Text style={{ fontSize: 10, color: '#64748b' }}>Ref: {rec.number}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#059669' }}>ZMW {rec.amount}</Text>
                        {renderBadge('receipt', rec.id)}
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              );
            })}
          </View>
        )}

        {activeTab === 'pastpapers' && (
          <View>
            <View style={{ flexDirection: 'row', marginBottom: 15 }}>
              <TouchableOpacity style={[styles.scanBtn, { flex: 1, marginBottom: 0, marginRight: 8 }]} onPress={() => { setSubmitted(false); setPaperForm(f => ({ ...f, year: selectedYear })); setModalType('scan_paper'); setModalVisible(true); }}>
                <FontAwesome5 name="camera" size={14} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: 'bold', marginLeft: 8 }}>Scan Exam</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.scanBtn, { flex: 1, marginBottom: 0, backgroundColor: '#b91c1c' }]} onPress={() => { setSubmitted(false); setModalType('add_pdf'); setModalVisible(true); }}>
                <FontAwesome5 name="file-pdf" size={14} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: 'bold', marginLeft: 8 }}>PDF File</Text>
              </TouchableOpacity>
            </View>

            {yearPapers.length === 0 && <Text style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>No past papers for {selectedYear} yet.</Text>}
            {yearPapers.map(paper => (
              <TouchableOpacity key={paper.id} style={styles.paperCard} onPress={() => openPhotos('paper', paper.id, `${paper.code} - ${paper.title}`)}>
                <Text style={styles.paperCode}>{paper.code} - {paper.title}</Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 11, color: '#64748b' }}>{paper.year} • {paper.semester} ({(imgStats['paper:' + paper.id] || {}).total || 0} Pages)</Text>
                  {renderBadge('paper', paper.id)}
                </View>
              </TouchableOpacity>
            ))}

            {documents.length > 0 && <Text style={styles.docHeading}>Saved PDFs & Books</Text>}
            {documents.map(d => (
              <View key={d.id} style={styles.paperCard}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[styles.paperCode, { flex: 1 }]} numberOfLines={2}>{d.title}</Text>
                  <Text style={[styles.docTag, d.category === 'book' && { backgroundColor: '#dbeafe', color: '#1e3a8a' }]}>{d.category === 'book' ? 'Book' : 'Important'}</Text>
                </View>
                <Text style={{ fontSize: 12, color: '#334155', marginTop: 4 }}>{d.description}</Text>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                  <Text style={{ fontSize: 10, color: '#64748b' }}>{Docs.fmtSize(d.size || 0)} • {new Date(d.created_at).toLocaleDateString()}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name={d.sync_status === 'synced' ? 'cloud-done' : 'cloud-offline-outline'} size={14} color={d.sync_status === 'synced' ? '#059669' : '#d97706'} />
                    <TouchableOpacity onPress={() => openDocument(d)} style={[styles.docAction, { flexDirection: 'row', alignItems: 'center' }]}><Ionicons name="share-social" size={12} color="#fff" /><Text style={{ color: '#fff', fontSize: 11, fontWeight: 'bold', marginLeft: 4 }}>Share / Open</Text></TouchableOpacity>
                    <TouchableOpacity onPress={() => deleteDocument(d)} style={[styles.docAction, { backgroundColor: '#fee2e2' }]}><Text style={{ color: '#b91c1c', fontSize: 11, fontWeight: 'bold' }}>Delete</Text></TouchableOpacity>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}

        {activeTab === 'profile' && (
          <View style={styles.profileCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={[styles.profileTitle, { marginBottom: 0 }]}>Student Profile</Text>
              {!editingProfile && (
                <TouchableOpacity style={styles.editProfileBtn} onPress={startEditProfile}>
                  <Ionicons name="create-outline" size={15} color="#fff" />
                  <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 12, marginLeft: 4 }}>Edit Profile</Text>
                </TouchableOpacity>
              )}
            </View>
            {editingProfile && profileDraft ? (
              <View style={{ marginBottom: 6 }}>
                <Field label="Full name" required value={profileDraft.fullName} error={profileErrors.fullName}
                  onChangeText={t => setProfileDraft({ ...profileDraft, fullName: t })} placeholder="e.g. Mary Banda" autoCapitalize="words" />
                <Field label="Student number" required value={profileDraft.studentNumber} error={profileErrors.studentNumber}
                  onChangeText={t => setProfileDraft({ ...profileDraft, studentNumber: t })} placeholder="e.g. RVU-2025-0892" autoCapitalize="characters" />
                <Field label="Programme" required value={profileDraft.programme} error={profileErrors.programme}
                  onChangeText={t => setProfileDraft({ ...profileDraft, programme: t })} placeholder="e.g. BSc Information and Communication Technology" autoCapitalize="words" />
                <Field label="Academic year" value={profileDraft.academicYear} keyboardType="numeric" maxLength={4}
                  onChangeText={t => setProfileDraft({ ...profileDraft, academicYear: t })} placeholder="e.g. 2026" />
                <Field label="Phone" value={profileDraft.phone} keyboardType="phone-pad"
                  onChangeText={t => setProfileDraft({ ...profileDraft, phone: t })} placeholder="e.g. +260 971 234 567" />

                <Text style={[styles.profileLabel, { marginBottom: 6 }]}>Step 1 - Are you on terms or semesters?</Text>
                <View style={{ flexDirection: 'row', marginBottom: 12 }}>
                  {[['term', 'Term (3 per year)'], ['semester', 'Semester (2 per year)']].map(([m, label]) => {
                    const on = (profileDraft.mode || 'term') === m;
                    return (
                      <TouchableOpacity key={m} style={[styles.termChip, on && styles.termChipOn]}
                        onPress={() => {
                          // switching mode keeps the intake only if that mode offers it; otherwise it is cleared so a new one must be chosen
                          const keep = MODES[m].intakes.some(n => (profileDraft.intake || '').includes(n));
                          setProfileDraft({ ...profileDraft, mode: m, intake: keep ? profileDraft.intake : '' });
                          setProfileErrors({ ...profileErrors, intake: undefined });
                        }}>
                        <Text style={{ fontWeight: 'bold', fontSize: 12, color: on ? '#fff' : '#0d233a' }}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={[styles.profileLabel, { marginBottom: 6 }]}>Step 2 - Select your intake <Text style={{ color: '#ef4444' }}>*</Text> (decides your annual fees)</Text>
                <View style={{ flexDirection: 'row', marginBottom: profileErrors.intake ? 4 : 14 }}>
                  {MODES[profileDraft.mode || 'term'].intakes.map((n) => {
                    const on = (profileDraft.intake || '').includes(n);
                    return (
                      <TouchableOpacity key={n} style={[styles.termChip, on && styles.termChipOn, !!profileErrors.intake && !on && { borderColor: '#ef4444' }]}
                        onPress={() => { setProfileDraft({ ...profileDraft, intake: n + ' Intake' }); setProfileErrors({ ...profileErrors, intake: undefined }); }}>
                        <Text style={{ fontWeight: 'bold', fontSize: 12, color: on ? '#fff' : '#0d233a' }}>{n}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {!!profileErrors.intake && <Text style={[styles.fieldError, { marginBottom: 12 }]}>{profileErrors.intake}</Text>}

                <View style={{ flexDirection: 'row' }}>
                  <TouchableOpacity style={[styles.termChip, { backgroundColor: '#0d233a', borderColor: '#0d233a' }]} onPress={commitProfile}>
                    <Text style={{ fontWeight: 'bold', fontSize: 13, color: '#fff' }}>Save changes</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.termChip, { marginRight: 0 }]} onPress={() => setEditingProfile(false)}>
                    <Text style={{ fontWeight: 'bold', fontSize: 13, color: '#0d233a' }}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <>
                <Text style={styles.profileLabel}>Full Name: <Text style={styles.profileVal}>{profile.fullName}</Text></Text>
                <Text style={styles.profileLabel}>Student No: <Text style={styles.profileVal}>{profile.studentNumber}</Text></Text>
                <Text style={styles.profileLabel}>Programme: <Text style={styles.profileVal}>{profile.programme}</Text></Text>
                <Text style={styles.profileLabel}>Academic Year: <Text style={styles.profileVal}>{profile.academicYear}</Text></Text>
                <Text style={styles.profileLabel}>Phone: <Text style={styles.profileVal}>{profile.phone}</Text></Text>
                <Text style={styles.profileLabel}>Study mode: <Text style={styles.profileVal}>{(profile.mode || 'term') === 'semester' ? 'Semester (2 per year)' : 'Term (3 per year)'}</Text></Text>
                <Text style={styles.profileLabel}>Intake: <Text style={styles.profileVal}>{intakeSelected(profile) ? intakeName(profileIntakeNo(profile)) : 'Not selected - tap Edit Profile'}</Text></Text>
              </>
            )}

            <View style={styles.devCard}>
              <Text style={{ fontSize: 11, color: '#92400e', fontWeight: 'bold' }}>Developer Support & Updates Required:</Text>
              <Text style={{ fontSize: 12, color: '#0d233a', fontWeight: 'bold', marginTop: 4 }}>{profile.developerEmail}</Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Navigation Footer */}
      <View style={styles.navBar}>
        <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('clearance')}>
          <MaterialCommunityIcons name="receipt" size={22} color={activeTab === 'clearance' ? '#0d233a' : '#94a3b8'} />
          <Text style={{ fontSize: 11, color: activeTab === 'clearance' ? '#0d233a' : '#94a3b8' }}>Clearance</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('annual')}>
          <MaterialCommunityIcons name="cash-multiple" size={22} color={activeTab === 'annual' ? '#0d233a' : '#94a3b8'} />
          <Text style={{ fontSize: 11, color: activeTab === 'annual' ? '#0d233a' : '#94a3b8' }}>Annual Fees</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('pastpapers')}>
          <FontAwesome5 name="book-open" size={18} color={activeTab === 'pastpapers' ? '#0d233a' : '#94a3b8'} />
          <Text style={{ fontSize: 11, color: activeTab === 'pastpapers' ? '#0d233a' : '#94a3b8' }}>Past Papers</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={() => setActiveTab('profile')}>
          <Ionicons name="person" size={20} color={activeTab === 'profile' ? '#0d233a' : '#94a3b8'} />
          <Text style={{ fontSize: 11, color: activeTab === 'profile' ? '#0d233a' : '#94a3b8' }}>Profile</Text>
        </TouchableOpacity>
      </View>

      {/* Dynamic Modal */}
      <Modal visible={modalVisible} animationType="slide" transparent={true} onRequestClose={() => { setModalVisible(false); setSubmitted(false); }}>
        {/* KeyboardAvoidingView + ScrollView: the form lifts above the keyboard so the field being typed in stays visible on Android */}
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.modalContent}>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
            {modalType === 'add_receipt' && (
              <View>
                <Text style={styles.modalTitle}>
                  {receiptForm.receiptType === 'clearance' ? `Add ${UNIT} ${receiptForm.term} Clearance ${receiptForm.slot}` : receiptForm.receiptType === 'annual_other' ? 'Add Required Clearance Receipt' : `Attach Receipt ${UNIT} ${receiptForm.term} (Slot #${receiptForm.slot})`}
                </Text>

                <Text style={{ fontSize: 11, color: '#1e3a8a', fontWeight: 'bold', marginTop: -6, marginBottom: 12 }}>Saving into academic year {selectedYear}</Text>

                {receiptForm.receiptType === 'annual_other' && (
                  <Field
                    label="Fee name" required
                    hint="What this fee is for, e.g. Cement, Building Fund, Library"
                    placeholder="e.g. Cement / Building Fund"
                    value={receiptForm.categoryTitle}
                    error={submitted && !receiptForm.categoryTitle.trim() ? 'Enter the name of the fee.' : ''}
                    onChangeText={t => setReceiptForm({ ...receiptForm, categoryTitle: t })}
                  />
                )}

                {receiptForm.receiptType === 'annual_other' && (
                  <View style={{ marginBottom: 4 }}>
                    <Text style={styles.fieldLabel}>Intake this fee belongs to <Text style={{ color: '#ef4444' }}>*</Text></Text>
                    <View style={{ flexDirection: 'row', marginTop: 4, marginBottom: 12 }}>
                      {cfg.intakes.map((_, i) => i + 1).map(t => (
                        <TouchableOpacity key={t} style={[styles.termChip, receiptForm.term === t && styles.termChipOn]} onPress={() => setReceiptForm({ ...receiptForm, term: t })}>
                          <Text style={{ fontWeight: 'bold', fontSize: 12, color: receiptForm.term === t ? '#fff' : '#0d233a' }}>{INTAKES[t - 1]}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                )}

                {receiptForm.receiptType === 'clearance' ? (
                  <Field
                    label="Clearance form description" required
                    hint="What the form is for, e.g. Exam clearance form, Library clearance"
                    placeholder="e.g. Exam clearance form"
                    value={receiptForm.categoryTitle}
                    error={submitted && !receiptForm.categoryTitle.trim() ? 'Describe the clearance form.' : ''}
                    onChangeText={t => setReceiptForm({ ...receiptForm, categoryTitle: t })}
                  />
                ) : (
                  <Field
                    label="Receipt reference number" required
                    hint="The number printed on the receipt. Each receipt number can only be saved once."
                    placeholder="e.g. RC-004512"
                    value={receiptForm.number}
                    autoCapitalize="characters"
                    error={submitted && !receiptForm.number.trim() ? 'Enter the receipt number.' : ''}
                    onChangeText={t => setReceiptForm({ ...receiptForm, number: t })}
                  />
                )}
                {receiptForm.receiptType !== 'clearance' && (
                  <Field
                    label="Amount paid (ZMW)" required
                    hint="Numbers only, as shown on the receipt"
                    placeholder="e.g. 1500"
                    keyboardType="numeric"
                    value={receiptForm.amount}
                    error={submitted && !(parseFloat(receiptForm.amount) > 0) ? 'Enter the amount paid (more than 0).' : ''}
                    onChangeText={t => setReceiptForm({ ...receiptForm, amount: t.replace(/[^0-9.]/g, '') })}
                  />
                )}
                <Text style={styles.fieldLabel}>Photo of the receipt{receiptForm.receiptType === 'clearance' ? ' / form' : ''} <Text style={{ color: '#94a3b8', fontWeight: 'normal' }}>(optional – you can add it later)</Text></Text>
                <View style={{ height: 6 }} />
                {renderPhotoPicker('receipt')}

                <TouchableOpacity style={styles.saveBtn} onPress={handleAddReceipt}>
                  <Text style={{ color: '#fff', fontWeight: 'bold' }}>Save Receipt</Text>
                </TouchableOpacity>
              </View>
            )}

            {modalType === 'scan_paper' && (
              <View>
                <Text style={styles.modalTitle}>Scan Exam Paper</Text>
                <Field
                  label="Course code" required
                  hint="The code printed on the exam paper"
                  placeholder="e.g. ICT214"
                  value={paperForm.code}
                  autoCapitalize="characters"
                  error={submitted && !paperForm.code.trim() ? 'Enter the course code.' : ''}
                  onChangeText={t => setPaperForm({ ...paperForm, code: t })}
                />
                <Field
                  label="Course title" required
                  hint="Full name of the course"
                  placeholder="e.g. Database Systems"
                  value={paperForm.title}
                  error={submitted && !paperForm.title.trim() ? 'Enter the course title.' : ''}
                  onChangeText={t => setPaperForm({ ...paperForm, title: t })}
                />
                <Field
                  label="Exam year" required
                  hint="4-digit year the exam was written"
                  placeholder="e.g. 2026"
                  keyboardType="numeric"
                  maxLength={4}
                  value={String(paperForm.year)}
                  error={submitted && !/^\d{4}$/.test(String(paperForm.year).trim()) ? 'Enter a 4-digit year, e.g. 2026.' : ''}
                  onChangeText={t => setPaperForm({ ...paperForm, year: t.replace(/[^0-9]/g, '') })}
                />
                <Text style={styles.fieldLabel}>{UNIT} written <Text style={{ color: '#ef4444' }}>*</Text></Text>
                <View style={{ flexDirection: 'row', marginTop: 4, marginBottom: 12 }}>
                  {cfg.periods.map(n => {
                    const on = ((paperForm.semester || '').startsWith(UNIT) ? paperForm.semester : `${UNIT} 1`) === `${UNIT} ${n}`;
                    return (
                      <TouchableOpacity key={n} style={[styles.termChip, on && styles.termChipOn]} onPress={() => setPaperForm({ ...paperForm, semester: `${UNIT} ${n}` })}>
                        <Text style={{ fontWeight: 'bold', fontSize: 12, color: on ? '#fff' : '#0d233a' }}>{UNIT} {n}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={styles.fieldLabel}>Photos of the paper <Text style={{ color: '#94a3b8', fontWeight: 'normal' }}>(optional – add every page)</Text></Text>
                <View style={{ height: 6 }} />
                {renderPhotoPicker('paper')}
                <TouchableOpacity style={styles.saveBtn} onPress={handleAddPastPaper}>
                  <Text style={{ color: '#fff', fontWeight: 'bold' }}>Save Paper</Text>
                </TouchableOpacity>
              </View>
            )}

            {modalType === 'add_pdf' && (
              <View>
                <Text style={styles.modalTitle}>Save PDF File</Text>
                <Text style={styles.fieldLabel}>PDF file <Text style={{ color: '#ef4444' }}>*</Text></Text>
                <TouchableOpacity style={[styles.camBtn, { marginTop: 4, marginBottom: 2 }, submitted && !docForm.file && { borderWidth: 2, borderColor: '#ef4444' }]} onPress={handlePickPdf}>
                  <Text style={{ color: '#0d233a', fontWeight: 'bold' }}>{docForm.file ? 'Change PDF' : 'Choose PDF'}</Text>
                </TouchableOpacity>
                {docForm.file
                  ? <Text style={{ fontSize: 11, color: '#059669', marginBottom: 10 }}>{docForm.file.name} • {Docs.fmtSize(docForm.file.size)}</Text>
                  : <Text style={[submitted ? styles.fieldError : styles.fieldHint, { marginBottom: 10 }]}>{submitted ? 'Choose a PDF file.' : 'PDF files smaller than 10 MB only'}</Text>}
                <Text style={styles.fieldLabel}>Type</Text>
                <View style={{ flexDirection: 'row', marginTop: 4, marginBottom: 12 }}>
                  {[['important', 'Important document'], ['book', 'Book']].map(([k, label]) => {
                    const on = docForm.category === k;
                    return (
                      <TouchableOpacity key={k} style={[styles.termChip, on && styles.termChipOn]} onPress={() => setDocForm({ ...docForm, category: k })}>
                        <Text style={{ fontWeight: 'bold', fontSize: 12, color: on ? '#fff' : '#0d233a' }}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Field
                  label="Title" required
                  hint="A short name you will recognise"
                  placeholder="e.g. Admission letter"
                  value={docForm.title}
                  error={submitted && !docForm.title.trim() ? 'Enter a title.' : ''}
                  onChangeText={t => setDocForm({ ...docForm, title: t })}
                />
                <Field
                  label="Description" required
                  hint="What is this document and why is it important?"
                  placeholder="e.g. Letter confirming my place, needed for clearance"
                  value={docForm.description}
                  error={submitted && !docForm.description.trim() ? 'Enter a description.' : ''}
                  onChangeText={t => setDocForm({ ...docForm, description: t })}
                />
                <TouchableOpacity style={styles.saveBtn} onPress={handleAddDocument}>
                  <Text style={{ color: '#fff', fontWeight: 'bold' }}>Save PDF</Text>
                </TouchableOpacity>
              </View>
            )}

            {modalType === 'add_year' && (
              <View>
                <Text style={styles.modalTitle}>Add a Year</Text>
                <Field
                  label="Year" required
                  hint="4-digit year, e.g. 2023. Receipts you add while it is selected are filed under it."
                  placeholder={`e.g. ${Number(thisYear) - 1}`}
                  keyboardType="numeric"
                  maxLength={4}
                  value={yearInput}
                  error={submitted && !/^\d{4}$/.test(yearInput.trim()) ? 'Enter a 4-digit year.' : ''}
                  onChangeText={t => setYearInput(t.replace(/[^0-9]/g, ''))}
                />
                <TouchableOpacity style={styles.saveBtn} onPress={handleAddYear}>
                  <Text style={{ color: '#fff', fontWeight: 'bold' }}>Open Year</Text>
                </TouchableOpacity>
              </View>
            )}

            {modalType === 'drive_sync' && (
              <View style={{ alignItems: 'center' }}>
                <Ionicons name="cloud" size={40} color="#059669" />
                <Text style={{ fontWeight: 'bold', marginVertical: 10 }}>Google Drive Sync</Text>
                <Text style={{ textAlign: 'center', fontSize: 12, color: '#64748b' }}>
                  Photos and PDFs are saved on the phone first, then pushed automatically to the "Rockview Clearance Hub" folder in your Google Drive.
                </Text>
                <Text style={{ fontSize: 12, marginTop: 10, fontWeight: 'bold' }}>
                  {signedIn ? `Connected • ${pendingCount} item(s) waiting` : 'Not connected'}
                </Text>
                {lastSync ? <Text style={{ fontSize: 10, color: '#64748b' }}>Last sync: {lastSync}</Text> : null}
                {!signedIn ? (
                  <TouchableOpacity style={[styles.saveBtn, { backgroundColor: '#059669', width: '100%', marginTop: 15 }]} onPress={handleSignIn}>
                    <Text style={{ color: '#fff', fontWeight: 'bold' }}>Sign in with Google</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={{ width: '100%' }}>
                    <TouchableOpacity style={[styles.saveBtn, { backgroundColor: '#059669', marginTop: 15, flexDirection: 'row', justifyContent: 'center' }]} onPress={triggerSync} disabled={syncing}>
                      {syncing && <ActivityIndicator color="#fff" style={{ marginRight: 8 }} />}
                      <Text style={{ color: '#fff', fontWeight: 'bold' }}>{syncing ? 'Syncing…' : 'Sync Now'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={{ marginTop: 12, alignItems: 'center' }} onPress={handleSignOut}>
                      <Text style={{ color: '#64748b', fontSize: 12 }}>Disconnect Google account</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}

            {modalType === 'view_photos' && (
              <View>
                <Text style={styles.modalTitle}>{viewer.title}</Text>
                {viewer.type === 'receipt' && (() => {
                  const vr = receipts.find(r => r.id === viewer.id);
                  return vr ? (
                    <View style={{ marginBottom: 10 }}>
                      <Text style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>Academic year (tap to move this receipt):</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        {yearList.map(y => (
                          <TouchableOpacity key={y} style={[styles.yearChipSmall, vr.year === y && styles.termChipOn]} onPress={() => vr.year !== y && moveReceiptYear(y)}>
                            <Text style={{ fontWeight: 'bold', fontSize: 12, color: vr.year === y ? '#fff' : '#0d233a' }}>{y}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  ) : null;
                })()}
                <View style={{ flexDirection: 'row' }}>
                  <TouchableOpacity style={[styles.camBtn, { flex: 1, marginRight: 6 }]} onPress={() => addToExisting('camera')}>
                    <Text style={{ color: '#0d233a', fontWeight: 'bold' }}>Take Photo</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.camBtn, { flex: 1 }]} onPress={() => addToExisting('files')}>
                    <Text style={{ color: '#0d233a', fontWeight: 'bold' }}>Choose Files</Text>
                  </TouchableOpacity>
                </View>
                <ScrollView style={{ maxHeight: 380 }} nestedScrollEnabled>
                  {viewer.photos.length === 0 && <Text style={{ color: '#64748b' }}>No photos attached.</Text>}
                  {viewer.photos.length > 0 && (
                    <TouchableOpacity style={[styles.fsBtn, { backgroundColor: '#059669', marginBottom: 0 }]} onPress={sharePhotosAsPdf}>
                      <Ionicons name="share-social" size={16} color="#fff" />
                      <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 12, marginLeft: 8 }}>Share all as one PDF</Text>
                    </TouchableOpacity>
                  )}
                  {viewer.photos.length > 0 && (
                    <TouchableOpacity style={styles.fsBtn} onPress={() => openFullScreen(0)}>
                      <Ionicons name="expand" size={16} color="#fff" />
                      <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 12, marginLeft: 8 }}>View Full Screen (show to officer)</Text>
                    </TouchableOpacity>
                  )}
                  {viewer.photos.map((p, idx) => (
                    <View key={p.id} style={{ marginBottom: 12 }}>
                      <TouchableOpacity activeOpacity={0.85} onPress={() => openFullScreen(idx)}>
                        <Image source={{ uri: `data:${p.mime};base64,${p.data}` }} style={styles.fullPhoto} resizeMode="contain" />
                        <View style={styles.fsHint}><Ionicons name="expand" size={14} color="#fff" /></View>
                      </TouchableOpacity>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={{ fontSize: 10, color: p.sync_status === 'synced' ? '#059669' : '#d97706' }}>
                          {p.sync_status === 'synced' ? 'Backed up to Google Drive' : 'Waiting to upload'}
                        </Text>
                        <TouchableOpacity onPress={() => sharePhoto(p, viewer.title)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4 }}>
                          <Ionicons name="share-social" size={14} color="#0d233a" />
                          <Text style={{ color: '#0d233a', fontWeight: 'bold', fontSize: 11, marginLeft: 4 }}>Share photo</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}
                </ScrollView>
              </View>
            )}

            <TouchableOpacity style={styles.closeBtn} onPress={() => { setModalVisible(false); setSubmitted(false); }}>
              <Text style={{ color: '#ef4444', fontWeight: 'bold' }}>Close</Text>
            </TouchableOpacity>
          </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Full-screen photo proof */}
      <Modal visible={fs.visible} animationType="fade" statusBarTranslucent onRequestClose={closeFullScreen}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {fs.zoom ? (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center', justifyContent: 'center' }} maximumZoomScale={4} minimumZoomScale={1}>
              <ScrollView horizontal contentContainerStyle={{ alignItems: 'center' }}>
                {viewer.photos[fs.index] && (
                  <Image source={{ uri: `data:${viewer.photos[fs.index].mime};base64,${viewer.photos[fs.index].data}` }}
                    style={{ width: winW * 2.5, height: winH * 2.5 }} resizeMode="contain" />
                )}
              </ScrollView>
            </ScrollView>
          ) : (
            <ScrollView
              horizontal pagingEnabled showsHorizontalScrollIndicator={false}
              contentOffset={{ x: fs.index * winW, y: 0 }}
              onMomentumScrollEnd={e => setFs(f => ({ ...f, index: Math.round(e.nativeEvent.contentOffset.x / winW) }))}
              style={{ flex: 1 }}
            >
              {viewer.photos.map(p => (
                <Pressable key={p.id} style={{ width: winW, height: winH }} onPress={() => setFs(f => ({ ...f, controls: !f.controls }))}>
                  <Image source={{ uri: `data:${p.mime};base64,${p.data}` }} style={{ width: winW, height: winH }} resizeMode="contain" />
                </Pressable>
              ))}
            </ScrollView>
          )}

          {fs.controls && (
            <View style={styles.fsTop} pointerEvents="box-none">
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 13 }} numberOfLines={2}>{viewer.title}</Text>
                <Text style={{ color: '#cbd5e1', fontSize: 11, marginTop: 2 }}>Photo {fs.index + 1} of {viewer.photos.length}{fs.zoom ? ' • zoomed' : ''}</Text>
              </View>
              <TouchableOpacity style={[styles.fsRoundBtn, { marginRight: 8 }]} onPress={() => viewer.photos[fs.index] && sharePhoto(viewer.photos[fs.index], viewer.title)}>
                <Ionicons name="share-social" size={18} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.fsRoundBtn} onPress={() => setFs(f => ({ ...f, zoom: !f.zoom }))}>
                <Ionicons name={fs.zoom ? 'contract' : 'search'} size={18} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.fsRoundBtn, { marginLeft: 8 }]} onPress={closeFullScreen}>
                <Ionicons name="close" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
          )}
          {fs.controls && !fs.zoom && viewer.photos.length > 1 && (
            <View style={styles.fsDots} pointerEvents="none">
              {viewer.photos.map((p, i) => <View key={p.id} style={[styles.fsDot, i === fs.index && { backgroundColor: '#fff' }]} />)}
            </View>
          )}
          {fs.controls && !fs.zoom && (
            <Text style={styles.fsTapHint} pointerEvents="none">Tap the photo to hide controls</Text>
          )}
        </View>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f6f9' },
  header: { backgroundColor: '#0d233a', padding: 15, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitleContainer: { flexDirection: 'row', alignItems: 'center' },
  logoBadge: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#d4af37', justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  logoText: { color: '#0d233a', fontWeight: 'bold', fontSize: 16 },
  headerTitle: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  headerSubtitle: { color: '#cbd5e1', fontSize: 10 },
  headerIcons: { flexDirection: 'row', alignItems: 'center' },
  content: { padding: 15 },
  cardBanner: { backgroundColor: '#0d233a', padding: 15, borderRadius: 15, marginBottom: 12 },
  bannerAmount: { color: '#d4af37', fontSize: 24, fontWeight: 'bold' },
  noticeCard: { backgroundColor: '#fef3c7', padding: 10, borderRadius: 10, borderLeftWidth: 4, borderLeftColor: '#d97706', flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  noticeText: { fontSize: 11, color: '#92400e', flex: 1 },
  annualAddBtn: { backgroundColor: '#1e3a8a', padding: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 12, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 3 },
  annualItemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  termCard: { backgroundColor: '#fff', padding: 12, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#e2e8f0' },
  termTitle: { fontWeight: 'bold', color: '#1e293b', fontSize: 13, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  slotActive: { width: '48%', backgroundColor: '#f0f9ff', borderWidth: 1, borderColor: '#bae6fd', padding: 8, borderRadius: 8, marginBottom: 8 },
  slotEmpty: { width: '48%', borderStyle: 'dashed', borderWidth: 1, borderColor: '#cbd5e1', padding: 10, borderRadius: 8, alignItems: 'center', marginBottom: 8 },
  docHeading: { fontSize: 13, fontWeight: 'bold', color: '#0d233a', marginTop: 8, marginBottom: 8 },
  docTag: { fontSize: 10, fontWeight: 'bold', color: '#b91c1c', backgroundColor: '#fee2e2', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, overflow: 'hidden', marginLeft: 8 },
  docAction: { backgroundColor: '#0d233a', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, marginLeft: 8 },
  scanBtn: { backgroundColor: '#0d233a', padding: 12, borderRadius: 10, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginBottom: 15 },
  paperCard: { backgroundColor: '#fff', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', marginBottom: 10 },
  paperCode: { fontWeight: 'bold', fontSize: 14, color: '#0d233a' },
  profileCard: { backgroundColor: '#fff', padding: 15, borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0' },
  editProfileBtn: { backgroundColor: '#0d233a', flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8 },
  profileTitle: { fontSize: 16, fontWeight: 'bold', color: '#0d233a', marginBottom: 10 },
  profileLabel: { fontSize: 12, color: '#64748b', marginBottom: 5 },
  profileVal: { color: '#0f172a', fontWeight: 'bold' },
  devCard: { backgroundColor: '#fef3c7', padding: 12, borderRadius: 10, marginTop: 15, borderWidth: 1, borderColor: '#fde68a' },
  navBar: { flexDirection: 'row', justifyContent: 'space-around', padding: 10, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  navItem: { alignItems: 'center' },
  fsBtn: { backgroundColor: '#0d233a', padding: 11, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 10, marginBottom: 10 },
  fsHint: { position: 'absolute', right: 8, top: 8, backgroundColor: 'rgba(13,35,58,0.75)', borderRadius: 14, padding: 6 },
  fsTop: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 40, paddingHorizontal: 14, paddingBottom: 14, backgroundColor: 'rgba(0,0,0,0.55)', flexDirection: 'row', alignItems: 'center' },
  fsRoundBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  fsDots: { position: 'absolute', bottom: 40, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center' },
  fsDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.35)', marginHorizontal: 4 },
  fsTapHint: { position: 'absolute', bottom: 14, left: 0, right: 0, textAlign: 'center', color: '#94a3b8', fontSize: 11 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#fff', padding: 20, maxHeight: '92%', borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  modalTitle: { fontSize: 16, fontWeight: 'bold', marginBottom: 12, color: '#0d233a' },
  fieldLabel: { fontSize: 12, fontWeight: 'bold', color: '#0d233a' },
  fieldHint: { fontSize: 10, color: '#64748b', marginTop: 3 },
  fieldError: { fontSize: 11, color: '#ef4444', fontWeight: 'bold', marginTop: 3 },
  inputFilled: { borderColor: '#34d399', backgroundColor: '#f0fdf4' },
  inputFocus: { borderColor: '#1e3a8a', borderWidth: 2, backgroundColor: '#eff6ff' },
  inputError: { borderColor: '#ef4444', borderWidth: 2, backgroundColor: '#fef2f2' },
  input: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, paddingVertical: 11, paddingHorizontal: 12, fontSize: 15, color: '#0f172a', backgroundColor: '#fff', marginBottom: 10 },
  camBtn: { backgroundColor: '#e2e8f0', padding: 10, borderRadius: 8, alignItems: 'center', marginBottom: 10 },
  saveBtn: { backgroundColor: '#0d233a', padding: 12, borderRadius: 8, alignItems: 'center' },
  closeBtn: { marginTop: 10, alignItems: 'center' },
  slotActive2: { width: '48%', backgroundColor: '#ecfdf5', borderWidth: 1, borderColor: '#a7f3d0', padding: 8, borderRadius: 8, marginBottom: 8 },
  termChip: { flex: 1, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, padding: 9, alignItems: 'center', marginRight: 6 },
  termChipOn: { backgroundColor: '#0d233a', borderColor: '#0d233a' },
  thumbRow: { marginBottom: 6 },
  thumb: { width: 64, height: 64, borderRadius: 8, backgroundColor: '#e2e8f0' },
  thumbX: { position: 'absolute', top: 2, right: 4, color: '#fff', fontSize: 11, fontWeight: 'bold' },
  yearBar: { backgroundColor: '#fff', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  yearChip: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, paddingVertical: 6, paddingHorizontal: 14, marginRight: 8, alignItems: 'center', backgroundColor: '#fff' },
  yearChipOn: { backgroundColor: '#0d233a', borderColor: '#0d233a' },
  yearChipAdd: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderStyle: 'dashed', borderColor: '#1e3a8a', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  yearChipSmall: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 14, marginRight: 6 },
  fullPhoto: { width: '100%', height: 300, backgroundColor: '#f1f5f9', borderRadius: 8 }
});
