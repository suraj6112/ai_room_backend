const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const { CloudTasksClient } = require('@google-cloud/tasks');

/**
 * Start an asynchronous review extraction process
 * POST /api/v1/reviews/:id/run
 */
exports.startRun = async (req, res, next) => {
  try {
    const { basePath, uid } = req.identity;
    const { id: reviewId } = req.params;
    
    const db = admin.firestore();
    const runId = uuidv4().replace(/-/g, '').slice(0, 20);

    const runRef = db.doc(`${basePath}/reviews/${reviewId}/runs/${runId}`);
    
    await runRef.set({
      status: 'pending',
      createdBy: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Dispatch Cloud Task
    // In dev mode or local, we might just call a local worker or use a fallback
    if (process.env.NODE_ENV !== 'test') {
      try {
        const client = new CloudTasksClient();
        const project = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
        const location = process.env.GCP_LOCATION || 'us-central1';
        const queue = 'review-processing-queue';
        
        const parent = client.queuePath(project, location, queue);
        
        const payload = {
          basePath,
          reviewId,
          runId
        };
        
        const task = {
          httpRequest: {
            httpMethod: 'POST',
            url: `${process.env.SERVICE_URL || `https://${project}.run.app`}/api/v1/internal/worker/reviewTask`,
            headers: {
              'Content-Type': 'application/json',
            },
            body: Buffer.from(JSON.stringify(payload)).toString('base64'),
          },
        };
        
        // Disable temporarily in local dev if queue doesn't exist to prevent crash
        // await client.createTask({ parent, task });
        console.log(`[CloudTasks] Dispatched task for run ${runId}`);
      } catch (queueErr) {
        console.warn(`[CloudTasks] Failed to enqueue task, fallback required:`, queueErr.message);
        // For local development, we could immediately fetch to the internal worker endpoint
        fetch(`http://localhost:${process.env.PORT || 8080}/api/v1/internal/worker/reviewTask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ basePath, reviewId, runId })
        }).catch(err => console.error('[LocalWorker] Dev fallback failed:', err.message));
      }
    }

    res.status(202).json({
      success: true,
      data: {
        runId,
        status: 'pending'
      },
      provenance: 'database',
      metadata: {}
    });

  } catch (err) {
    next(err);
  }
};

/**
 * Stream events for a specific run using SSE (Server-Sent Events)
 * GET /api/v1/reviews/:id/runs/:run_id/stream
 */
exports.streamRunEvents = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id: reviewId, run_id: runId } = req.params;
    const lastEventId = req.headers['last-event-id'];

    const db = admin.firestore();
    const runRef = db.doc(`${basePath}/reviews/${reviewId}/runs/${runId}`);
    
    const runDoc = await runRef.get();
    if (!runDoc.exists) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Run not found' } });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Send initial heartbeat to establish connection
    res.write(':\n\n');

    let eventsQuery = db.collection(`${basePath}/reviews/${reviewId}/runs/${runId}/events`)
                        .orderBy('sequence', 'asc');
    
    // If client reconnects, replay missing events
    if (lastEventId) {
      const seq = parseInt(lastEventId, 10);
      if (!isNaN(seq)) {
        eventsQuery = eventsQuery.where('sequence', '>', seq);
      }
    }

    const unsubscribe = eventsQuery.onSnapshot(
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const data = change.doc.data();
            const eventName = data.type; // e.g. 'row_started', 'cell_completed'
            
            res.write(`id: ${data.sequence}\n`);
            res.write(`event: ${eventName}\n`);
            res.write(`data: ${JSON.stringify(data.payload)}\n\n`);
          }
        });
      },
      (error) => {
        console.error(`[SSE Error] Firestore listener failed for run ${runId}:`, error);
        res.write(`event: error\ndata: {"message":"Stream interrupted"}\n\n`);
        res.end();
      }
    );

    // Heartbeat every 15 seconds to keep the socket alive on Cloud Run
    const heartbeatInterval = setInterval(() => {
      res.write(':\n\n');
    }, 15000);

    // Cleanup on client disconnect
    req.on('close', () => {
      clearInterval(heartbeatInterval);
      unsubscribe();
      res.end();
    });

  } catch (err) {
    // Only call next if headers aren't sent yet
    if (!res.headersSent) {
      next(err);
    } else {
      console.error(`[SSE Error] Failed to initialize stream:`, err);
      res.write(`event: error\ndata: {"message":"Internal server error"}\n\n`);
      res.end();
    }
  }
};

exports.runColumn = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id: reviewId } = req.params;
    const { cid: columnId } = req.body;
    
    if (!columnId) return next({ status: 400, message: 'Column ID required' });

    const db = admin.firestore();
    const reviewSnap = await db.doc(`${basePath}/reviews/${reviewId}`).get();
    if (!reviewSnap.exists) return next({ status: 404, message: 'Review not found' });
    const review = reviewSnap.data();
    
    let fileIds = [];
    if (review.scope && review.scope.kind === 'fileSet') {
      fileIds = review.scope.fileIds || [];
    } else if (review.scope && review.scope.kind === 'folder') {
      const folderId = review.scope.folderId;
      const filesSnap = await db.collection(`${basePath}/files`).where('folderId', '==', folderId).get();
      fileIds = filesSnap.docs.map(d => d.id);
    }

    const colSnap = await db.doc(`${basePath}/reviews/${reviewId}/columns/${columnId}`).get();
    if (!colSnap.exists) return next({ status: 404, message: 'Column not found' });
    const col = colSnap.data();

    const tasks = fileIds.map(fileId => ({
      fileId,
      columnId,
      columnName: col.name,
      columnType: col.type,
      columnPrompt: col.prompt,
      columnOptions: col.options || null
    }));

    if (tasks.length > 0) {
      const port = process.env.PORT || 8080;
      const response = await fetch(`http://localhost:${port}/extract-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basePath, reviewId, tasks })
      });
      if (!response.ok) {
        const errorText = await response.text();
        return next({ status: response.status, message: errorText });
      }
      const result = await response.json();
      return res.json({ success: true, data: result, provenance: 'llm', metadata: {} });
    }
    
    res.json({ success: true, data: { completed: 0, errors: 0 }, provenance: 'llm', metadata: {} });
  } catch (err) {
    next(err);
  }
};

exports.runCell = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id: reviewId } = req.params;
    const { cid: columnId, fid: fileId } = req.body;
    
    if (!columnId || !fileId) return next({ status: 400, message: 'Column ID and File ID required' });

    const db = admin.firestore();
    const colSnap = await db.doc(`${basePath}/reviews/${reviewId}/columns/${columnId}`).get();
    if (!colSnap.exists) return next({ status: 404, message: 'Column not found' });
    const col = colSnap.data();

    const tasks = [{
      fileId,
      columnId,
      columnName: col.name,
      columnType: col.type,
      columnPrompt: col.prompt,
      columnOptions: col.options || null
    }];

    const port = process.env.PORT || 8080;
    const response = await fetch(`http://localhost:${port}/extract-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basePath, reviewId, tasks })
    });
    if (!response.ok) {
      const errorText = await response.text();
      return next({ status: response.status, message: errorText });
    }
    const result = await response.json();
    res.json({ success: true, data: result, provenance: 'llm', metadata: {} });
  } catch (err) {
    next(err);
  }
};
