const admin = require('firebase-admin');

/**
 * Get the document profile (TOC, key facts, summary)
 * GET /api/v1/files/:id/profile
 */
exports.getProfile = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id } = req.params;

    const db = admin.firestore();
    const doc = await db.doc(`${basePath}/files/${id}`).get();

    if (!doc.exists) {
      return next({ status: 404, code: 'not_found', message: 'File not found' });
    }

    const data = doc.data();
    const profile = data.documentProfileSummary || null;

    res.json({
      success: true,
      data: profile,
      provenance: 'database',
      metadata: {}
    });
  } catch (err) {
    next(err);
  }
};
