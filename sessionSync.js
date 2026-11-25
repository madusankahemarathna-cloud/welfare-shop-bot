const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Restores Welfare Shop WhatsApp session files from Firestore backup if local creds are absent
 */
async function restoreSessionFromFirestore(authDir, db) {
  try {
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    const credsPath = path.join(authDir, 'creds.json');
    if (fs.existsSync(credsPath)) {
      console.log('📂 [Session] Local creds.json found. Using local session files.');
      return true;
    }

    if (!db) {
      console.log('⚠️ [Session] Firestore not available for session restore.');
      return false;
    }

    console.log('🔄 [Session] Local session empty. Checking Firestore backup...');
    const docSnap = await db.collection('welfare_whatsapp_session').doc('backup').get();
    if (!docSnap.exists) {
      console.log('ℹ️ [Session] No existing session found in Firestore. QR code scan required.');
      return false;
    }

    const { data, fileCount } = docSnap.data();
    if (!data) return false;

    const buffer = Buffer.from(data, 'base64');
    const decompressed = zlib.gunzipSync(buffer).toString('utf8');
    const filesMap = JSON.parse(decompressed);

    for (const [filename, content] of Object.entries(filesMap)) {
      fs.writeFileSync(path.join(authDir, filename), content, 'utf8');
    }

    console.log(`✅ [Session] Restored Welfare Shop WhatsApp session from Firestore backup (${Object.keys(filesMap).length} files).`);
    return true;
  } catch (err) {
    console.error('❌ [Session] Error restoring session from Firestore:', err.message);
    return false;
  }
}

/**
 * Backs up Welfare Shop WhatsApp session files to Firestore compressed base64
 */
let debounceTimeout = null;
function backupSessionToFirestore(authDir, db, immediate = false) {
  if (!db) return;

  const doBackup = async () => {
    try {
      if (!fs.existsSync(authDir)) return;
      const files = fs.readdirSync(authDir);
      if (files.length === 0) return;

      const credsPath = path.join(authDir, 'creds.json');
      if (!fs.existsSync(credsPath)) return; // Only backup if creds exist

      const filesMap = {};
      for (const file of files) {
        filesMap[file] = fs.readFileSync(path.join(authDir, file), 'utf8');
      }

      const jsonStr = JSON.stringify(filesMap);
      const compressed = zlib.gzipSync(jsonStr).toString('base64');

      await db.collection('welfare_whatsapp_session').doc('backup').set({
        data: compressed,
        updatedAt: new Date().toISOString(),
        fileCount: files.length
      });

      console.log(`💾 [Session] Welfare Shop WhatsApp session synced to Firestore backup (${files.length} files).`);
    } catch (err) {
      console.error('❌ [Session] Error backing up session to Firestore:', err.message);
    }
  };

  if (immediate) {
    if (debounceTimeout) clearTimeout(debounceTimeout);
    return doBackup();
  }

  // Debounce multiple frequent writes
  if (debounceTimeout) clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(doBackup, 10000); // sync every 10 seconds after updates
}

module.exports = {
  restoreSessionFromFirestore,
  backupSessionToFirestore
};
