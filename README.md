# File Processor Microservice

The File Processor is a high-performance, parallelized Cloud Run microservice responsible for converting, extracting, and indexing complex financial documents (PDF, DOCX, XLSX, CSV) into highly accurate Markdown using advanced Generative AI Vision models.

## Core Capabilities

- **High-Fidelity Tabular Extraction:** Enforces `temperature: 0.0` and utilizes high-resolution image compression (`2500px`, `JPEG 100%`) to guarantee deterministic, zero-hallucination extraction of dense financial spreadsheets and tables.
- **Multi-Provider Fallback Engine:** Natively integrates OpenAI, Google Gemini, and Anthropic Claude. If the primary model fails or rate-limits, the system automatically chains to the next provider without crashing the pipeline.
- **Granular Cost Tracking:** Calculates and logs fraction-of-a-cent API costs per-page and accumulates the total processing cost directly into the document's Firestore entry for precise business analytics.
- **Massive Parallelization:** Employs Promise pools to process up to 50 pages concurrently. Network payload optimization (JPEG compression) ensures uploads do not bottleneck the concurrent AI inference requests.
- **Resilient Recovery:** Uses `fileId`-based partial recovery to instantly resume processing if the cloud worker is preempted or times out midway through a large document.
- **Encryption Bypass:** Intelligently bypasses strict PDF "Owner Password" protections (copy/print locks) to process perfectly readable client documents that would otherwise be falsely rejected.

## Environment Variables

Configure these settings in your `.env` (local) or via Google Cloud Run variables:

```env
# AI Provider Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# Preferred Vision Models
VISION_PROVIDER=openai     # Primary provider (openai, google, anthropic)
VISION_MODEL=gpt-4o        # Primary model
TRUTH_MODEL=gpt-4o         # Model used for benchmarking truth generation

# High-Fidelity Extraction Settings
EXTRACTION_MAX_WIDTH=2500  # Default: 1500. Increase for dense financial PDFs.
EXTRACTION_JPEG_QUALITY=100 # Default: 85. Increase to prevent compression blur on numbers.
MAX_PAGES_TO_PROCESS=100   # Hard truncation limit to prevent infinite cloud timeouts.
PAGE_CONCURRENCY=50        # Number of pages to process concurrently.

# GCP & Firebase Settings
GOOGLE_CLOUD_PROJECT=<your-project-id>
FIREBASE_STORAGE_BUCKET=<your-project-id>.appspot.com
```

## Supported File Types

1. **PDFs (`.pdf`)**: Converted to high-res images via `pdftoppm` and extracted via Vision AI.
2. **Office Docs (`.xlsx`, `.docx`, `.pptx`, etc.)**: Converted to PDF natively via headless `libreoffice`, then processed through the Vision AI pipeline.
3. **Text / CSV (`.csv`, `.txt`)**: Read natively and immediately stored to Firestore at `$0.00` API cost.
4. **Images (`.png`, `.jpg`, etc.)**: Sent directly to the Vision AI pipeline.

## Local Development Requirements

If running this microservice locally (outside of the provided Docker container), you must install the following system dependencies:
- **Poppler**: Required for `pdftoppm` (PDF to Image conversion).
- **LibreOffice**: Required for `.xlsx` and `.docx` conversion to PDF.

*(Note: These dependencies are automatically installed in the Dockerfile for Google Cloud Run production deployments).*

## Firestore Integration

The service heavily interacts with Firestore, injecting data at two layers:
1. **Document Level (`files/{fileId}`)**: Stores aggregate metadata including `processingStatus`, `extractedText`, `truncated` flags, and the total `totalProcessingCost`.
2. **Page Level (`files/{fileId}/pages/{pageNum}`)**: Stores granular data for each specific page, including `markdown_text`, the raw `page_url` image, and the individual `processing_cost`.

## Benchmarking & Validation Workflow

We have built a comprehensive offline benchmarking suite located in `test/benchmark/`.
To guarantee accuracy, we successfully tested the pipeline against **22 complex screenshots** sourced directly from the 5 financial documents (PDFs & Excel) provided by the client. The system perfectly extracted these into isolated `.md` files.

If you want to run new benchmarks in the future, follow this strict workflow:
1. **Generate the Baseline:** Run `node generate_truth.js`. This will create initial `.md` files that are formatted exactly the way the system naturally outputs them.
2. **Manual Review:** A human *must* manually review the generated truth `.md` files and correct any numbers to ensure they perfectly match the source image. This becomes your "Gold Standard".
3. **Run the Benchmark:** Run `node run_benchmark.js`. The system will re-extract the images and algorithmically compare them against your Gold Standard to calculate an accuracy score.

## Production Deployment & Testing Guide

To test all the recent hardening, accuracy, and cost-tracking implementations on the live production server, follow these exact steps:

### 1. Update Cloud Run Environment Variables
Ensure the following variables are set in your Google Cloud Run service configuration (or via your deployment script):
```env
EXTRACTION_MAX_WIDTH=2500
EXTRACTION_JPEG_QUALITY=100
MAX_PAGES_TO_PROCESS=100
```
*(This guarantees the AI receives high-fidelity images and prevents infinite timeouts).*

### 2. Deploy the File Processor Microservice
Deploy the updated `file-processor` directory to Google Cloud Run:
```bash
gcloud run deploy file-processor --source .
```

### 3. Deploy the Firebase Functions (Janitor & Triggers)
Because the file processor relies on background triggers and cleanup tasks, you must also deploy the updated Firebase Functions from the root directory:
```bash
firebase deploy --only functions
```
Important: To enable the Janitor service, you must create a Firestore Collection Group Index for the files collection on fields processingStatus (Ascending) and updatedAt (Ascending).


### 4. Verify Implementations
Once deployed, perform the following tests on the live platform:
- **Test Password Bypass:** Upload a "copy-protected" (Owner Password) PDF. The system should now process it perfectly instead of throwing a `PASSWORD_PROTECTED` error.
- **Test Cost Tracking:** Upload any PDF or Excel file. Open your Firebase Console and check the newly created document. You should see a `totalProcessingCost` field on the main document, and a `processing_cost` field inside each page's sub-collection.
- **Test Fallback / Refusals:** If a document is completely blank or triggers an AI content policy, the server will no longer crash. It will gracefully inject an `<!-- EXTRACTION FAILED -->` notice into that specific page's markdown and continue processing the rest of the document.
