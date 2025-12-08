// index.js – Jira + Risk Management MCP Server for Copilot Studio
// Version: 2.0.0
// Updated: Working with Copilot Studio MCP Streamable HTTP

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const XLSX = require("xlsx");

const app = express();
const API_KEY = process.env.MCP_API_KEY || "123456";

// === CORS & JSON Parsing ===
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, x-api-key, Authorization, Mcp-Session-Id");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "50mb" }));

// === Startup Logs ===
console.log("\n=== Environment Variables ===");
console.log("JIRA_BASE_URL:", process.env.JIRA_BASE_URL || "[NOT SET]");
console.log("JIRA_EMAIL:", process.env.JIRA_EMAIL || "[NOT SET]");
console.log("JIRA_API_TOKEN:", process.env.JIRA_API_TOKEN ? "[SET]" : "[NOT SET]");
console.log("MCP_API_KEY:", API_KEY);

// === In-Memory Storage ===
let riskData = {
  lastUpdated: null,
  filename: null,
  risks: [],
  headers: [],
  summary: {}
};

// === Jira Client ===
const jira = axios.create({
  baseURL: process.env.JIRA_BASE_URL,
  timeout: 15000,
  auth: {
    username: process.env.JIRA_EMAIL,
    password: process.env.JIRA_API_TOKEN,
  },
});

