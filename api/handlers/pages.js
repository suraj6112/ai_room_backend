const admin = require('firebase-admin');

const wrapPromptSafety = (fileId, text) => {
  return `<document source="file_${fileId}">\n${text}\n</document>`;
};

/**
 * Get a specific page
 * GET /api/v1/files/:id/pages/:n
 */
exports.getPage = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id, n } = req.params;

    const db = admin.firestore();
    const pageDoc = await db.doc(`${basePath}/files/${id}/pages/${n}`).get();

    if (!pageDoc.exists) {
      return next({ status: 404, code: 'not_found', message: `Page ${n} not found for file ${id}` });
    }

    const data = pageDoc.data();
    
    res.json({
      success: true,
      data: {
        page_number: parseInt(n, 10),
        markdown_text: wrapPromptSafety(id, data.markdown_text || ''),
        page_url: data.page_url
      },
      provenance: 'database',
      citations: [`/files/${id}?page=${n}`],
      metadata: {}
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get a continuous block of pages
 * POST /api/v1/files/:id/page_range
 * Body: { start: number, end: number }
 */
exports.getPageRange = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id } = req.params;
    const { start, end } = req.body;

    if (start === undefined || end === undefined || start > end) {
      return next({ status: 400, code: 'invalid_request', message: 'Invalid start or end page' });
    }

    const db = admin.firestore();
    const pagesRef = db.collection(`${basePath}/files/${id}/pages`);
    
    // Fetch the pages concurrently (since it's a known range)
    const pagePromises = [];
    for (let i = start; i <= end; i++) {
      pagePromises.push(pagesRef.doc(i.toString()).get());
    }

    const snaps = await Promise.all(pagePromises);
    const pages = snaps.filter(snap => snap.exists).map(snap => ({
      page_number: parseInt(snap.id, 10),
      markdown_text: snap.data().markdown_text || '',
      page_url: snap.data().page_url
    }));

    // Combine markdown
    const combinedMarkdown = pages.map(p => `--- Page ${p.page_number} ---\n${p.markdown_text}`).join('\n\n');

    res.json({
      success: true,
      data: {
        pages,
        combined_markdown_text: wrapPromptSafety(id, combinedMarkdown)
      },
      provenance: 'database',
      citations: pages.map(p => `/files/${id}?page=${p.page_number}`),
      metadata: { partial: pages.length < (end - start + 1) }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Fetch section markdown by heading path
 * POST /api/v1/files/:id/sections
 * Body: { headingPath: string[] }
 */
exports.getSection = async (req, res, next) => {
  try {
    const { basePath } = req.identity;
    const { id } = req.params;
    const { headingPath } = req.body;

    if (!Array.isArray(headingPath)) {
      return next({ status: 400, code: 'invalid_request', message: 'headingPath must be an array of strings' });
    }

    // In a full implementation, this reads the documentProfileSummary TOC,
    // finds the start and end pages for the heading, and then fetches the page range.
    // For V1, we simulate retrieving the profile to find the pages.
    const db = admin.firestore();
    const fileDoc = await db.doc(`${basePath}/files/${id}`).get();
    
    if (!fileDoc.exists) {
      return next({ status: 404, code: 'not_found', message: 'File not found' });
    }

    const profile = fileDoc.data().documentProfileSummary;
    if (!profile || !profile.headings) {
      return next({ status: 404, code: 'not_found', message: 'Document has no TOC profile' });
    }

    // Recursive search for heading
    const findNode = (nodes, path, depth) => {
      if (!nodes) return null;
      const target = path[depth];
      const match = nodes.find(n => n.title === target);
      if (!match) return null;
      if (depth === path.length - 1) return match;
      return findNode(match.children, path, depth + 1);
    };

    const sectionNode = findNode(profile.headings, headingPath, 0);
    if (!sectionNode) {
      return next({ status: 404, code: 'not_found', message: 'Heading not found in TOC' });
    }

    // Usually sectionNode has start_page and end_page
    const start = sectionNode.start_page || sectionNode.page || 1;
    let end = sectionNode.end_page || start;

    // Fetch the page range
    const pagesRef = db.collection(`${basePath}/files/${id}/pages`);
    const pagePromises = [];
    for (let i = start; i <= end; i++) {
      pagePromises.push(pagesRef.doc(i.toString()).get());
    }

    const snaps = await Promise.all(pagePromises);
    const combinedMarkdown = snaps
      .filter(snap => snap.exists)
      .map(snap => `--- Page ${snap.id} ---\n${snap.data().markdown_text || ''}`)
      .join('\n\n');

    res.json({
      success: true,
      data: {
        heading: sectionNode.title,
        markdown_text: wrapPromptSafety(id, combinedMarkdown)
      },
      provenance: 'database',
      metadata: {}
    });

  } catch (err) {
    next(err);
  }
};
