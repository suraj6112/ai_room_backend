const admin = require('firebase-admin');

/**
 * List files in the workspace with optional filters.
 * GET /api/v1/files
 */
exports.listFiles = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { folder_id, extensions, has_profile, limit, next_page_token } = req.query;
    
    const db = admin.firestore();
    let filesQuery = db.collection(`${basePath}/files`);

    // Filtering
    if (folder_id) {
      filesQuery = filesQuery.where('folderId', '==', folder_id);
    } else {
      // If no folder specified, default to root or all? Let's just return all or allow 'root'
      // filesQuery = filesQuery.where('folderId', '==', null);
    }

    if (extensions) {
      const extList = extensions.split(',').map(e => e.trim().toLowerCase());
      filesQuery = filesQuery.where('extension', 'in', extList);
    }

    if (has_profile === 'true') {
      filesQuery = filesQuery.where('documentProfileSummary', '!=', null);
    }

    // KeyFacts filtering (e.g. keyFacts.governingLaw=Delaware)
    for (const [key, value] of Object.entries(req.query)) {
      if (key.startsWith('keyFacts.')) {
        filesQuery = filesQuery.where(`documentProfileSummary.${key}`, '==', value);
      }
    }

    // Pagination
    const pageSize = parseInt(limit, 10) || 50;
    filesQuery = filesQuery.orderBy('createdAt', 'desc').limit(pageSize);

    if (next_page_token) {
      // In a real implementation, you'd decode the token to get the last document snapshot.
      // For simplicity in V1, we might just offset or use a simple cursor.
      // Easiest is to pass the ID of the last document and fetch it to startAfter.
      const lastDoc = await db.doc(`${basePath}/files/${next_page_token}`).get();
      if (lastDoc.exists) {
        filesQuery = filesQuery.startAfter(lastDoc);
      }
    }

    const snapshot = await filesQuery.get();
    
    const items = snapshot.docs.map(doc => ({
      fileId: doc.id,
      ...doc.data()
    }));

    const new_next_page_token = items.length === pageSize ? items[items.length - 1].fileId : null;

    res.json({
      success: true,
      data: {
        items,
        next_page_token: new_next_page_token
      },
      provenance: 'database',
      metadata: {}
    });

  } catch (err) {
    next(err);
  }
};

/**
 * Get single file metadata
 * GET /api/v1/files/:id
 */
exports.getFile = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id } = req.params;

    const db = admin.firestore();
    const doc = await db.doc(`${basePath}/files/${id}`).get();

    if (!doc.exists) {
      return next({ status: 404, code: 'not_found', message: 'File not found' });
    }

    res.json({
      success: true,
      data: {
        fileId: doc.id,
        ...doc.data()
      },
      provenance: 'database',
      metadata: {}
    });
  } catch (err) {
    next(err);
  }
};

/**
 * List folders in the workspace
 * GET /api/v1/folders
 */
exports.listFolders = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { parent_id } = req.query;

    const db = admin.firestore();
    let foldersQuery = db.collection(`${basePath}/file_folders`);

    if (parent_id) {
      foldersQuery = foldersQuery.where('parentId', '==', parent_id);
    } else if (parent_id === 'null' || parent_id === '') {
      foldersQuery = foldersQuery.where('parentId', '==', null);
    }

    foldersQuery = foldersQuery.orderBy('name', 'asc');

    const snapshot = await foldersQuery.get();
    
    const items = snapshot.docs.map(doc => ({
      folderId: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      data: { items },
      provenance: 'database',
      metadata: {}
    });
  } catch (err) {
    next(err);
  }
};
