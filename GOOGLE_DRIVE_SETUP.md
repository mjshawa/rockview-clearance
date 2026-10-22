# Google Drive backup: one-time setup

The app code is done. Google just needs to know your app exists. About 15 minutes, free.

## 1. Create a Google Cloud project
1. Go to https://console.cloud.google.com and sign in with your developer account (mjshawa23@gmail.com).
2. Top bar > project picker > **New Project** > name it `Rockview Clearance Hub`.

## 2. Turn on the Drive API
**APIs & Services > Library** > search **Google Drive API** > **Enable**.

## 3. OAuth consent screen
**APIs & Services > OAuth consent screen** (may be called "Google Auth Platform").
1. User type: **External**. Fill app name, support email, developer email.
2. **Data access / Scopes** > add `.../auth/drive.file` (it is a non-sensitive scope, so Google does not need to review it).
3. **Publishing status: click "Publish app" (move to Production).**
   If you leave it in "Testing", ONLY emails listed under "Test users" can sign in. Students will be blocked.

## 4. Get the SHA-1 of the key that signs your APK
In the project folder run:
```
npx eas-cli credentials -p android
```
Choose the `preview` build profile > Keystore > view. Copy the **SHA1 Fingerprint**.
(The `production` profile may use a different keystore, so repeat for it if you use it.)

## 5. Create TWO OAuth clients (APIs & Services > Credentials > Create credentials > OAuth client ID)
**A. Android client**
- Package name: `com.rockview.clearancehub`
- SHA-1: the one from step 4
You never paste this one anywhere. Google just matches it to your app on the phone.

**B. Web application client**
- Name: `Rockview web`, no redirect URIs needed.
- Copy its **Client ID** (ends in `.apps.googleusercontent.com`).

## 6. Paste the Web client ID into the app
Edit `src/config.js`:
```js
export const WEB_CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
```

## 7. Rebuild
```
npm install
npx eas-cli build -p android --profile preview
```

## Testing checklist
1. Install the APK, tap the cloud icon, **Sign in with Google**.
2. Add a receipt with a photo. It uploads automatically.
3. Open Google Drive on the phone: you should see **Rockview Clearance Hub / Receipts** (and **Past Papers / <COURSE CODE>**, **Backup**).
4. Turn on **Keep a duplicate copy folder** to also get **Rockview Clearance Hub (Copy)**.
5. Uninstall and reinstall the app, sign in again, tap **Restore from Drive**.

## Troubleshooting
- **DEVELOPER_ERROR / error 10**: package name or SHA-1 in the Android client does not match the APK. Fix step 4/5A.
- **"Access blocked / app not verified"**: you are still in Testing mode (step 3), or the person is not a test user.
- **Sign-in works but backup says 403**: Drive API not enabled (step 2).
