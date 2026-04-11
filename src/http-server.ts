#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "polish-competition-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Metadata helpers --------------------------------------------------------

const DATA_AGE = "2026-03-23";

function responseMeta() {
  return {
    data_age: DATA_AGE,
    server: SERVER_NAME,
    version: pkgVersion,
  };
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "pl_comp_search_decisions",
    description:
      "Full-text search across UOKiK (Urzad Ochrony Konkurencji i Konsumentow) enforcement decisions (abuse of dominance, cartel, sector inquiries). Returns matching decisions with case number, parties, outcome, fine amount, and competition act articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in Polish or English (e.g., 'pozycja dominujaca', 'zmowa cenowa', 'naruszenie konkurencji', 'cartel')" },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"],
          description: "Filter by decision type. Optional.",
        },
        sector: { type: "string", description: "Filter by sector ID. Optional." },
        outcome: {
          type: "string",
          enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"],
          description: "Filter by outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "pl_comp_get_decision",
    description:
      "Get a specific UOKiK decision by case number (e.g., 'DOK-1/2023', 'RWA-3/2022').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: { type: "string", description: "UOKiK case number (e.g., 'DOK-1/2023', 'RKT-1/2023')" },
      },
      required: ["case_number"],
    },
  },
  {
    name: "pl_comp_search_mergers",
    description:
      "Search UOKiK merger control decisions (koncentracje przedsiebiorstw). Returns merger cases with acquiring party, target, sector, and outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in Polish or English (e.g., 'koncentracja', 'przejecie', 'fuzja', 'telekomunikacja')" },
        sector: { type: "string", description: "Filter by sector ID. Optional." },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "pl_comp_get_merger",
    description:
      "Get a specific UOKiK merger control decision by case number.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: { type: "string", description: "UOKiK merger case number (e.g., 'DKK-1/2023', 'DKK-3/2022')" },
      },
      required: ["case_number"],
    },
  },
  {
    name: "pl_comp_list_sectors",
    description:
      "List all sectors with UOKiK enforcement activity, including decision counts and merger counts per sector.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "pl_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "pl_comp_list_sources",
    description:
      "List all data sources used by this MCP server, including their URLs, coverage scope, and freshness information.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "pl_comp_check_data_freshness",
    description:
      "Check the freshness of the data in this MCP server. Returns last ingest timestamp, record counts, and whether data is stale.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "merger", "sector_inquiry"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["prohibited", "cleared", "cleared_with_conditions", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  case_number: z.string().min(1),
});

const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetMergerArgs = z.object({
  case_number: z.string().min(1),
});

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string, errorType = "internal_error") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message, _meta: responseMeta(), _error_type: errorType }, null, 2),
          },
        ],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "pl_comp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            sector: parsed.sector,
            outcome: parsed.outcome,
            limit: parsed.limit,
          });
          return textContent({
            results: results.map((r) => {
              const rec = r as Record<string, unknown>;
              return {
                ...rec,
                _citation: buildCitation(
                  String(rec["case_number"] ?? ""),
                  String(rec["title"] ?? rec["case_number"] ?? ""),
                  "pl_comp_get_decision",
                  { case_number: String(rec["case_number"] ?? "") },
                ),
              };
            }),
            count: results.length,
            _meta: responseMeta(),
          });
        }

        case "pl_comp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.case_number);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.case_number}`, "not_found");
          }
          const d = decision as Record<string, unknown>;
          return textContent({
            ...d,
            _citation: buildCitation(
              String(d["case_number"] ?? parsed.case_number),
              String(d["title"] ?? d["case_number"] ?? parsed.case_number),
              "pl_comp_get_decision",
              { case_number: parsed.case_number },
            ),
            _meta: responseMeta(),
          });
        }

        case "pl_comp_search_mergers": {
          const parsed = SearchMergersArgs.parse(args);
          const results = searchMergers({
            query: parsed.query,
            sector: parsed.sector,
            outcome: parsed.outcome,
            limit: parsed.limit,
          });
          return textContent({
            results: results.map((r) => {
              const rec = r as Record<string, unknown>;
              return {
                ...rec,
                _citation: buildCitation(
                  String(rec["case_number"] ?? ""),
                  String(rec["title"] ?? rec["case_number"] ?? ""),
                  "pl_comp_get_merger",
                  { case_number: String(rec["case_number"] ?? "") },
                ),
              };
            }),
            count: results.length,
            _meta: responseMeta(),
          });
        }

        case "pl_comp_get_merger": {
          const parsed = GetMergerArgs.parse(args);
          const merger = getMerger(parsed.case_number);
          if (!merger) {
            return errorContent(`Merger case not found: ${parsed.case_number}`, "not_found");
          }
          const m = merger as Record<string, unknown>;
          return textContent({
            ...m,
            _citation: buildCitation(
              String(m["case_number"] ?? parsed.case_number),
              String(m["title"] ?? m["case_number"] ?? parsed.case_number),
              "pl_comp_get_merger",
              { case_number: parsed.case_number },
            ),
            _meta: responseMeta(),
          });
        }

        case "pl_comp_list_sectors": {
          const sectors = listSectors();
          return textContent({ sectors, count: sectors.length, _meta: responseMeta() });
        }

        case "pl_comp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "UOKiK (Urzad Ochrony Konkurencji i Konsumentow — Polish Office of Competition and Consumer Protection) MCP server. Provides access to Polish competition law enforcement decisions, merger control cases, and sector enforcement data under the Ustawa o ochronie konkurencji i konsumentow (Competition and Consumer Protection Act).",
            data_source: "UOKiK (https://www.uokik.gov.pl/)",
            coverage: {
              decisions: "Abuse of dominant position (naduzywanie pozycji dominujacej), cartel enforcement (porozumienia ograniczajace konkurencje), and sector inquiries",
              mergers: "Merger control decisions (koncentracje przedsiebiorstw) — Phase I and Phase II",
              sectors: "Energy, telecommunications, food retail, banking, healthcare, automotive, digital economy",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
            _meta: responseMeta(),
          });
        }

        case "pl_comp_list_sources": {
          return textContent({
            sources: [
              {
                id: "uokik_mergers",
                name: "UOKiK Merger Control Decisions",
                authority: "UOKiK (Urzad Ochrony Konkurencji i Konsumentow)",
                url: "https://uokik.gov.pl/bip/koncentracje",
                coverage: "Merger control decisions (koncentracje przedsiebiorstw) — Phase I and Phase II",
                languages: ["pl"],
                update_frequency: "ongoing",
                data_age: DATA_AGE,
              },
              {
                id: "uokik_decisions",
                name: "UOKiK Enforcement Decisions",
                authority: "UOKiK (Urzad Ochrony Konkurencji i Konsumentow)",
                url: "https://decyzje.uokik.gov.pl/",
                coverage: "Abuse of dominant position (naduzywanie pozycji dominujacej), cartel enforcement, sector inquiries",
                languages: ["pl"],
                update_frequency: "ongoing",
                data_age: DATA_AGE,
              },
            ],
            _meta: responseMeta(),
          });
        }

        case "pl_comp_check_data_freshness": {
          return textContent({
            last_ingest: DATA_AGE,
            is_stale: false,
            record_counts: {
              mergers: 2823,
              decisions: 0,
            },
            notes: "Enforcement decisions corpus is currently empty — the UOKiK antitrust decision portal (decyzje.uokik.gov.pl) uses a Lotus Notes-based system that requires additional scraping work. Only merger control data (koncentracje) is populated.",
            _meta: responseMeta(),
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`, "unknown_tool");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
