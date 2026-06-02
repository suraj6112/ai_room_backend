/**
 * File Processor Cloud Run Service
 *
 * Processes uploaded documents:
 * - Converts Office documents (docx, xlsx, pptx) to PDF using LibreOffice
 * - Converts PDF pages to images using Poppler
 * - Extracts text using OpenAI Vision API
 * - Generates thumbnails using Sharp
 * - Updates Firestore with results
 *
 * ============================================================================
 * IMPORTANT: This file is part of the CloudFiles file processing pipeline.
 * Before modifying this code, you MUST read:
 *   docs/cloudfiles/FILE_PROCESSING_PIPELINE.md
 *
 * This service is deployed to Cloud Run and receives tasks from Cloud Tasks.
 * It is called by the Cloud Functions triggers, NOT directly by the frontend.
 *
 * Deployment:
 *   cd microservices/file-processor
 *   gcloud run deploy file-processor --source . --region us-central1 ...
 *   (See full command in docs/cloudfiles/FILE_PROCESSING_PIPELINE.md)
 *
 * Service URL: (set by Cloud Run deployment — see setup-dev-project.sh output)
 * Health Check: curl <your-service-url>/health
 *
 * If you change processing logic or supported file types, update the docs!
 * ============================================================================
 */

// Load environment variables for local development
require("dotenv").config();

const express = require("express");
const admin = require("firebase-admin");
const { extractTextFromImage } = require("./vision.js");
const { validateDocument } = require("./financialValidator.js");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const tmp = require("tmp");
const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const { v4: uuidv4 } = require("uuid");

const escapeShellArg = (arg) => {
  if (process.platform === "win32") {
    // Windows: double quotes, escape double quotes by doubling them
    return `"${arg.replace(/"/g, '""')}"`;
  }
  // Linux/Bash: single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
};

const execAsync = (command, options) => {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

// Initialize Firebase Admin
const firebaseConfig = {
  storageBucket:
    process.env.FIREBASE_STORAGE_BUCKET ||
    (() => {
      throw new Error(
        "FIREBASE_STORAGE_BUCKET env var is required. Set it to <your-project-id>.appspot.com",
      );
    })(),
};

if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  firebaseConfig.credential = admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: privateKey,
  });
}

admin.initializeApp(firebaseConfig);
const db = admin.firestore();
const bucket = admin.storage().bucket();

// Configuration
const os = require("os");
const PORT = process.env.PORT || 8080;
const TEMP_DIR = path.resolve(
  process.env.TEMP_DIR || path.join(os.tmpdir(), "file-processor"),
);
const MAX_PAGES_TO_PROCESS = parseInt(
  process.env.MAX_PAGES_TO_PROCESS || "1000",
  10,
);
const PAGE_CONCURRENCY = parseInt(process.env.PAGE_CONCURRENCY || "15", 10);
const MAX_PREVIEW_PAGES = 20; // Number of pages to keep in main document for instant UI preview
const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_HEIGHT = 566;

// Processing configurations (configurable via .env for benchmarking)
const PAGE_IMAGE_DPI = parseInt(process.env.PAGE_IMAGE_DPI || "200", 10);
const EXTRACTION_MAX_WIDTH = parseInt(
  process.env.EXTRACTION_MAX_WIDTH || "1500",
  10,
);
const EXTRACTION_JPEG_QUALITY = parseInt(
  process.env.EXTRACTION_JPEG_QUALITY || "85",
  10,
);

// =============================================================================
// EXTRACTION PROMPTS
// =============================================================================

/**
 * Layout-aware extraction prompt with DealVerse directives.
 * Used ONLY when extractionMode === 'layout-aware' (i.e., DOCX import via DocEditor).
 * @see docs/design/DOCX_IMPORT_DVTAG_EXTRACTION.md
 */
const LAYOUT_AWARE_PROMPT = `You are a document replication assistant. Recreate the document faithfully using markdown and DealVerse layout directives.

## #1 RULE: TABLES → <dvrow>/<dvcol> WITH ACCURATE STYLING

When you see a table in the document:
- Output EACH row as a separate <dvrow>, including header rows
- NEVER use markdown tables for tables with colored headers or multi-line cells
- NEVER skip or omit header rows — every row in the original must appear in output

**Color detection:**
- ONLY add background="..." if the row CLEARLY has a visible colored/shaded background in the image
- Use the EXACT hex color you observe — do NOT default to any specific color
- If the header has white/light text on a dark background, add color="#ffffff" to the columns
- If a row has NO visible background color (plain white/unshaded), do NOT add background or color attributes

**Border detection:**
- If the table has visible grid lines/borders, replicate them using border attributes
- Use border-bottom on <dvrow> for horizontal lines between rows
- Use border-left/border-right on <dvcol> for vertical cell borders
- Match the observed border color and weight (e.g., "1px solid #000000")

Pattern — colored header (ONLY if visibly colored in the original):
<dvrow background="#OBSERVED_HEX" padding="6px 10px">
<dvcol width="25" color="#ffffff">

**Header A**

</dvcol>
<dvcol width="25" color="#ffffff">

**Header B**

</dvcol>
</dvrow>

Pattern — plain table with grid borders:
<dvrow padding="6px 10px" border-bottom="1px solid #000000">
<dvcol width="25" border-left="1px solid #000000" border-right="1px solid #000000">

**Header A**

</dvcol>
<dvcol width="25" border-left="1px solid #000000" border-right="1px solid #000000">

**Header B**

</dvcol>
</dvrow>

Pattern — data rows:
<dvrow padding="6px 10px" border-bottom="1px solid #dee2e6">
<dvcol width="25">

Data A1

</dvcol>
<dvcol width="25">

Data B1

</dvcol>
<dvcol width="25">

Data C1

</dvcol>
<dvcol width="25">

- Bullet item 1
- Bullet item 2

</dvcol>
</dvrow>

If the document has MULTIPLE such tables, output each one with its own header <dvrow> + data <dvrow>(s). Do NOT merge or skip any.

## CORE PRINCIPLE

Replicate the document's visual layout AND functional purpose:
- Forms → fillable (markdown tables with empty cells)
- Reports with KPIs → stat boxes
- Columns → column layout directives
- Callout boxes → callout directives
- Plain text → clean markdown

## NEVER USE CODE BLOCKS

Code blocks are ONLY for actual programming code. Never for lists, tables, or text.

## HEADINGS AND HIERARCHY

Standardize document headers into markdown header symbols:
- Main Title / Top-level Heading → # Header 1
- Section Headings (e.g., "Section 1.0", "Article I") → ## Header 2
- Sub-sections / Bold paragraph headers → ### Header 3
- NEVER use bold only (e.g., "**Section 1**") for standalone headers. ALWAYS prefix them with the appropriate number of '#' symbols to create a structured hierarchy.
- Standardize "CAPITALIZED HEADERS" into regular casing with markdown symbols (e.g., "ARTICLE 1" → "## Article 1").

## CONTENT RULES (100% Verbatim)

1. ALL text exactly as it appears — no summarization
2. Preserve line breaks, spacing, indentation
3. Bullets → markdown lists (- or *)
4. Headers → Use strict markdown hierarchy (# ## ###)
5. Footnotes, citations, small print — include all
6. Charts/graphs — describe data points and trends
7. Simple tables (NO colored headers, single-line cells only) → markdown table syntax
8. Tables with colored headers OR multi-line cells → <dvrow>/<dvcol> (see #1 RULE above)

## FORM DETECTION

Forms, questionnaires, intake sheets:

Labeled fields (Name: ___) → two-column markdown table:
| Field | Value |
|-------|-------|
| Name | |
| Date | |

Checkbox lists → markdown checklist:
- [ ] Option A
- [ ] Option B

Side-by-side form fields → column layout:
<dvrow>
<dvcol width="50">

| Field | Value |
|-------|-------|
| First Name | |

</dvcol>
<dvcol width="50">

| Field | Value |
|-------|-------|
| Last Name | |

</dvcol>
</dvrow>

## LAYOUT DIRECTIVES

### Multi-Column Layouts
2+ horizontal columns → <dvrow> and <dvcol>:
- 2 equal: width="50" each
- 3 equal: width="33" each
- 4 equal: width="25" each

<dvrow>
<dvcol width="50">
Left column
</dvcol>
<dvcol width="50">
Right column
</dvcol>
</dvrow>

### <dvrow> Attributes
- background="#hex" — row background color (ONLY if clearly colored in the original)
- color="#hex" — text color for the row
- padding="CSS" — inner padding (e.g., "6px 10px")
- border, border-top, border-bottom, border-left, border-right — CSS border (e.g., "1px solid #000000")

### <dvcol> Attributes
- width="N" — percentage width (required)
- color="#hex" — text color (ONLY use on rows with dark background, to make text white)
- border, border-top, border-bottom, border-left, border-right — CSS border (e.g., "1px solid #000000")
- valign="top|center|bottom" — vertical alignment

IMPORTANT: Do NOT add background colors unless the original clearly shows them. Do NOT invent colors. If a cell appears white or has no obvious fill color, do NOT add a background attribute.

### Statistics/KPIs
Large numbers with labels → <dvstat>:
<dvstat color="success">
$2.5M
Annual Revenue
</dvstat>
Colors: primary, success, warning, danger, info

### Callout Boxes
Boxed content with "Note:", "Warning:" → <dvcallout>:
<dvcallout type="warning" title="Important">
Content here
</dvcallout>
Types: info, warning, success, danger

### Cards
Boxed sections with titles → <dvcard>:
<dvcard title="Feature Name">
Card content
</dvcard>

### Timelines
Chronological events → <dvtimeline>/<dvevent>:
<dvtimeline>
<dvevent date="Q1 2025" title="Phase 1" color="primary">
Description
</dvevent>
</dvtimeline>

### Simple Tables
ONLY for tables where ALL cells are single-line AND there are NO colored headers:
| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |

For multi-line cells use <br>:
| Name | Address |
|------|---------|
| John | 123 Main St<br>New York |

## OUTPUT FORMAT

Output only the structured markdown. No commentary. Replicate the visual layout.

## IMPORTANT

- Preserve ALL text — never summarize or truncate
- NEVER use raw HTML (<b>, <i>, <u>) — use markdown **bold** and *italic*
- NEVER skip colored header rows — they MUST be <dvrow> with background
- ALWAYS use <br> for line breaks inside markdown table cells
- If layout unclear, default to simple markdown

If the page is blank, contains only a watermark, or has no readable text, respond ONLY with the word "EMPTY".`;

