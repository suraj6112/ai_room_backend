const admin = require('firebase-admin');

// Extensible alias mapping for standard columns
const ALIAS_MAP = {
  parties: ['counterparty', 'vendor', 'supplier', 'customer', 'seller', 'contracting entity', 'supplier name'],
  effectiveDate: ['effective date', 'start date'],
  term: ['term', 'duration', 'initial period', 'subscription term', 'renewal term'],
  governingLaw: ['governing law', 'applicable law', 'jurisdiction', 'governing jurisdiction'],
  changeOfControl: ['change of control'],
  assignmentRequiresConsent: ['assignment']
};

/**
 * Normalizes a string by converting to lowercase and collapsing whitespace.
 */
function normalizeString(str) {
  if (!str) return '';
  return String(str).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Finds the corresponding keyFacts field name for a given column name.
 */
function findKeyFactFieldForColumn(columnName) {
  const normalizedCol = normalizeString(columnName);
  for (const [field, aliases] of Object.entries(ALIAS_MAP)) {
    if (aliases.includes(normalizedCol)) {
      return field;
    }
  }
  return null;
}

/**
 * Checks if the document type implies an override risk (Amendment, Addendum, SOW).
 */
function isOverrideProneDocument(documentType) {
  const normType = normalizeString(documentType);
  return normType.includes('amendment') || 
         normType.includes('addendum') || 
         normType.includes('sow') || 
         normType.includes('statement of work') ||
         normType.includes('order form');
}

/**
 * Validates that the quote exists on the specified page using whitespace-normalized matching.
 */
async function validateQuoteAgainstPage(quote, pageNum, fileId, basePath) {
  if (!quote || !pageNum) return false;

  const db = admin.firestore();
  const pageDoc = await db.doc(`${basePath}/files/${fileId}/pages/${pageNum}`).get();
  
  if (!pageDoc.exists) return false;
  
  const pageText = pageDoc.data().markdown_text || '';
  
  // Whitespace-normalized substring check
  const normalizedQuote = normalizeString(quote);
  const normalizedPageText = normalizeString(pageText);
  
  return normalizedPageText.includes(normalizedQuote);
}

/**
 * Attempts to short-circuit the extraction using keyFacts from the document profile.
 * 
 * @param {Object} params
 * @param {string} params.columnName
 * @param {Object} params.profileSummary - fileData.documentProfileSummary
 * @param {string} params.fileId
 * @param {string} params.basePath
 * @returns {Object|null} The formatted cell payload if successful, otherwise null
 */
async function tryKeyFactsShortCircuit({ columnName, profileSummary, fileId, basePath }) {
  // 1. The Scope Gates
  if (!profileSummary || profileSummary.hasProfile !== true) return null;
  if (profileSummary.category !== 'contract') return null;
  if (profileSummary.typeConfidence !== 'high') return null;
  
  // Scope Restriction: Abort if document type implies overrides
  if (isOverrideProneDocument(profileSummary.documentType)) {
    console.log(`[ShortCircuit] Aborting for ${columnName}: Document type '${profileSummary.documentType}' is override-prone.`);
    return null;
  }

  // 2. The Alias Taxonomy
  const keyFactField = findKeyFactFieldForColumn(columnName);
  if (!keyFactField) return null; // Not a standard column

  const fact = profileSummary.keyFacts && profileSummary.keyFacts[keyFactField];
  if (!fact || fact.value === null || fact.value === undefined) return null;

  // 3. Quote Validation Engine
  const isValidQuote = await validateQuoteAgainstPage(fact.quote, fact.page, fileId, basePath);
  if (!isValidQuote) {
    console.warn(`[ShortCircuit] Aborting for ${columnName}: Quote validation failed for page ${fact.page}. Fallback to RAG.`);
    return null;
  }

  // 4. Trust Semantics & Payload
  console.log(`[ShortCircuit] SUCCESS for ${columnName} -> using keyFacts.${keyFactField}`);
  
  return {
    value: fact.value,
    quote: fact.quote,
    page: fact.page,
    confidence: profileSummary.typeConfidence, // Inherit profile confidence
    reasoning: "Derived from document profile analysis.",
    provenance: "profile",
    // Future versioning hooks
    profileVersion: "1.0",
    extractionVersion: "1.0"
  };
}

module.exports = {
  tryKeyFactsShortCircuit,
  ALIAS_MAP
};
