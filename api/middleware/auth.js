const admin = require('firebase-admin');
const crypto = require('crypto');

/**
 * Authentication and Tenant-Isolation Middleware
 * Resolves Bearer tokens (Firebase ID Token or API Key) into req.identity
 */
module.exports = async (req, res, next) => {
  try {

    let authHeader = req.headers.authorization;
    
    // Fallback to query parameter if header is missing
    if (!authHeader && req.query.token) {
      authHeader = `Bearer ${req.query.token}`;
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next({ status: 401, code: 'unauthenticated', message: 'Missing or invalid Authorization header or token query parameter' });
    }

    const token = authHeader.split('Bearer ')[1].trim();
    let identity = null;

    if (token.startsWith('airoom_')) {
      // --- API KEY AUTHENTICATION ---
      // Format: airoom_<keyId>_<secret>
      const parts = token.split('_');
      if (parts.length !== 3) {
        return next({ status: 401, code: 'unauthenticated', message: 'Invalid API Key format' });
      }
      const keyId = parts[1];
      const secret = parts[2];

      const db = admin.firestore();
      
      // Look up key globally without requiring X-Base-Path
      const keyQuery = await db.collectionGroup('apiKeys').where('keyId', '==', keyId).limit(1).get();
      
      if (keyQuery.empty) {
        return next({ status: 401, code: 'unauthenticated', message: 'Invalid API Key' });
      }

      const keyDoc = keyQuery.docs[0];

      const keyData = keyDoc.data();

      // Check revocation & expiration
      if (keyData.revokedAt) {
        return next({ status: 401, code: 'unauthenticated', message: 'API Key has been revoked' });
      }
      if (keyData.expiresAt && keyData.expiresAt.toDate() < new Date()) {
        return next({ status: 401, code: 'unauthenticated', message: 'API Key has expired' });
      }

      // Hash provided secret and compare
      const hashedSecret = crypto.createHash('sha256').update(secret).digest('hex');
      if (hashedSecret !== keyData.hashedSecret) {
        return next({ status: 401, code: 'unauthenticated', message: 'Invalid API Key secret' });
      }

      // Cost Governance: Check budget
      const currentSpend = keyData.current_spend_usd || 0;
      const budget = keyData.monthly_budget_usd;
      if (budget !== undefined && currentSpend >= budget) {
        return next({ status: 429, code: 'rate_limited', message: 'API Key monthly budget exceeded' });
      }

      // Verify live membership to ensure the user wasn't removed from the workspace
      const memberDoc = await db.doc(`workspaces/${keyData.wsId}/members/${keyData.uid}`).get();
      if (!memberDoc.exists) {
        return next({ status: 403, code: 'tenant_access_denied', message: 'User is no longer a member of this workspace' });
      }

      // Update lastUsedAt asynchronously
      keyDoc.ref.update({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(console.error);

      identity = {
        uid: keyData.uid,
        basePath: keyData.basePath,
        role: memberDoc.data().role,
        scopes: keyData.scopes || ['read:files'], // Default to readonly
        authMethod: 'api_key',
        keyId: keyId
      };

    } else {
      // --- FIREBASE ID TOKEN AUTHENTICATION ---
      // For interactive UI requests. Requires X-Base-Path header.
      const decoded = await admin.auth().verifyIdToken(token);
      const basePath = req.headers['x-base-path'] || req.query.basePath;

      if (!basePath || !basePath.startsWith('workspaces/')) {
        return next({ status: 400, code: 'invalid_request', message: 'Missing or invalid X-Base-Path header' });
      }

      const wsId = basePath.split('/')[1];
      const db = admin.firestore();
      
      const memberDoc = await db.doc(`workspaces/${wsId}/members/${decoded.uid}`).get();
      if (!memberDoc.exists) {
        return next({ status: 403, code: 'tenant_access_denied', message: 'Access denied to this workspace' });
      }

      identity = {
        uid: decoded.uid,
        basePath: basePath,
        role: memberDoc.data().role,
        // Interactive users implicitly have full scopes in the UI context
        scopes: ['read:files', 'execute:search', 'write:reviews', 'export:reviews'], 
        authMethod: 'id_token'
      };
    }

    req.identity = identity;
    next();
  } catch (err) {
    if (err.code === 'auth/id-token-expired' || err.code === 'auth/argument-error') {
      return next({ status: 401, code: 'unauthenticated', message: 'Invalid or expired token' });
    }
    next(err);
  }
};
