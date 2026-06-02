const admin = require('firebase-admin');

/**
 * Audit Logging Middleware
 * Asynchronously writes an audit record for every tool/API invocation
 */
module.exports = (req, res, next) => {
  const startTime = Date.now();
  
  // Wait for the response to finish so we can capture the status code and latency
  res.on('finish', () => {
    if (!req.identity || !req.identity.basePath) return; // Unauthenticated requests are not logged here

    const latencyMs = Date.now() - startTime;
    const db = admin.firestore();
    const wsId = req.identity.basePath.split('/')[1];

    const auditEntry = {
      traceId: req.traceId,
      uid: req.identity.uid,
      authMethod: req.identity.authMethod,
      keyId: req.identity.keyId || null,
      route: req.originalUrl,
      method: req.method,
      statusCode: res.statusCode,
      latencyMs,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    // Fire and forget
    db.collection(`workspaces/${wsId}/audit_logs`)
      .add(auditEntry)
      .catch(err => {
        console.error(`[Audit Log Failed] TraceID: ${req.traceId}`, err.message);
      });
  });

  next();
};