/**
 * Clean markdown extraction prompt (default).
 * Used for CloudFiles processing, PDFs, images, and all non-DOCX-import flows.
 */
const CLEAN_MARKDOWN_PROMPT = `You are a document text extraction assistant. Extract ALL content from this image as clean markdown.

## CRITICAL: NEVER USE CODE BLOCKS

NEVER use code blocks (\\\`\\\`\\\` or triple backticks) for document content. Code blocks are ONLY for actual programming code.
- Bullet lists with • or - symbols are NOT code - render as markdown lists using - or *
- Numbered lists are NOT code - render as 1. 2. 3.
- Legal text, terms, policies, and contracts are NOT code - render as regular paragraphs and lists
- Tables should use markdown table syntax with | pipes |, NOT code blocks
- Bold text in lists (like "**No Competitive Use:**") should use markdown bold, NOT code

## HEADINGS AND HIERARCHY

Standardize document headers into markdown header symbols:
- Main Title / Top-level Heading → # Header 1
- Section Headings (e.g., "Section 1.0", "Article I") → ## Header 2
- Sub-sections / Bold paragraph headers → ### Header 3
- NEVER use bold only (e.g., "**Section 1**") for standalone headers. ALWAYS prefix them with the appropriate number of '#' symbols to create a structured hierarchy.
- Standardize "CAPITALIZED HEADERS" into regular casing with markdown symbols (e.g., "ARTICLE 1" → "## Article 1").

## CONTENT EXTRACTION RULES (100% Verbatim)

1. Include ALL text exactly as it appears - no summarization
2. Preserve exact line breaks and paragraph spacing
3. Preserve indentation for nested content
4. Convert bullet symbols (•) to markdown list format (- or *)
5. Headers → Use strict markdown hierarchy (# ## ###)
6. Include footnotes, citations, and small print
7. Include text from charts, graphs, and data visualizations
8. Preserve tables using markdown table syntax
9. For multi-column layouts, extract content in logical reading order (left to right, top to bottom)

## Tables
Preserve tables using standard markdown table syntax:
| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |

CRITICAL TABLE RULE: Each table row MUST be a single line. Markdown tables break if a cell contains a newline character. If a cell needs multiple lines, use <br> tags to separate them.

CORRECT — multi-line cell with <br> (single line per row):
| Name | Address |
|------|---------|
| John Smith | 123 Main St<br>Suite 200<br>New York, NY 10001 |

WRONG — actual newlines break the table:
| Name | Address |
|------|---------|
| John Smith | 123 Main St
Suite 200
New York, NY 10001 |

## OUTPUT FORMAT

Output the extracted content as clean, standard markdown. Maintain the visual hierarchy using headers, lists, bold, and tables. Do NOT add commentary - only output the extracted content.

## IMPORTANT

- Preserve ALL text content - never summarize or truncate
- Use standard markdown only (headers, bold, italic, lists, tables, blockquotes)
- Do NOT use any custom HTML tags or XML-like tags EXCEPT <br> inside table cells for line breaks
- For statistics/KPIs, use bold text (e.g., **$2.5M** Annual Revenue)
- For callouts or notes, use blockquotes (> Note: ...)
- For multi-column content, extract each column's content sequentially
- ALWAYS use <br> for line breaks inside table cells — NEVER use actual newlines in table rows

If the page is blank, contains only a watermark, or has no readable text, respond ONLY with the word "EMPTY".`;

// Supported file types
const OFFICE_EXTENSIONS = [
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
];
const PDF_EXTENSION = "pdf";
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff"];
const TEXT_EXTENSIONS = ["txt", "csv"];

// =============================================================================
// TABULAR REVIEW — EXTRACTION CONFIG
// =============================================================================

/**
 * Tabular Review uses cheap text-only LLM calls (no Vision). The OpenAI API
 * key is held server-side; the browser NEVER calls OpenAI directly.
 *
 * @see docs/design/TABULAR_REVIEW.md
 */
const OpenAI = require("openai");
const {
  buildExtractionPrompt,
  buildColumnJsonSchema,
  coerceValue,
  SUPPORTED_COLUMN_TYPES,
} = require("./reviews/extractionPrompts.js");
const { runWithConcurrency } = require("./util/concurrency.js");

// CloudFiles RAG indexing + search (TypeSense). Lazy-required so module load
// order doesn't matter — both modules call admin.firestore() lazily inside
// their functions, after admin.initializeApp() has run above.
const {
  indexCloudFile,
  getDocTypesenseClient,
  getCollectionName,
} = require("./indexService.js");
const { buildAndStoreProfile } = require("./profile.js");
const { semanticSearch } = require("./searchService.js");
const ContextService = require("./reviews/contextService.js");
const { tryKeyFactsShortCircuit } = require("./reviews/shortCircuit.js");
const { extractCellLLM } = require("./reviews/extractionEngine.js");

const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL || "gpt-4o-mini";
const EXTRACTION_MAX_INPUT_CHARS = parseInt(
  process.env.EXTRACTION_MAX_INPUT_CHARS || "120000",
  10,
);
const EXTRACTION_BATCH_CONCURRENCY = parseInt(
  process.env.EXTRACTION_BATCH_CONCURRENCY || "10",
  10,
);

/**
 * Run extraction for a single (file, column) pair.
 * Reads extractedText from Firestore, calls OpenAI with structured output,
 * and writes the result back to {basePath}/reviews/{reviewId}/rows/{fileId}.
 *
 * Returns { ok: boolean, fileId, columnId, result?, error? }
 */
