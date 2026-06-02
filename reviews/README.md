# `microservices/file-processor/reviews/` — Tabular Review feature

Everything in this directory is part of the **Tabular Review** feature
(structured extraction across documents — see `docs/design/TABULAR_REVIEW.md`).

## Layering rule

This directory **depends on core** (`microservices/file-processor/profile.js`,
`searchService.js`, `indexService.js`, `vision.js`, `chunker.js`, `hyde.js`,
`util/*`) but **core does NOT depend on this directory**.

Stated mechanically: no file outside `reviews/` may `require('./reviews/...')`.

The single exception is `server.js`, which mounts review-specific HTTP routes
(`/extract`, `/extract-batch`, future `/api/v1/reviews/*`) by importing handlers
from this directory. That import is intentionally narrow and is documented in
`server.js`. If a downstream consumer wants to ship the file-processor as a
**RAG box without the reviews feature**, they can:

1. Delete this directory.
2. Comment out / remove the review-route mounts in `server.js`.
3. Drop the dependency on the openai SDK if it isn't otherwise needed.

The remaining file-processor (`/process`, `/process-sync`, `/search`, profile
build at ingestion, page reads) ships unchanged.

## What's inside today

- `extractionPrompts.js` — prompt construction, JSON schema, value coercion,
  column-type metadata. The pure helpers used by the `/extract` and
  `/extract-batch` endpoints.
- `__tests__/extractionPrompts.test.js` — vitest coverage of the pure helpers.

## What will be added (per `docs/design/REASONING_DOCUMENT_QA.md`)

- `cellTools.js` — per-row agent's six tools (search_chunks, get_section,
  get_pages, get_related_documents, get_related_section, get_document_profile).
  These wrap **core** primitives — they live here because they're shaped for
  the review row-agent's contract.
- `rowAgent.js` — Anthropic tool-use loop that fills all pending cells of one
  row in a single session.
- `extractRow.js` — keyFacts short-circuit + rowAgent dispatch.
- `router.js` — Express handlers for `/api/v1/reviews/*`.

## Why this matters

The Tabular Review feature is product surface area we may want to keep
proprietary while open-sourcing or licensing the underlying RAG box. Keeping
review code physically separated and one-directionally dependent on core means
that split happens by deletion, not by surgery.

## Lint guard

`__tests__/abstraction_boundary.test.js` (in core, parent `__tests__/` dir)
asserts at test time that no core file imports from `reviews/`. If anyone
adds such an import, CI fails before the regression ships.