// === Excel Parsing Function ===
function parseExcelFromBase64(base64Data, filename) {
  try {
    const buffer = Buffer.from(base64Data, "base64");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);
    const headers = data.length > 0 ? Object.keys(data[0]) : [];

    return {
      success: true,
      filename: filename || "uploaded_file.xlsx",
      sheetName,
      headers,
      rowCount: data.length,
      data
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// === MCP Server Factory ===
function createMcpServer() {
  const mcpServer = new McpServer({
    name: "jira-risk-mcp-server",
    version: "2.0.0",
  });

  // =====================
  // JIRA TOOLS
  // =====================

  // Tool 1: List Projects
  mcpServer.tool(
    "list_projects",
    "List all Jira projects accessible to the user",
    {},
    async () => {
      console.log(">>> Tool called: list_projects");
      try {
        const { data } = await jira.get("/rest/api/3/project/search?maxResults=100");
        const projects = data.values.map((p) => ({
          key: p.key,
          name: p.name,
          id: p.id,
          type: p.projectTypeKey
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, count: projects.length, projects }, null, 2) }]
        };
      } catch (error) {
        console.log("Error:", error.message);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: error.message }) }],
          isError: true
        };
      }
    }
  );

  // Tool 2: Search Issues
  mcpServer.tool(
    "search_issues",
    "Search Jira issues using JQL query",
    {
      jql: z.string().describe("JQL query string, e.g., 'project = AT'"),
      maxResults: z.number().optional().default(50).describe("Maximum results to return")
    },
    async ({ jql, maxResults }) => {
      console.log(">>> Tool called: search_issues");
      console.log("    JQL:", jql);
      try {
        const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults || 50}&fields=key,summary,status,assignee,priority,issuetype,created,updated`;
        const { data } = await jira.get(url);
        
        const issues = data.issues.map((i) => ({
          key: i.key,
          summary: i.fields.summary,
          status: i.fields.status?.name || "Unknown",
          assignee: i.fields.assignee?.displayName || "Unassigned",
          priority: i.fields.priority?.name || "None",
          type: i.fields.issuetype?.name || "Unknown",
          created: i.fields.created,
          updated: i.fields.updated
        }));

        console.log("    Found:", issues.length, "issues");
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, total: issues.length, issues }, null, 2) }]
        };
      } catch (error) {
        console.log("Error:", error.message);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: error.message }) }],
          isError: true
        };
      }
    }
  );

  // Tool 3: Get Issue Details
  mcpServer.tool(
    "get_issue",
    "Get detailed information about a specific Jira issue",
    {
      issueKey: z.string().describe("Issue key, e.g., 'AT-1'")
    },
    async ({ issueKey }) => {
      console.log(">>> Tool called: get_issue", issueKey);
      try {
        const { data } = await jira.get(`/rest/api/3/issue/${issueKey}`);
        const issue = {
          key: data.key,
          summary: data.fields.summary,
          description: data.fields.description,
          status: data.fields.status?.name,
          assignee: data.fields.assignee?.displayName || "Unassigned",
          reporter: data.fields.reporter?.displayName || "Unknown",
          priority: data.fields.priority?.name || "None",
          type: data.fields.issuetype?.name,
          created: data.fields.created,
          updated: data.fields.updated,
          labels: data.fields.labels || []
        };
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, issue }, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: error.message }) }],
          isError: true
        };
      }
    }
  );

  // Tool 4: Create Issue
  mcpServer.tool(
    "create_issue",
    "Create a new Jira issue",
    {
      projectKey: z.string().describe("Project key, e.g., 'AT'"),
      summary: z.string().describe("Issue title/summary"),
      description: z.string().optional().describe("Issue description"),
      issueType: z.string().optional().default("Task").describe("Issue type: Task, Bug, Story, Epic")
    },
    async ({ projectKey, summary, description, issueType }) => {
      console.log(">>> Tool called: create_issue");
      try {
        const issueData = {
          fields: {
            project: { key: projectKey },
            summary,
            description: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: description || "" }] }]
            },
            issuetype: { name: issueType || "Task" }
          }
        };
        const { data } = await jira.post("/rest/api/3/issue", issueData);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              key: data.key,
              id: data.id,
              url: `${process.env.JIRA_BASE_URL}/browse/${data.key}`
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: error.response?.data?.errors || error.message }) }],
          isError: true
        };
      }
    }
  );

  // =====================
  // RISK MANAGEMENT TOOLS
  // =====================

  // Tool 5: Upload Risk File (Base64)
  mcpServer.tool(
    "upload_risk_file",
    "Upload and parse a Risk Management Excel file from base64 data",
    {
      base64Data: z.string().describe("Base64 encoded Excel file content"),
      filename: z.string().optional().describe("Original filename")
    },
    async ({ base64Data, filename }) => {
      console.log(">>> Tool called: upload_risk_file");
      try {
        const parsed = parseExcelFromBase64(base64Data, filename);
        
        if (!parsed.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: parsed.error }) }],
            isError: true
          };
        }

        // Store in memory
        riskData = {
          lastUpdated: new Date().toISOString(),
          filename: parsed.filename,
          risks: parsed.data,
          headers: parsed.headers,
          summary: {
            totalRisks: parsed.rowCount,
            sheetName: parsed.sheetName
          }
        };

        console.log("    Stored", parsed.rowCount, "risks");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Risk file uploaded successfully",
              filename: parsed.filename,
              totalRisks: parsed.rowCount,
              headers: parsed.headers,
              preview: parsed.data.slice(0, 3)
            }, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: error.message }) }],
          isError: true
        };
      }
    }
  );

  // Tool 6: Get Risk Data
  mcpServer.tool(
    "get_risk_data",
    "Get the uploaded risk management data",
    {},
    async () => {
      console.log(">>> Tool called: get_risk_data");
      if (!riskData.risks.length) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, message: "No risk data uploaded. Please upload a risk file first." }) }]
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            filename: riskData.filename,
            lastUpdated: riskData.lastUpdated,
            totalRisks: riskData.risks.length,
            headers: riskData.headers,
            risks: riskData.risks
          }, null, 2)
        }]
      };
    }
  );

  // Tool 7: Get Risk Summary
  mcpServer.tool(
    "get_risk_summary",
    "Get a summary of risks grouped by a column (e.g., Status, Severity)",
    {
      groupBy: z.string().optional().describe("Column name to group by")
    },
    async ({ groupBy }) => {
      console.log(">>> Tool called: get_risk_summary");
      if (!riskData.risks.length) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, message: "No risk data uploaded." }) }]
        };
      }

      // Find a column to group by
      const column = groupBy || riskData.headers.find(h =>
        h.toLowerCase().includes("status") ||
        h.toLowerCase().includes("severity") ||
        h.toLowerCase().includes("priority")
      ) || riskData.headers[0];

      const grouped = {};
      riskData.risks.forEach(risk => {
        const value = risk[column] || "Unknown";
        grouped[value] = (grouped[value] || 0) + 1;
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            groupedBy: column,
            totalRisks: riskData.risks.length,
            summary: grouped
          }, null, 2)
        }]
      };
    }
  );

  // Tool 8: Query Risks
  mcpServer.tool(
    "query_risks",
    "Filter/search risks by column value",
    {
      column: z.string().describe("Column name to filter"),
      value: z.string().describe("Value to search for"),
      operator: z.enum(["equals", "contains"]).optional().default("contains").describe("Match type")
    },
    async ({ column, value, operator }) => {
      console.log(">>> Tool called: query_risks");
      if (!riskData.risks.length) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, message: "No risk data uploaded." }) }]
        };
      }

      const filtered = riskData.risks.filter(risk => {
        const cellValue = String(risk[column] || "").toLowerCase();
        const searchValue = value.toLowerCase();
        return operator === "equals"
          ? cellValue === searchValue
          : cellValue.includes(searchValue);
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            query: { column, operator, value },
            resultCount: filtered.length,
            results: filtered
          }, null, 2)
        }]
      };
    }
  );

  // =====================
  // COMBINED REPORT TOOL
  // =====================

  // Tool 9: Generate Status Report
  mcpServer.tool(
    "generate_status_report",
    "Generate a combined status report with Jira issues and Risk data",
    {
      projectKey: z.string().describe("Jira project key, e.g., 'AT'"),
      includeRisks: z.boolean().optional().default(true).describe("Include risk data in report")
    },
    async ({ projectKey, includeRisks }) => {
      console.log(">>> Tool called: generate_status_report");
      console.log("    Project:", projectKey, "| Include Risks:", includeRisks);

      const report = {
        generatedAt: new Date().toISOString(),
        project: projectKey,
        jira: { success: false },
        risks: { success: false },
        summary: {}
      };

      // Fetch Jira Data
      try {
        const jql = `project = ${projectKey} ORDER BY updated DESC`;
        const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=key,summary,status,assignee,priority,issuetype`;
        const { data } = await jira.get(url);

        const issues = data.issues.map((i) => ({
          key: i.key,
          summary: i.fields.summary,
          status: i.fields.status?.name,
          assignee: i.fields.assignee?.displayName || "Unassigned",
          priority: i.fields.priority?.name,
          type: i.fields.issuetype?.name
        }));

        // Group by status
        const byStatus = {};
        issues.forEach(issue => {
          byStatus[issue.status] = (byStatus[issue.status] || 0) + 1;
        });

        // Group by type
        const byType = {};
        issues.forEach(issue => {
          byType[issue.type] = (byType[issue.type] || 0) + 1;
        });

        report.jira = {
          success: true,
          totalIssues: issues.length,
          byStatus,
          byType,
          issues
        };

        report.summary.totalIssues = issues.length;
        report.summary.issuesByStatus = byStatus;
      } catch (error) {
        report.jira = { success: false, error: error.message };
      }

      // Include Risk Data
      if (includeRisks && riskData.risks.length > 0) {
        const riskColumn = riskData.headers.find(h =>
          h.toLowerCase().includes("status") ||
          h.toLowerCase().includes("severity")
        );

        const byRiskStatus = {};
        if (riskColumn) {
          riskData.risks.forEach(risk => {
            const value = risk[riskColumn] || "Unknown";
            byRiskStatus[value] = (byRiskStatus[value] || 0) + 1;
          });
        }

        report.risks = {
          success: true,
          filename: riskData.filename,
          lastUpdated: riskData.lastUpdated,
          totalRisks: riskData.risks.length,
          groupedBy: riskColumn,
          byStatus: byRiskStatus,
          risks: riskData.risks
        };

        report.summary.totalRisks = riskData.risks.length;
        report.summary.risksByStatus = byRiskStatus;
      } else if (includeRisks) {
        report.risks = { success: false, message: "No risk data uploaded" };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }]
      };
    }
  );

  // Tool 10: Clear Risk Data
  mcpServer.tool(
    "clear_risk_data",
    "Clear the stored risk management data",
    {},
    async () => {
      console.log(">>> Tool called: clear_risk_data");
      riskData = { lastUpdated: null, filename: null, risks: [], headers: [], summary: {} };
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, message: "Risk data cleared" }) }]
      };
    }
  );

  return mcpServer;
}