async function extractCell({
  reviewId,
  fileId,
  columnId,
  basePath,
  columnName,
  columnType,
  columnPrompt,
  columnOptions,
}) {
  try {
    // 1. Initial Validation
    const fileRef = db.doc(`${basePath}/files/${fileId}`);
    const fileDoc = await fileRef.get();

    if (!fileDoc.exists) {
      throw new Error(`File ${fileId} not found`);
    }

    const fileData = fileDoc.data();

    if (fileData.processingStatus !== "completed") {
      throw new Error(`File ${fileId} is not in completed status`);
    }

    const jsonSchema = buildColumnJsonSchema(columnType, columnOptions);

    let finalParsed = null;
    let finalJourney = [];
    let finalMetrics = null;

    // 2. Try KeyFacts Short-Circuit (Capability 4)
    const shortCircuitPayload = await tryKeyFactsShortCircuit({
      columnName,
      profileSummary: fileData.documentProfileSummary,
      fileId,
      basePath,
    });

    if (shortCircuitPayload) {
      finalParsed = shortCircuitPayload;
      finalJourney = [
        "[ShortCircuit] Answer derived from document profile keyFacts. RAG bypassed.",
      ];
      // finalMetrics can be left null or filled with a dummy to prevent errors
      finalMetrics = { strategy: "short_circuit" };
    } else {
      // 3. Multi-Pass Retrieval Logic (Capability 2)
      const attemptPasses = [
        { maxPages: 5, label: "Standard Retrieval" },
        { maxPages: 10, label: "Expanded Retrieval" },
      ];

      for (let pass of attemptPasses) {
        console.log(
          `[FileProcessor] ${pass.label} for ${fileId}/${columnName}`,
        );

        const contextResult = await ContextService.buildTargetedContext({
          fileId,
          basePath,
          query: columnPrompt,
          maxPages: pass.maxPages,
          shortDocThreshold: 15,
        });

        const extractedText = contextResult.text;
        finalMetrics = contextResult.metrics;

        if (!extractedText.trim()) {
          throw new Error(`File ${fileId} has no content pages`);
        }

        const prompt = buildExtractionPrompt(
          columnName,
          columnType,
          columnPrompt,
          extractedText,
          {
            maxInputChars: 500000, // Safe threshold for gpt-4o-mini
            columnOptions,
          },
        );

        // 3. Call LLM with targeted context
        const result = await extractCellLLM({
          prompt,
          jsonSchema,
          options: {
            provider: process.env.EXTRACTION_PROVIDER || "openai",
            model: EXTRACTION_MODEL,
          },
        });

        finalParsed = result.parsed;
        finalJourney = result.journey;

        // Stop if we have a confident answer or we're on the last pass
        if (
          (finalParsed.value !== null && finalParsed.confidence === "high") ||
          pass === attemptPasses[1]
        ) {
          break;
        }

        console.log(
          `[FileProcessor] Value null or confidence low. Expanding search...`,
        );
        finalJourney.push(
          `[Retrieval] Expanded to ${attemptPasses[1].maxPages} pages`,
        );
      }
    } // End of else block (RAG)

    // Observability Logging
    if (finalMetrics) {
      console.log(
        `[Retrieval Observability] File: ${fileId} | Column: ${columnName}`,
      );
      console.log(`  Strategy: ${finalMetrics.strategy}`);
      if (finalMetrics.strategy === "semantic_search") {
        console.log(`  Query: "${finalMetrics.query}"`);
        console.log(
          `  HyDE Used: ${finalMetrics.hydeUsed} | Tokens: ${finalMetrics.hydeTokens}`,
        );
        console.log(
          `  Pages Retrieved: [${finalMetrics.retrievedPages.join(", ")}] | Top Score: ${finalMetrics.topScore.toFixed(2)}`,
        );
        console.log(
          `  Expanded Pages Count (w/ neighbors): ${finalMetrics.expandedPagesCount}`,
        );
        console.log(
          `  Context Chars: ${finalMetrics.contextChars} | Search Time: ${finalMetrics.searchTimeMs}ms`,
        );
      }
      console.log(`  Extraction Confidence: ${finalParsed.confidence}`);
    }

    const coerced = {
      ...finalParsed,
      value: coerceValue(finalParsed.value, columnType, columnOptions),
    };

    // 4. Write result to Firestore
    const rowRef = db.doc(`${basePath}/reviews/${reviewId}/rows/${fileId}`);
    const rowDoc = await rowRef.get();
    const existingCells = rowDoc.exists ? rowDoc.data().cells || {} : {};
    const existingCell = existingCells[columnId] || {};

    const cellPayload = {
      ...existingCell,
      value: coerced.value,
      confidence: coerced.confidence,
      quote: coerced.quote,
      page: coerced.page,
      reasoning: coerced.reasoning,
      provenance: coerced.provenance || "llm",
      status: "completed",
      error: null,
      extractedAt: admin.firestore.FieldValue.serverTimestamp(),
      // Reset edited/verified flags on fresh extraction
      editedValue: null,
      editedAt: null,
      editedBy: null,
      verifiedAt: null,
      verifiedBy: null,
    };

    await rowRef.set(
      {
        fileId,
        fileName: fileData.name || null,
        fileExtension: fileData.extension || null,
        cells: { [columnId]: cellPayload },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Increment completedCells on the review
    const reviewRef = db.doc(`${basePath}/reviews/${reviewId}`);
    await reviewRef
      .update({
        completedCells: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch((err) => {
        // Non-fatal — the review document might not have a completedCells field yet
        console.warn(
          `[FileProcessor] Failed to increment completedCells:`,
          err.message,
        );
      });

    return { ok: true, fileId, columnId, result: cellPayload };
  } catch (err) {
    console.error(
      `[FileProcessor] extractCell failed for ${fileId}/${columnId}:`,
      err,
    );

    // Write error to Firestore so the UI sees it
    try {
      const rowRef = db.doc(`${basePath}/reviews/${reviewId}/rows/${fileId}`);
      const rowDoc = await rowRef.get();
      const existingCells = rowDoc.exists ? rowDoc.data().cells || {} : {};
      const existingCell = existingCells[columnId] || {};

      await rowRef.set(
        {
          fileId,
          cells: {
            [columnId]: {
              ...existingCell,
              status: "error",
              error: err.message,
            },
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      const reviewRef = db.doc(`${basePath}/reviews/${reviewId}`);
      await reviewRef
        .update({
          errorCells: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        })
        .catch(() => {});
    } catch (writeErr) {
      console.error(
        "[FileProcessor] Failed to write error state to Firestore:",
        writeErr,
      );
    }

    return { ok: false, fileId, columnId, error: err.message };
  }
}

// runWithConcurrency is imported from ./util/concurrency.js

// Express app
const app = express();
app.use(express.json({ limit: "10mb" }));

// Dev mode: allow direct browser calls (CORS + relaxed auth)
// Set DEV_MODE=true when running locally or for contractor dev environments
const DEV_MODE = process.env.DEV_MODE === "true";

if (DEV_MODE) {
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, X-API-Key, Authorization",
    );
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, X-API-Key, Authorization, x-base-path",
    );
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  console.log("[FileProcessor] DEV_MODE enabled — CORS open, auth relaxed");
}

// Health check endpoint (no auth required)
app.get("/health", (req, res) => {
  res
    .status(200)
    .json({
      status: "healthy",
      devMode: DEV_MODE,
      timestamp: new Date().toISOString(),
    });
});

// =============================================================================
// AGENTIC DD REST API (V1)
// =============================================================================
const apiRouter = require("./api");
const mcpRouter = require("./api/mcp");
app.use("/api/v1", apiRouter);
app.use("/api/v1", mcpRouter);

// =============================================================================
// INTERNAL WORKER ENDPOINTS
// =============================================================================
const { handleReviewTask } = require("./workers/reviewTaskWorker");
app.post("/api/v1/internal/worker/reviewTask", handleReviewTask);

// =============================================================================
// CLOUDFILES RAG SEARCH
// Frontend calls this directly. Auth is a Firebase ID token (Bearer header) —
// not the X-API-KEY shared secret used by Cloud Tasks / api-proxy. Mounted
// BEFORE the global API-key middleware so it can do its own auth.
// @see docs/design/CONTENT_SEARCH.md
// =============================================================================
app.post("/search", async (req, res) => {
  // 1. Verify Firebase ID token from Authorization: Bearer header.
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res
      .status(401)
      .json({ error: "Authorization: Bearer <Firebase ID token> required" });
  }
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: `Invalid ID token: ${e.message}` });
  }

  const { query, basePath } = req.body || {};
  if (!query || typeof query !== "string" || query.trim().length < 2) {
    return res
      .status(400)
      .json({ error: "query is required (min 2 characters)" });
  }
  if (!basePath || typeof basePath !== "string") {
    return res.status(400).json({ error: "basePath is required" });
  }

  // 2. Tenant access check — mirrors firestore.rules and the
  // searchCloudFiles Cloud Function.
  if (basePath.startsWith("users/")) {
    if (basePath !== `users/${uid}`) {
      return res.status(403).json({ error: "Cross-user search not allowed" });
    }
  } else if (basePath.startsWith("workspaces/")) {
    const wsId = basePath.split("/")[1];
    if (!wsId) {
      return res.status(400).json({ error: "Invalid basePath" });
    }
    const memberSnap = await db.doc(`workspaces/${wsId}/members/${uid}`).get();
    if (!memberSnap.exists) {
      return res.status(403).json({ error: "Not a workspace member" });
    }
  } else {
    return res
      .status(400)
      .json({ error: "basePath must start with users/ or workspaces/" });
  }

  // 3. Run semantic search with analytics.
  try {
    const queryId = crypto.randomUUID();

    // Fire-and-forget analytics: read workspace redactQueries flag then log.
    (async () => {
      try {
        let redactQueries = false;
        if (basePath.startsWith("workspaces/")) {
          const wsId = basePath.split("/")[1];
          const wsSnap = await db.doc(`workspaces/${wsId}`).get();
          redactQueries = !!(wsSnap.exists && wsSnap.data().redactQueries);
        }
        const yyyymm = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
        const analyticsPayload = {
          uid,
          basePath,
          mode: req.body && req.body.hybrid === false ? "semantic" : "hybrid",
          ts: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (redactQueries) {
          analyticsPayload.query_length = query.trim().length;
          analyticsPayload.query_has_digits = /\d/.test(query);
        } else {
          analyticsPayload.query = query.trim();
        }
        await db
          .doc(`usage/search/months/${yyyymm}/queries/${queryId}`)
          .set(analyticsPayload);
      } catch (analyticsErr) {
        console.warn(
          "[FileProcessor] /search analytics write failed:",
          analyticsErr.message,
        );
      }
    })();

    const result = await semanticSearch({
      ...req.body,
      query: query.trim(),
      uid,
    });
    return res.json({ ...result, query_id: queryId });
  } catch (e) {
    console.error("[FileProcessor] /search failed:", e);
    if (e.status === 400) return res.status(400).json({ error: e.message });
    return res.status(500).json({ error: `Search failed: ${e.message}` });
  }
});

// =============================================================================
// SEARCH CLICK TRACKING
// Records when a reviewer opens a search result. Links back to the query via
// query_id so operators can correlate searches with document opens.
// =============================================================================
app.post("/search/click", async (req, res) => {
  // 1. Verify Firebase ID token.
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res
      .status(401)
      .json({ error: "Authorization: Bearer <Firebase ID token> required" });
  }
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: `Invalid ID token: ${e.message}` });
  }

  const { query_id, file_id, chunk_index, rank, basePath } = req.body || {};
  if (!query_id || typeof query_id !== "string") {
    return res.status(400).json({ error: "query_id is required" });
  }
  if (!file_id || typeof file_id !== "string") {
    return res.status(400).json({ error: "file_id is required" });
  }
  if (typeof chunk_index !== "number") {
    return res.status(400).json({ error: "chunk_index (number) is required" });
  }
  if (typeof rank !== "number") {
    return res.status(400).json({ error: "rank (number) is required" });
  }
  if (!basePath || typeof basePath !== "string") {
    return res.status(400).json({ error: "basePath is required" });
  }

  // 2. Tenant access check.
  if (basePath.startsWith("users/")) {
    if (basePath !== `users/${uid}`) {
      return res.status(403).json({ error: "Cross-user access not allowed" });
    }
  } else if (basePath.startsWith("workspaces/")) {
    const wsId = basePath.split("/")[1];
    const memberSnap = await db.doc(`workspaces/${wsId}/members/${uid}`).get();
    if (!memberSnap.exists) {
      return res.status(403).json({ error: "Not a workspace member" });
    }
  } else {
    return res
      .status(400)
      .json({ error: "basePath must start with users/ or workspaces/" });
  }

  // 3. Write click event fire-and-forget.
  try {
    const yyyymm = new Date().toISOString().slice(0, 7);
    await db.collection(`usage/search/months/${yyyymm}/clicks`).add({
      query_id,
      uid,
      basePath,
      file_id,
      chunk_index,
      rank,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[FileProcessor] /search/click failed:", e);
    return res
      .status(500)
      .json({ error: `Click tracking failed: ${e.message}` });
  }
});

