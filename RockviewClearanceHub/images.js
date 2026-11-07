// images.js - camera and gallery helpers used by App.js
// Every picked photo is returned as { uri, mime, base64 } because App.js stores the base64 text in SQLite.
import * as ImagePicker from 'expo-image-picker';

const MEDIA_IMAGES = ImagePicker.MediaType ? ['images'] : ImagePicker.MediaTypeOptions.Images;
const QUALITY = 0.6; // keeps each photo small enough to store in the local database

const toPhoto = (a) => ({
  uri: a.uri,
  mime: a.mimeType || 'image/jpeg',
  base64: a.base64,
});

export async function takePhoto() {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Camera permission is needed to take a photo. Allow it in your phone settings.');
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: MEDIA_IMAGES, quality: QUALITY, base64: true });
  if (res.canceled) return [];
  return res.assets.filter(a => a.base64).map(toPhoto);
}

export async function chooseFromFiles() {
  // Android 13+ uses the system photo picker and needs no permission; older phones ask for it
  try { await ImagePicker.requestMediaLibraryPermissionsAsync(); } catch (e) { /* picker may still work */ }
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: MEDIA_IMAGES,
    quality: QUALITY,
    base64: true,
    allowsMultipleSelection: true,
    selectionLimit: 10,
  });
  if (res.canceled) return [];
  return res.assets.filter(a => a.base64).map(toPhoto);
}
