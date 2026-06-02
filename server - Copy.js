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
require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');
const OpenAI = require('openai');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const tmp = require('tmp');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');

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
admin.initializeApp({
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || (() => { throw new Error('FIREBASE_STORAGE_BUCKET env var is required. Set it to <your-project-id>.appspot.com'); })()
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Configuration
const PORT = process.env.PORT || 8080;
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/file-processor';
const MAX_PAGES_TO_PROCESS = 100;
const PAGE_CONCURRENCY = parseInt(process.env.PAGE_CONCURRENCY || '50', 10);
const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_HEIGHT = 566;

// Processing configurations (configurable via .env for benchmarking)
const PAGE_IMAGE_DPI = parseInt(process.env.PAGE_IMAGE_DPI || '200', 10);
const EXTRACTION_MAX_WIDTH = parseInt(process.env.EXTRACTION_MAX_WIDTH || '1500', 10);
const EXTRACTION_JPEG_QUALITY = parseInt(process.env.EXTRACTION_JPEG_QUALITY || '85', 10);

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

## CONTENT RULES (100% Verbatim)

1. ALL text exactly as it appears — no summarization
2. Preserve line breaks, spacing, indentation
3. Bullets → markdown lists (- or *)
4. Headers → # ## ###
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
- If layout unclear, default to simple markdown`;

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

## CONTENT EXTRACTION RULES (100% Verbatim)

1. Include ALL text exactly as it appears - no summarization
2. Preserve exact line breaks and paragraph spacing
3. Preserve indentation for nested content
4. Convert bullet symbols (•) to markdown list format (- or *)
5. Preserve headers and their hierarchy (# ## ###)
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
- ALWAYS use <br> for line breaks inside table cells — NEVER use actual newlines in table rows`;

// Supported file types
const OFFICE_EXTENSIONS = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'];
const PDF_EXTENSION = 'pdf';
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'];
const TEXT_EXTENSIONS = ['txt', 'csv'];

// Express app
const app = express();
app.use(express.json({ limit: '10mb' }));

// Dev mode: allow direct browser calls (CORS + relaxed auth)
// Set DEV_MODE=true when running locally or for contractor dev environments
const DEV_MODE = process.env.DEV_MODE === 'true';

if (DEV_MODE) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  console.log('[FileProcessor] DEV_MODE enabled — CORS open, auth relaxed');
}

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', devMode: DEV_MODE, timestamp: new Date().toISOString() });
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
  const cloudTasksQueue = req.headers['x-cloudtasks-queuename'];
  if (cloudTasksQueue) {
    return next();
  }

  // Path 2: API proxy — shared secret
  if (!FILE_PROCESSOR_API_KEY) {
    console.error('[FileProcessor] FILE_PROCESSOR_API_KEY env var is not set — rejecting non-Cloud-Tasks requests');
    return res.status(500).json({ error: 'Service misconfigured' });
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== FILE_PROCESSOR_API_KEY) {
    console.warn(`[FileProcessor] Unauthorized request to ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
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
app.post('/process', async (req, res) => {
  const startTime = Date.now();
  const { fileId, basePath, storagePath, fileName, extension } = req.body;

  if (!fileId || !basePath || !storagePath) {
    // 400 = permanent failure, don't retry
    return res.status(400).json({ error: 'Missing required fields: fileId, basePath, storagePath' });
  }

  console.log(`[FileProcessor] Starting processing for ${fileId} (${fileName})`);

  // IDEMPOTENCY CHECK: Skip if already processed or currently processing
  const fileRef = db.doc(`${basePath}/files/${fileId}`);
  const fileDoc = await fileRef.get();

  if (!fileDoc.exists) {
    // File was deleted, return 200 to complete the task
    console.log(`[FileProcessor] File ${fileId} no longer exists, skipping`);
    return res.status(200).json({ skipped: true, reason: 'file_deleted' });
  }

  const currentStatus = fileDoc.data()?.processingStatus;

  if (currentStatus === 'completed') {
    // Already processed, return 200 to complete the task
    console.log(`[FileProcessor] File ${fileId} already completed, skipping`);
    return res.status(200).json({ skipped: true, reason: 'already_completed' });
  }

  if (currentStatus === 'processing') {
    // Check if it's been stuck in processing for too long (> 10 minutes)
    const updatedAt = fileDoc.data()?.updatedAt?.toDate();
    const stuckThreshold = 10 * 60 * 1000; // 10 minutes

    if (updatedAt && (Date.now() - updatedAt.getTime()) < stuckThreshold) {
      // Recently updated, another instance is likely processing
      console.log(`[FileProcessor] File ${fileId} is being processed by another instance, skipping`);
      return res.status(200).json({ skipped: true, reason: 'already_processing' });
    }
    // Otherwise, it's stuck - continue to reprocess
    console.log(`[FileProcessor] File ${fileId} was stuck in processing, reprocessing`);
  }

  try {
    // Use shared processing logic
    const result = await processFileCore({ fileId, basePath, storagePath, fileName, extension });

    const duration = Date.now() - startTime;
    console.log(`[FileProcessor] Completed processing ${fileId} in ${duration}ms`);

    res.json({
      success: true,
      fileId,
      duration,
      result
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
app.post('/process-sync', async (req, res) => {
  const startTime = Date.now();
  const { fileId, basePath, storagePath, fileName, extension, extractionMode } = req.body;

  if (!fileId || !basePath || !storagePath) {
    return res.status(400).json({ error: 'Missing required fields: fileId, basePath, storagePath' });
  }

  console.log(`[FileProcessor] Sync processing for ${fileId} (${fileName}), extractionMode: ${extractionMode || 'clean'}`);

  try {
    // Use shared processing logic — extractionMode is only passed from /process-sync (DOCX import)
    const result = await processFileCore({ fileId, basePath, storagePath, fileName, extension, extractionMode });

    const duration = Date.now() - startTime;
    console.log(`[FileProcessor] Sync processing completed ${fileId} in ${duration}ms`);

    // Return full result for immediate use
    res.json({
      success: true,
      fileId,
      duration,
      pageCount: result.pageCount || 0,
      markdownPages: result.markdownPages || {},
      extractedText: result.extractedText || '',
      thumbnailUrl: result.thumbnailUrl || null,
      pageUrls: result.pageUrls || {}
    });

  } catch (error) {
    console.error(`[FileProcessor] Sync processing error ${fileId}:`, error);
    // Note: processFileCore already updated status to 'error'
    res.status(500).json({
      success: false,
      error: error.message
    });
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
 * @returns {Promise<Object>} Processing result
 */
async function processFileCore({ fileId, basePath, storagePath, fileName, extension, extractionMode = 'clean' }) {
  // Create unique temp directory for this job
  const jobDir = path.join(TEMP_DIR, uuidv4());
  await fs.mkdir(jobDir, { recursive: true });

  try {
    // Update status to processing
    await updateStatus(basePath, fileId, 'processing');

    // Download file from Storage
    const localFilePath = path.join(jobDir, fileName);
    await downloadFile(storagePath, localFilePath);
    console.log(`[FileProcessor] Downloaded file to ${localFilePath}`);

    let result;
    const ext = (extension || '').toLowerCase();

    if (IMAGE_EXTENSIONS.includes(ext)) {
      result = await processImage(localFilePath, fileId, basePath, jobDir);
    } else if (TEXT_EXTENSIONS.includes(ext)) {
      result = await processTextFile(localFilePath, fileId, basePath, jobDir);
    } else if (ext === PDF_EXTENSION) {
      result = await processPdf(localFilePath, fileId, basePath, jobDir, extractionMode);
    } else if (OFFICE_EXTENSIONS.includes(ext)) {
      result = await processOfficeDocument(localFilePath, fileId, basePath, jobDir, extractionMode);
    } else {
      await updateStatus(basePath, fileId, 'unsupported', null, `File type .${ext} is not supported`);
      throw new Error(`File type .${ext} is not supported for processing`);
    }

    // Update status to completed
    await updateStatus(basePath, fileId, 'completed', result);

    return result;

  } catch (error) {
    // Update status to error (unless it's already set to unsupported)
    const fileRef = db.doc(`${basePath}/files/${fileId}`);
    const fileDoc = await fileRef.get();
    if (fileDoc.exists && fileDoc.data()?.processingStatus !== 'unsupported') {
      await updateStatus(basePath, fileId, 'error', null, error.message);
    }
    throw error;

  } finally {
    // Cleanup temp directory
    try {
      await fs.rm(jobDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('[FileProcessor] Failed to cleanup temp directory:', e);
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
async function uploadFile(localPath, storagePath) {
  await bucket.upload(localPath, {
    destination: storagePath,
    metadata: {
      cacheControl: 'public, max-age=31536000'
    },
    predefinedAcl: 'publicRead'
  });

  return `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
}

/**
 * Update file processing status in Firestore
 *
 * Now stores per-page data like pdf2pngmarkdown attachments:
 * - pageUrls: { "1": "https://...", "2": "https://...", ... }
 * - markdownPages: { "1": "# Page 1 content...", "2": "# Page 2...", ... }
 * - extractedText: Combined markdown from all pages
 */
async function updateStatus(basePath, fileId, status, result = null, errorMessage = null) {
  const fileRef = db.doc(`${basePath}/files/${fileId}`);

  const updateData = {
    processingStatus: status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (status === 'completed') {
    updateData.processingCompletedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  if (result) {
    if (result.thumbnailUrl) updateData.thumbnailUrl = result.thumbnailUrl;
    if (result.extractedText) updateData.extractedText = result.extractedText;
    if (result.pageCount) updateData.pageCount = result.pageCount;
    // Per-page data (matching attachment structure)
    if (result.pageUrls) updateData.pageUrls = result.pageUrls;
    if (result.markdownPages) updateData.markdownPages = result.markdownPages;
    // Truncation metadata
    if (result.processedPageCount !== undefined) updateData.processedPageCount = result.processedPageCount;
    if (result.truncated !== undefined) updateData.truncated = result.truncated;
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
async function storePageData(basePath, fileId, pageNumber, markdownText, pageUrl) {
  const pageRef = db.doc(`${basePath}/files/${fileId}/pages/${pageNumber}`);

  await pageRef.set({
    markdown_text: markdownText,
    page_number: pageNumber,
    page_url: pageUrl,
    processed_at: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log(`[FileProcessor] Stored page ${pageNumber} data in Firestore`);
}

/**
 * Upload a page image to Firebase Storage permanently
 * Path: {basePath}/files/{fileId}/pages/page_{pageNumber}.png
 */
async function uploadPageImage(localPath, basePath, fileId, pageNumber) {
  const storagePath = `${basePath}/files/${fileId}/pages/page_${pageNumber}.png`;
  const url = await uploadFile(localPath, storagePath);
  console.log(`[FileProcessor] Uploaded page ${pageNumber} image to: ${storagePath}`);
  return url;
}

/**
 * Process an image file
 */
async function processImage(imagePath, fileId, basePath, jobDir) {
  console.log(`[FileProcessor] Processing image: ${imagePath}`);

  // Generate thumbnail
  const thumbnailPath = path.join(jobDir, 'thumbnail.jpg');
  await sharp(imagePath)
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: 'inside' })
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

  const extractedText = await extractTextWithVision([{
    base64: extractionBuffer.toString('base64'),
    mimeType: 'image/jpeg',
    pageNumber: 1
  }]);

  return {
    thumbnailUrl,
    extractedText,
    pageCount: 1
  };
}

/**
 * Process a text file (txt, csv)
 */
async function processTextFile(filePath, fileId, basePath, jobDir) {
  console.log(`[FileProcessor] Processing text file: ${filePath}`);

  const content = await fs.readFile(filePath, 'utf-8');

  // Create thumbnail placeholder
  const thumbnailPath = path.join(jobDir, 'thumbnail.jpg');
  await createTextThumbnail(thumbnailPath);

  const thumbnailStoragePath = `${basePath}/thumbnails/${fileId}.jpg`;
  const thumbnailUrl = await uploadFile(thumbnailPath, thumbnailStoragePath);

  return {
    thumbnailUrl,
    extractedText: content.substring(0, 100000),
    pageCount: 1
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
async function processPdf(pdfPath, fileId, basePath, jobDir, extractionMode = 'clean') {
  console.log(`[FileProcessor] Processing PDF: ${pdfPath}`);

  // Get page count
  const pdfBuffer = await fs.readFile(pdfPath);
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBuffer);
  } catch (err) {
    // pdf-lib throws specifically when it can't load due to encryption
    const isEncrypted = err.message.toLowerCase().includes('encrypted') || 
                        err.message.toLowerCase().includes('password');
    if (isEncrypted) {
      console.error(`[FileProcessor] PDF is password protected: ${fileId}`);
      throw new Error('PASSWORD_PROTECTED');
    }
    throw err;
  }
  const totalPageCount = pdfDoc.getPageCount();
  console.log(`[FileProcessor] PDF has ${totalPageCount} pages`);

  // Check if document will be truncated
  const wasTruncated = totalPageCount > MAX_PAGES_TO_PROCESS;
  const processedPageCount = Math.min(totalPageCount, MAX_PAGES_TO_PROCESS);

  if (wasTruncated) {
    console.log(`[FileProcessor] Document will be TRUNCATED: processing ${processedPageCount} of ${totalPageCount} pages`);
  }

  // Convert PDF to images using pdftoppm (Poppler)
  const t0 = Date.now();
  const pageImages = await convertPdfToImages(pdfPath, jobDir, totalPageCount);
  console.log(`[FileProcessor] pdftoppm: ${pageImages.length} pages in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (pageImages.length === 0) {
    throw new Error('Failed to convert PDF to images');
  }

  // === RESUME LOGIC: Check already processed pages to skip Vision call ===
  const existingPages = {};
  try {
    const pagesSnapshot = await db.collection(`${basePath}/files/${fileId}/pages`).get();
    pagesSnapshot.docs.forEach(doc => {
      existingPages[doc.id] = doc.data();
    });
    if (Object.keys(existingPages).length > 0) {
      console.log(`[FileProcessor] Found ${Object.keys(existingPages).length} existing pages. Resuming...`);
    }
  } catch (err) {
    console.warn(`[FileProcessor] Failed to fetch existing pages for resume:`, err.message);
  }

  // Generate thumbnail from first page
  const thumbnailPath = path.join(jobDir, 'thumbnail.jpg');
  await sharp(pageImages[0].path)
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: 'inside' })
    .jpeg({ quality: 85 })
    .toFile(thumbnailPath);

  const thumbnailStoragePath = `${basePath}/thumbnails/${fileId}.jpg`;
  const thumbnailUrl = await uploadFile(thumbnailPath, thumbnailStoragePath);

  // === Upload page images permanently and extract text per-page ===
  const pageUrls = {};
  const markdownPages = {};
  const t1 = Date.now();

  console.log(`[FileProcessor] Extracting ${pageImages.length} pages (concurrency: ${PAGE_CONCURRENCY})...`);

  // Process pages in parallel batches
  async function processOnePage(pageImage) {
    const pageNum = pageImage.pageNumber;

    // RESUME CHECK: Skip Vision + Storage upload if page exists
    if (existingPages[pageNum] && existingPages[pageNum].markdown_text && existingPages[pageNum].page_url) {
      console.log(`[FileProcessor] Page ${pageNum}: Skipping (Already exists)`);
      return {
        pageNum,
        pageUrl: existingPages[pageNum].page_url,
        pageMarkdown: existingPages[pageNum].markdown_text
      };
    }

    const imageBuffer = await fs.readFile(pageImage.path);

    // Resize + JPEG for API extraction (~300KB vs ~5MB PNG = 15x smaller payload)
    const extractionBuffer = await sharp(imageBuffer)
      .resize(EXTRACTION_MAX_WIDTH, null, { withoutEnlargement: true })
      .jpeg({ quality: EXTRACTION_JPEG_QUALITY })
      .toBuffer();

    // Upload permanent PNG to Storage AND extract text via API in parallel
    const [pageUrl, pageMarkdown] = await Promise.all([
      uploadPageImage(pageImage.path, basePath, fileId, pageNum),
      extractTextFromSinglePage({
        base64: extractionBuffer.toString('base64'),
        mimeType: 'image/jpeg',
        pageNumber: pageNum
      }, extractionMode)
    ]);

    await storePageData(basePath, fileId, pageNum, pageMarkdown, pageUrl);
    return { pageNum, pageUrl, pageMarkdown };
  }

  for (let i = 0; i < pageImages.length; i += PAGE_CONCURRENCY) {
    const batch = pageImages.slice(i, i + PAGE_CONCURRENCY);
    const results = await Promise.all(batch.map(processOnePage));
    for (const { pageNum, pageUrl, pageMarkdown } of results) {
      pageUrls[String(pageNum)] = pageUrl;
      markdownPages[String(pageNum)] = pageMarkdown;
    }
  }

  console.log(`[FileProcessor] Extraction: ${Object.keys(pageUrls).length} pages in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // Combine all pages into single extractedText (sorted by page number)
  const sortedPageNumbers = Object.keys(markdownPages).sort((a, b) => parseInt(a) - parseInt(b));
  let extractedText = sortedPageNumbers.map(pageNum => {
    return `## Page ${pageNum}\n\n${markdownPages[pageNum]}`;
  }).join('\n\n---\n\n');

  // Add clear truncation notice if document was truncated
  if (wasTruncated) {
    const truncationNotice = `\n\n---\n\n## ⚠️ DOCUMENT TRUNCATED\n\n**This document was truncated during processing.**\n- Total pages in document: ${totalPageCount}\n- Pages processed: ${processedPageCount}\n- Pages not indexed: ${totalPageCount - processedPageCount} (pages ${processedPageCount + 1}-${totalPageCount})\n\nThe remaining pages were not extracted or indexed.`;
    extractedText += truncationNotice;
    console.log(`[FileProcessor] Added truncation notice: ${processedPageCount}/${totalPageCount} pages processed`);
  }

  console.log(`[FileProcessor] Processed ${Object.keys(pageUrls).length} pages with per-page storage`);

  return {
    thumbnailUrl,
    extractedText: extractedText.substring(0, 100000), // Limit combined text
    pageCount: totalPageCount,           // Total pages in document
    processedPageCount,                   // Pages actually processed
    truncated: wasTruncated,              // Was the document truncated?
    pageUrls,
    markdownPages
  };
}

/**
 * Process an Office document (docx, xlsx, pptx, etc.)
 */
async function processOfficeDocument(filePath, fileId, basePath, jobDir, extractionMode = 'clean') {
  console.log(`[FileProcessor] Processing Office document: ${filePath}`);

  // Convert to PDF using LibreOffice
  const pdfPath = await convertToPdfWithLibreOffice(filePath, jobDir);
  console.log(`[FileProcessor] Converted to PDF: ${pdfPath}`);

  // Now process as PDF
  return await processPdf(pdfPath, fileId, basePath, jobDir, extractionMode);
}

/**
 * Convert Office document to PDF using LibreOffice
 */
async function convertToPdfWithLibreOffice(inputPath, outputDir) {
  const command = `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${inputPath}"`;

  try {
    await execAsync(command, { timeout: 120000 }); // 2 minute timeout

    // Find the output PDF
    const inputBasename = path.basename(inputPath, path.extname(inputPath));
    const pdfPath = path.join(outputDir, `${inputBasename}.pdf`);

    // Verify PDF was created
    await fs.access(pdfPath);
    return pdfPath;
  } catch (error) {
    console.error('[FileProcessor] LibreOffice conversion failed:', error);
    throw new Error(`LibreOffice conversion failed: ${error.message}`);
  }
}

/**
 * Convert PDF to images using Poppler's pdftoppm
 */
async function convertPdfToImages(pdfPath, outputDir, totalPages) {
  const pagesToConvert = Math.min(totalPages, MAX_PAGES_TO_PROCESS);
  const outputPrefix = path.join(outputDir, 'page');

  // Use pdftoppm for high-quality conversion
  const command = `pdftoppm -png -r ${PAGE_IMAGE_DPI} -l ${pagesToConvert} "${pdfPath}" "${outputPrefix}"`;

  try {
    const { stderr } = await execAsync(command, { timeout: 300000 });
    if (stderr && stderr.toLowerCase().includes('password')) {
      throw new Error('PASSWORD_PROTECTED');
    }
  } catch (error) {
    const msg = error.message.toLowerCase() + (error.stderr ? error.stderr.toLowerCase() : '');
    
    if (msg.includes('password') || msg.includes('encrypted')) {
      throw new Error('PASSWORD_PROTECTED');
    }
    if (msg.includes('corrupt') || msg.includes('damaged') || msg.includes('eof')) {
      throw new Error('CORRUPTED');
    }
    
    console.error('[FileProcessor] PDF to image conversion failed:', error);
    throw new Error(`PDF conversion failed: ${error.message}`);
  }

  // Collect generated images
  const pageImages = [];
  for (let i = 1; i <= pagesToConvert; i++) {
    // pdftoppm uses different naming conventions based on page count
    const possiblePaths = [
      path.join(outputDir, `page-${i}.png`),
      path.join(outputDir, `page-${String(i).padStart(2, '0')}.png`),
      path.join(outputDir, `page-${String(i).padStart(3, '0')}.png`)
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
 * Extract text from page images using OpenAI Vision (batch mode - legacy)
 */
async function extractTextFromPages(pageImages) {
  const imagesToProcess = [];

  for (const pageImage of pageImages) {
    const imageBuffer = await fs.readFile(pageImage.path);
    imagesToProcess.push({
      base64: imageBuffer.toString('base64'),
      mimeType: 'image/png',
      pageNumber: pageImage.pageNumber
    });
  }

  return await extractTextWithVision(imagesToProcess);
}

/**
 * Extract text from a single page image using OpenAI Vision
 * Used for per-page processing to store markdown per page
 *
 * @param {Object} image - Image data with base64, mimeType, pageNumber
 * @param {string} extractionMode - 'clean' (default) or 'layout-aware' (DV tags)
 * @see docs/design/DOCX_IMPORT_DVTAG_EXTRACTION.md
 */
async function extractTextFromSinglePage(image, extractionMode = 'clean') {
  const mode = extractionMode === 'layout-aware' ? 'layout-aware' : 'clean';
  const prompt = mode === 'layout-aware' ? LAYOUT_AWARE_PROMPT : CLEAN_MARKDOWN_PROMPT;
  console.log(`[FileProcessor] Extracting text from page ${image.pageNumber} (mode: ${mode})`);

  const content = [
    {
      type: 'text',
      text: prompt
    },
    {
      type: 'image_url',
      image_url: {
        url: `data:${image.mimeType};base64,${image.base64}`,
        detail: 'high'
      }
    }
  ];

  // gpt-5-mini is fast enough; gpt-5 is too slow (1.5min/page vs ~15s/page)
  const visionModel = 'gpt-5-mini';
  const maxTokens = mode === 'layout-aware' ? 16384 : 4096;

  try {
    const response = await openai.chat.completions.create({
      model: visionModel,
      messages: [{ role: 'user', content }],
      max_completion_tokens: maxTokens
    });

    const markdown = response.choices[0]?.message?.content || '';
    
    // Check for refusal or content policy finish reason
    const finishReason = response.choices[0]?.finish_reason;
    if (finishReason === 'content_filter' || (!markdown && finishReason === 'refusal')) {
      console.warn(`[FileProcessor] Page ${image.pageNumber}: AI refused to process due to content policy`);
      throw new Error('CONTENT_POLICY_REFUSAL');
    }

    console.log(`[FileProcessor] Page ${image.pageNumber}: ${markdown.length} chars (${visionModel})`);
    if (mode === 'layout-aware') {
      const hasDvrow = markdown.includes('<dvrow');
      const hasBackground = markdown.includes('background=');
      console.log(`[FileProcessor] Page ${image.pageNumber} DV tags: dvrow=${hasDvrow}, background=${hasBackground}`);
    }
    return markdown;
  } catch (error) {
    // Categorize errors for OBJ-3 visibility
    const msg = error.message.toLowerCase();
    if (msg.includes('policy') || msg.includes('safety') || msg.includes('content_filter')) {
      throw new Error('CONTENT_POLICY_REFUSAL');
    }
    
    console.error(`[FileProcessor] OpenAI Vision API error for page ${image.pageNumber}:`, error);
    throw new Error(`OpenAI Vision extraction failed for page ${image.pageNumber}: ${error.message}`);
  }
}

/**
 * Extract text using OpenAI Vision API
 */
async function extractTextWithVision(images) {
  if (images.length === 0) return '';

  console.log(`[FileProcessor] Extracting text from ${images.length} images using OpenAI Vision`);

  const allText = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const batch = images.slice(i, i + BATCH_SIZE);
    const batchText = await extractTextFromBatch(batch);
    allText.push(batchText);
  }

  return allText.join('\n\n---\n\n');
}

/**
 * Extract text from a batch of images
 */
async function extractTextFromBatch(images) {
  const content = [
    {
      type: 'text',
      text: `You are a document text extraction assistant. Extract ALL text content from the following document page(s).

Instructions:
- Extract every piece of text you can see, maintaining the logical reading order
- For tables, format them as markdown tables
- For charts or graphs, describe what they show including any data points, labels, and trends
- For images or diagrams, provide a brief description of what they contain
- Preserve headings, bullet points, and numbered lists in markdown format
- If there are multiple columns, read left to right
- Include headers and footers
- Note any handwritten text if present

Output the extracted content in clean markdown format.`
    }
  ];

  for (const image of images) {
    if (images.length > 1) {
      content.push({
        type: 'text',
        text: `\n--- Page ${image.pageNumber} ---\n`
      });
    }

    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${image.mimeType};base64,${image.base64}`,
        detail: 'high'
      }
    });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content }],
      max_completion_tokens: 4096
    });

    return response.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('[FileProcessor] OpenAI Vision API error:', error);
    throw new Error(`OpenAI Vision extraction failed: ${error.message}`);
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

  await sharp(Buffer.from(svg))
    .jpeg({ quality: 85 })
    .toFile(outputPath);
}

/**
 * Get MIME type from file extension
 */
function getMimeType(ext) {
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff'
  };
  return mimeTypes[ext.toLowerCase()] || 'image/png';
}

// Start server
app.listen(PORT, () => {
  console.log(`[FileProcessor] Server running on port ${PORT}`);
  console.log(`[FileProcessor] Temp directory: ${TEMP_DIR}`);
});
