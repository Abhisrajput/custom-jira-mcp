// index.js – Jira MCP Server (Unified get_issues with description)

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const app = express();
app.use(express.json());

// ==============================
// ENV / CONFIG
// ==============================
const API_KEY = process.env.MCP_API_KEY || "123456";

console.log("=== Environment Variables ===");
console.log("JIRA_BASE_URL:", process.env.JIRA_BASE_URL);
console.log("JIRA_EMAIL:", process.env.JIRA_EMAIL);
console.log(
  "JIRA_API_TOKEN:",
  process.env.JIRA_API_TOKEN ? "[SET]" : "[NOT SET]"
);

// ==============================
// JIRA CLIENT
// ==============================
const jira = axios.create({
  baseURL: process.env.JIRA_BASE_URL,
  timeout: 15000,
  auth: {
    username: process.env.JIRA_EMAIL,
    password: process.env.JIRA_API_TOKEN,
  },
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
  },
});

// ==============================
// ADF → TEXT CONVERTER
// ==============================
function extractDescription(adf) {
  if (!adf || !Array.isArray(adf.content)) return "";

  let text = "";

  for (const block of adf.content) {
    if (block.type === "paragraph" && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item.type === "text") {
          text += item.text;
        }
      }
      text += "\n";
    }
  }

  return text.trim();
}

// ==============================
// MCP SERVER
// ==============================
function createMcpServer() {
  const mcpServer = new McpServer({
    name: "jira-mcp",
    version: "1.2.0",
  });

  // ------------------------------------------------
  // List Projects
  // ------------------------------------------------
  mcpServer.tool(
    "list_projects",
    "List all Jira projects",
    {},
    async () => {
      console.log("=== list_projects called ===");

      try {
        const { data } = await jira.get(
          "/rest/api/3/project/search?maxResults=1000"
        );

        const projects = data.values.map((p) => ({
          key: p.key,
          name: p.name,
          id: p.id,
        }));

        return {
          content: [
            { type: "text", text: JSON.stringify(projects, null, 2) },
          ],
        };
      } catch (error) {
        console.error("list_projects error:", error.message);
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    }
  );

  // ------------------------------------------------
  // ✅ Unified get_issues tool (with description)
  // ------------------------------------------------
  mcpServer.tool(
    "get_issues",
    "Get Jira issues by issue key or JQL (includes description)",
    {
      issueKey: z
        .string()
        .optional()
        .describe("Single issue key (e.g., AT-123)"),
      jql: z
        .string()
        .optional()
        .describe("JQL query to search issues"),
      maxResults: z.number().optional().default(50),
    },
    async ({ issueKey, jql, maxResults }) => {
      console.log("=== get_issues called ===");

      try {
        // -------------------------
        // Single Issue
        // -------------------------
        if (issueKey) {
          console.log("Fetching issue:", issueKey);

          const { data } = await jira.get(
            `/rest/api/3/issue/${issueKey}`
          );

          const issue = {
            key: data.key,
            summary: data.fields.summary,
            description: extractDescription(data.fields.description),
            status: data.fields.status?.name,
            assignee:
              data.fields.assignee?.displayName || "Unassigned",
          };

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { mode: "single", issue },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // -------------------------
        // JQL Search
        // -------------------------
        if (jql) {
          console.log("Searching with JQL:", jql);

          const url =
            `/rest/api/3/search/jql` +
            `?jql=${encodeURIComponent(jql)}` +
            `&maxResults=${maxResults}` +
            `&fields=key,summary,status,assignee,description`;

          const { data } = await jira.get(url);

          const issues = data.issues.map((i) => ({
            key: i.key,
            summary: i.fields.summary,
            description: extractDescription(i.fields.description),
            status: i.fields.status?.name,
            assignee:
              i.fields.assignee?.displayName || "Unassigned",
          }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    mode: "search",
                    total: issues.length,
                    issues,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // -------------------------
        // Validation Error
        // -------------------------
        return {
          content: [
            {
              type: "text",
              text: "Error: Provide either issueKey or jql",
            },
          ],
          isError: true,
        };
      } catch (error) {
        console.error("get_issues error:", error.message);
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    }
  );

  return mcpServer;
}

// ==============================
// API KEY GUARD
// ==============================
app.use("/mcp", (req, res, next) => {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ==============================
// MCP ENDPOINT
// ==============================
app.post("/mcp", async (req, res) => {
  console.log("=== MCP request ===");

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const mcpServer = createMcpServer();

    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// ==============================
// HEALTH CHECK
// ==============================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ==============================
// START SERVER
// ==============================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Jira MCP Server running at http://localhost:${port}`);
});
