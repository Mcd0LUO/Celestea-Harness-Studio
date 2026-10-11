/**
 * The official-SDK side of the `McpTransport` seam.
 *
 * This is the ONLY module that imports `@modelcontextprotocol/sdk`. Everything else
 * in the package speaks the seam from transport.ts, which is what lets the
 * lifecycle and tool-adaptation tests run with a fake transport and no process.
 *
 * Two things are decided here and nowhere else:
 *   - **env scrubbing** — the child starts from the scrubbed parent environment
 *     (transport.ts [childEnvironment]); otherwise any third-party server would
 *     inherit every credential on the machine.
 *   - **no redirects** — `redirect: "manual"` + `redirectPolicy: "same-origin"`.
 *     The endpoint is operator configuration, and following a redirect turns that
 *     fixed target into an arbitrary one (docs/feature/mcp-client.md §7.3).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { childEnvironment, type McpClient, type McpTransport, type McpTransportFactory } from "./transport.js";
import type { McpCallResult, McpRemoteTool, McpServerConfig } from "./types.js";

const CLIENT_INFO = { name: "celestea-mcp", version: "0.1.0" } as const;

interface SdkClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(params?: unknown, options?: { signal?: AbortSignal }): Promise<{ tools: unknown[] }>;
  callTool(
    params: { name: string; arguments?: unknown },
    ...rest: unknown[]
  ): Promise<unknown>;
  close(): Promise<void>;
}

function asToolList(payload: { tools: unknown[] }): McpRemoteTool[] {
  return payload.tools.filter((t): t is McpRemoteTool => typeof t === "object" && t !== null && "name" in t);
}

/** Adapt one SDK `Client` to the seam. */
class SdkMcpClient implements McpClient {
  constructor(private readonly client: SdkClientLike) {}

  async listTools(signal?: AbortSignal): Promise<readonly McpRemoteTool[]> {
    const payload = await this.client.listTools(undefined, signal === undefined ? undefined : { signal });
    return asToolList(payload);
  }

  async callTool(tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const result = (await this.client.callTool(
      { name: tool, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      signal === undefined ? undefined : { signal },
    )) as McpCallResult;
    return { ...result, content: Array.isArray(result.content) ? result.content : [] };
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

/** stdio: spawn the configured command with the scrubbed environment. */
class StdioSdkTransport implements McpTransport {
  private client: SdkMcpClient | null = null;

  constructor(private readonly server: McpServerConfig, private readonly parentEnv: NodeJS.ProcessEnv) {}

  async connect(): Promise<McpClient> {
    const transport = new StdioClientTransport({
      command: this.server.command ?? "",
      args: [...this.server.args],
      env: childEnvironment(this.parentEnv, this.server.env),
      ...(this.server.cwd === undefined ? {} : { cwd: this.server.cwd }),
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} }) as unknown as SdkClientLike;
    await client.connect(transport);
    this.client = new SdkMcpClient(client);
    return this.client;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client !== null) await client.close();
  }
}

/** Streamable HTTP: a fixed operator-configured endpoint, never a derived one. */
class HttpSdkTransport implements McpTransport {
  private client: SdkMcpClient | null = null;

  constructor(private readonly server: McpServerConfig) {}

  async connect(): Promise<McpClient> {
    const transport = new StreamableHTTPClientTransport(new URL(this.server.url ?? ""), {
      requestInit: { redirect: "manual", headers: { ...this.server.headers } },
      redirectPolicy: "same-origin",
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} }) as unknown as SdkClientLike;
    await client.connect(transport);
    this.client = new SdkMcpClient(client);
    return this.client;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client !== null) await client.close();
  }
}

/** The production factory: the one place that knows which SDK transport to use. */
export function sdkTransportFactory(parentEnv: NodeJS.ProcessEnv = process.env): McpTransportFactory {
  return (server: McpServerConfig): McpTransport =>
    server.transport === "stdio" ? new StdioSdkTransport(server, parentEnv) : new HttpSdkTransport(server);
}
