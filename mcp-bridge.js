const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { 
    ListToolsRequestSchema, 
    CallToolRequestSchema,
    ListResourceTemplatesRequestSchema,
    ReadResourceRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');

async function main() {
    const sseUrl = new URL("http://localhost:8080/api/v1/mcp");
    const clientTransport = new SSEClientTransport(sseUrl, {
        eventSourceInit: {
            headers: {
                "Authorization": "Bearer airoom_737fd56360824d83_604ff4f7cff9098af525db991a3d2cf650671bd6988bd6c236baf0408241afac",
            }
        },
        requestInit: {
            headers: {
                "Authorization": "Bearer airoom_737fd56360824d83_604ff4f7cff9098af525db991a3d2cf650671bd6988bd6c236baf0408241afac",
            }
        }
    });

    const client = new Client({ name: "mcp-bridge", version: "1.0.0" }, {
        capabilities: { tools: {}, resources: {}, prompts: {} }
    });
    
    await client.connect(clientTransport);

    const stdioTransport = new StdioServerTransport();
    const server = new Server({ name: "stdio-bridge-server", version: "1.0.0" }, {
        capabilities: { tools: {}, resources: {}, prompts: {} }
    });

    server.setRequestHandler(
        ListToolsRequestSchema,
        async (request) => {
            return await client.listTools();
        }
    );

    server.setRequestHandler(
        CallToolRequestSchema,
        async (request) => {
            return await client.callTool({
                name: request.params.name,
                arguments: request.params.arguments
            });
        }
    );

    server.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        async () => {
            return await client.listResourceTemplates();
        }
    );

    server.setRequestHandler(
        ReadResourceRequestSchema,
        async (request) => {
            return await client.readResource({ uri: request.params.uri });
        }
    );

    server.setRequestHandler(
        ListPromptsRequestSchema,
        async () => {
            return await client.listPrompts();
        }
    );

    server.setRequestHandler(
        GetPromptRequestSchema,
        async (request) => {
            return await client.getPrompt({ 
                name: request.params.name, 
                arguments: request.params.arguments 
            });
        }
    );

    await server.connect(stdioTransport);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});