require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Initialize Firebase Admin
if (!admin.apps.length) {
  const firebaseConfig = {};
  if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    firebaseConfig.credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Fix relative path for GOOGLE_APPLICATION_CREDENTIALS if running from scripts/ folder
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS.startsWith('./')) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(__dirname, '..', process.env.GOOGLE_APPLICATION_CREDENTIALS);
    }
  }
  admin.initializeApp(firebaseConfig);
}

async function generateKey() {
  const args = process.argv.slice(2);
  const wsId = args[0];
  const uid = args[1] || 'dev_tester_uid'; // Provide a default test UID if none provided

  if (!wsId) {
    console.error('Usage: node generateApiKey.js <workspaceId> [uid]');
    process.exit(1);
  }

  const db = admin.firestore();

  // 1. Generate random secret and Key ID
  const keyId = uuidv4().replace(/-/g, '').slice(0, 16);
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const hashedSecret = crypto.createHash('sha256').update(rawSecret).digest('hex');

  // 2. Prepare API Key Document Data
  const apiKeyData = {
    keyId: keyId,
    uid: uid,
    wsId: wsId,
    basePath: `workspaces/${wsId}`,
    hashedSecret: hashedSecret,
    scopes: ['read:files', 'execute:search', 'write:reviews', 'export:reviews'],
    monthly_budget_usd: 100, // $100 test budget
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    name: 'Auto-Generated Test Key'
  };

  try {
    // 3. Ensure the mock user is a member of the workspace (required by auth.js)
    const memberRef = db.doc(`workspaces/${wsId}/members/${uid}`);
    const memberDoc = await memberRef.get();
    if (!memberDoc.exists) {
      console.log(`[Info] Creating mock member doc for ${uid} in workspace ${wsId}...`);
      await memberRef.set({
        role: 'admin',
        addedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // 4. Save API Key Document
    await db.doc(`workspaces/${wsId}/apiKeys/${keyId}`).set(apiKeyData);

    // 5. Output the final usable key
    const finalKey = `airoom_${keyId}_${rawSecret}`;
    console.log('\n======================================================');
    console.log('✅ API Key Successfully Generated!');
    console.log('======================================================');
    console.log('Workspace ID  :', wsId);
    console.log('User ID       :', uid);
    console.log('\n🗝️  YOUR API KEY:');
    console.log(finalKey);
    console.log('\n⚠️  IMPORTANT: Copy this key now! The raw secret is not stored anywhere.');
    console.log('======================================================\n');
    
    process.exit(0);
  } catch (error) { 
    console.error('❌ Failed to generate API Key:', error.message);
    process.exit(1);
  }
}
 
generateKey();
