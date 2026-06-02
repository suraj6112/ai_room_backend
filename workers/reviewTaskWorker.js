const admin = require('firebase-admin');

/**
 * Worker for executing a Tabular Review Run
 * This handles the Cloud Task triggered by POST /run
 * It processes rows and writes events to Firestore.
 */
exports.handleReviewTask = async (req, res) => {
  const { basePath, reviewId, runId } = req.body;
  if (!basePath || !reviewId || !runId) {
    return res.status(400).send('Missing required fields');
  }

  const db = admin.firestore();
  const runRef = db.doc(`${basePath}/reviews/${reviewId}/runs/${runId}`);
  
  try {
    // 1. Idempotent Execution Check
    const runDoc = await runRef.get();
    if (!runDoc.exists) {
      return res.status(404).send('Run not found');
    }
    const runData = runDoc.data();
    if (runData.status !== 'pending') {
      console.log(`[ReviewWorker] Run ${runId} is already ${runData.status}. Skipping.`);
      return res.status(200).send('Already processed');
    }

    // Mark as running
    await runRef.update({ 
      status: 'running', 
      startedAt: admin.firestore.FieldValue.serverTimestamp() 
    });

    const eventsRef = db.collection(`${basePath}/reviews/${reviewId}/runs/${runId}/events`);
    let sequence = 1;

    const emitEvent = async (type, payload) => {
      await eventsRef.add({
        sequence,
        type,
        payload,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // TTL cleanup 30 days
      });
      sequence++;
    };

    // 2. Fetch Review and Scope
    const reviewDoc = await db.doc(`${basePath}/reviews/${reviewId}`).get();
    const review = reviewDoc.data();
    const colsSnap = await db.collection(`${basePath}/reviews/${reviewId}/columns`).get();
    const columns = colsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Let's assume we resolve file IDs from the scope
    let fileIds = [];
    if (review.scope.kind === 'fileSet') {
      fileIds = review.scope.fileIds || [];
    } else if (review.scope.kind === 'folder') {
      const folderId = review.scope.folderId;
      const filesSnap = await db.collection(`${basePath}/files`).where('folderId', '==', folderId).get();
      fileIds = filesSnap.docs.map(d => d.id);
    }

    await emitEvent('started', { run_id: runId, total_rows: fileIds.length, total_cells: fileIds.length * columns.length });

    // 3. Process Files (Rows) via /extract-batch
    const tasks = [];
    for (const fileId of fileIds) {
      for (const col of columns) {
        tasks.push({
          fileId,
          columnId: col.id,
          columnName: col.name,
          columnType: col.type,
          columnPrompt: col.prompt,
          columnOptions: col.options || null
        });
      }
    }

    if (tasks.length > 0) {
      const port = process.env.PORT || 8080;
      const response = await fetch(`http://localhost:${port}/extract-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basePath, reviewId, tasks })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Batch extraction failed: ${response.status} ${errorText}`);
      }
      
      const result = await response.json();
      
      // Emit completion events for each task
      for (const r of result.results || []) {
        if (r.ok) {
          await emitEvent('cell_completed', { file_id: r.fileId, column_id: r.columnId, cell: { status: 'completed' } });
        } else {
          await emitEvent('error', { file_id: r.fileId, column_id: r.columnId, message: r.error });
        }
      }
    }

    await emitEvent('done', { completed: true, errors: [], duration_ms: 1000 });
    await runRef.update({ status: 'completed', completedAt: admin.firestore.FieldValue.serverTimestamp() });
    
    res.status(200).send('OK');

  } catch (err) {
    console.error(`[ReviewWorker] Fatal error for run ${runId}:`, err);
    await runRef.update({ status: 'error', error: err.message });
    res.status(500).send(err.message);
  }
};