// =============================================================================
// RETRIEVE NEIGHBORING CHUNKS OR FULL PAGES FOR CONTEXT
// Frontend calls this to expand search results or show page context.
// Auth is verified via Firebase Bearer token.
// =============================================================================
app.post("/retrieve", async (req, res) => {
  // 1. Verify Firebase ID token from Authorization: Bearer header.
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res
      .status(401)
      .json({ error: "Authorization: Bearer <Firebase ID token> required" });
  }
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: `Invalid ID token: ${e.message}` });
  }

  const { file_id, chunk_index, basePath, mode = "neighbors" } = req.body || {};
  if (!file_id || typeof file_id !== "string") {
    return res.status(400).json({ error: "file_id is required" });
  }
  if (!basePath || typeof basePath !== "string") {
    return res.status(400).json({ error: "basePath is required" });
  }

  // 2. Tenant access check
  if (basePath.startsWith("users/")) {
    if (basePath !== `users/${uid}`) {
      return res.status(403).json({ error: "Cross-user access not allowed" });
    }
  } else if (basePath.startsWith("workspaces/")) {
    const wsId = basePath.split("/")[1];
    if (!wsId) {
      return res.status(400).json({ error: "Invalid basePath" });
    }
    const memberSnap = await db.doc(`workspaces/${wsId}/members/${uid}`).get();
    if (!memberSnap.exists) {
      return res.status(403).json({ error: "Not a workspace member" });
    }
  } else {
    return res
      .status(400)
      .json({ error: "basePath must start with users/ or workspaces/" });
  }

  try {
    const typesenseClient = getDocTypesenseClient();
    if (!typesenseClient) {
      return res
        .status(500)
        .json({ error: "TypeSense client not initialized" });
    }

    const collectionName = getCollectionName(basePath);

    if (mode === "neighbors") {
      if (typeof chunk_index !== "number" || chunk_index < 0) {
        return res
          .status(400)
          .json({
            error: "chunk_index (number >= 0) is required for neighbors mode",
          });
      }

      // Fetch chunks index - 1, index, index + 1
      const filterBy = `source_type:=cloudfile && cloudfile_id:=${file_id} && chunk_index:[${chunk_index - 1},${chunk_index},${chunk_index + 1}]`;
      const searchResult = await typesenseClient
        .collections(collectionName)
        .documents()
        .search({
          q: "*",
          filter_by: filterBy,
          per_page: 3,
          sort_by: "chunk_index:asc",
          include_fields: "chunk_index,text,page_number,page_span_json",
        });

      const hits = (searchResult.hits || []).map((h) => {
        const doc = h.document || {};
        let span = [doc.page_number || 1, doc.page_number || 1];
        if (doc.page_span_json) {
          try {
            span = JSON.parse(doc.page_span_json);
          } catch {}
        }
        return {
          chunk_index: doc.chunk_index,
          text: doc.text,
          page_number: span[0],
          page_span: span,
        };
      });

      return res.json({
        file_id,
        mode: "neighbors",
        chunks: hits,
      });
    } else if (mode === "full_page") {
      // Fetch full-page text from Firestore pages subcollection
      const pageSnap = await db
        .collection(`${basePath}/files/${file_id}/pages`)
        .get();
      const pages = [];
      pageSnap.forEach((doc) => {
        const data = doc.data();
        const pageNum = parseInt(doc.id, 10);
        if (Number.isFinite(pageNum)) {
          pages.push({
            page_number: pageNum,
            text: data.markdown_text || data.markdown || "",
          });
        }
      });

      // Sort by page number ascending
      pages.sort((a, b) => a.page_number - b.page_number);

      return res.json({
        file_id,
        mode: "full_page",
        pages,
      });
    } else {
      return res
        .status(400)
        .json({
          error: `Unsupported mode "${mode}". Supported: neighbors, full_page`,
        });
    }
  } catch (e) {
    console.error("[FileProcessor] /retrieve failed:", e);
    return res.status(500).json({ error: `Retrieval failed: ${e.message}` });
  }
});

// API key authentication middleware
// Three authorized callers:
// 1. API proxy backend → sends X-API-KEY header (for /process-sync)
// 2. Cloud Tasks → sends X-CloudTasks-QueueName header (for /process)
//    Cloud Run strips X-CloudTasks-* headers from external requests,
//    so these headers can only be present on legitimate Cloud Tasks invocations.
// 3. Dev mode → all requests accepted (for local development)
const FILE_PROCESSOR_API_KEY = process.env.FILE_PROCESSOR_API_KEY;

app.use((req, res, next) => {
  // Health check is handled above this middleware (no auth needed)

  // Path 0: Dev mode — skip auth entirely (local development only)
  if (DEV_MODE) {
    return next();
  }

  // Path 1: Cloud Tasks — trusted header injected by Google, stripped from external requests
  const cloudTasksQueue = req.headers["x-cloudtasks-queuename"];
  if (cloudTasksQueue) {
    return next();
  }

  // Path 2: API proxy — shared secret
  if (!FILE_PROCESSOR_API_KEY) {
    console.error(
      "[FileProcessor] FILE_PROCESSOR_API_KEY env var is not set — rejecting non-Cloud-Tasks requests",
    );
    return res.status(500).json({ error: "Service misconfigured" });
  }

  const apiKey = req.headers["x-api-key"];
  if (apiKey !== FILE_PROCESSOR_API_KEY) {
    console.warn(
      `[FileProcessor] Unauthorized request to ${req.method} ${req.path} from ${req.ip}`,
    );
    return res
      .status(401)
      .json({ error: "Unauthorized: Invalid or missing API key" });
  }

  next();
});

/**
 * Main processing endpoint
 * Called by Cloud Tasks when a file needs processing
 *
 * Idempotency: This endpoint can be safely retried.
 * - If file is already completed/processing, we skip
 * - Cloud Tasks will retry on 5xx errors
 * - 2xx response = task completed successfully
 * - 4xx response = permanent failure (no retry)
 */
app.post("/process", async (req, res) => {
  console.log("pdfPassword", req.body.pdfPassword);
  const startTime = Date.now();
  const {
    fileId,
    basePath,
    storagePath,
    fileName,
    extension,
    pdfPassword: password,
  } = req.body;

  if (!fileId || !basePath || !storagePath) {
    // 400 = permanent failure, don't retry
    return res
      .status(400)
      .json({
        error: "Missing required fields: fileId, basePath, storagePath",
      });
  }

  console.log(
    `[FileProcessor] Starting processing for ${fileId} (${fileName})`,
  );

  // IDEMPOTENCY CHECK: Skip if already processed or currently processing
  const fileRef = db.doc(`${basePath}/files/${fileId}`);
  const fileDoc = await fileRef.get();

  if (!fileDoc.exists) {
    // File was deleted, return 200 to complete the task
    console.log(`[FileProcessor] File ${fileId} no longer exists, skipping`);
    return res.status(200).json({ skipped: true, reason: "file_deleted" });
  }

  const currentStatus = fileDoc.data()?.processingStatus;

  if (currentStatus === "completed") {
    // Already processed, return 200 to complete the task
    console.log(`[FileProcessor] File ${fileId} already completed, skipping`);
    return res.status(200).json({ skipped: true, reason: "already_completed" });
  }

  if (currentStatus === "processing") {
    // Check if it's been stuck in processing for too long (> 10 minutes)
    const updatedAt = fileDoc.data()?.updatedAt?.toDate();
    const stuckThreshold = 10 * 60 * 1000; // 10 minutes

    if (updatedAt && Date.now() - updatedAt.getTime() < stuckThreshold) {
      // Recently updated, another instance is likely processing
      console.log(
        `[FileProcessor] File ${fileId} is being processed by another instance, skipping`,
      );
      return res
        .status(200)
        .json({ skipped: true, reason: "already_processing" });
    }
    // Otherwise, it's stuck - continue to reprocess
    console.log(
      `[FileProcessor] File ${fileId} was stuck in processing, reprocessing`,
    );
  }

  try {
    console.log("password", password);
    // Use shared processing logic
    const result = await processFileCore({
      fileId,
      basePath,
      storagePath,
      fileName,
      extension,
      password,
    });

    const duration = Date.now() - startTime;
    console.log(
      `[FileProcessor] Completed processing ${fileId} in ${duration}ms`,
    );

    res.json({
      success: true,
      fileId,
      duration,
      result,
    });
  } catch (error) {
    console.error(`[FileProcessor] Error processing ${fileId}:`, error);
    // Note: processFileCore already updated status to 'error' or 'unsupported'
    res.status(500).json({ error: error.message });
  }
});

/**
 * Synchronous processing endpoint for user-initiated imports
 * Bypasses the Cloud Tasks queue for immediate processing
 *
 * Use this endpoint when:
 * - User is actively waiting for the result (e.g., DOCX import)
 * - You need the processing results immediately
 *
 * Returns the full processing result including markdownPages
 */
app.post("/process-sync", async (req, res) => {
  const startTime = Date.now();
  const {
    fileId,
    basePath,
    storagePath,
    fileName,
    extension,
    extractionMode,
    pdfPassword: password,
  } = req.body;

  if (!fileId || !basePath || !storagePath) {
    return res
      .status(400)
      .json({
        error: "Missing required fields: fileId, basePath, storagePath",
      });
  }

  console.log(
    `[FileProcessor] Sync processing for ${fileId} (${fileName}), extractionMode: ${extractionMode || "clean"}`,
  );

  try {
    // Use shared processing logic — extractionMode is only passed from /process-sync (DOCX import)
    const result = await processFileCore({
      fileId,
      basePath,
      storagePath,
      fileName,
      extension,
      extractionMode,
      password,
    });

    const duration = Date.now() - startTime;
    console.log(
      `[FileProcessor] Sync processing completed ${fileId} in ${duration}ms`,
    );

    // Return full result for immediate use
    res.json({
      success: true,
      fileId,
      duration,
      pageCount: result.pageCount || 0,
      markdownPages: result.markdownPages || {},
      extractedText: result.extractedText || "",
      thumbnailUrl: result.thumbnailUrl || null,
      pageUrls: result.pageUrls || {},
    });
  } catch (error) {
    console.error(`[FileProcessor] Sync processing error ${fileId}:`, error);
    // Note: processFileCore already updated status to 'error'
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// =============================================================================
// PREVIEW GENERATION
// Generates a PDF preview for Office documents dynamically
// =============================================================================
app.post("/api/files/preview", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res
      .status(401)
      .json({ error: "Authorization: Bearer <Firebase ID token> required" });
  }
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: `Invalid ID token: ${e.message}` });
  }

  const { storagePath, pdfPassword, password } = req.body || {};
  if (!storagePath) {
    return res.status(400).json({ error: "storagePath is required" });
  }
  const previewPassword = pdfPassword || password || null;

  const basePath = req.headers["x-base-path"];
  // 2. Tenant access check
  if (basePath) {
    if (basePath.startsWith("users/") && basePath !== `users/${uid}`) {
      return res.status(403).json({ error: "Cross-user access not allowed" });
    } else if (basePath.startsWith("workspaces/")) {
      const wsId = basePath.split("/")[1];
      const memberSnap = await db
        .doc(`workspaces/${wsId}/members/${uid}`)
        .get();
      if (!memberSnap.exists) {
        return res.status(403).json({ error: "Not a workspace member" });
      }
    }
  }

  let jobDir;
  try {
    // Create temp dir manually using uuid
    const jobId = uuidv4();
    jobDir = path.join(TEMP_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const extension = path.extname(storagePath).toLowerCase() || ".docx";
    const localFilePath = path.join(jobDir, `downloaded${extension}`);

    // Download original file
    console.log(`[FileProcessor] Downloading ${storagePath} for preview...`);
    await bucket.file(storagePath).download({ destination: localFilePath });

    let activeFilePath = localFilePath;
    if (previewPassword) {
      try {
        const decryptedPath = path.join(jobDir, `decrypted${extension}`);
        await decryptOfficeDocument(localFilePath, decryptedPath, previewPassword);
        activeFilePath = decryptedPath;
      } catch (decryptErr) {
        console.warn(
          "[FileProcessor] Preview decryption failed:",
          decryptErr.message,
        );
      }
    }

    // Convert to PDF using LibreOffice
    console.log(`[FileProcessor] Converting to PDF for preview...`);
    const pdfPath = await convertToPdfWithLibreOffice(activeFilePath, jobDir);

    // Read PDF and stream back
    const pdfBuffer = await fs.readFile(pdfPath);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="preview.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error("[FileProcessor] Preview generation failed:", err);
    if (err.message === "PASSWORD_PROTECTED") {
      return res.status(423).json({
        error: "PASSWORD_PROTECTED",
        message: "This document is password protected.",
      });
    }
    res
      .status(500)
      .json({ error: `Failed to generate preview: ${err.message}` });
  } finally {
    if (jobDir) {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {}); // Cleanup temp files
    }
  }
});

