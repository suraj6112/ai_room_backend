const express = require('express');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('./middleware/auth');
const auditMiddleware = require('./middleware/audit');

// Import handlers
const filesHandlers = require('./handlers/files');
const profileHandlers = require('./handlers/profile');
const pagesHandlers = require('./handlers/pages');
const searchHandlers = require('./handlers/search');
const reviewsHandlers = require('./handlers/reviews');
const runsHandlers = require('./handlers/runs');
const apiKeysHandlers = require('./handlers/apiKeys');

const router = express.Router();

// 1. Ingress Middleware (Trace ID)
router.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  res.setHeader('x-trace-id', req.traceId);
  next();
});

// 2. Authentication Middleware
// Expects either a Firebase ID Token (interactive) or an API Key (server-to-server)
router.use(authMiddleware);

// 3. Audit Middleware
// Logs every tool invocation to workspaces/{wsId}/audit_logs
router.use(auditMiddleware);

// 4. API Endpoints
// Files & Folders
router.get('/files', filesHandlers.listFiles);
router.get('/files/:id', filesHandlers.getFile);
router.get('/folders', filesHandlers.listFolders);

// Document Profiles
router.get('/files/:id/profile', profileHandlers.getProfile);

// Pages & Sections
router.get('/files/:id/pages/:n', pagesHandlers.getPage);
router.post('/files/:id/sections', pagesHandlers.getSection);
router.post('/files/:id/page_range', pagesHandlers.getPageRange);

// Semantic Search
router.post('/search', searchHandlers.searchChunks);
router.post('/retrieve', searchHandlers.retrieveChunks);

// Tabular Reviews CRUD
router.post('/reviews', reviewsHandlers.createReview);
router.get('/reviews', reviewsHandlers.listReviews);
router.get('/reviews/:id', reviewsHandlers.getReview);
router.patch('/reviews/:id', reviewsHandlers.updateReview);
router.delete('/reviews/:id', reviewsHandlers.deleteReview);
router.post('/reviews/:id/columns', reviewsHandlers.addColumn);
router.patch('/reviews/:id/columns/:cid', reviewsHandlers.updateColumn);
router.delete('/reviews/:id/columns/:cid', reviewsHandlers.deleteColumn);
router.get('/reviews/:id/cells', reviewsHandlers.getCells);
router.get('/reviews/:id/export', reviewsHandlers.exportReview);

// Review Run & Streaming
router.post('/reviews/:id/run', runsHandlers.startRun);
router.get('/reviews/:id/runs/:run_id/stream', runsHandlers.streamRunEvents);

// API Keys Management (Admin Only)
const requireAdmin = (req, res, next) => {
  if (req.identity.role !== 'admin') {
    return res.status(403).json({ error: { code: 'forbidden', message: 'Only workspace admins can manage API keys' } });
  }
  next();
};
router.post('/api-keys', requireAdmin, apiKeysHandlers.createApiKey);
router.get('/api-keys', requireAdmin, apiKeysHandlers.listApiKeys);
router.delete('/api-keys/:id', requireAdmin, apiKeysHandlers.revokeApiKey);

// Error Handler
router.use((err, req, res, next) => {
  console.error(`[API Error] TraceID: ${req.traceId}`, err);
  
  const statusCode = err.status || 500;
  const errorCode = err.code || (statusCode === 500 ? 'internal_error' : 'invalid_request');
  const message = err.message || 'An unexpected error occurred';

  res.status(statusCode).json({
    error: {
      code: errorCode,
      message,
      details: err.details || {}
    }
  });
});

module.exports = router;
