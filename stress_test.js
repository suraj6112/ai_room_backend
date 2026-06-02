/**
 * Stress Test - Scalability & Reliability Verification
 * 
 * Target: Verify Section OBJ-3 and Priority 2 of DEVELOPER_GUIDE.md
 */

const path = require('path');
// Ensure that when we require files from other folders (like functions/), 
// they can find the dependencies installed here.
const localModules = path.join(__dirname, 'node_modules');
if (require('fs').existsSync(localModules)) {
  require('module').Module._initPaths();
  process.env.NODE_PATH = (process.env.NODE_PATH || '') + path.delimiter + localModules;
  require('module').Module._initPaths();
}

const admin = require('firebase-admin');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Initialize Firebase
if (!admin.apps.length) {
  const firebaseConfig = {};
  if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    firebaseConfig.credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    });
  }
  admin.initializeApp(firebaseConfig);
}
const db = admin.firestore();

const TEST_WORKSPACE_ID = 'stress-test-' + Math.random().toString(36).substring(7);
const FILE_COUNT = 25; // Exceeds the 20-file limit

async function runVerification() {
  console.log(`\n [Verification] Room ID: ${TEST_WORKSPACE_ID}`);

  // 1. STRESS TEST: CONCURRENCY
  console.log(`\n Task 1: Verifying Concurrency (Limit: 20 per workspace)`);
  const filesRef = db.collection(`workspaces/${TEST_WORKSPACE_ID}/files`);

  const batch = db.batch();
  for (let i = 1; i <= FILE_COUNT; i++) {
    batch.set(filesRef.doc(`file-${i}`), {
      name: `Scale_Test_${i}.pdf`,
      processingStatus: 'pending',
      storagePath: `stress_test/dummy.pdf`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  await batch.commit();
  console.log(`   - ${FILE_COUNT} files injected.`);

  // 2. STUCK FILE DETECTION (JANITOR)
  console.log(`\n Task 2: Injecting STUCK file for Janitor`);
  const stuckTime = new Date(Date.now() - 25 * 60 * 1000); // 25m ago
  await filesRef.doc('stuck-file').set({
    name: 'Stuck_Doc_25min.pdf',
    processingStatus: 'processing',
    updatedAt: admin.firestore.Timestamp.fromDate(stuckTime),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`   - Stuck file injected (Status: processing, Age: 25m).`);

  // 3. MONITORING
  console.log(`\n Monitoring Firestore for 60 seconds...`);

  return new Promise((resolve) => {
    const unsubscribe = filesRef.onSnapshot(snap => {
      const stats = { pending: 0, processing: 0, completed: 0, error: 0, unsupported: 0 };
      snap.docs.forEach(d => stats[d.data().processingStatus]++);

      process.stdout.write(`\r   [STATS] Pending: ${stats.pending} | Processing: ${stats.processing} | Finished: ${stats.completed + stats.error + stats.unsupported}  `);

      // Gating Verification
      if (stats.processing > 20) {
        console.error(`\n❌ FAIL: Concurrency limit violated! (${stats.processing}/20)`);
        unsubscribe();
        resolve(false);
      }
    });

    setTimeout(() => {
      console.log(`\n\n✅ Snapshot Monitoring Complete.`);
      unsubscribe();
      resolve(true);
    }, 60000);
  });
}

/**
 * Manually call the Janitor logic to verify stuck files are reset
 */
async function triggerJanitorVerification() {
  console.log(`\n Task 3: Running Janitor logic manually...`);
  // Path updated to reach functions folder from microservices/file-processor
  const { detectStuckFiles } = require('../../functions/janitorService');

  const result = await detectStuckFiles();
  if (result.resetCount > 0) {
    console.log(`   - ✅ SUCCESS: Janitor detected and reset ${result.resetCount} files.`);
  } else {
    console.warn(`   -  Janitor reset 0 files. (Might be because timestamps didn't trigger)`);
  }
}

async function main() {
  try {
    const success = await runVerification();
    if (success) {
      await triggerJanitorVerification();
    }
    console.log(`\n Verification Logic finished. Clean up workspace ${TEST_WORKSPACE_ID} in Firebase Console later.`);
  } catch (err) {
    console.error(`\n CRASH: ${err.message}`);
  }
}

main();
