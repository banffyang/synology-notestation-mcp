/**
 * Test client for NoteStation MCP Server
 * Connects via stdio, calls tools, prints results
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "dist", "index.js");

const env = {
  SYNO_HOST: "192.168.50.69",
  SYNO_PORT: "4071",
  SYNO_HTTPS: "true",
  SYNO_IGNORE_CERT: "true",
  SYNO_USERNAME: "ygt1005",
  SYNO_PASSWORD: "jiwon0530!",
  ...process.env,
};

const proc = spawn("node", [serverPath], {
  env,
  stdio: ["pipe", "pipe", "inherit"],
});

let msgId = 0;
const pending = new Map();
let buffer = "";

proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch (e) {
      console.error("Parse error:", e.message, "line:", line.slice(0, 200));
    }
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    pending.set(id, resolve);
    proc.stdin.write(msg + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout for ${method} (id=${id})`));
      }
    }, 30000);
  });
}

async function main() {
  try {
    // Step 1: Initialize
    const initResult = await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0" },
    });
    console.log("--- INITIALIZED ---");

    // Step 2: List tools (verify)
    const toolsResult = await send("tools/list", {});
    const toolNames = toolsResult.result?.tools?.map((t) => t.name) || [];
    console.log("Available tools:", toolNames.join(", "));

    // Step 3: List notebooks
    console.log("\n=== list_notebooks ===");
    const notebooksResult = await send("tools/call", {
      name: "list_notebooks",
      arguments: {},
    });
    const notebooks = JSON.parse(notebooksResult.result.content[0].text);
    console.log(JSON.stringify(notebooks, null, 2));

    // Find '프로젝트' notebook
    const targetNotebook = notebooks.find(
      (nb) => nb.name === "프로젝트" || nb.name === "Project"
    );
    if (!targetNotebook) {
      console.log("\n=== Available notebooks ===");
      notebooks.forEach((nb) => console.log(`  - ${nb.name} (id: ${nb.notebook_id})`));
      throw new Error("Notebook '프로젝트' not found. Pick one from the list above.");
    }
    console.log(`\nUsing notebook: ${targetNotebook.name} (id: ${targetNotebook.notebook_id})`);

    // Step 3: Create note
    console.log("\n=== create_note ===");
    const noteContent = `# Synology NoteStation MCP Server 분석 결과

## 구현 완료된 항목
- MCP 서버 프로젝트: C:\\\\Users\\\\LGSPO\\\\synology-notestation-mcp
- TypeScript 기반 MCP SDK (@modelcontextprotocol/sdk) 사용
- DSM API 클라이언트: 인증(session), API 호출, raw API 지원
- NoteStation 래퍼: 노트북/노트/태그 CRUD

## 제공하는 MCP 툴 (15개)
| 툴 | 설명 | 상태 |
|---|---|---|
| list_notebooks | 모든 노트북 조회 | ✅ |
| list_notes | 노트 목록 조회 | ✅ |
| get_note | 특정 노트 상세 조회 | ✅ |
| list_tags | 태그 목록 조회 | ✅ |
| list_todos | 할 일 목록 조회 | ✅ |
| list_smart_notes | 스마트 노트 조회 | ✅ |
| create_note | 새 노트 생성 | ⚠️ 미문서화 API |
| update_note | 노트 수정 | ⚠️ 미문서화 API |
| delete_note | 노트 삭제 | ⚠️ 미문서화 API |
| raw_api_call | 직접 API 호출 | 🛠️ |

## 설정 파일
- opencode.json에 notestation MCP 서버 등록 완료
- NAS 연결 정보: 192.168.50.69:4071 (HTTPS)

## 주요 이슈
- NoteStation의 create/update/delete API는 공식 문서화되지 않음
- DSM 웹 UI의 DevTools > Network 분석을 통해 실제 메서드 확인 필요
- raw_api_call 툴로 우회 호출 가능`;

    const createResult = await send("tools/call", {
      name: "create_note",
      arguments: {
        title: "2025-06-12 API 분석",
        content: noteContent,
        notebook_id: targetNotebook.notebook_id,
        tags: ["API", "분석", "NoteStation"],
      },
    });
    console.log(JSON.stringify(createResult.result || createResult, null, 2));
    if (createResult.result?.isError) {
      console.log("\n❌ create_note failed. Trying raw_api_call as fallback...");
      // Try alternative method names
      for (const methodName of ["new", "add", "set", "save"]) {
        console.log(`\nTrying raw_api_call: SYNO.NoteStation.Note.${methodName}`);
        const rawResult = await send("tools/call", {
          name: "raw_api_call",
          arguments: {
            api: "SYNO.NoteStation.Note",
            method: methodName,
            params: {
              title: "2025-06-12 API 분석",
              content: noteContent,
              notebook_id: targetNotebook.notebook_id,
            },
            use_post: true,
          },
        });
        console.log(JSON.stringify(rawResult.result || rawResult, null, 2));
        if (!rawResult.result?.isError) {
          console.log(`\n✅ Note created with method: ${methodName}`);
          break;
        }
      }
    } else {
      console.log("\n✅ Note created successfully!");
    }
  } catch (err) {
    console.error("\n❌ Error:", err.message);
  } finally {
    // Graceful shutdown
    try {
      await send("shutdown");
    } catch {}
    proc.stdin.end();
    setTimeout(() => proc.kill(), 2000);
  }
}

main();