// =============================================================================
// TABULAR REVIEW — EXTRACTION ENDPOINTS
// =============================================================================

/**
 * Validate the column type + classification options on an incoming task. Returns
 * an error string on failure, null on success.
 */
function validateExtractionTaskShape(task) {
  if (
    !task.fileId ||
    !task.columnId ||
    !task.columnName ||
    !task.columnType ||
    !task.columnPrompt
  ) {
    return "Each task must have fileId, columnId, columnName, columnType, columnPrompt";
  }
  if (!SUPPORTED_COLUMN_TYPES.includes(task.columnType)) {
    return `Unsupported columnType "${task.columnType}". Allowed: ${SUPPORTED_COLUMN_TYPES.join(", ")}`;
  }
  if (task.columnType === "classification") {
    const values = task.columnOptions?.values;
    if (!Array.isArray(values) || values.length === 0) {
      return "classification columns require columnOptions.values (non-empty array)";
    }
    for (const v of values) {
      if (!v || typeof v.value !== "string" || !v.value.trim()) {
        return "classification columnOptions.values entries need a non-empty string `value`";
      }
    }
  }
  if (task.columnType === "currency") {
    const code = task.columnOptions?.currencyCode;
    if (
      code !== undefined &&
      code !== null &&
      !/^[A-Z]{3}$/.test(String(code))
    ) {
      return "currency columnOptions.currencyCode must be a 3-letter ISO code (e.g., USD)";
    }
  }
  return null;
}

/**
 * Extract data for a single (file, column) pair.
 * Reads extractedText from Firestore, calls OpenAI with structured output,
 * writes result to {basePath}/reviews/{reviewId}/rows/{fileId}.
 *
 * Body: {
 *   reviewId, fileId, columnId, basePath,
 *   columnName, columnType, columnPrompt,
 *   columnOptions?  // required for classification / used for currency
 * }
 *
 * The browser NEVER calls OpenAI directly — the API key is held server-side.
 */
app.post("/extract", async (req, res) => {
  const {
    reviewId,
    fileId,
    columnId,
    basePath,
    columnName,
    columnType,
    columnPrompt,
    columnOptions,
  } = req.body;

  if (!reviewId || !fileId || !columnId || !basePath) {
    return res.status(400).json({
      error: "Missing required fields: reviewId, fileId, columnId, basePath",
    });
  }

  const taskErr = validateExtractionTaskShape({
    fileId,
    columnId,
    columnName,
    columnType,
    columnPrompt,
    columnOptions,
  });
  if (taskErr) {
    return res.status(400).json({ error: taskErr });
  }

  console.log(
    `[FileProcessor] /extract ${reviewId}/${fileId}/${columnId} (${columnName} :: ${columnType})`,
  );

  const result = await extractCell({
    reviewId,
    fileId,
    columnId,
    basePath,
    columnName,
    columnType,
    columnPrompt,
    columnOptions,
  });

  if (result.ok) {
    res.json({ success: true, fileId, columnId, result: result.result });
  } else {
    // The cell error has already been persisted to Firestore.
    res
      .status(500)
      .json({ success: false, fileId, columnId, error: result.error });
  }
});

/**
 * Run a batch of extractions with bounded concurrency.
 *
 * Body: {
 *   reviewId: string,
 *   basePath: string,
 *   tasks: [{ fileId, columnId, columnName, columnType, columnPrompt, columnOptions? }, ...]
 * }
 *
 * Each task fails or succeeds independently — one bad cell never blocks the rest.
 */
app.post("/extract-batch", async (req, res) => {
  const { reviewId, basePath, tasks } = req.body;

  if (!reviewId || !basePath || !Array.isArray(tasks) || tasks.length === 0) {
    return res
      .status(400)
      .json({
        error:
          "Missing required fields: reviewId, basePath, tasks (non-empty array)",
      });
  }

  console.log(
    `[FileProcessor] /extract-batch ${reviewId}: ${tasks.length} tasks`,
  );

  // Validate each task — reject the whole batch on bad input so the client
  // gets a single clear error rather than per-cell failures everywhere.
  for (const t of tasks) {
    const err = validateExtractionTaskShape(t);
    if (err) {
      return res.status(400).json({ error: err });
    }
  }

  const startedAt = Date.now();

  const results = await runWithConcurrency(
    tasks,
    EXTRACTION_BATCH_CONCURRENCY,
    async (task) => await extractCell({ reviewId, basePath, ...task }),
  );

  const completed = results.filter((r) => r.ok).length;
  const errors = results.filter((r) => !r.ok).length;
  const duration = Date.now() - startedAt;

  console.log(
    `[FileProcessor] /extract-batch ${reviewId}: completed=${completed} errors=${errors} duration=${duration}ms`,
  );

  res.json({
    success: true,
    completed,
    errors,
    total: tasks.length,
    duration,
    results: results.map((r) => ({
      fileId: r.fileId,
      columnId: r.columnId,
      ok: r.ok,
      error: r.error || null,
    })),
  });
});

/**
 * Suggest an extraction prompt for a given column name.
 * Helps users who aren't sure what prompt to write — the LLM proposes one.
 *
 * Body: { columnName: string, columnType?: string }
 * Response: { prompt: string }
 */
