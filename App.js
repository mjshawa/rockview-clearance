import React, { useState, useEffect, useRef } from 'react';
import { 
  StyleSheet, Text, View, ScrollView, TextInput, 
  TouchableOpacity, Alert, Modal, SafeAreaView, StatusBar,
  Switch, Linking, ActivityIndicator
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { MaterialCommunityIcons, FontAwesome5, Ionicons } from '@expo/vector-icons';
import {
  configureGoogle, isConfigured, currentUser, signIn, signOut,
  initDriveTables, getSetting, setSetting, backupToDrive, restoreFromDrive,
  folderUrl, PHOTO_DIR,
} from './src/drive';

const db = SQLite.openDatabaseSync('rockview_hub.db');

// How many study periods per year and instalment slots per period.
// Change `count` / `slots` here if your school uses different numbers.
const PERIODS = {
  term: { label: 'Term', plural: 'Terms', count: 3, slots: 4 },
  semester: { label: 'Semester', plural: 'Semesters', count: 2, slots: 4 },
};

export default function App() {
  const [activeTab, setActiveTab] = useState('clearance');
  const [profile, setProfile] = useState({
    fullName: 'Student User',
    studentNumber: 'RVU-2025-0892',
    programme: 'BSc Information and Communication Technology',
    academicYear: '2026',
    intake: 'January Intake',
    phone: '+260 971 234 567',
    developerEmail: 'mjshawa23@gmail.com'
  });

  const [receipts, setReceipts] = useState([]);
  const [pastPapers, setPastPapers] = useState([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalType, setModalType] = useState(''); // 'add_receipt', 'scan_paper', 'drive_sync'

  // Study system chosen by the student: 'term' or 'semester'
  const [periodMode, setPeriodMode] = useState('term');
  const [profileSet, setProfileSet] = useState(true);
  const [profileForm, setProfileForm] = useState({ fullName: '', studentNumber: '', programme: '', academicYear: '', intake: '', phone: '', mode: null });
  const P = PERIODS[periodMode];
  const periodNumbers = Array.from({ length: P.count }, (_, i) => i + 1);
  const slotNumbers = Array.from({ length: P.slots }, (_, i) => i + 1);
  const inMode = (r) => r.receiptType === 'annual_other' || r.periodType === periodMode;

  // Form states: type can be 'term' (default 1-4 instalments) or 'annual_other' (cement, non-recurring mandatory clearance items)
  const [receiptForm, setReceiptForm] = useState({ 
    receiptType: 'term', // 'term' or 'annual_other'
    term: 1, 
    slot: 1, 
    categoryTitle: 'Cement / Building Fund', // for non-term required clearance receipts
    number: '', 
    amount: '', 
    cleared: false, 
    image: null 
  });

  // Google Drive state
  const [driveUser, setDriveUser] = useState(null);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveMsg, setDriveMsg] = useState('');
  const [duplicateOn, setDuplicateOn] = useState(false);
  const [lastSync, setLastSync] = useState('');
  const [driveFolderId, setDriveFolderId] = useState('');
  const syncing = useRef(false);

  const [paperForm, setPaperForm] = useState({ code: '', year: '2025', title: '', semester: 'Term 1', images: [] });

  useEffect(() => {
    initTables();
    loadData();
    configureGoogle();
    setDuplicateOn(getSetting(db, 'duplicate', '0') === '1');
    setLastSync(getSetting(db, 'last_sync', ''));
    setDriveFolderId(getSetting(db, 'folder_id', ''));
    const u = currentUser();
    setDriveUser(u);
    const isSet = loadProfile();
    if (!isSet) openProfileModal(false);
    else if (u) offerRestoreIfEmpty();
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

      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_type TEXT DEFAULT 'term',
        period_type TEXT DEFAULT 'term',
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
    `);
    initDriveTables(db);
    // Upgrade older installs: remember whether a receipt belongs to a Term or a Semester
    try { db.execSync("ALTER TABLE receipts ADD COLUMN period_type TEXT DEFAULT 'term'"); } catch (e) {}
  };

  const loadData = () => {
    try {
      const receiptRows = db.getAllSync('SELECT * FROM receipts');
      setReceipts(receiptRows.map(r => ({
        id: r.id,
        receiptType: r.receipt_type || 'term',
        periodType: r.period_type || 'term',
        term: r.term,
        slot: r.slot,
        categoryTitle: r.category_title,
        number: r.receipt_number,
        amount: r.amount,
        cleared: r.is_cleared === 1,
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
    } catch (err) {
      console.log('Error loading SQLite data:', err);
    }
  };

  // ---------- Profile & study system ----------
  const loadProfile = () => {
    const raw = getSetting(db, 'profile', '');
    const mode = getSetting(db, 'period_mode', '');
    if (raw) { try { setProfile(p => ({ ...p, ...JSON.parse(raw) })); } catch (e) {} }
    if (mode === 'term' || mode === 'semester') {
      setPeriodMode(mode);
      setPaperForm(pf => ({ ...pf, semester: `${PERIODS[mode].label} 1` }));
    }
    const isSet = !!raw && (mode === 'term' || mode === 'semester');
    setProfileSet(isSet);
    return isSet;
  };

  const openProfileModal = (isSet) => {
    setProfileForm(isSet
      ? { fullName: profile.fullName, studentNumber: profile.studentNumber, programme: profile.programme, academicYear: profile.academicYear, intake: profile.intake, phone: profile.phone, mode: periodMode }
      : { fullName: '', studentNumber: '', programme: '', academicYear: '', intake: '', phone: '', mode: null });
    setModalType('edit_profile');
    setModalVisible(true);
  };

  const saveProfile = () => {
    const f = profileForm;
    if (!f.fullName.trim() || !f.studentNumber.trim()) {
      Alert.alert('Missing details', 'Please enter your full name and student number.');
      return;
    }
    if (!f.mode) {
      Alert.alert('Choose your study system', 'Select whether your school uses Terms or Semesters.');
      return;
    }
    const doSave = () => {
      const next = {
        fullName: f.fullName.trim(), studentNumber: f.studentNumber.trim(), programme: f.programme.trim(),
        academicYear: f.academicYear.trim(), intake: f.intake.trim(), phone: f.phone.trim(),
      };
      setSetting(db, 'profile', JSON.stringify(next));
      setSetting(db, 'period_mode', f.mode);
      setProfile(p => ({ ...p, ...next }));
      setPeriodMode(f.mode);
      setPaperForm(pf => ({ ...pf, semester: `${PERIODS[f.mode].label} 1` }));
      setProfileSet(true);
      setModalVisible(false);
      runBackup(true);
    };
    if (profileSet && f.mode !== periodMode) {
      const hidden = receipts.filter(r => r.receiptType !== 'annual_other' && r.periodType === periodMode).length;
      if (hidden > 0) {
        Alert.alert(
          `Switch to ${PERIODS[f.mode].plural}?`,
          `Your ${hidden} ${PERIODS[periodMode].label.toLowerCase()} receipt(s) stay saved, but are hidden while ${PERIODS[f.mode].plural} is selected. You can switch back any time.`,
          [{ text: 'Cancel', style: 'cancel' }, { text: 'Switch', onPress: doSave }]
        );
        return;
      }
    }
    doSave();
  };

  const closeModal = () => {
    // A brand-new student must finish the profile setup before using the app
    if (!profileSet && modalType !== 'edit_profile') { setModalType('edit_profile'); return; }
    setModalVisible(false);
  };

  // ---------- Google Drive ----------
  const driveHelp = (e) => {
    const m = String(e?.message || e);
    if (/DEVELOPER_ERROR|\b10\b/.test(m)) {
      return m + '\n\nGoogle rejected this app build. Check the package name and the SHA-1 fingerprint on the Android OAuth client (see GOOGLE_DRIVE_SETUP.md).';
    }
    return m;
  };

  const runBackup = async (silent = false) => {
    if (syncing.current) return;
    if (!isConfigured() || !currentUser()) return;
    syncing.current = true;
    setDriveBusy(true);
    if (!silent) setDriveMsg('Starting backup…');
    try {
      const r = await backupToDrive({
        db,
        duplicate: getSetting(db, 'duplicate', '0') === '1',
        onProgress: setDriveMsg,
      });
      const when = new Date().toLocaleString();
      setSetting(db, 'last_sync', when);
      setSetting(db, 'folder_id', r.folderId);
      setLastSync(when);
      setDriveFolderId(r.folderId);
      setDriveMsg(`Backup complete. ${r.uploaded} new photo(s) uploaded.` + (r.missing ? ` ${r.missing} photo(s) could not be found on this phone.` : ''));
    } catch (e) {
      setDriveMsg('Backup failed: ' + driveHelp(e));
    } finally {
      syncing.current = false;
      setDriveBusy(false);
    }
  };

  const runRestore = async () => {
    if (syncing.current) return;
    syncing.current = true;
    setDriveBusy(true);
    setDriveMsg('Looking for your backup…');
    try {
      const r = await restoreFromDrive({ db, onProgress: setDriveMsg });
      if (!r.found) {
        setDriveMsg('No backup found in this Google account yet.');
      } else {
        loadData();
        if (r.profile) loadProfile();
        setDriveFolderId(r.folderId);
        setSetting(db, 'folder_id', r.folderId);
        setDriveMsg(`Restored ${r.receipts} receipt(s), ${r.papers} paper(s) and ${r.photos} photo(s).`);
      }
    } catch (e) {
      setDriveMsg('Restore failed: ' + driveHelp(e));
    } finally {
      syncing.current = false;
      setDriveBusy(false);
    }
  };

  const offerRestoreIfEmpty = () => {
    try {
      const r = db.getFirstSync('SELECT COUNT(*) AS c FROM receipts');
      const p = db.getFirstSync('SELECT COUNT(*) AS c FROM past_papers');
      if ((r?.c || 0) + (p?.c || 0) === 0) {
        Alert.alert('Restore from Google Drive?', 'This phone has no records yet. If you backed up before, you can restore your receipts and photos now.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Restore', onPress: () => { setModalType('drive_sync'); setModalVisible(true); runRestore(); } },
        ]);
      }
    } catch {}
  };

  const handleDriveSignIn = async () => {
    if (!isConfigured()) {
      Alert.alert('Google Drive not set up', 'The developer must paste the Web client ID into src/config.js and rebuild (see GOOGLE_DRIVE_SETUP.md).');
      return;
    }
    try {
      const u = await signIn();
      if (u) {
        setDriveUser(u);
        setDriveMsg('');
        offerRestoreIfEmpty();
      }
    } catch (e) {
      Alert.alert('Sign-in failed', driveHelp(e));
    }
  };

  const handleDriveSignOut = async () => {
    await signOut();
    setDriveUser(null);
    setDriveMsg('');
  };

  const toggleDuplicate = (on) => {
    setDuplicateOn(on);
    setSetting(db, 'duplicate', on ? '1' : '0');
    if (on) runBackup();
  };

  const persistPhoto = async (uri) => {
    try {
      await FileSystem.makeDirectoryAsync(PHOTO_DIR, { intermediates: true });
      const dest = `${PHOTO_DIR}${Date.now()}.jpg`;
      await FileSystem.copyAsync({ from: uri, to: dest });
      return dest;
    } catch {
      return uri;
    }
  };

  const handleAddReceipt = () => {
    if (!receiptForm.number) {
      Alert.alert('Error', 'Receipt reference number is required.');
      return;
    }

    try {
      db.runSync(
        'INSERT INTO receipts (receipt_type, period_type, term, slot, category_title, receipt_number, amount, is_cleared, image_uri) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          receiptForm.receiptType, 
          periodMode,
          receiptForm.receiptType === 'term' ? receiptForm.term : 0, 
          receiptForm.receiptType === 'term' ? receiptForm.slot : 0, 
          receiptForm.receiptType === 'annual_other' ? receiptForm.categoryTitle : `${P.label} Instalment`,
          receiptForm.number, 
          receiptForm.amount || '0', 
          receiptForm.cleared ? 1 : 0, 
          receiptForm.image || ''
        ]
      );
      Alert.alert('Success', 'Receipt saved securely to local SQLite.');
      runBackup(true);
      setModalVisible(false);
      setReceiptForm({ receiptType: 'term', term: 1, slot: 1, categoryTitle: 'Cement / Building Fund', number: '', amount: '', cleared: false, image: null });
      loadData();
    } catch (e) {
      Alert.alert('Error', 'Receipt reference number must be unique.');
    }
  };

  const handleAddPastPaper = () => {
    if (!paperForm.code || !paperForm.title) {
      Alert.alert('Error', 'Course code and title are required.');
      return;
    }

    try {
      db.runSync(
        'INSERT INTO past_papers (course_code, course_title, exam_year, term_or_semester, image_uris_json) VALUES (?, ?, ?, ?, ?)',
        [paperForm.code.toUpperCase(), paperForm.title, paperForm.year, paperForm.semester, JSON.stringify(paperForm.images)]
      );
      Alert.alert('Success', 'Past paper added to repository.');
      runBackup(true);
      setModalVisible(false);
      setPaperForm({ code: '', year: paperForm.year || '2025', title: '', semester: `${P.label} 1`, images: [] });
      loadData();
    } catch (e) {
      Alert.alert('Error', 'Failed to save past paper.');
    }
  };

  const pickImage = async (type) => {
    let result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0].uri) {
      const saved = await persistPhoto(result.assets[0].uri);
      if (type === 'receipt') {
        setReceiptForm({ ...receiptForm, image: saved });
      } else if (type === 'paper') {
        setPaperForm({ ...paperForm, images: [...paperForm.images, saved] });
      }
    }
  };

  const exportClearancePDF = async () => {
    const shown = receipts.filter(inMode);
    const totalPaid = shown.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
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
          <h3>OFFICIAL STUDENT CLEARANCE RECEIPTS REPORT</h3>
          
          <div class="note">
            <strong>Note:</strong> Includes mandatory clearance receipts (Tuition Instalments, Cement/Building Fund, Exam Clearance). Excludes non-clearance items like Registration and ID fees.
          </div>

          <p><strong>Student:</strong> ${profile.fullName} (${profile.studentNumber})</p>
          <p><strong>Programme:</strong> ${profile.programme}</p>
          <p><strong>Year & Intake:</strong> ${profile.academicYear} | ${profile.intake} | ${P.plural}</p>
          <p><strong>Total Clearance Payments:</strong> ZMW ${totalPaid}</p>

          <table>
            <thead>
              <tr>
                <th>Category / ${P.label}</th>
                <th>Reference</th>
                <th style="text-align: right;">Amount (ZMW)</th>
              </tr>
            </thead>
            <tbody>
              ${shown.map(r => `
                <tr>
                  <td>${r.receiptType === 'annual_other' ? r.categoryTitle : P.label + ' ' + r.term + ' (Instalment ' + r.slot + ')'}</td>
                  <td>${r.number}</td>
                  <td style="text-align: right;">${r.amount}</td>
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
      await Sharing.shareAsync(uri);
    } catch (e) {
      Alert.alert('Error', 'Failed to generate PDF.');
    }
  };

  const termReceiptsList = receipts.filter(r => (r.receiptType === 'term' || !r.receiptType) && r.periodType === periodMode);
  const annualOtherReceiptsList = receipts.filter(r => r.receiptType === 'annual_other');
  const totalPaid = receipts.filter(inMode).reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

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
            <FontAwesome5 name="file-pdf" size={22} color="#d4af37" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Content Area */}
      <ScrollView style={styles.content}>
        {activeTab === 'clearance' && (
          <View>
            <View style={styles.cardBanner}>
              <Text style={{ color: '#93c5fd', fontSize: 12 }}>Total Recorded Clearance Payments</Text>
              <Text style={styles.bannerAmount}>ZMW {totalPaid}</Text>
              <Text style={{ color: '#e2e8f0', fontSize: 11, marginTop: 5 }}>Year: {profile.academicYear} • Intake: {profile.intake}</Text>
            </View>

            {/* Clearance Guidance Notice */}
            <View style={styles.noticeCard}>
              <Ionicons name="information-circle" size={18} color="#92400e" style={{ marginRight: 6 }} />
              <Text style={styles.noticeText}>
                <Text style={{ fontWeight: 'bold' }}>Clearance Payments Required:</Text> Attach receipts needed strictly for term/annual clearance (Tuition Instalments, Cement/Building Fund). Registration and ID card receipts are excluded.
              </Text>
            </View>

            {/* Quick Add Annual / Mandatory One-Time Receipt Button */}
            <TouchableOpacity style={styles.annualAddBtn} onPress={() => { 
              setReceiptForm({ receiptType: 'annual_other', term: 1, slot: 1, categoryTitle: 'Cement / Building Fund', number: '', amount: '', cleared: false, image: null });
              setModalType('add_receipt'); 
              setModalVisible(true); 
            }}>
              <Ionicons name="add-circle" size={18} color="#d4af37" />
              <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 12, marginLeft: 8 }}>Add Annual / Non-Recurring Clearance Receipt (Cement, etc.)</Text>
            </TouchableOpacity>

            {/* Annual & Non-Recurring Required Receipts Section */}
            {annualOtherReceiptsList.length > 0 && (
              <View style={styles.termCard}>
                <Text style={styles.termTitle}>Annual / Mandatory Clearance Fees (Cement, etc.)</Text>
                {annualOtherReceiptsList.map(rec => (
                  <View key={rec.id} style={styles.annualItemRow}>
                    <View>
                      <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#0d233a' }}>{rec.categoryTitle}</Text>
                      <Text style={{ fontSize: 10, color: '#64748b' }}>Ref: {rec.number}</Text>
                    </View>
                    <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#059669' }}>ZMW {rec.amount}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Term Cards */}
            {periodNumbers.map(termNum => {
              const termReceipts = termReceiptsList.filter(r => r.term === termNum);
              return (
                <View key={termNum} style={styles.termCard}>
                  <Text style={styles.termTitle}>{P.label} {termNum} Clearance ({termReceipts.length}/{P.slots} Instalments)</Text>
                  <View style={styles.grid}>
                    {slotNumbers.map(slotNum => {
                      const rec = termReceipts.find(r => r.slot === slotNum);
                      return rec ? (
                        <View key={slotNum} style={styles.slotActive}>
                          <Text style={{ fontSize: 10, color: '#64748b' }}>Slot #{slotNum}</Text>
                          <Text style={{ fontSize: 12, fontWeight: 'bold' }} numberOfLines={1}>{rec.number}</Text>
                          <Text style={{ fontSize: 10, color: '#059669' }}>ZMW {rec.amount}</Text>
                        </View>
                      ) : (
                        <TouchableOpacity key={slotNum} style={styles.slotEmpty} onPress={() => {
                          setReceiptForm({ receiptType: 'term', term: termNum, slot: slotNum, categoryTitle: '', number: '', amount: '', cleared: false, image: null });
                          setModalType('add_receipt');
                          setModalVisible(true);
                        }}>
                          <Ionicons name="add" size={16} color="#94a3b8" />
                          <Text style={{ fontSize: 10, color: '#94a3b8' }}>Slot {slotNum}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {activeTab === 'pastpapers' && (
          <View>
            <TouchableOpacity style={styles.scanBtn} onPress={() => { if (!paperForm.semester.startsWith(P.label)) setPaperForm({ ...paperForm, semester: `${P.label} 1` }); setModalType('scan_paper'); setModalVisible(true); }}>
              <FontAwesome5 name="camera" size={14} color="#fff" />
              <Text style={{ color: '#fff', fontWeight: 'bold', marginLeft: 8 }}>Scan Exam Paper</Text>
            </TouchableOpacity>

            {pastPapers.map(paper => (
              <View key={paper.id} style={styles.paperCard}>
                <Text style={styles.paperCode}>{paper.code} - {paper.title}</Text>
                <Text style={{ fontSize: 11, color: '#64748b' }}>{paper.year} • {paper.semester} ({paper.pages.length} Pages)</Text>
              </View>
            ))}
          </View>
        )}

        {activeTab === 'profile' && (
          <View style={styles.profileCard}>
            <Text style={styles.profileTitle}>Student Profile</Text>
            <Text style={styles.profileLabel}>Full Name: <Text style={styles.profileVal}>{profile.fullName}</Text></Text>
            <Text style={styles.profileLabel}>Student No: <Text style={styles.profileVal}>{profile.studentNumber}</Text></Text>
            <Text style={styles.profileLabel}>Programme: <Text style={styles.profileVal}>{profile.programme}</Text></Text>
            <Text style={styles.profileLabel}>Phone: <Text style={styles.profileVal}>{profile.phone}</Text></Text>
            <Text style={styles.profileLabel}>Academic Year: <Text style={styles.profileVal}>{profile.academicYear}</Text></Text>
            <Text style={styles.profileLabel}>Intake: <Text style={styles.profileVal}>{profile.intake}</Text></Text>
            <Text style={styles.profileLabel}>Study System: <Text style={styles.profileVal}>{P.plural} ({P.count} per year)</Text></Text>
            <TouchableOpacity style={[styles.camBtn, { marginTop: 8, marginBottom: 0 }]} onPress={() => openProfileModal(true)}>
              <Text style={{ color: '#0d233a', fontWeight: 'bold' }}>Edit Profile & Study System</Text>
            </TouchableOpacity>

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
      <Modal visible={modalVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {modalType === 'add_receipt' && (
              <View>
                <Text style={styles.modalTitle}>
                  {receiptForm.receiptType === 'annual_other' ? 'Add Required Clearance Receipt' : `Attach Receipt ${P.label} ${receiptForm.term} (Slot #${receiptForm.slot})`}
                </Text>

                {receiptForm.receiptType === 'annual_other' && (
                  <TextInput 
                    placeholder="Clearance Fee Title (e.g. Cement, Building Fund)" 
                    value={receiptForm.categoryTitle} 
                    style={styles.input} 
                    onChangeText={t => setReceiptForm({ ...receiptForm, categoryTitle: t })} 
                  />
                )}

                <TextInput placeholder="Receipt Reference No." style={styles.input} onChangeText={t => setReceiptForm({ ...receiptForm, number: t })} />
                <TextInput placeholder="Amount Paid (ZMW)" keyboardType="numeric" style={styles.input} onChangeText={t => setReceiptForm({ ...receiptForm, amount: t })} />
                
                <TouchableOpacity style={styles.camBtn} onPress={() => pickImage('receipt')}>
                  <Text style={{ color: '#0d233a', fontWeight: 'bold' }}>Capture Receipt Photo</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.saveBtn} onPress={handleAddReceipt}>
                  <Text style={{ color: '#fff', fontWeight: 'bold' }}>Save to SQLite</Text>
                </TouchableOpacity>
              </View>
            )}

            {modalType === 'scan_paper' && (
              <View>
                <Text style={styles.modalTitle}>Scan Exam Paper</Text>
                <TextInput placeholder="Course Code (e.g. ICT214)" style={styles.input} onChangeText={t => setPaperForm({ ...paperForm, code: t })} />
                <TextInput placeholder="Course Title" style={styles.input} onChangeText={t => setPaperForm({ ...paperForm, title: t })} />
                <TextInput placeholder="Exam Year (e.g. 2025)" keyboardType="numeric" value={paperForm.year} style={styles.input} onChangeText={t => setPaperForm({ ...paperForm, year: t })} />
                <View style={{ flexDirection: 'row', marginBottom: 10 }}>
                  {periodNumbers.map(n => {
                    const val = `${P.label} ${n}`;
                    const on = paperForm.semester === val;
                    return (
                      <TouchableOpacity key={n} onPress={() => setPaperForm({ ...paperForm, semester: val })} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, marginRight: 8, backgroundColor: on ? '#0d233a' : '#e2e8f0' }}>
                        <Text style={{ fontSize: 12, fontWeight: 'bold', color: on ? '#fff' : '#0d233a' }}>{val}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TouchableOpacity style={styles.camBtn} onPress={() => pickImage('paper')}>
                  <Text style={{ color: '#0d233a', fontWeight: 'bold' }}>Capture Page ({paperForm.images.length} added)</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={handleAddPastPaper}>
                  <Text style={{ color: '#fff', fontWeight: 'bold' }}>Save Paper</Text>
                </TouchableOpacity>
              </View>
            )}

            {modalType === 'edit_profile' && (
              <ScrollView style={{ maxHeight: 460 }} keyboardShouldPersistTaps="handled">
                <Text style={styles.modalTitle}>{profileSet ? 'Edit Profile' : 'Welcome! Set up your profile'}</Text>
                <TextInput placeholder="Full Name" value={profileForm.fullName} style={styles.input} onChangeText={t => setProfileForm({ ...profileForm, fullName: t })} />
                <TextInput placeholder="Student Number" value={profileForm.studentNumber} autoCapitalize="characters" style={styles.input} onChangeText={t => setProfileForm({ ...profileForm, studentNumber: t })} />
                <TextInput placeholder="Programme" value={profileForm.programme} style={styles.input} onChangeText={t => setProfileForm({ ...profileForm, programme: t })} />
                <TextInput placeholder="Academic Year (e.g. 2026)" value={profileForm.academicYear} keyboardType="numeric" style={styles.input} onChangeText={t => setProfileForm({ ...profileForm, academicYear: t })} />
                <TextInput placeholder="Intake (e.g. January Intake)" value={profileForm.intake} style={styles.input} onChangeText={t => setProfileForm({ ...profileForm, intake: t })} />
                <TextInput placeholder="Phone" value={profileForm.phone} keyboardType="phone-pad" style={styles.input} onChangeText={t => setProfileForm({ ...profileForm, phone: t })} />

                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#0d233a', marginBottom: 6 }}>Does your school use Terms or Semesters?</Text>
                <View style={{ flexDirection: 'row', marginBottom: 12 }}>
                  {['term', 'semester'].map(m => {
                    const on = profileForm.mode === m;
                    return (
                      <TouchableOpacity key={m} onPress={() => setProfileForm({ ...profileForm, mode: m })} style={{ flex: 1, padding: 12, borderRadius: 10, marginHorizontal: 4, alignItems: 'center', borderWidth: 2, borderColor: on ? '#0d233a' : '#cbd5e1', backgroundColor: on ? '#0d233a' : '#fff' }}>
                        <Text style={{ fontWeight: 'bold', color: on ? '#fff' : '#0d233a' }}>{PERIODS[m].plural}</Text>
                        <Text style={{ fontSize: 10, color: on ? '#cbd5e1' : '#64748b' }}>{PERIODS[m].count} per year</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <TouchableOpacity style={styles.saveBtn} onPress={saveProfile}>
                  <Text style={{ color: '#fff', fontWeight: 'bold' }}>Save Profile</Text>
                </TouchableOpacity>

                {!profileSet && (
                  <TouchableOpacity style={{ marginTop: 12, alignItems: 'center' }} onPress={() => setModalType('drive_sync')}>
                    <Text style={{ fontSize: 12, color: '#059669', fontWeight: 'bold' }}>Already backed up? Restore from Google Drive</Text>
                  </TouchableOpacity>
                )}
              </ScrollView>
            )}

            {modalType === 'drive_sync' && (
              <View>
                <View style={{ alignItems: 'center' }}>
                  <Ionicons name="cloud" size={40} color="#059669" />
                  <Text style={{ fontWeight: 'bold', marginVertical: 8 }}>Google Drive Backup</Text>
                </View>

                {!driveUser ? (
                  <View>
                    <Text style={{ textAlign: 'center', fontSize: 12, color: '#64748b' }}>
                      Sign in with your Google account. Your receipts and past-paper photos are saved in a "Rockview Clearance Hub" folder in your own Google Drive, and you can restore everything if you change phone or reinstall.
                    </Text>
                    <TouchableOpacity style={[styles.saveBtn, { backgroundColor: '#059669', marginTop: 15 }]} onPress={handleDriveSignIn}>
                      <Text style={{ color: '#fff', fontWeight: 'bold' }}>Sign in with Google</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View>
                    <Text style={{ textAlign: 'center', fontSize: 12, color: '#0d233a', fontWeight: 'bold' }}>{driveUser.email}</Text>
                    <Text style={{ textAlign: 'center', fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      {lastSync ? `Last backup: ${lastSync}` : 'No backup yet'}
                    </Text>

                    <TouchableOpacity disabled={driveBusy} style={[styles.saveBtn, { backgroundColor: '#059669', marginTop: 12, opacity: driveBusy ? 0.6 : 1 }]} onPress={() => runBackup(false)}>
                      <Text style={{ color: '#fff', fontWeight: 'bold' }}>Back Up Now</Text>
                    </TouchableOpacity>

                    <TouchableOpacity disabled={driveBusy} style={[styles.camBtn, { marginTop: 8, marginBottom: 0, opacity: driveBusy ? 0.6 : 1 }]} onPress={() => Alert.alert('Restore from Drive', 'This adds any records and photos found in your Drive backup to this phone. Existing records are kept.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Restore', onPress: runRestore }])}>
                      <Text style={{ color: '#0d233a', fontWeight: 'bold' }}>Restore from Drive</Text>
                    </TouchableOpacity>

                    {!!driveFolderId && (
                      <TouchableOpacity style={[styles.camBtn, { marginTop: 8, marginBottom: 0 }]} onPress={() => Linking.openURL(folderUrl(driveFolderId))}>
                        <Text style={{ color: '#0d233a', fontWeight: 'bold' }}>Open Folder in Google Drive</Text>
                      </TouchableOpacity>
                    )}

                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
                      <View style={{ flex: 1, paddingRight: 10 }}>
                        <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#0d233a' }}>Keep a duplicate copy folder</Text>
                        <Text style={{ fontSize: 10, color: '#64748b' }}>Also saves everything to "Rockview Clearance Hub (Copy)".</Text>
                      </View>
                      <Switch value={duplicateOn} onValueChange={toggleDuplicate} disabled={driveBusy} />
                    </View>

                    {driveBusy && <ActivityIndicator style={{ marginTop: 10 }} color="#059669" />}
                    {!!driveMsg && <Text style={{ textAlign: 'center', fontSize: 11, color: '#334155', marginTop: 8 }}>{driveMsg}</Text>}

                    <TouchableOpacity onPress={handleDriveSignOut} style={{ marginTop: 10, alignItems: 'center' }}>
                      <Text style={{ fontSize: 11, color: '#64748b' }}>Sign out of Google</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}

            {!(modalType === 'edit_profile' && !profileSet) && (
              <TouchableOpacity style={styles.closeBtn} onPress={closeModal}>
                <Text style={{ color: '#ef4444', fontWeight: 'bold' }}>Close</Text>
              </TouchableOpacity>
            )}
          </View>
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
  scanBtn: { backgroundColor: '#0d233a', padding: 12, borderRadius: 10, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginBottom: 15 },
  paperCard: { backgroundColor: '#fff', padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', marginBottom: 10 },
  paperCode: { fontWeight: 'bold', fontSize: 14, color: '#0d233a' },
  profileCard: { backgroundColor: '#fff', padding: 15, borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0' },
  profileTitle: { fontSize: 16, fontWeight: 'bold', color: '#0d233a', marginBottom: 10 },
  profileLabel: { fontSize: 12, color: '#64748b', marginBottom: 5 },
  profileVal: { color: '#0f172a', fontWeight: 'bold' },
  devCard: { backgroundColor: '#fef3c7', padding: 12, borderRadius: 10, marginTop: 15, borderWidth: 1, borderColor: '#fde68a' },
  navBar: { flexDirection: 'row', justifyContent: 'space-around', padding: 10, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  navItem: { alignItems: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#fff', padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  modalTitle: { fontSize: 16, fontWeight: 'bold', marginBottom: 12, color: '#0d233a' },
  input: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, padding: 10, fontSize: 12, marginBottom: 10 },
  camBtn: { backgroundColor: '#e2e8f0', padding: 10, borderRadius: 8, alignItems: 'center', marginBottom: 10 },
  saveBtn: { backgroundColor: '#0d233a', padding: 12, borderRadius: 8, alignItems: 'center' },
  closeBtn: { marginTop: 10, alignItems: 'center' }
});
