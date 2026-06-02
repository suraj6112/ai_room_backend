const admin = require('firebase-admin');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

/**
 * API Key Management Handlers
 */

// POST /api/v1/api-keys
exports.createApiKey = async (req, res, next) => {
  try {
    const { name } = req.body;
    // We get wsId from the auth middleware identity
    const wsId = req.identity.basePath.split('/')[1];

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'API Key name is required' });
    }

    const db = admin.firestore();

    // 1. Generate secure random secret and Key ID
    const keyId = uuidv4().replace(/-/g, '').slice(0, 16);
    const rawSecret = crypto.randomBytes(32).toString('hex');
    const hashedSecret = crypto.createHash('sha256').update(rawSecret).digest('hex');

    // 2. Prepare API Key Document Data
    const apiKeyData = {
      keyId: keyId,
      uid: req.identity.uid,
      wsId: wsId,
      basePath: req.identity.basePath,
      hashedSecret: hashedSecret,
      scopes: ['read:files', 'execute:search', 'write:reviews', 'export:reviews'], // Default full access
      monthly_budget_usd: 100, // $100 default budget
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.identity.uid,
      name: name.trim()
    };

    // 3. Save to Firestore
    await db.doc(`workspaces/${wsId}/apiKeys/${keyId}`).set(apiKeyData);

    // 4. Return the plaintext key (ONLY ONCE!)
    const finalKey = `airoom_${keyId}_${rawSecret}`;
    
    res.status(201).json({
      message: 'API Key generated successfully',
      key: finalKey,
      keyId: keyId,
      name: apiKeyData.name
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/api-keys
exports.listApiKeys = async (req, res, next) => {
  try {
    const wsId = req.identity.basePath.split('/')[1];
    const db = admin.firestore();

    const snapshot = await db.collection(`workspaces/${wsId}/apiKeys`).orderBy('createdAt', 'desc').get();
    
    const keys = snapshot.docs.map(doc => {
      const data = doc.data();
      // NEVER return the hashedSecret or raw secret
      return {
        id: doc.id,
        keyId: data.keyId,
        name: data.name,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : new Date().toISOString(),
        lastUsedAt: data.lastUsedAt ? data.lastUsedAt.toDate().toISOString() : null,
        createdBy: data.createdBy,
        revokedAt: data.revokedAt ? data.revokedAt.toDate().toISOString() : null
      };
    });

    // Filter out revoked keys (optional, or let frontend show them as revoked)
    const activeKeys = keys.filter(k => !k.revokedAt);

    res.json({ keys: activeKeys });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/v1/api-keys/:id
exports.revokeApiKey = async (req, res, next) => {
  try {
    const wsId = req.identity.basePath.split('/')[1];
    const keyId = req.params.id;
    const db = admin.firestore();

    const keyRef = db.doc(`workspaces/${wsId}/apiKeys/${keyId}`);
    const keyDoc = await keyRef.get();

    if (!keyDoc.exists) {
      return res.status(404).json({ error: 'API Key not found' });
    }

    // Mark as revoked (soft delete) or hard delete. We will soft delete for audit purposes.
    await keyRef.update({
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
      revokedBy: req.identity.uid
    });

    res.json({ message: 'API Key revoked successfully' });
  } catch (error) {
    next(error);
  }
};