app.post("/extract/suggest-prompt", async (req, res) => {
  const { columnName, columnType } = req.body || {};
  if (!columnName || typeof columnName !== "string") {
    return res.status(400).json({ error: "columnName is required" });
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const sysMsg = `You write concise extraction prompts for a document review tool. The user provides a column name (and optional data type). Respond with ONE sentence telling an LLM exactly what to extract from a contract or financial document. No commentary, no quotes around the response — just the instruction sentence. Be specific and unambiguous.`;
    const userMsg = `Column name: ${columnName}\nData type: ${columnType || "text"}`;

    const response = await openai.chat.completions.create({
      model: EXTRACTION_MODEL,
      messages: [
        { role: "system", content: sysMsg },
        { role: "user", content: userMsg },
      ],
      temperature: 0.3,
      max_tokens: 120,
    });

    const prompt = (response.choices[0]?.message?.content || "").trim();
    if (!prompt) {
      return res.status(502).json({ error: "Empty response from OpenAI" });
    }
    res.json({ prompt });
  } catch (err) {
    console.error("[FileProcessor] /extract/suggest-prompt failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Core file processing logic - shared by /process and /process-sync
 *
 * @param {Object} params - Processing parameters
 * @param {string} params.fileId - Firestore file ID
 * @param {string} params.basePath - Firestore base path
 * @param {string} params.storagePath - Firebase Storage path
 * @param {string} params.fileName - Original file name
 * @param {string} params.extension - File extension
 * @param {string} [params.extractionMode='clean'] - 'clean' or 'layout-aware'
 * @param {string} [params.password] - PDF decryption password
 * @returns {Promise<Object>} Processing result
 */

/**
 * Resolve the human-readable folder path for a file (e.g.,
 * "Customer Contracts / Acme") by walking the file_folders collection from
 * the file's folderId up to the root. Returns null for files at the root.
 * Best-effort — broken parent chains terminate the walk and return what's
 * been collected so far. Used to give the profile builder context about
 * where a document lives.
 *
 * @param {string} basePath
 * @param {string|null} folderId
 * @returns {Promise<string|null>}
 */
async function resolveFolderPath(basePath, folderId) {
  if (!folderId) return null;
  const parts = [];
  let current = folderId;
  let safety = 0;
  while (current && safety < 50) {
    const snap = await db.doc(`${basePath}/file_folders/${current}`).get();
    if (!snap.exists) break;
    const data = snap.data() || {};
    if (data.name) parts.unshift(data.name);
    current = data.parentId || null;
    safety++;
  }
  return parts.length ? parts.join(" / ") : null;
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      resolve();
    } else {
      this.count--;
    }
  }
}
const globalFileProcessSemaphore = new Semaphore(1);

async function processFileCore(args) {
  await globalFileProcessSemaphore.acquire();
  try {
    return await _processFileCore(args);
  } finally {
    globalFileProcessSemaphore.release();
  }
}

async function _processFileCore({
  fileId,
  basePath,
  storagePath,
  fileName,
  extension,
  extractionMode = "clean",
  password,
}) {
  // Create unique temp directory for this job
  const jobDir = path.join(TEMP_DIR, uuidv4());
  await fs.mkdir(jobDir, { recursive: true });

  try {
    // Update status to processing
    await updateStatus(basePath, fileId, "processing");

    // Download file from Storage
    const localFilePath = path.join(jobDir, fileName);
    await downloadFile(storagePath, localFilePath);
    console.log(`[FileProcessor] Downloaded file to ${localFilePath}`);

    let result;
    const ext = (extension || "").toLowerCase();

    if (IMAGE_EXTENSIONS.includes(ext)) {
      result = await processImage(localFilePath, fileId, basePath, jobDir);
    } else if (TEXT_EXTENSIONS.includes(ext)) {
      result = await processTextFile(localFilePath, fileId, basePath, jobDir);
    } else if (ext === PDF_EXTENSION) {
      result = await processPdf(
        localFilePath,
        fileId,
        basePath,
        jobDir,
        extractionMode,
        password,
      );
    } else if (OFFICE_EXTENSIONS.includes(ext)) {
      result = await processOfficeDocument(
        localFilePath,
        fileId,
        basePath,
        jobDir,
        extractionMode,
        password,
      );
    } else {
      await updateStatus(
        basePath,
        fileId,
        "unsupported",
        null,
        `File type .${ext} is not supported`,
      );
      throw new Error(`File type .${ext} is not supported for processing`);
    }

    // Update status to completed
    await updateStatus(basePath, fileId, "completed", result);

    // Fetch the freshly-updated doc to get markdownPages
    let updatedFileData = null;
    try {
      const updatedDoc = await db.doc(`${basePath}/files/${fileId}`).get();
      if (updatedDoc.exists) {
        updatedFileData = updatedDoc.data();
      }
    } catch (fetchErr) {
      console.warn(
        `[FileProcessor] Failed to fetch completed file doc ${fileId}:`,
        fetchErr.message,
      );
    }

    // 1. Build the document profile FIRST (TOC + summary + keyFacts + source pointers).
    // This generates documentProfileSummary so chunk indexing can denormalize it.
    if (updatedFileData?.markdownPages) {
      try {
        const folderPath = await resolveFolderPath(
          basePath,
          updatedFileData.folderId || null,
        );
        const profileResult = await buildAndStoreProfile({
          basePath,
          fileId,
          fileName: updatedFileData.name || fileId,
          folderPath,
          markdownPages: updatedFileData.markdownPages,
          contentHash: updatedFileData.fileContentHash || null,
        });
        if (!profileResult.ok) {
          console.warn(
            `[FileProcessor] Profile build failed for ${fileId} (non-fatal): ${profileResult.error}`,
          );
        } else {
          // Re-fetch file data to capture the newly added documentProfileSummary
          const reDoc = await db.doc(`${basePath}/files/${fileId}`).get();
          if (reDoc.exists) {
            updatedFileData = reDoc.data();
          }
        }
      } catch (profileErr) {
        console.warn(
          `[FileProcessor] Profile build threw for ${fileId} (non-fatal):`,
          profileErr.message,
        );
      }
    }

    // 2. Index for content search (TypeSense) SECOND.
    // Now it will successfully capture and denormalize documentProfileSummary onto chunks!
    if (updatedFileData) {
      try {
        const r = await indexCloudFile(fileId, basePath, updatedFileData);
        console.log(`[FileProcessor] Indexed ${fileId}: ${JSON.stringify(r)}`);
      } catch (indexErr) {
        console.warn(
          `[FileProcessor] Indexing failed for ${fileId} (non-fatal):`,
          indexErr.message,
        );
      }
    }

    return result;
  } catch (error) {
    // Update status to error (unless it's already set to unsupported)
    const fileRef = db.doc(`${basePath}/files/${fileId}`);
    const fileDoc = await fileRef.get();
    if (fileDoc.exists && fileDoc.data()?.processingStatus !== "unsupported") {
      await updateStatus(basePath, fileId, "error", null, error.message);
    }
    throw error;
  } finally {
    // Cleanup temp directory
    try {
      await fs.rm(jobDir, { recursive: true, force: true });
    } catch (e) {
      console.warn("[FileProcessor] Failed to cleanup temp directory:", e);
    }
  }
}

/**
 * Download file from Firebase Storage
 */
async function downloadFile(storagePath, localPath) {
  const file = bucket.file(storagePath);
  await file.download({ destination: localPath });
}

/**
 * Upload file to Firebase Storage and return URL
 *
 * Uses public URLs instead of signed URLs. Signed URLs break when the
 * GCE default service account's system-managed keys are auto-rotated
 * by Google (~every 2 weeks), causing SignatureDoesNotMatch errors.
 * Public URLs are stable and match the pdf2pngmarkdown service approach.
 */
async function uploadFile(localPath, storagePath, retries = 3) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      await bucket.upload(localPath, {
        destination: storagePath,
        metadata: {
          cacheControl: "public, max-age=31536000",
        },
        predefinedAcl: "publicRead",
      });
      return `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
    } catch (err) {
      lastError = err;
      const isRetryable =
        err.message.includes("Retry limit exceeded") ||
        err.message.includes("timeout") ||
        err.code === 429 ||
        err.code >= 500;

      if (!isRetryable || i === retries - 1) throw err;

      const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
      console.warn(
        `[FileProcessor] Upload failed for ${storagePath}, retrying in ${Math.round(delay)}ms... (${i + 1}/${retries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Update file processing status in Firestore
 *
 * Now stores per-page data like pdf2pngmarkdown attachments:
 * - pageUrls: { "1": "https://...", "2": "https://...", ... }
 * - markdownPages: { "1": "# Page 1 content...", "2": "# Page 2...", ... }
 * - extractedText: Combined markdown from all pages
 */
async function updateStatus(
  basePath,
  fileId,
  status,
  result = null,
  errorMessage = null,
) {
  const fileRef = db.doc(`${basePath}/files/${fileId}`);

  const updateData = {
    processingStatus: status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (status === "processing") {
    updateData.processingStartedAt =
      admin.firestore.FieldValue.serverTimestamp();
  }

  if (status === "completed") {
    updateData.processingCompletedAt =
      admin.firestore.FieldValue.serverTimestamp();
  }

  if (result) {
    if (result.thumbnailUrl) updateData.thumbnailUrl = result.thumbnailUrl;
    if (result.extractedText) updateData.extractedText = result.extractedText;
    if (result.pageCount) updateData.pageCount = result.pageCount;
    // Per-page data (matching attachment structure)
    if (result.pageUrls) updateData.pageUrls = result.pageUrls;
    if (result.markdownPages) updateData.markdownPages = result.markdownPages;
    // Truncation metadata
    if (result.processedPageCount !== undefined)
      updateData.processedPageCount = result.processedPageCount;
    if (result.wasTruncated !== undefined)
      updateData.wasTruncated = result.wasTruncated;
    // Cost Tracking
    if (result.totalProcessingCost !== undefined)
      updateData.totalProcessingCost = result.totalProcessingCost;
    // Math Validation
    if (result.mathConfidence)
      updateData.mathConfidence = result.mathConfidence;
    if (result.mathValidationLog)
      updateData.mathValidationLog = result.mathValidationLog;
  }

  if (errorMessage) {
    updateData.processingError = errorMessage;
  }

  await fileRef.update(updateData);
}

/**
 * Store a single page's data in Firestore pages subcollection
 * Matches pdf2pngmarkdown: {basePath}/files/{fileId}/pages/{pageNumber}
 */
async function storePageData(
  basePath,
  fileId,
  pageNumber,
  markdownText,
  pageUrl,
  pageCost,
  mathConfidence = "HIGH",
  mathLog = null,
) {
  const pageRef = db.doc(`${basePath}/files/${fileId}/pages/${pageNumber}`);

  await pageRef.set({
    markdown_text: markdownText,
    page_number: pageNumber,
    page_url: pageUrl,
    processing_cost: pageCost,
    math_confidence: mathConfidence,
    math_validation_log: mathLog,
    processed_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(
    `[FileProcessor] Stored page ${pageNumber} data in Firestore (Math: ${mathConfidence})`,
  );
}

/**
 * Upload a page image to Firebase Storage permanently
 * Path: {basePath}/files/{fileId}/pages/page_{pageNumber}.png
 */
async function uploadPageImage(localPath, basePath, fileId, pageNumber) {
  const storagePath = `${basePath}/files/${fileId}/pages/page_${pageNumber}.png`;
  const url = await uploadFile(localPath, storagePath);
  console.log(
    `[FileProcessor] Uploaded page ${pageNumber} image to: ${storagePath}`,
  );
  return url;
}

/**
 * Process an image file
 */
async function processImage(imagePath, fileId, basePath, jobDir) {
  console.log(`[FileProcessor] Processing image: ${imagePath}`);

  // Generate thumbnail
  const thumbnailPath = path.join(jobDir, "thumbnail.jpg");
  await sharp(imagePath)
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "inside" })
    .jpeg({ quality: 85 })
    .toFile(thumbnailPath);

  // Upload thumbnail
  const thumbnailStoragePath = `${basePath}/thumbnails/${fileId}.jpg`;
  const thumbnailUrl = await uploadFile(thumbnailPath, thumbnailStoragePath);

  // Resize for extraction API (smaller payload = faster API call)
  const imageBuffer = await fs.readFile(imagePath);
  const extractionBuffer = await sharp(imageBuffer)
    .resize(EXTRACTION_MAX_WIDTH, null, { withoutEnlargement: true })
    .jpeg({ quality: EXTRACTION_JPEG_QUALITY })
    .toBuffer();

  const extraction = await extractTextFromSinglePage({
    base64: extractionBuffer.toString("base64"),
    mimeType: "image/jpeg",
    pageNumber: 1,
  });

  const pageMarkdown = extraction.markdown;
  const pageCost = extraction.cost || 0;

  // Upload original image as page 1
  const pageUrl = await uploadPageImage(imagePath, basePath, fileId, 1);

  // Math validation for single images
  const mathResult = validateDocument(pageMarkdown);

  await storePageData(
    basePath,
    fileId,
    1,
    pageMarkdown,
    pageUrl,
    pageCost,
    mathResult.confidence,
    mathResult.reason,
  );

  return {
    thumbnailUrl,
    extractedText: pageMarkdown,
    pageCount: 1,
    pageUrls: { 1: pageUrl },
    markdownPages: { 1: pageMarkdown },
    totalProcessingCost: pageCost,
    mathConfidence: mathResult.confidence,
    mathValidationLog: mathResult.reason,
  };
}

/**
 * Process a text file (txt, csv)
 */
async function processTextFile(filePath, fileId, basePath, jobDir) {
  console.log(`[FileProcessor] Processing text file: ${filePath}`);

  const content = await fs.readFile(filePath, "utf-8");

  // Create thumbnail placeholder
  const thumbnailPath = path.join(jobDir, "thumbnail.jpg");
  await createTextThumbnail(thumbnailPath);

  const thumbnailStoragePath = `${basePath}/thumbnails/${fileId}.jpg`;
  const thumbnailUrl = await uploadFile(thumbnailPath, thumbnailStoragePath);

  return {
    thumbnailUrl,
    extractedText: content.substring(0, 100000),
    pageCount: 1,
  };
}

/**
 * Process a PDF file
 *
 * Now stores per-page data exactly like pdf2pngmarkdown attachments:
 * 1. Page images permanently in Storage: {basePath}/files/{fileId}/pages/page_{N}.png
 * 2. Per-page markdown in Firestore subcollection: {basePath}/files/{fileId}/pages/{N}
 * 3. Combined data in main file document: pageUrls, markdownPages, extractedText
 */
async function processPdf(
  pdfPath,
  fileId,
  basePath,
  jobDir,
  extractionMode = "clean",
  password = null,
) {
  console.log(`[FileProcessor] Processing PDF: ${pdfPath}`);

  // Get page count
  const pdfBuffer = await fs.readFile(pdfPath);
  let pdfDoc;
  try {
    const loadOptions = { ignoreEncryption: true };
    if (password) {
      loadOptions.password = password;
    }
    pdfDoc = await PDFDocument.load(pdfBuffer, loadOptions);
  } catch (err) {
    // pdf-lib throws specifically when it can't load due to encryption
    const isEncrypted =
      err.message.toLowerCase().includes("encrypted") ||
      err.message.toLowerCase().includes("password");
    if (isEncrypted) {
      console.error(`[FileProcessor] PDF is password protected: ${fileId}`);
      throw new Error("PASSWORD_PROTECTED");
    }
    throw err;
  }
  const totalPageCount = pdfDoc.getPageCount();
  console.log(`[FileProcessor] PDF has ${totalPageCount} pages`);

  // Check if document will be truncated
  const wasTruncated = totalPageCount > MAX_PAGES_TO_PROCESS;
  const processedPageCount = Math.min(totalPageCount, MAX_PAGES_TO_PROCESS);

  if (wasTruncated) {
    console.log(
      `[FileProcessor] Document will be TRUNCATED: processing ${processedPageCount} of ${totalPageCount} pages`,
    );
  }

  // Convert PDF to images using pdftoppm (Poppler) in batches to save disk space
  const t1 = Date.now();
  console.log(
    `[FileProcessor] Extracting ${processedPageCount} pages in batches of ${PAGE_CONCURRENCY}...`,
  );

  // === RESUME LOGIC: Check already processed pages to skip Vision call ===
  const existingPages = {};
  try {
    const pagesSnapshot = await db
      .collection(`${basePath}/files/${fileId}/pages`)
      .get();
    pagesSnapshot.docs.forEach((doc) => {
      existingPages[doc.id] = doc.data();
    });
    if (Object.keys(existingPages).length > 0) {
      console.log(
        `[FileProcessor] Found ${Object.keys(existingPages).length} existing pages. Resuming...`,
      );
    }
  } catch (err) {
    console.warn(
      `[FileProcessor] Failed to fetch existing pages for resume:`,
      err.message,
    );
  }

  const pageUrls = {};
  const markdownPages = {};
  let totalProcessingCost = 0;
  const pageMathResults = [];

  // Helper to process a single page image
  async function processOnePage(pageImage) {
    const pageNum = pageImage.pageNumber;

    // RESUME CHECK: Skip Vision + Storage upload if page exists
    if (
      existingPages[pageNum] &&
      existingPages[pageNum].markdown_text &&
      existingPages[pageNum].page_url
    ) {
      console.log(`[FileProcessor] Page ${pageNum}: Skipping (Already exists)`);
      return {
        pageNum,
        pageUrl: existingPages[pageNum].page_url,
        pageMarkdown: existingPages[pageNum].markdown_text,
      };
    }

    const imageBuffer = await fs.readFile(pageImage.path);

    // Resize + JPEG for API extraction (~300KB vs ~5MB PNG = 15x smaller payload)
    const extractionBuffer = await sharp(imageBuffer)
      .resize(EXTRACTION_MAX_WIDTH, null, { withoutEnlargement: true })
      .jpeg({ quality: EXTRACTION_JPEG_QUALITY })
      .toBuffer();

    // Upload permanent PNG to Storage AND extract text via API in parallel
    const [pageUrl, extraction] = await Promise.all([
      uploadPageImage(pageImage.path, basePath, fileId, pageNum),
      extractTextFromSinglePage(
        {
          base64: extractionBuffer.toString("base64"),
          mimeType: "image/jpeg",
          pageNumber: pageNum,
        },
        extractionMode,
      ),
    ]);

    const pageMarkdown = extraction.markdown;
    const pageCost = extraction.cost || 0;

    // Per-Page Math Validation (Phase 2 Point 1)
    const mathResult = validateDocument(pageMarkdown);

    await storePageData(
      basePath,
      fileId,
      pageNum,
      pageMarkdown,
      pageUrl,
      pageCost,
      mathResult.confidence,
      mathResult.reason,
    );

    return {
      pageNum,
      pageUrl,
      pageMarkdown,
      pageCost,
      mathConfidence: mathResult.confidence,
      mathReason: mathResult.reason,
    };
  }

  let thumbnailUrl = null;

  // Process in batches
  for (
    let startPage = 1;
    startPage <= processedPageCount;
    startPage += PAGE_CONCURRENCY
  ) {
    const endPage = Math.min(
      startPage + PAGE_CONCURRENCY - 1,
      processedPageCount,
    );

    // 1. Generate PNGs for this batch
    const batchImages = await convertPdfToImages(
      pdfPath,
      jobDir,
      startPage,
      endPage,
      password,
    );

    if (batchImages.length === 0) {
      throw new Error(
        `Failed to convert PDF to images for pages ${startPage}-${endPage}`,
      );
    }

    // Generate thumbnail from first page if this is the first batch
    if (startPage === 1) {
      const thumbnailPath = path.join(jobDir, "thumbnail.jpg");
      await sharp(batchImages[0].path)
        .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "inside" })
        .jpeg({ quality: 85 })
        .toFile(thumbnailPath);

      const thumbnailStoragePath = `${basePath}/thumbnails/${fileId}.jpg`;
      thumbnailUrl = await uploadFile(thumbnailPath, thumbnailStoragePath);
      // We don't store thumbnailUrl anywhere explicitly here, but it's uploaded to standard path
    }

    // 2. Process this batch in parallel
    const results = await Promise.all(batchImages.map(processOnePage));
    for (const {
      pageNum,
      pageUrl,
      pageMarkdown,
      pageCost,
      mathConfidence,
      mathReason,
    } of results) {
      pageUrls[String(pageNum)] = pageUrl;
      markdownPages[String(pageNum)] = pageMarkdown;
      if (pageCost) totalProcessingCost += pageCost;
      pageMathResults.push({ confidence: mathConfidence, reason: mathReason });
    }

    // Update progress in Firestore (Throttled: once per batch)
    const progress = Math.round((endPage / processedPageCount) * 100);
    await db
      .doc(`${basePath}/files/${fileId}`)
      .update({
        processingProgress: progress,
        processingStage: `Extracting pages ${startPage}-${endPage} of ${totalPageCount}...`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch((err) =>
        console.warn(`[FileProcessor] Failed to update progress:`, err.message),
      );

    // 3. Delete the PNGs from this batch to save disk space
    for (const img of batchImages) {
      try {
        await fs.unlink(img.path);
      } catch (err) {
        console.warn(
          `[FileProcessor] Failed to delete temp image ${img.path}:`,
          err.message,
        );
      }
    }
  }

  console.log(
    `[FileProcessor] Extraction: ${Object.keys(pageUrls).length} pages in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
  );

  // Combine all pages into single extractedText (sorted by page number)
  const sortedPageNumbers = Object.keys(markdownPages).sort(
    (a, b) => parseInt(a) - parseInt(b),
  );
  let extractedText = sortedPageNumbers
    .map((pageNum) => {
      return `## Page ${pageNum}\n\n${markdownPages[pageNum]}`;
    })
    .join("\n\n---\n\n");

  // Add clear truncation notice if document was truncated
  if (wasTruncated) {
    const truncationNotice = `\n\n---\n\n## ⚠️ DOCUMENT TRUNCATED\n\n**This document was truncated during processing.**\n- Total pages in document: ${totalPageCount}\n- Pages processed: ${processedPageCount}\n- Pages not indexed: ${totalPageCount - processedPageCount} (pages ${processedPageCount + 1}-${totalPageCount})\n\nThe remaining pages were not extracted or indexed.`;
    extractedText += truncationNotice;
    console.log(
      `[FileProcessor] Added truncation notice: ${processedPageCount}/${totalPageCount} pages processed`,
    );
  }

  console.log(
    `[FileProcessor] Processed ${Object.keys(pageUrls).length} pages with per-page storage`,
  );

  // Calculate global document confidence based on weakest page
  const globalMathResult = pageMathResults.reduce(
    (min, r) => {
      const scores = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      return scores[r.confidence] < scores[min.confidence] ? r : min;
    },
    { confidence: "HIGH", reason: "No pages processed" },
  );

  // Truncate maps for main document to avoid Firestore 1MB size limit.
  // Full authoritative data remains in the 'pages' subcollection.
  const previewPageUrls = {};
  const previewMarkdownPages = {};
  const previewKeys = Object.keys(markdownPages)
    .sort((a, b) => parseInt(a) - parseInt(b))
    .slice(0, MAX_PREVIEW_PAGES);

  previewKeys.forEach((key) => {
    previewPageUrls[key] = pageUrls[key];
    previewMarkdownPages[key] = markdownPages[key];
  });

  return {
    thumbnailUrl,
    extractedText: extractedText.substring(0, 100000), // Limit combined text
    pageCount: totalPageCount, // Total pages in document
    processedPageCount, // Pages actually processed
    truncated: wasTruncated, // Was the document truncated?
    pageUrls: previewPageUrls,
    markdownPages: previewMarkdownPages,
    totalProcessingCost,
    mathConfidence: globalMathResult.confidence,
    mathValidationLog: globalMathResult.reason,
  };
}

/**
 * Process an Office document (docx, xlsx, pptx, etc.)
 */
async function processOfficeDocument(
  filePath,
  fileId,
  basePath,
  jobDir,
  extractionMode = "clean",
  password = null,
) {
  console.log(`[FileProcessor] Processing Office document: ${filePath}`);

  let activeFilePath = filePath;

  // If password provided, attempt decryption first
  if (password) {
    try {
      const decryptedPath = path.join(
        jobDir,
        `decrypted_${path.basename(filePath)}`,
      );
      await decryptOfficeDocument(filePath, decryptedPath, password);
      activeFilePath = decryptedPath;
      console.log(
        `[FileProcessor] Successfully decrypted Office document: ${activeFilePath}`,
      );
    } catch (err) {
      console.error(
        `[FileProcessor] Decryption failed for ${fileId}:`,
        err.message,
      );
      // If decryption fails, we continue anyway (LibreOffice might still try),
      // but usually this means the password was wrong.
    }
  }

  // Convert to PDF using LibreOffice
  const pdfPath = await convertToPdfWithLibreOffice(activeFilePath, jobDir);
  console.log(`[FileProcessor] Converted to PDF: ${pdfPath}`);

  // Now process as PDF
  return await processPdf(pdfPath, fileId, basePath, jobDir, extractionMode);
}

/**
 * Decrypt an Office document using msoffcrypto-tool
 */
async function decryptOfficeDocument(inputPath, outputPath, password) {
  const escapedInput = escapeShellArg(inputPath);
  const escapedOutput = escapeShellArg(outputPath);
  const escapedPassword = escapeShellArg(password);

  const command = `msoffcrypto-tool ${escapedInput} ${escapedOutput} -p ${escapedPassword}`;

  try {
    await execAsync(command, { timeout: 60000 });
    return outputPath;
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

/**
 * Convert Office document to PDF using LibreOffice
 */
async function convertToPdfWithLibreOffice(inputPath, outputDir) {
  // Per-job user profile so concurrent invocations don't collide on the
  // shared default profile lock — without this, a second simultaneous
  // libreoffice run silently exits with no output and no error.
  const profileDir = path.join(outputDir, "lo-profile");
  const profileUrl =
    process.platform === "win32"
      ? `file:///${profileDir.replace(/\\/g, "/")}`
      : `file://${profileDir}`;

  const libreOfficeCmd =
    process.platform === "win32" ? "soffice" : "libreoffice";
  const command = `${libreOfficeCmd} --headless "-env:UserInstallation=${profileUrl}" --convert-to pdf --outdir ${escapeShellArg(outputDir)} ${escapeShellArg(inputPath)}`;

  try {
    await execAsync(command, { timeout: 120000 }); // 2 minute timeout

    // LibreOffice usually writes <basename>.pdf, but may sanitize the
    // basename. Try the expected path first, then fall back to scanning
    // outputDir for any .pdf file produced by the conversion.
    const inputBasename = path.basename(inputPath, path.extname(inputPath));
    const expectedPdf = path.join(outputDir, `${inputBasename}.pdf`);
    try {
      await fs.access(expectedPdf);
      return expectedPdf;
    } catch {
      const entries = await fs.readdir(outputDir, { withFileTypes: true });
      const pdf = entries.find(
        (e) => e.isFile() && e.name.toLowerCase().endsWith(".pdf"),
      );
      if (!pdf) {
        throw new Error(
          `LibreOffice produced no PDF in ${outputDir} for ${inputBasename}`,
        );
      }
      return path.join(outputDir, pdf.name);
    }
  } catch (error) {
    const msg =
      error.message.toLowerCase() +
      (error.stderr ? error.stderr.toLowerCase() : "");

    // LibreOffice doesn't always give clear "Password Required" errors via CLI,
    // but "source file could not be loaded" or "General Error" are common when encrypted.
    if (
      msg.includes("source file could not be loaded") ||
      msg.includes("general error") ||
      msg.includes("encryption")
    ) {
      console.error(
        `[FileProcessor] Office document appears to be password protected: ${inputPath}`,
      );
      throw new Error("PASSWORD_PROTECTED");
    }

    console.error("[FileProcessor] LibreOffice conversion failed:", error);
    throw new Error(`LibreOffice conversion failed: ${error.message}`);
  }
}

/**
 * Convert PDF to images using Poppler's pdftoppm for a specific page range
 */
async function convertPdfToImages(
  pdfPath,
  outputDir,
  startPage,
  endPage,
  password = null,
) {
  const outputPrefix = path.join(outputDir, "page");

  // Use pdftoppm for high-quality conversion, generating only the requested range
  let command = `pdftoppm -png -r ${PAGE_IMAGE_DPI} -f ${startPage} -l ${endPage}`;
  if (password) {
    const escapedPassword = escapeShellArg(password);
    command += ` -upw ${escapedPassword} -opw ${escapedPassword}`;
  }
  command += ` ${escapeShellArg(pdfPath)} ${escapeShellArg(outputPrefix)}`;

  try {
    const { stderr } = await execAsync(command, { timeout: 300000 });
    if (stderr && stderr.toLowerCase().includes("password")) {
      throw new Error("PASSWORD_PROTECTED");
    }
  } catch (error) {
    const msg =
      error.message.toLowerCase() +
      (error.stderr ? error.stderr.toLowerCase() : "");

    if (msg.includes("password") || msg.includes("encrypted")) {
      throw new Error("PASSWORD_PROTECTED");
    }
    if (
      msg.includes("corrupt") ||
      msg.includes("damaged") ||
      msg.includes("eof")
    ) {
      throw new Error("CORRUPTED");
    }

    console.error("[FileProcessor] PDF to image conversion failed:", error);
    throw new Error(`PDF conversion failed: ${error.message}`);
  }

  // Collect generated images
  const pageImages = [];
  for (let i = startPage; i <= endPage; i++) {
    // pdftoppm uses different naming conventions based on page count
    const possiblePaths = [
      path.join(outputDir, `page-${i}.png`),
      path.join(outputDir, `page-${String(i).padStart(2, "0")}.png`),
      path.join(outputDir, `page-${String(i).padStart(3, "0")}.png`),
      path.join(outputDir, `page-${String(i).padStart(4, "0")}.png`),
    ];

    for (const imgPath of possiblePaths) {
      try {
        await fs.access(imgPath);
        pageImages.push({ path: imgPath, pageNumber: i });
        break;
      } catch {
        // Try next path
      }
    }
  }

  return pageImages;
}

/**
/**
 * Extract text from a single page image using OpenAI Vision
 * Used for per-page processing to store markdown per page
 *
 * @param {Object} image - Image data with base64, mimeType, pageNumber
 * @param {string} extractionMode - 'clean' (default) or 'layout-aware' (DV tags)
 * @see docs/design/DOCX_IMPORT_DVTAG_EXTRACTION.md
 */
async function extractTextFromSinglePage(image, extractionMode = "clean") {
  const mode = extractionMode === "layout-aware" ? "layout-aware" : "clean";
  const prompt =
    mode === "layout-aware" ? LAYOUT_AWARE_PROMPT : CLEAN_MARKDOWN_PROMPT;
  console.log(
    `[FileProcessor] Extracting text from page ${image.pageNumber} (mode: ${mode})`,
  );

  const maxTokens = mode === "layout-aware" ? 16384 : 4096;

  try {
    const result = await extractTextFromImage(
      image.base64,
      image.mimeType,
      prompt,
      {
        provider: process.env.VISION_PROVIDER || "openai",
        model: process.env.VISION_MODEL || "gpt-4o",
        maxTokens: maxTokens,
      },
    );

    const markdown = result.text || "";

    if (!markdown || markdown.trim().length === 0) {
      console.warn(
        `[FileProcessor] Page ${image.pageNumber}: AI refused or returned empty (Exhausted fallback chain)`,
      );
      return {
        markdown: `<!-- EXTRACTION FAILED: CONTENT POLICY OR REFUSAL -->\n\n*This page could not be processed due to a content policy or extraction failure.*`,
        cost: result.totalCostEstimate || 0,
      };
    }

    console.log(
      `[FileProcessor] Page ${image.pageNumber}: ${markdown.length} chars extracted`,
    );
    if (result.journey && result.journey.length > 1) {
      console.log(
        `[FileProcessor] Page ${image.pageNumber} Fallback Journey: ${result.journey.join(" -> ")}`,
      );
    }

    if (mode === "layout-aware") {
      const hasDvrow = markdown.includes("<dvrow");
      const hasBackground = markdown.includes("background=");
      console.log(
        `[FileProcessor] Page ${image.pageNumber} DV tags: dvrow=${hasDvrow}, background=${hasBackground}`,
      );
    }
    return { markdown, cost: result.costEstimate || 0 };
  } catch (error) {
    console.error(
      `[FileProcessor] Vision API error for page ${image.pageNumber}:`,
      error,
    );
    // Non-breaking error: Return failure message instead of crashing the pipeline
    return {
      markdown: `<!-- EXTRACTION FAILED: ${error.message} -->\n\n*This page could not be processed. Error: ${error.message}*`,
      cost: 0,
    };
  }
}

/**
 * Create a simple thumbnail for text files
 */
async function createTextThumbnail(outputPath) {
  const svg = `
    <svg width="${THUMBNAIL_WIDTH}" height="${THUMBNAIL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f5f5f5"/>
      <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="16" fill="#666" text-anchor="middle">
        Text Document
      </text>
    </svg>
  `;

  await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(outputPath);
}

/**
 * Get MIME type from file extension
 */
function getMimeType(ext) {
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
  };
  return mimeTypes[ext.toLowerCase()] || "image/png";
}

// Start server
app.listen(PORT, () => {
  console.log(`[FileProcessor] Server running on port ${PORT}`);
  console.log(`[FileProcessor] Temp directory: ${TEMP_DIR}`);
});
