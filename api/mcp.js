const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { 
  CallToolRequestSchema, 
  ListToolsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const authMiddleware = require('./middleware/auth');
const auditMiddleware = require('./middleware/audit');
const { v4: uuidv4 } = require('uuid');

// Import all handlers to reuse REST logic
const filesHandlers = require('./handlers/files');
const profileHandlers = require('./handlers/profile');
const pagesHandlers = require('./handlers/pages');
const searchHandlers = require('./handlers/search');
const reviewsHandlers = require('./handlers/reviews');
const runsHandlers = require('./handlers/runs');

const router = express.Router();
const transports = new Map();

// Helper to execute Express handlers inside MCP context
const executeHandler = (handler, identity, params) => {
  return new Promise((resolve, reject) => {
    const mockReq = {
      identity,
      query: params || {},
      body: params || {},
      params: params || {}
    };

    const mockRes = {
      json: (data) => resolve(data),
      status: (code) => mockRes, // chainable
      send: (data) => resolve(data),
      setHeader: () => {} // mock to prevent crash on exportReview
    };

    const mockNext = (err) => {
      if (err) {
        reject(new Error(err.message || JSON.stringify(err)));
      } else {
        resolve(null);
      }
    };

    try {
      handler(mockReq, mockRes, mockNext).catch(mockNext);
    } catch (e) {
      mockNext(e);
    }
  });
};

router.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  next();
});

