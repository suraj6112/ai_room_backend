'use strict';

const Typesense = require('typesense');
require('dotenv').config({ path: 'c:/ai-room-main/microservices/file-processor/.env' });

const client = new Typesense.Client({
  nodes: [{
    host: process.env.TYPESENSE_DOC_HOST,
    port: '443',
    protocol: 'https',
  }],
  apiKey: process.env.TYPESENSE_DOC_API_KEY,
  connectionTimeoutSeconds: 10,
});

const collectionName = 'pdf2md_workspaces_al2bhwTyVjfKAk0g9gWr_chunks';

async function run() {
  try {
    const searchResult = await client.collections(collectionName).documents().search({
      q: '*',
      per_page: 50,
    });

    console.log(`Total chunks found: ${searchResult.found}`);
    const hits = searchResult.hits || [];
    hits.forEach((h, idx) => {
      const d = h.document;
      console.log(`[Chunk ${idx + 1}] ID: ${d.id}`);
      console.log(`  File: ${d.file_name} (${d.folder_path_display})`);
      console.log(`  Chunk Index: ${d.chunk_index} / ${d.chunk_total}`);
      console.log(`  Page Number: ${d.page_number}`);
      console.log(`  Page Span: ${d.page_span_json}`);
      console.log(`  Text Length: ${d.text ? d.text.length : 0}`);
      console.log(`  Text Preview: ${d.text ? d.text.substring(0, 150) + '...' : 'none'}`);
      
      // Count occurrences of "klaviyo" (case-insensitive) in this chunk's text
      const matches = (d.text || '').match(/klaviyo/gi);
      console.log(`  "klaviyo" occurrences in this chunk: ${matches ? matches.length : 0}`);
      console.log('-----------------------------------');
    });
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

run();
