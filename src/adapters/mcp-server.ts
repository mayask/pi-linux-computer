/**
 * Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0). Works with any MCP client:
 * omp, opencode, Claude Code, Codex, Cursor, …
 *
 * MCP carries no session identity, so the VM scope is LINUX_COMPUTER_SCOPE when the client sets it,
 * otherwise the project directory the server was started in.
 */
import { createInterface } from "node:readline";
import { processScope } from "../core/scope.js";
import { INSTRUCTIONS, TOOLS } from "../core/tools.js";

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number;

interface Message {
  jsonrpc: "2.0";
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

export async function runMcpServer(version: string): Promise<void> {
  const scope = processScope("mcp", process.cwd());
  const inflight = new Map<Id, AbortController>();
  const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const reply = (id: Id, result: unknown) => send({ id, result });
  const fail = (id: Id, code: number, message: string) => send({ id, error: { code, message } });

  async function callTool(id: Id, params: Record<string, unknown>): Promise<void> {
    const tool = TOOLS.find((candidate) => candidate.name === params.name);
    if (!tool) {
      fail(id, -32602, `Unknown tool ${String(params.name)}`);
      return;
    }
    const controller = new AbortController();
    inflight.set(id, controller);
    const progressToken = (params._meta as { progressToken?: Id } | undefined)?.progressToken;
    let progress = 0;
    try {
      const result = await tool.execute((params.arguments as Record<string, unknown>) ?? {}, {
        scope,
        cwd: scope.cwd ?? process.cwd(),
        signal: controller.signal,
        progress: (message) => {
          if (progressToken !== undefined) send({ method: "notifications/progress", params: { progressToken, progress: ++progress, message } });
        },
      });
      reply(id, { content: result.content, isError: result.isError ?? false });
    } catch (error) {
      if (controller.signal.aborted) return;
      reply(id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
    } finally {
      inflight.delete(id);
    }
  }

  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const { id, method, params = {} } = message;
    if (id === undefined) {
      if (method === "notifications/cancelled") inflight.get(params.requestId as Id)?.abort();
      continue;
    }
    switch (method) {
      case "initialize": {
        const requested = String(params.protocolVersion ?? "");
        reply(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "linux-computer", version },
          instructions: `${INSTRUCTIONS}\nVM scope for this server: ${scope.id}.`,
        });
        break;
      }
      case "ping":
        reply(id, {});
        break;
      case "tools/list":
        reply(id, {
          tools: TOOLS.map((tool) => ({ name: tool.name, title: tool.label, description: tool.description, inputSchema: tool.parameters })),
        });
        break;
      case "tools/call": {
        const call = callTool(id, params).finally(() => pending.delete(call));
        pending.add(call);
        break;
      }
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  }
  // The client closed stdin; finish answering what it already asked.
  await Promise.all(pending);
}