// =====================
// REST API ENDPOINTS
// (For Power Automate / Direct HTTP calls)
// =====================

// Upload Risk File (REST)
app.post("/api/upload-risk", (req, res) => {
  console.log(">>> REST API: POST /api/upload-risk");
  try {
    const { base64Data, filename } = req.body;
    if (!base64Data) {
      return res.status(400).json({ success: false, error: "base64Data is required" });
    }

    const parsed = parseExcelFromBase64(base64Data, filename);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error });
    }

    riskData = {
      lastUpdated: new Date().toISOString(),
      filename: parsed.filename,
      risks: parsed.data,
      headers: parsed.headers,
      summary: { totalRisks: parsed.rowCount }
    };

    res.json({
      success: true,
      message: "Risk file uploaded",
      filename: parsed.filename,
      totalRisks: parsed.rowCount,
      headers: parsed.headers
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Risk Data (REST)
app.get("/api/risks", (req, res) => {
  console.log(">>> REST API: GET /api/risks");
  res.json(riskData);
});

// Generate Report (REST)
app.post("/api/generate-report", async (req, res) => {
  console.log(">>> REST API: POST /api/generate-report");
  try {
    const { projectKey, includeRisks = true } = req.body;
    if (!projectKey) {
      return res.status(400).json({ success: false, error: "projectKey is required" });
    }

    const report = { generatedAt: new Date().toISOString(), project: projectKey };

    // Fetch Jira
    try {
      const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(`project = ${projectKey}`)}&maxResults=100&fields=key,summary,status,assignee,priority,issuetype`;
      const { data } = await jira.get(url);
      report.jiraData = {
        totalIssues: data.issues.length,
        issues: data.issues.map((i) => ({
          key: i.key,
          summary: i.fields.summary,
          status: i.fields.status?.name,
          assignee: i.fields.assignee?.displayName || "Unassigned"
        }))
      };
    } catch (error) {
      report.jiraData = { error: error.message };
    }

    if (includeRisks) {
      report.riskData = riskData.risks.length ? riskData : { message: "No risk data uploaded" };
    }

    res.json(report);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear Risk Data (REST)
app.delete("/api/risks", (req, res) => {
  console.log(">>> REST API: DELETE /api/risks");
  riskData = { lastUpdated: null, filename: null, risks: [], headers: [], summary: {} };
  res.json({ success: true, message: "Risk data cleared" });
});

// =====================
// MCP ENDPOINT
// =====================

app.use("/mcp", (req, res, next) => {
  const key = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (key !== API_KEY) {
    console.log(">>> MCP: Unauthorized request");
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.post("/mcp", async (req, res) => {
  console.log(">>> MCP: POST /mcp");
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = createMcpServer();
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// =====================
// HEALTH CHECK
// =====================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    jiraConfigured: !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN),
    riskDataLoaded: riskData.risks.length > 0,
    riskCount: riskData.risks.length
  });
});

// =====================
// START SERVER
// =====================

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          JIRA + RISK MANAGEMENT MCP SERVER v2.0.0             ║
╠═══════════════════════════════════════════════════════════════╣
║  Server URL:  http://localhost:${port}                           ║
║  MCP Endpoint: http://localhost:${port}/mcp                      ║
║  API Key: ${API_KEY.padEnd(50)}║
╠═══════════════════════════════════════════════════════════════╣
║  MCP TOOLS:                                                   ║
║    • list_projects        - List Jira projects                ║
║    • search_issues        - Search with JQL                   ║
║    • get_issue            - Get issue details                 ║
║    • create_issue         - Create new issue                  ║
║    • upload_risk_file     - Upload Excel (base64)             ║
║    • get_risk_data        - Get stored risks                  ║
║    • get_risk_summary     - Summarize risks                   ║
║    • query_risks          - Filter/search risks               ║
║    • generate_status_report - Combined Jira + Risk report     ║
║    • clear_risk_data      - Clear stored risks                ║
╠═══════════════════════════════════════════════════════════════╣
║  REST API:                                                    ║
║    POST /api/upload-risk    - Upload risk Excel               ║
║    GET  /api/risks          - Get risk data                   ║
║    POST /api/generate-report - Generate report                ║
║    DELETE /api/risks        - Clear risk data                 ║
╠═══════════════════════════════════════════════════════════════╣
║  Health: http://localhost:${port}/health                         ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});