// Expose the SSE endpoint to connect
// Apply Auth & Audit ONLY to the GET route. POST route uses sessionId for security.
router.get('/mcp', authMiddleware, auditMiddleware, async (req, res, next) => {
  try {
    console.log(`[MCP] New SSE connection established`);
    
    // Preserve query parameters (like token and basePath) for the POST endpoint
    const queryParams = new URLSearchParams(req.query).toString();
    const endpointPath = queryParams ? `/api/v1/mcp/messages?${queryParams}` : `/api/v1/mcp/messages`;
    
    const transport = new SSEServerTransport(endpointPath, res);
    
    // The SDK generates its own sessionId automatically. We MUST use it.
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);
    console.log(`[MCP] Session tracked as: ${sessionId}`);

    // Capture the authenticated identity for this connection
    const identity = req.identity;

    const server = new Server({
      name: 'ai-room-mcp',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      }
    });

    // Handle tool list
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // Browsing
          {
            name: 'list_folders',
            description: 'List folders in the workspace',
            inputSchema: { type: 'object', properties: { parent_id: { type: 'string' } } }
          },
          {
            name: 'list_files',
            description: 'List all available files in the workspace',
            inputSchema: { type: 'object', properties: { folder_id: { type: 'string' }, include_subfolders: { type: 'boolean' } } }
          },
          {
            name: 'get_file',
            description: 'Get metadata for a single file',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
          },
          
          // Reading Docs
          {
            name: 'get_document_profile',
            description: 'Get the summary profile of a document',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
          },
          {
            name: 'get_page',
            description: 'Read a specific page of a document',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'string' } }, required: ['id', 'n'] }
          },
          {
            name: 'get_section',
            description: 'Read a specific section/heading of a document',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, headingPath: { type: 'string' } }, required: ['id', 'headingPath'] }
          },
          {
            name: 'get_page_range',
            description: 'Read a range of pages in a document',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } }, required: ['id', 'start', 'end'] }
          },

          // Search
          {
            name: 'search_chunks',
            description: 'Semantic search across all documents in the workspace',
            inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }
          },
          {
            name: 'retrieve_chunks',
            description: 'Retrieve surrounding context chunks around a specific file search hit',
            inputSchema: { type: 'object', properties: { file_id: { type: 'string' }, chunk_index: { type: 'number' } }, required: ['file_id', 'chunk_index'] }
          },

          // Reviews
          {
            name: 'list_reviews',
            description: 'List tabular reviews in the workspace',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            name: 'get_review',
            description: 'Get details of a specific tabular review',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
          },
          {
            name: 'create_review',
            description: 'Create a new tabular review',
            inputSchema: { 
              type: 'object', 
              properties: { 
                name: { type: 'string' }, 
                description: { type: 'string' }, 
                scope: { 
                  type: 'object',
                  description: "Must have kind: 'folder' (with optional folderId) OR kind: 'fileSet' (with fileIds array)",
                  properties: {
                    kind: { type: 'string', enum: ['folder', 'fileSet', 'filter'] },
                    folderId: { type: 'string' },
                    includeSubfolders: { type: 'boolean' },
                    fileIds: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['kind']
                } 
              }, 
              required: ['name', 'scope'] 
            }
          },
          {
            name: 'update_review',
            description: 'Update tabular review name/description',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } }, required: ['id'] }
          },
          {
            name: 'delete_review',
            description: 'Delete a tabular review',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
          },

          // Columns
          {
            name: 'add_column',
            description: 'Add a column to a tabular review',
            inputSchema: { 
              type: 'object', 
              properties: { 
                id: { type: 'string' }, 
                name: { type: 'string' }, 
                type: { type: 'string', description: "e.g., 'short_text', 'long_text', 'classification', 'date', 'currency'" }, 
                prompt: { type: 'string' },
                options: { 
                  type: 'object', 
                  description: "Required for 'classification' type. Example: { values: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }" 
                }
              }, 
              required: ['id', 'name', 'type', 'prompt'] 
            }
          },
          {
            name: 'update_column',
            description: 'Update a column in a tabular review',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, cid: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' } }, required: ['id', 'cid'] }
          },
          {
            name: 'delete_column',
            description: 'Delete a column from a tabular review',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, cid: { type: 'string' } }, required: ['id', 'cid'] }
          },

          // Execution & Cells
          {
            name: 'start_review_run',
            description: 'Start processing a tabular review asynchronously',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
          },
          {
            name: 'get_review_cells',
            description: 'Read the extracted cells of a tabular review',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
          },
          {
            name: 'run_column',
            description: 'Synchronously extract all cells for a single column',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, cid: { type: 'string' } }, required: ['id', 'cid'] }
          },
          {
            name: 'run_cell',
            description: 'Synchronously re-extract a single cell',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, fid: { type: 'string' }, cid: { type: 'string' } }, required: ['id', 'fid', 'cid'] }
          },
          {
            name: 'export_review',
            description: 'Export a tabular review as CSV or XLSX',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, format: { type: 'string', enum: ['csv', 'xlsx'] } }, required: ['id'] }
          }
        ]
      };
    });

    // Handle tool execution
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      let data = null;

      try {
        switch (name) {
          case 'list_folders': data = await executeHandler(filesHandlers.listFolders, identity, args); break;
          case 'list_files': data = await executeHandler(filesHandlers.listFiles, identity, args); break;
          case 'get_file': data = await executeHandler(filesHandlers.getFile, identity, args); break;
          case 'get_document_profile': data = await executeHandler(profileHandlers.getProfile, identity, args); break;
          case 'get_page': data = await executeHandler(pagesHandlers.getPage, identity, args); break;
          case 'get_section': data = await executeHandler(pagesHandlers.getSection, identity, args); break;
          case 'get_page_range': data = await executeHandler(pagesHandlers.getPageRange, identity, args); break;
          case 'search_chunks': data = await executeHandler(searchHandlers.searchChunks, identity, args); break;
          case 'retrieve_chunks': data = await executeHandler(searchHandlers.retrieveChunks, identity, args); break;
          case 'list_reviews': data = await executeHandler(reviewsHandlers.listReviews, identity, args); break;
          case 'get_review': data = await executeHandler(reviewsHandlers.getReview, identity, args); break;
          case 'create_review': data = await executeHandler(reviewsHandlers.createReview, identity, args); break;
          case 'update_review': data = await executeHandler(reviewsHandlers.updateReview, identity, args); break;
          case 'delete_review': data = await executeHandler(reviewsHandlers.deleteReview, identity, args); break;
          case 'add_column': data = await executeHandler(reviewsHandlers.addColumn, identity, args); break;
          case 'update_column': data = await executeHandler(reviewsHandlers.updateColumn, identity, args); break;
          case 'delete_column': data = await executeHandler(reviewsHandlers.deleteColumn, identity, args); break;
          case 'get_review_cells': data = await executeHandler(reviewsHandlers.getCells, identity, args); break;
          case 'export_review': data = await executeHandler(reviewsHandlers.exportReview, identity, args); break;
          case 'start_review_run': data = await executeHandler(runsHandlers.startRun, identity, args); break;
          case 'run_column': data = await executeHandler(runsHandlers.runColumn, identity, args); break;
          case 'run_cell': data = await executeHandler(runsHandlers.runCell, identity, args); break;
          default: throw new Error(`Tool not found: ${name}`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error executing tool ${name}: ${error.message}` }] };
      }
    });

    // Handle Resource Templates
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      return {
        resourceTemplates: [
          { uriTemplate: "airoom://files/{id}", name: "File metadata", description: "Metadata for a file" },
          { uriTemplate: "airoom://files/{id}/profile", name: "File profile", description: "Document profile/summary" },
          { uriTemplate: "airoom://files/{id}/pages/{page}", name: "File page", description: "A specific page of a file" },
          { uriTemplate: "airoom://folders/{id}", name: "Folder contents", description: "Contents of a folder" },
          { uriTemplate: "airoom://reviews/{id}", name: "Review metadata", description: "Metadata for a review" },
          { uriTemplate: "airoom://reviews/{id}/cells.csv", name: "Review cells CSV", description: "Extracted cells exported as CSV" }
        ]
      };
    });

    // Handle Resource Reading
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      try {
        let data = null;
        let mimeType = 'application/json';

        if (uri.startsWith('airoom://files/')) {
          const parts = uri.replace('airoom://files/', '').split('/');
          const id = parts[0];
          
          if (parts.length === 1) {
            data = await executeHandler(filesHandlers.getFile, identity, { id });
          } else if (parts[1] === 'profile') {
            data = await executeHandler(profileHandlers.getProfile, identity, { id });
          } else if (parts[1] === 'pages' && parts[2]) {
            data = await executeHandler(pagesHandlers.getPage, identity, { id, n: parts[2] });
          }
        } 
        else if (uri.startsWith('airoom://folders/')) {
          const id = uri.replace('airoom://folders/', '');
          data = await executeHandler(filesHandlers.listFiles, identity, { folder_id: id });
        }
        else if (uri.startsWith('airoom://reviews/')) {
          const parts = uri.replace('airoom://reviews/', '').split('/');
          const id = parts[0];

          if (parts.length === 1) {
            data = await executeHandler(reviewsHandlers.getReview, identity, { id });
          } else if (parts[1] === 'cells.csv') {
            data = await executeHandler(reviewsHandlers.exportReview, identity, { id, format: 'csv' });
            mimeType = 'text/csv';
          }
        }

        if (!data) throw new Error("Resource not found or invalid URI");

        return {
          contents: [{
            uri,
            mimeType,
            text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
          }]
        };
      } catch (error) {
        throw new Error(`Failed to read resource ${uri}: ${error.message}`);
      }
    });

    // Handle Prompts List
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: [
          { name: "airoom_search", description: "Instructions for semantic search" },
          { name: "airoom_doc", description: "Instructions for browsing documents" },
          { name: "airoom_review_run", description: "Instructions for creating and running a tabular review" },
          { name: "airoom_review_export", description: "Instructions for exporting a tabular review" }
        ]
      };
    });

    // Handle Prompts
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const name = request.params.name;
      const prompts = {
        airoom_search: "When the user asks you to search for something, use the search_chunks tool. If you need more context around a hit, use retrieve_chunks.",
        airoom_doc: "To understand a document, first use get_document_profile to see its summary and table of contents. Then use get_page, get_section, or get_page_range to read the specific parts required.",
        airoom_review_run: "To create a review: 1. use create_review. Make sure to provide a valid scope, e.g. { kind: 'folder', folderId: null } for all files, or { kind: 'fileSet', fileIds: ['id1', 'id2'] }. 2. use add_column to define the questions. 3. use start_review_run to begin extraction. You must wait for it to complete on the server side.",
        airoom_review_export: "To get the results of a review, use export_review with format='csv' to get structured data, or get_review_cells for raw JSON."
      };
      
      if (!prompts[name]) throw new Error("Prompt not found");

      return {
        description: name,
        messages: [{
          role: 'user',
          content: { type: 'text', text: prompts[name] }
        }]
      };
    });

    await server.connect(transport);

    req.on('close', () => {
      console.log(`[MCP] Connection closed for sessionId: ${sessionId}`);
      transports.delete(sessionId);
      server.close();
    });

  } catch (err) {
    next(err);
  }
});

// Endpoint to receive POST messages for the MCP SSE transport
router.post('/mcp/messages', async (req, res, next) => {
  try {
    const sessionId = req.query.sessionId; 
    console.log(`[MCP] Received POST request. sessionId in query: ${sessionId}. Active sessions:`, Array.from(transports.keys()));
    
    const transport = transports.get(sessionId);
    if (!transport) {
      console.log(`[MCP] Returning 404 because transport not found for ${sessionId}`);
      return res.status(404).send('Session not found');
    }
    
    // Pass req.body as the third argument since Express has already parsed the JSON
    // and consumed the request stream.
    await transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
