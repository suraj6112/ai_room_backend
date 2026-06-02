const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

/**
 * Tabular Reviews CRUD
 */

exports.createReview = async (req, res, next) => {
  try {
    const { basePath, uid } = req.identity;
    const { name, scope, columns } = req.body;

    if (!name || !scope || !scope.kind) {
      return next({ status: 400, code: 'invalid_request', message: 'Missing name or scope' });
    }

    const db = admin.firestore();
    const reviewId = uuidv4().replace(/-/g, '').slice(0, 20); // random id
    const reviewRef = db.doc(`${basePath}/reviews/${reviewId}`);

    const reviewData = {
      name,
      scope,
      createdBy: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'idle'
    };

    await reviewRef.set(reviewData);

    // Save columns
    if (Array.isArray(columns) && columns.length > 0) {
      const batch = db.batch();
      for (const col of columns) {
        const colId = uuidv4().replace(/-/g, '').slice(0, 20);
        batch.set(db.doc(`${basePath}/reviews/${reviewId}/columns/${colId}`), {
          ...col,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      await batch.commit();
    }

    res.status(201).json({
      success: true,
      data: { reviewId, ...reviewData },
      provenance: 'database',
      metadata: {}
    });
  } catch (err) {
    next(err);
  }
};

exports.listReviews = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const db = admin.firestore();
    
    const snapshot = await db.collection(`${basePath}/reviews`).orderBy('createdAt', 'desc').get();
    const reviews = snapshot.docs.map(doc => ({ reviewId: doc.id, ...doc.data() }));

    res.json({
      success: true,
      data: reviews,
      provenance: 'database',
      metadata: {}
    });
  } catch (err) {
    next(err);
  }
};

exports.getReview = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id } = req.params;
    const db = admin.firestore();
    
    const doc = await db.doc(`${basePath}/reviews/${id}`).get();
    if (!doc.exists) {
      return next({ status: 404, code: 'not_found', message: 'Review not found' });
    }

    const colsSnap = await db.collection(`${basePath}/reviews/${id}/columns`).get();
    const columns = colsSnap.docs.map(d => ({ columnId: d.id, ...d.data() }));

    res.json({
      success: true,
      data: { reviewId: doc.id, ...doc.data(), columns },
      provenance: 'database',
      metadata: {}
    });
  } catch (err) {
    next(err);
  }
};

exports.updateReview = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id } = req.params;
    const { name, scope } = req.body;
    
    const db = admin.firestore();
    const updateData = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (name) updateData.name = name;
    if (scope) updateData.scope = scope;

    await db.doc(`${basePath}/reviews/${id}`).update(updateData);
    
    res.json({ success: true, data: { reviewId: id, ...updateData }, provenance: 'database', metadata: {} });
  } catch (err) {
    next(err);
  }
};

exports.deleteReview = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id } = req.params;
    const db = admin.firestore();
    
    await db.doc(`${basePath}/reviews/${id}`).delete();
    
    res.json({ success: true, data: { reviewId: id }, provenance: 'database', metadata: {} });
  } catch (err) {
    next(err);
  }
};

exports.addColumn = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id } = req.params;
    const colData = req.body;
    
    const db = admin.firestore();
    const colId = uuidv4().replace(/-/g, '').slice(0, 20);
    
    // Fetch review doc to get existing columnOrder
    const reviewRef = db.doc(`${basePath}/reviews/${id}`);
    const reviewSnap = await reviewRef.get();
    if (!reviewSnap.exists) {
      return next({ status: 404, code: 'not_found', message: 'Review not found' });
    }
    
    const reviewData = reviewSnap.data();
    const existingOrder = reviewData.columnOrder || [];
    const newOrder = existingOrder.length;

    // Helper to generate a key
    const slugifyKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_') || 'col';
    const key = (colData.key && String(colData.key).trim()) || slugifyKey(colData.name);

    const formattedCol = {
      name: colData.name ? colData.name.trim() : 'Unnamed',
      key,
      type: colData.type || 'short_text',
      prompt: colData.prompt ? colData.prompt.trim() : '',
      description: colData.description || null,
      width: colData.width || 220,
      options: colData.options && Object.keys(colData.options).length ? colData.options : null,
      order: newOrder,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.doc(`${basePath}/reviews/${id}/columns/${colId}`).set(formattedCol);

    // Append to columnOrder
    await reviewRef.update({
      columnOrder: [...existingOrder, colId],
      totalCells: ((reviewData.fileIds || []).length) * (existingOrder.length + 1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, data: { columnId: colId, ...formattedCol }, provenance: 'database', metadata: {} });
  } catch (err) {
    next(err);
  }
};

exports.updateColumn = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id, cid } = req.params;
    const colData = req.body;
    
    const db = admin.firestore();
    await db.doc(`${basePath}/reviews/${id}/columns/${cid}`).update(colData);

    res.json({ success: true, data: { columnId: cid, ...colData }, provenance: 'database', metadata: {} });
  } catch (err) {
    next(err);
  }
};

exports.deleteColumn = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id, cid } = req.params;
    const db = admin.firestore();
    await db.doc(`${basePath}/reviews/${id}/columns/${cid}`).delete();
    res.json({ success: true, data: { columnId: cid }, provenance: 'database', metadata: {} });
  } catch (err) {
    next(err);
  }
};

exports.getCells = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id } = req.params;
    const db = admin.firestore();
    
    const rowsSnap = await db.collection(`${basePath}/reviews/${id}/rows`).get();
    const cells = rowsSnap.docs.map(doc => ({ fileId: doc.id, cells: doc.data().cells }));

    res.json({ success: true, data: cells, provenance: 'llm', metadata: {} });
  } catch (err) {
    next(err);
  }
};

exports.exportReview = async (req, res, next) => {
  try {
    const { basePath, scopes } = req.identity;
    const { id } = req.params;
    const { format = 'json' } = req.query;

    if (!scopes.includes('export:reviews')) {
      return next({ status: 403, code: 'tenant_access_denied', message: 'Missing export:reviews scope' });
    }

    const db = admin.firestore();
    const colsSnap = await db.collection(`${basePath}/reviews/${id}/columns`).get();
    const columns = colsSnap.docs.map(d => ({ columnId: d.id, name: d.data().name }));

    const rowsSnap = await db.collection(`${basePath}/reviews/${id}/rows`).get();
    
    // In a real implementation, this would stream the CSV to handle massive datasets without OOM
    if (format === 'csv') {
      let csv = 'File ID,' + columns.map(c => `"${c.name}","${c.name}_confidence","${c.name}_page"`).join(',') + '\n';
      
      rowsSnap.forEach(row => {
        const data = row.data();
        const rowCells = data.cells || {};
        let rowStr = `"${row.id}"`;
        
        for (const col of columns) {
          const cell = rowCells[col.columnId] || {};
          const val = cell.value ? cell.value.toString().replace(/"/g, '""') : '';
          const conf = cell.confidence || '';
          const page = cell.page || '';
          rowStr += `,"${val}","${conf}","${page}"`;
        }
        csv += rowStr + '\n';
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="review_${id}.csv"`);
      return res.send(csv);
    }

    res.json({ success: true, data: rowsSnap.docs.map(d => d.data()), provenance: 'llm', metadata: {} });
  } catch (err) {
    next(err);
  }
};
