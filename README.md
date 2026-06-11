# Synology NoteStation MCP Server

Model Context Protocol (MCP) server for **Synology NoteStation** — allows AI assistants to read and write notes on your NAS via the DSM Web API.

## Features

- **12 MCP tools** — notebooks, notes, tags, todos, smart notes
- **DSM 7.2+ compatible** — handles X-SYNO-TOKEN CSRF auth
- **Self-signed certificate support** — works with NAS HTTPS out of the box
- **opencode / Claude / any MCP client** — stdio transport

## Prerequisites

- Node.js 18+
- Synology NAS with **NoteStation** package installed
- DSM account with NoteStation access

## Quick Start

### 1. Install & Build

```bash
git clone https://github.com/banffyang/synology-notestation-mcp.git
cd synology-notestation-mcp
npm install
npm run build
```

### 2. Configure Environment

```bash
set SYNO_HOST=192.168.50.69
set SYNO_PORT=4071
set SYNO_HTTPS=true
set SYNO_IGNORE_CERT=true
set SYNO_USERNAME=your_username
set SYNO_PASSWORD=your_password
```

### 3. Run

```bash
npm start
```

The server starts on stdio and waits for MCP protocol messages.

## MCP Tools

| Tool | Description | Status |
|---|---|---|
| `list_notebooks` | List all notebooks with note counts | ✅ |
| `list_notes` | List notes (pagination supported) | ✅ |
| `get_note` | Get full note content | ✅ |
| `create_note` | Create a new note | ✅ |
| `update_note` | Update note title/content/tags | ✅ |
| `delete_note` | Delete a note | ✅ |
| `list_tags` | List all tags | ✅ |
| `get_settings` | Get NoteStation settings | ✅ |
| `get_info` | Get NoteStation info | ✅ |
| `list_todos` | List todo items | ✅ |
| `list_smart_notes` | List smart notes | ✅ |
| `raw_api_call` | Direct DSM API call (for debugging) | ✅ |

## opencode Integration

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "notestation": {
      "type": "local",
      "command": ["node", "C:\\path\\to\\synology-notestation-mcp\\dist\\index.js"],
      "enabled": true,
      "environment": {
        "SYNO_HOST": "192.168.50.69",
        "SYNO_PORT": "4071",
        "SYNO_HTTPS": "true",
        "SYNO_IGNORE_CERT": "true",
        "SYNO_USERNAME": "your_username",
        "SYNO_PASSWORD": "your_password"
      }
    }
  }
}
```

## Technical Notes

| Issue | Solution |
|---|---|
| DSM 7.2+ requires CSRF token | `X-SYNO-TOKEN` header from login response |
| API discovery fails with prefix query | Use `query=all` then filter for `SYNO.NoteStation.*` |
| Note API uses `object_id` not `note_id` | Field mapping layer in `notestation.ts` |
| Create note requires `parent_id` not `notebook_id` | Parameter translation in `createNote()` |
| Self-signed HTTPS certificates | `NODE_TLS_REJECT_UNAUTHORIZED=0` |

## Project Structure

```
src/
├── dsm-api.ts          # DSM auth, session, API discovery, fetch
├── notestation.ts      # NoteStation CRUD wrapper
└── index.ts            # MCP server entry point (12 tools)
```

## License

MIT
