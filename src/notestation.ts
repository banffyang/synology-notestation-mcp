/**
 * NoteStation API Wrapper
 */
import { DsmApiClient } from "./dsm-api.js";

export interface Notebook {
  notebook_id: string;
  name: string;
  note_count: number;
  created_time?: number;
}

export interface NoteTag {
  tag_name: string;
  note_count: number;
}

export interface Note {
  note_id: string;
  title: string;
  content: string;
  notebook_id: string;
  created_time?: number;
  updated_time?: number;
  tags?: string[];
}

export class NoteStationApi {
  private client: DsmApiClient;

  constructor(client: DsmApiClient) {
    this.client = client;
  }

  /**
   * Get NoteStation settings info
   */
  async getSettings(): Promise<any> {
    return this.client.callNoteStation("SYNO.NoteStation.Setting", "get");
  }

  /**
   * Initialize NoteStation settings (one-time setup)
   */
  async initSettings(): Promise<any> {
    return this.client.callNoteStation("SYNO.NoteStation.Setting", "init");
  }

  /**
   * Get NoteStation general info
   */
  async getInfo(): Promise<any> {
    return this.client.callNoteStation("SYNO.NoteStation.Info", "get");
  }

  /**
   * List all notebooks
   */
  async listNotebooks(): Promise<Notebook[]> {
    const data = await this.client.callNoteStation("SYNO.NoteStation.Notebook", "list");
    const notebooks = data.data?.notebooks ?? data.data ?? [];
    return (Array.isArray(notebooks) ? notebooks : []).map((nb: any) => ({
      notebook_id: nb.object_id,
      name: nb.title,
      note_count: Array.isArray(nb.items) ? nb.items.length : 0,
      created_time: nb.ctime,
    }));
  }

  /**
   * Create a new notebook (undocumented method - may not work on all DSM versions)
   */
  async createNotebook(name: string): Promise<any> {
    return this.client.callNoteStationPost("SYNO.NoteStation.Notebook", "create", { name });
  }

  /**
   * List all notes (with optional pagination)
   */
  async listNotes(offset: number = 0, limit: number = 100): Promise<Note[]> {
    const data = await this.client.callNoteStation("SYNO.NoteStation.Note", "list", {
      offset,
      limit,
    });
    const notes = data.data?.notes ?? data.data ?? [];
    return (Array.isArray(notes) ? notes : []).map((n: any) => ({
      note_id: n.object_id,
      title: n.title,
      content: n.brief || "",
      notebook_id: n.parent_id,
      created_time: n.ctime,
      updated_time: n.mtime,
      tags: n.tag ? (Array.isArray(n.tag) ? n.tag : [n.tag]) : [],
    }));
  }

  /**
   * Get a specific note by ID
   */
  async getNote(noteId: string): Promise<Note | null> {
    const data = await this.client.callNoteStation("SYNO.NoteStation.Note", "get", {
      object_id: noteId,
    });
    const n = data.data;
    if (!n) return null;
    return {
      note_id: n.object_id,
      title: n.title,
      content: n.content || n.brief || "",
      notebook_id: n.parent_id,
      created_time: n.ctime,
      updated_time: n.mtime,
      tags: n.tag ? (Array.isArray(n.tag) ? n.tag : [n.tag]) : [],
    };
  }

  /**
   * Create a new note
   */
  async createNote(
    title: string,
    content: string,
    notebookId: string,
    tags?: string[]
  ): Promise<any> {
    const params: Record<string, string | number> = {
      title,
      content: this.markdownToHtml(content),
      parent_id: notebookId,
    };
    if (tags && tags.length > 0) {
      params.tag = JSON.stringify(tags);
    }
    return this.client.callNoteStationPost("SYNO.NoteStation.Note", "create", params);
  }

  /**
   * Update a note
   */
  async updateNote(
    noteId: string,
    title?: string,
    content?: string,
    tags?: string[]
  ): Promise<any> {
    const params: Record<string, string | number> = {
      object_id: noteId,
    };
    if (title !== undefined) params.title = title;
    if (content !== undefined) params.content = this.markdownToHtml(content);
    if (tags !== undefined) params.tag = JSON.stringify(tags);
    return this.client.callNoteStationPost("SYNO.NoteStation.Note", "update", params);
  }

  /**
   * Delete a note
   */
  async deleteNote(noteId: string): Promise<any> {
    return this.client.callNoteStationPost("SYNO.NoteStation.Note", "delete", {
      object_id: noteId,
    });
  }

  /**
   * List all tags
   */
  async listTags(): Promise<NoteTag[]> {
    const data = await this.client.callNoteStation("SYNO.NoteStation.Tag", "list");
    return data.data?.tags ?? data.data ?? [];
  }

  /**
   * List todo items
   */
  async listTodos(): Promise<any[]> {
    const data = await this.client.callNoteStation("SYNO.NoteStation.Todo", "list");
    return data.data?.todos ?? data.data ?? [];
  }

  /**
   * List shortcuts
   */
  async listShortcuts(): Promise<any[]> {
    const data = await this.client.callNoteStation("SYNO.NoteStation.Shortcut", "list");
    return data.data?.shortcuts ?? data.data ?? [];
  }

  /**
   * List smart notes
   */
  async listSmartNotes(offset: number = 0, limit: number = 50): Promise<any[]> {
    const data = await this.client.callNoteStation("SYNO.NoteStation.Smart", "list", {
      offset,
      limit,
    });
    return data.data?.smart_notes ?? data.data ?? [];
  }

  /**
   * Raw API call for discovering undocumented methods
   */
  async rawApiCall(
    apiName: string,
    method: string,
    params: Record<string, string | number> = {},
    usePost: boolean = false
  ): Promise<any> {
    return this.client.rawCall(apiName, method, params, usePost);
  }

  /**
   * Simple markdown to HTML converter
   */
  private markdownToHtml(md: string): string {
    // If already contains HTML tags, return as-is
    if (/<[a-z][\s\S]*>/i.test(md)) return md;

    let html = md
      // Escape HTML special chars first
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // Headers
      .replace(/^######\s+(.+)$/gm, "<h6>$1</h6>")
      .replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>")
      .replace(/^####\s+(.+)$/gm, "<h4>$1</h4>")
      .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
      .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
      .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
      // Horizontal rules
      .replace(/^---$/gm, "<hr>")
      // Bold
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      // Italic
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      // Inline code
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // Images
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // Code blocks (must be before other block handling)
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      // Unordered lists
      .replace(/^\s*[-*+]\s+(.+)$/gm, "<li>$1</li>")
      // Ordered lists
      .replace(/^\s*\d+\.\s+(.+)$/gm, "<li>$1</li>")
      // Line breaks
      .replace(/\n\n+/g, "</p><p>")
      .replace(/\n/g, "<br>");

    // Wrap consecutive <li> in <ul>
    html = html.replace(/((?:<li>.*?<\/li><br>?)+)/g, (match) => {
      const items = match.replace(/<br>/g, "").replace(/<\/li><br>/g, "</li>");
      return `<ul>${items}</ul>`;
    });

    // Wrap in paragraph if not already wrapped
    if (!html.startsWith("<h") && !html.startsWith("<p") && !html.startsWith("<ul") && !html.startsWith("<pre")) {
      html = `<p>${html}</p>`;
    }

    return html;
  }
}
