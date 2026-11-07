// documents.js - saves PDFs and books on the phone (the "PDF File" button on the Past Papers tab)
import * as FileSystem from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';

export const DIR = FileSystem.documentDirectory + 'rockview_pdfs/';
const MAX_BYTES = 10 * 1024 * 1024; // matches the "smaller than 10 MB" hint in the form

const ensureDir = async () => {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
};

export async function pickPdf() {
  const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
  if (res.canceled) return null;
  const a = res.assets[0];
  if (a.size && a.size > MAX_BYTES) throw new Error('PDF files smaller than 10 MB only.');
  return { uri: a.uri, name: a.name || 'document.pdf', size: a.size || 0 };
}

// Copies the picked file into app storage and returns the stored file name (saved in documents.file_name)
export async function storeFile(uri, name) {
  await ensureDir();
  const stored = `${Date.now()}_${String(name).replace(/[^\w.\-]+/g, '_')}`;
  await FileSystem.copyAsync({ from: uri, to: DIR + stored });
  return stored;
}

export async function removeFile(fileName) {
  if (!fileName) return;
  await FileSystem.deleteAsync(DIR + fileName, { idempotent: true });
}

export const fmtSize = (bytes) => {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};
