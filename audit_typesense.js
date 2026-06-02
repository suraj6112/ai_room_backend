'use strict';

const admin = require('firebase-admin');
const Typesense = require('typesense');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

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
  } else {
    try {
      firebaseConfig.credential = admin.credential.cert(path.resolve(__dirname, 'firebase-key.json'));
    } catch (e) {
      // Ignore if not present
    }
  }
  admin.initializeApp(firebaseConfig);
}

const client = new Typesense.Client({
  nodes: [{
    host: process.env.TYPESENSE_DOC_HOST,
    port: '443',
    protocol: 'https',
  }],
  apiKey: process.env.TYPESENSE_DOC_API_KEY,
  connectionTimeoutSeconds: 10,
});

async function run() {
  try {
    console.log('Connecting to Typesense...');
    const collections = await client.collections().retrieve();
    console.log('Collections present:', collections.map(c => c.name));

    for (const coll of collections) {
      console.log(`\n--- Documents in collection: ${coll.name} ---`);
      const searchResult = await client.collections(coll.name).documents().search({
        q: '*',
        per_page: 50,
      });

      console.log(`Total hits: ${searchResult.found}`);
      const hits = searchResult.hits || [];
      hits.forEach((h, idx) => {
        const d = h.document;
        console.log(`[Hit ${idx + 1}] ID: ${d.id}`);
        console.log(`  File Name: ${d.file_name}`);
        console.log(`  Folder Path ID: ${d.folder_id}`);
        console.log(`  Folder Path Display: ${d.folder_path_display}`);
        console.log(`  Doc Type: ${d.doc_type}`);
        console.log(`  Doc Parties: ${JSON.stringify(d.doc_parties)}`);
        console.log(`  Metadata Text: ${d.doc_metadata_text}`);
        console.log(`  Chunk Index: ${d.chunk_index} / ${d.chunk_total}`);
        console.log('-----------------------------------');
      });
    }
  } catch (error) {
    console.error('Error during Typesense audit:', error);
  } finally {
    process.exit(0);
  }
}

run();
