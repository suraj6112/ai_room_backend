require('dotenv').config({ path: __dirname + '/../../.env' });
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { extractCellLLM } = require('../../reviews/extractionEngine.js');
const { buildExtractionPrompt, buildColumnJsonSchema } = require('../../reviews/extractionPrompts.js');

if (!admin.apps.length) {
  admin.initializeApp({ storageBucket: process.env.FIREBASE_STORAGE_BUCKET });
}
const db = admin.firestore();

// Target test cases to evaluate
const TEST_TARGETS = [
  { fileName: '01_Master_Subscription_Agreement_Template.pdf', columnName: 'Governing Law', columnType: 'text', prompt: 'Which state or country laws govern this contract?' },
  { fileName: '01_Master_Subscription_Agreement_Template.pdf', columnName: 'Term', columnType: 'text', prompt: 'What is the initial duration of the agreement?' },
  { fileName: '04_AWS_EDP_Summary.pdf', columnName: 'Commitment', columnType: 'currency', prompt: 'What is the total financial commitment?', options: { currencyCode: 'USD' } },
  { fileName: '04_AWS_EDP_Summary.pdf', columnName: 'Counterparty', columnType: 'text', prompt: 'Who is the counterparty?' },
  // Eval Bench Alignment: Massive Mirage
  { fileName: '01_Master_Subscription_Agreement_Template.pdf', columnName: 'Nuclear Liability Cap', columnType: 'currency', prompt: 'What is the specific liability cap for nuclear waste spills or radiation exposure?', options: { currencyCode: 'USD' } },
  // Eval Bench Alignment: Needle in the Haystack
  { fileName: '01_Master_Subscription_Agreement_Template.pdf', columnName: 'Assignment', columnType: 'boolean', prompt: 'Can either party assign this agreement without prior written consent?' },
  // Eval Bench Alignment: Capability 4 Tests
  { fileName: '01_Master_Subscription_Agreement_Template.pdf', columnName: 'Supplier Name', columnType: 'text', prompt: 'Who is the supplier or vendor?' }, // Alias test
  { fileName: '04_AWS_EDP_Summary.pdf', columnName: 'Governing Law', columnType: 'text', prompt: 'Governing law?' }, // Override test: Mocking doc type to Amendment later
  { fileName: '04_AWS_EDP_Summary.pdf', columnName: 'Term', columnType: 'text', prompt: 'Term?' } // Poisoned Quote test: Mocking later
];

const EVAL_JSON_PATH = path.join(__dirname, 'eval_cases.json');

async function generateTruthFiles() {
  console.log('\n================================================');
  console.log('    TABULAR REVIEW: TRUTH FILE GENERATOR        ');
  console.log(`    MODEL: ${process.env.TRUTH_MODEL || 'gpt-5-mini'}`);
  console.log('================================================\n');

  const evalCases = [];

  for (let i = 0; i < TEST_TARGETS.length; i++) {
    const target = TEST_TARGETS[i];
    console.log(`[${i+1}/${TEST_TARGETS.length}] Fetching ${target.fileName}...`);
    
    // Fetch file from Firestore by iterating workspaces
    let fileData = null;
    let fileId = null;
    let basePath = null;
    const workspacesSnap = await db.collection('workspaces').get();
    for (const wsDoc of workspacesSnap.docs) {
      const filesSnap = await db.collection(`workspaces/${wsDoc.id}/files`).where('name', '==', target.fileName).limit(1).get();
      if (!filesSnap.empty) {
        fileId = filesSnap.docs[0].id;
        basePath = `workspaces/${wsDoc.id}`;
        fileData = filesSnap.docs[0].data();
        break;
      }
    }

    if (!fileData) {
      console.error(`  ❌ Not found in Firestore: ${target.fileName}`);
      continue;
    }

    const extractedText = fileData.extractedText;
    if (!extractedText) {
      console.error(`  ❌ No extractedText found for: ${target.fileName}`);
      continue;
    }

    const promptText = buildExtractionPrompt(target.columnName, target.columnType, target.prompt, extractedText, {
      columnOptions: target.options
    });
    const jsonSchema = buildColumnJsonSchema(target.columnType, target.options);

    console.log(`  -> Generating truth for column: [${target.columnName}]`);
    
    try {
      const result = await extractCellLLM({
        prompt: promptText,
        jsonSchema: jsonSchema,
        options: {
          provider: 'openai',
          model: process.env.TRUTH_MODEL || 'gpt-5-mini'
        }
      });

      let docProfile = fileData.documentProfileSummary || null;

      // Mock overrides for Cap 4 eval bench
      if (target.columnName === 'Governing Law' && target.fileName === '04_AWS_EDP_Summary.pdf') {
        docProfile = { ...docProfile, hasProfile: true, category: 'contract', typeConfidence: 'high', documentType: 'amendment', keyFacts: { governingLaw: { value: 'NY', quote: 'test', page: 1 } } };
      }
      if (target.columnName === 'Term' && target.fileName === '04_AWS_EDP_Summary.pdf') {
        docProfile = { ...docProfile, hasProfile: true, category: 'contract', typeConfidence: 'high', documentType: 'contract', keyFacts: { term: { value: '5 years', quote: 'this quote does not exist on page', page: 1 } } };
      }
      // Mock valid profile for Alias test
      if (target.columnName === 'Supplier Name' && target.fileName === '01_Master_Subscription_Agreement_Template.pdf') {
         docProfile = { ...docProfile, hasProfile: true, category: 'contract', typeConfidence: 'high', documentType: 'contract', keyFacts: { parties: { value: 'Acme Corp', quote: 'between Acme Corp', page: 1 } } };
         // Ensure page exists in mock
         const db = admin.firestore();
         await db.doc(`${basePath}/files/${fileId}/pages/1`).set({ markdown_text: 'This agreement is between Acme Corp and the Buyer.' });
      }

      evalCases.push({
        fileName: target.fileName,
        fileId: fileId,
        basePath: basePath,
        extractedTextCache: extractedText, // Fallback cache
        documentProfileSummary: docProfile, // Pass profile for short-circuit eval
        columnName: target.columnName,
        columnType: target.columnType,
        columnPrompt: target.prompt,
        columnOptions: target.options || {},
        expected_value: result.parsed.value,
        expected_confidence: result.parsed.confidence
      });
      console.log(`  ✅ Done. Expected Value: ${result.parsed.value}`);
    } catch (err) {
      console.error(`  ❌ Failed to generate truth: ${err.message}`);
    }
  }

  fs.writeFileSync(EVAL_JSON_PATH, JSON.stringify(evalCases, null, 2));
  console.log(`\n🎉 Generated ${evalCases.length} truth cases and saved to eval_cases.json\n`);
  process.exit(0);
}

generateTruthFiles().catch(console.error);
