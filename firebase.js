const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

let db = null;

function initFirebase() {
  if (admin.apps.length > 0) {
    return admin.firestore();
  }

  try {
    const keyPath = path.join(__dirname, 'serviceAccountKey.json');

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      // Cloud environment variable (Render, Koyeb, Railway)
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('🔥 [Firebase] Initialized using FIREBASE_SERVICE_ACCOUNT environment variable');
    } else if (fs.existsSync(keyPath)) {
      // Local development key file
      const serviceAccount = require(keyPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('🔥 [Firebase] Initialized using local serviceAccountKey.json');
    } else {
      // Fallback for GCP or default credentials
      admin.initializeApp();
      console.log('🔥 [Firebase] Initialized using default credentials');
    }

    db = admin.firestore();
    return db;
  } catch (error) {
    console.error('❌ [Firebase] Failed to initialize Firebase Admin SDK:', error.message);
    console.error('👉 Ensure serviceAccountKey.json is placed in /whatsapp-service or FIREBASE_SERVICE_ACCOUNT env is set.');
    return null;
  }
}

module.exports = {
  admin,
  getDb: () => db || initFirebase()
};
