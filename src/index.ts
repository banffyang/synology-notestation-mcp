#!/usr/bin/env node

/**
 * Synology NoteStation MCP Server
 *
 * Provides tools to read/write notes on Synology NoteStation via AI assistants.
 * Uses the DSM Web API to communicate with the NAS.
 *
 * Environment variables:
 *   SYNO_HOST        - NAS hostname or IP (required)
 *   SYNO_PORT        - DSM port (default: 5001)
 *   SYNO_HTTPS       - Use HTTPS (default: true)
 *   SYNO_IGNORE_CERT - Ignore self-signed cert errors (default: false)
 *   SYNO_USERNAME    - DSM username (required)
 *   SYNO_PASSWORD    - DSM password (required)
 *   SYNO_OTP_CODE    - OTP code for 2FA (optional)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { DsmApiClient, DsmConfig } from "./dsm-api.js";
import { NoteStationApi } from "./notestation.js";

// ── Configuration ──────────────────────────────────────────────────────────

function getConfig(): DsmConfig {
  const host = process.env.SYNO_HOST;
  if (!host) throw new Error("SYNO_HOST environment variable is required");
  const username = process.env.SYNO_USERNAME;
  if (!username) throw new Error("SYNO_USERNAME environment variable is required");
  const password = process.env.SYNO_PASSWORD;
  if (!password) throw new Error("SYNO_PASSWORD environment variable is required");

  return {
    host,
    port: parseInt(process.env.SYNO_PORT || "5001", 10),
    https: process.env.SYNO_HTTPS !== "false",
    account: username,
    password: password,
    otpCode: process.env.SYNO_OTP_CODE || undefined,
    ignoreCert: process.env.SYNO_IGNORE_CERT === "true",
  };
}

// ── Server Setup ───────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "synology-notestation-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

let nsApi: NoteStationApi;

async function initClient(): Promise<void> {
  const config = getConfig();
  const client = new DsmApiClient(config);
  await client.login();
  nsApi = new NoteStationApi(client);
}

// ── Tool Handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_notebooks",
      description: "List all NoteStation notebooks",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_notes",
      description: "List all notes in NoteStation, with optional pagination",
      inputSchema: {
        type: "object",
        properties: {
          offset: {
            type: "number",
            description: "Starting index (default: 0)",
            default: 0,
          },
          limit: {
            type: "number",
            description: "Max results (default: 100)",
            default: 100,
          },
        },
      },
    },
    {
      name: "get_note",
      description: "Get a specific note by its ID",
      inputSchema: {
        type: "object",
        properties: {
          note_id: {
            type: "string",
            description: "The note ID to retrieve",
          },
        },
        required: ["note_id"],
      },
    },
    {
      name: "create_note",
      description:
        "Create a new note in NoteStation. Content can be markdown or HTML. REQUIRES NoteStation package installed on DSM 7.2+ and this is an undocumented API method — may fail on some DSM versions, try raw_api_call if it does.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Note title",
          },
          content: {
            type: "string",
            description: "Note content (markdown or HTML)",
          },
          notebook_id: {
            type: "string",
            description: "Notebook ID to place the note in (use list_notebooks to find)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for the note",
          },
        },
        required: ["title", "content", "notebook_id"],
      },
    },
    {
      name: "update_note",
      description:
        "Update an existing note. Only provided fields will be updated. Undocumented API method — may fail on some DSM versions.",
      inputSchema: {
        type: "object",
        properties: {
          note_id: {
            type: "string",
            description: "The note ID to update",
          },
          title: {
            type: "string",
            description: "New title (optional)",
          },
          content: {
            type: "string",
            description: "New content in markdown or HTML (optional)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "New tags (optional)",
          },
        },
        required: ["note_id"],
      },
    },
    {
      name: "delete_note",
      description:
        "Delete a note by ID. Undocumented API method — may fail on some DSM versions.",
      inputSchema: {
        type: "object",
        properties: {
          note_id: {
            type: "string",
            description: "The note ID to delete",
          },
        },
        required: ["note_id"],
      },
    },
    {
      name: "list_tags",
      description: "List all tags used in NoteStation",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_settings",
      description: "Get NoteStation settings information",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_info",
      description: "Get NoteStation general information",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_todos",
      description: "List todo items from NoteStation",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_smart_notes",
      description: "List smart notes from NoteStation",
      inputSchema: {
        type: "object",
        properties: {
          offset: { type: "number", description: "Starting index", default: 0 },
          limit: { type: "number", description: "Max results", default: 50 },
        },
      },
    },
    {
      name: "raw_api_call",
      description:
        "Make a raw DSM API call to NoteStation for undocumented methods. Use this to discover the actual create/update/delete methods if the dedicated tools fail. Check your NAS by opening DSM NoteStation in browser DevTools > Network tab to find the real API calls.",
      inputSchema: {
        type: "object",
        properties: {
          api: {
            type: "string",
            description:
              'The API name, e.g. "SYNO.NoteStation.Note", "SYNO.NoteStation.Notebook"',
          },
          method: {
            type: "string",
            description:
              'The method name, e.g. "create", "set", "delete", "edit"',
          },
          params: {
            type: "object",
            description:
              "Additional parameters as key-value pairs",
            additionalProperties: { type: "string" },
          },
          use_post: {
            type: "boolean",
            description: "Use POST instead of GET (default: false)",
            default: false,
          },
        },
        required: ["api", "method"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── Read operations ──────────────────────────────────────────────

      case "list_notebooks": {
        const notebooks = await nsApi.listNotebooks();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(notebooks, null, 2),
            },
          ],
        };
      }

      case "list_notes": {
        const a = args as { offset?: number; limit?: number };
        const notes = await nsApi.listNotes(a.offset ?? 0, a.limit ?? 100);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(notes, null, 2),
            },
          ],
        };
      }

      case "get_note": {
        const a = args as { note_id: string };
        const note = await nsApi.getNote(a.note_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(note, null, 2),
            },
          ],
        };
      }

      case "list_tags": {
        const tags = await nsApi.listTags();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(tags, null, 2),
            },
          ],
        };
      }

      case "get_settings": {
        const settings = await nsApi.getSettings();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(settings, null, 2),
            },
          ],
        };
      }

      case "get_info": {
        const info = await nsApi.getInfo();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(info, null, 2),
            },
          ],
        };
      }

      case "list_todos": {
        const todos = await nsApi.listTodos();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(todos, null, 2),
            },
          ],
        };
      }

      case "list_smart_notes": {
        const a = args as { offset?: number; limit?: number };
        const smartNotes = await nsApi.listSmartNotes(a.offset ?? 0, a.limit ?? 50);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(smartNotes, null, 2),
            },
          ],
        };
      }

      // ── Write operations (undocumented) ──────────────────────────────

      case "create_note": {
        const a = args as {
          title: string;
          content: string;
          notebook_id: string;
          tags?: string[];
        };
        const result = await nsApi.createNote(
          a.title,
          a.content,
          a.notebook_id,
          a.tags
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "update_note": {
        const a = args as {
          note_id: string;
          title?: string;
          content?: string;
          tags?: string[];
        };
        const result = await nsApi.updateNote(
          a.note_id,
          a.title,
          a.content,
          a.tags
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "delete_note": {
        const a = args as { note_id: string };
        const result = await nsApi.deleteNote(a.note_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // ── Raw API call for discovery ──────────────────────────────────

      case "raw_api_call": {
        const a = args as {
          api: string;
          method: string;
          params?: Record<string, string>;
          use_post?: boolean;
        };
        const result = await nsApi.rawApiCall(
          a.api,
          a.method,
          a.params ?? {},
          a.use_post ?? false
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  } catch (error: any) {
    // If it's an auth error, try reconnecting once
    if (
      error.message?.includes("105") || // session expired
      error.message?.includes("119")    // permission denied
    ) {
      try {
        const config = getConfig();
        const client = new DsmApiClient(config);
        await client.login();
        nsApi = new NoteStationApi(client);

        // Retry the same operation
        // (Simplified: for a real retry we'd need to re-call the handler)
      } catch {}
    }

    // If create/update/delete fails with "Unknown method" or "106", provide guidance
    const isWriteOp = ["create_note", "update_note", "delete_note"].includes(name);
    if (isWriteOp && error.message?.includes("106")) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: error.message,
                hint: "This API method is not available on your DSM version. Try using 'raw_api_call' to discover the correct method. Open DSM NoteStation in your browser, open DevTools > Network tab, create a note manually, and inspect the API call. Then use raw_api_call with the same parameters.",
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message || error}`,
        },
      ],
      isError: true,
    };
  }
});

// ── Startup ────────────────────────────────────────────────────────────────

async function main() {
  try {
    await initClient();
    console.error("Synology NoteStation MCP server initialized successfully");
    console.error(`Connected to NAS: ${process.env.SYNO_HOST}`);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Synology NoteStation MCP server running on stdio");
  } catch (error: any) {
    console.error("Failed to start NoteStation MCP server:", error.message);
    process.exit(1);
  }
}

main();
