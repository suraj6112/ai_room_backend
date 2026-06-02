require('dotenv').config({ path: __dirname + '/../../.env' });
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { extractCellLLM } = require('../../reviews/extractionEngine.js');
const ContextService = require('../../reviews/contextService.js');
const { tryKeyFactsShortCircuit } = require('../../reviews/shortCircuit.js');
const { buildExtractionPrompt, buildColumnJsonSchema, coerceValue } = require('../../reviews/extractionPrompts.js');

if (!admin.apps.length) {
  admin.initializeApp({ storageBucket: process.env.FIREBASE_STORAGE_BUCKET });
}

const EVAL_JSON_PATH = path.join(__dirname, 'eval_cases.json');
const ERRORS_JSON_PATH = path.join(__dirname, 'errors.json');

async function runEval() {
  console.log('\n================================================');
  console.log('    TABULAR REVIEW: EXTRACTION EVAL BENCH       ');
  console.log(`    PROVIDER: ${process.env.EXTRACTION_PROVIDER || 'openai'}`);
  console.log(`    MODEL: ${process.env.EXTRACTION_MODEL || 'gpt-4o-mini'}`);
  console.log('================================================\n');

  if (!fs.existsSync(EVAL_JSON_PATH)) {
    console.error('❌ eval_cases.json not found. Run generate_truth.js first.');
    process.exit(1);
  }

  const cases = JSON.parse(fs.readFileSync(EVAL_JSON_PATH, 'utf8'));
  console.log(`Found ${cases.length} evaluation cases. Starting execution...\n`);

  let correctCount = 0;
  let partialCount = 0;
  let wrongCount = 0;
  let dodgedCount = 0;
  let totalTime = 0;
  let totalCost = 0;
  const errorsLog = [];

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    console.log(`[${i+1}/${cases.length}] EVALUATING: ${testCase.fileName} -> [${testCase.columnName}]`);

    const t0 = Date.now();
    try {
      let finalParsed = null;
      let finalJourney = [];
      let finalCost = 0;
      let searchMetrics = null;

      const shortCircuitPayload = await tryKeyFactsShortCircuit({
        columnName: testCase.columnName,
        profileSummary: testCase.documentProfileSummary,
        fileId: testCase.fileId,
        basePath: testCase.basePath
      });

      if (shortCircuitPayload) {
        finalParsed = shortCircuitPayload;
        finalJourney = ['[ShortCircuit] Answer derived from document profile keyFacts. RAG bypassed.'];
        searchMetrics = { strategy: 'short_circuit' };
      } else {
        const attemptPasses = [
          { maxPages: 5 },
          { maxPages: 10 }
        ];

      for (let pass of attemptPasses) {
        const contextResult = await ContextService.buildTargetedContext({
          fileId: testCase.fileId,
          basePath: testCase.basePath,
          query: testCase.columnPrompt,
          maxPages: pass.maxPages,
          shortDocThreshold: 15
        });

        searchMetrics = contextResult.metrics;

        const promptText = buildExtractionPrompt(testCase.columnName, testCase.columnType, testCase.columnPrompt, contextResult.text, {
          columnOptions: testCase.columnOptions
        });

        const jsonSchema = buildColumnJsonSchema(testCase.columnType, testCase.columnOptions);

        const result = await extractCellLLM({
          prompt: promptText,
          jsonSchema: jsonSchema,
          options: {
            provider: process.env.EXTRACTION_PROVIDER || 'openai',
            model: process.env.EXTRACTION_MODEL || 'gpt-4o-mini'
          }
        });

        finalParsed = result.parsed;
        finalJourney = result.journey;
        finalCost += result.costEstimate;

        if ((finalParsed.value !== null && finalParsed.confidence === 'high') || pass === attemptPasses[1]) {
          break;
        }
      }
      } // End of RAG else block

      const t1 = Date.now();
      const timeTaken = (t1 - t0) / 1000;
      totalTime += timeTaken;
      totalCost += finalCost;

      const coercedActual = coerceValue(finalParsed.value, testCase.columnType, testCase.columnOptions);
      const coercedExpected = coerceValue(testCase.expected_value, testCase.columnType, testCase.columnOptions);

      let status = 'WRONG';
      if (coercedActual === coercedExpected) {
        if (coercedExpected === null) {
          status = 'DODGED';
          dodgedCount++;
        } else {
          status = 'CORRECT';
          correctCount++;
        }
      } else if (String(coercedActual).toLowerCase().includes(String(coercedExpected).toLowerCase()) || 
                 String(coercedExpected).toLowerCase().includes(String(coercedActual).toLowerCase())) {
        status = 'PARTIAL';
        partialCount++;
      } else {
        status = 'WRONG';
        wrongCount++;
      }

      let statusIcon = status === 'CORRECT' ? '✅' : (status === 'DODGED' ? '🛡️' : (status === 'PARTIAL' ? '⚠️' : '❌'));
      console.log(`  └ Status: ${statusIcon} ${status}`);
      console.log(`  └ Expected: ${coercedExpected}`);
      console.log(`  └ Actual:   ${coercedActual}`);
      console.log(`  └ Time: ${timeTaken.toFixed(1)}s | Cost: ~$${finalCost.toFixed(5)}`);

      if (status === 'WRONG' || status === 'PARTIAL') {
        errorsLog.push({
          fileName: testCase.fileName,
          columnName: testCase.columnName,
          status,
          expected: coercedExpected,
          actual: coercedActual,
          reasoning: finalParsed.reasoning,
          journey: finalJourney,
          searchMetrics
        });
      }

    } catch (err) {
      console.error(`  ❌ FAILED: ${err.message}`);
      wrongCount++;
      errorsLog.push({ fileName: testCase.fileName, columnName: testCase.columnName, status: 'FATAL_ERROR', error: err.message });
    }
  }

  fs.writeFileSync(ERRORS_JSON_PATH, JSON.stringify(errorsLog, null, 2));

  console.log('\n================================================');
  console.log('              EVALUATION SUMMARY                ');
  console.log('================================================');
  console.log(`  Total Cases: ${cases.length}`);
  console.log(`  Correct:     ${correctCount}`);
  console.log(`  Dodged:      ${dodgedCount}`);
  console.log(`  Partial:     ${partialCount}`);
  console.log(`  Wrong:       ${wrongCount}`);
  const accuracy = cases.length > 0 ? (((correctCount + dodgedCount + (partialCount * 0.5)) / cases.length) * 100).toFixed(1) : 0;
  console.log(`  ----------------------------------------------`);
  console.log(`  Overall Accuracy: ${accuracy}%`);
  console.log(`  Total Time:       ${totalTime.toFixed(1)}s`);
  console.log(`  Total Cost:       ~$${totalCost.toFixed(5)}`);
  console.log('================================================\n');
  console.log(`📄 Error log saved to: ${ERRORS_JSON_PATH}\n`);
}

runEval().catch(console.error);
