// index.js – Jira MCP Server with Weekly Report Generation

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

// Base URL to build issue links, e.g. https://your-domain.atlassian.net
const JIRA_BROWSE_BASE_URL =
  process.env.JIRA_BROWSE_BASE_URL || process.env.JIRA_BASE_URL || "";

// ==============================
// JIRA CLIENT
// ==============================
const jira = axios.create({
  baseURL: process.env.JIRA_BASE_URL,
  timeout: 20000,
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
// HELPERS – Dates, ADF, Formatting
// ==============================

function extractDescription(adf) {
  // Jira Cloud description is ADF JSON; convert simple paragraphs to text
  if (!adf || !Array.isArray(adf.content)) return "";

  let text = "";

  for (const block of adf.content) {
    if (block.type === "paragraph" && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item.type === "text" && typeof item.text === "string") {
          text += item.text;
        }
      }
      text += "\n";
    }
  }

  return text.trim();
}

function addDays(base, days) {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function isBetween(date, start, end) {
  if (!date) return false;
  return date >= start && date <= end;
}

function formatDate(date) {
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function buildIssueLink(key) {
  if (!JIRA_BROWSE_BASE_URL) return key;
  return `${JIRA_BROWSE_BASE_URL.replace(/\/$/, "")}/browse/${key}`;
}

// ==============================
// REPORT BUILDER
// ==============================

/**
 * issues: normalized array:
 * {
 *   key, summary, description, statusName, statusCategoryKey,
 *   assignee, issueTypeName, resolutionDate, dueDate
 * }
 */
function buildWeeklyReport(projectKey, issues) {
  const now = new Date();
  const lastWeekStart = addDays(now, -7);
  const lastWeekEnd = now;
  const nextWeekStart = now;
  const nextWeekEnd = addDays(now, 7);

  // Helper predicates
  const isDone = (i) => i.statusCategoryKey === "done";
  const isStory = (i) => i.issueTypeName === "Story";
  const isMilestone = (i) =>
    i.issueTypeName === "Epic" || i.issueTypeName === "Milestone";
  const hasDescription = (i) =>
    typeof i.description === "string" && i.description.trim().length > 0;

  const inLastWeekByResolution = (i) =>
    isBetween(i.resolutionDate, lastWeekStart, lastWeekEnd);

  const inNextWeekByDue = (i) =>
    isBetween(i.dueDate, nextWeekStart, nextWeekEnd);

  const inRangeOrPending = (i) => {
    // "Include only records from the defined date range OR still pending."
    // If it has resolution date or due date in window → include
    if (inLastWeekByResolution(i) || inNextWeekByDue(i)) return true;

    // Still pending → not done
    if (!isDone(i)) return true;

    return false;
  };

  // Filter once for global inclusion rule + description presence
  const validIssues = issues.filter(
    (i) => hasDescription(i) && inRangeOrPending(i)
  );

  // 2.1 Key Accomplishments for Last Week
  const accomplishments = validIssues.filter(
    (i) => isDone(i) && inLastWeekByResolution(i)
  );

  // 2.2 Top Priorities for Next Week
  const topPriorities = validIssues.filter(
    (i) => !isDone(i) && inNextWeekByDue(i)
  );

  // 2.3 Key Risks, Issues & Action Items
  // "only stories if not completed, no subtasks, no tasks"
  const risksIssuesActions = validIssues.filter(
    (i) => isStory(i) && !isDone(i)
  );

  // 2.4 Key Milestones & Status
  const milestones = validIssues.filter(
    (i) => isMilestone(i) && (inLastWeekByResolution(i) || !isDone(i))
  );

  // 2.5 Upcoming Key Milestones (coming couple of weeks – here: next 7 days)
  const upcomingMilestones = validIssues.filter(
    (i) => isMilestone(i) && inNextWeekByDue(i)
  );

  // Build pure text report (no markdown, no JSON)
  let report = "";

  report += `Weekly Status Report: ${projectKey}\n\n`;

  // 2.1
  report += "2.1 Key Accomplishments for Last Week\n";
  accomplishments.forEach((i) => {
    const link = buildIssueLink(i.key);
    // Format: issue key with jira link, summarized issue description from a business context
    report += `• ${i.key} (${link}): ${i.description}\n`;
  });
  report += "\n";

  // 2.2
  report += "2.2 Top Priorities for Next Week\n";
  topPriorities.forEach((i) => {
    const link = buildIssueLink(i.key);
    const owner = i.assignee || "Unassigned";
    // Format: id(issue key with jira link), description, owner
    report += `• ${i.key} (${link}) | ${i.description} | Owner: ${owner}\n`;
  });
  report += "\n";

  // 2.3
  report += "2.3 Key Risks, Issues & Action Items\n";
  risksIssuesActions.forEach((i) => {
    const link = buildIssueLink(i.key);
    const owner = i.assignee || "Unassigned";
    const targetDate = formatDate(i.dueDate);
    const status = i.statusName || "";
    // Format: id, description, owner, target date, status
    report += `• ${i.key} (${link}) | ${i.description} | Owner: ${owner} | Target Date: ${targetDate || "N/A"} | Status: ${status}\n`;
  });
  report += "\n";

  // 2.4
  report += "2.4 Key Milestones & Status\n";
  milestones.forEach((i) => {
    const targetDate = formatDate(i.dueDate);
    const status = i.statusName || "";
    // Format: milestone key, milestone description, target date, status
    report += `• ${i.key}: ${i.description} | Target Date: ${targetDate || "N/A"} | Status: ${status}\n`;
  });
  report += "\n";

  // 2.5
  report += "2.5 Upcoming Key Milestones\n";
  upcomingMilestones.forEach((i) => {
    const status = i.statusName || "";
    // Format: milestone key, milestone description, status
    report += `• ${i.key}: ${i.description} | Status: ${status}\n`;
  });

  return report.trim();
}

// ==============================
// MCP SERVER
// ==============================
function createMcpServer() {
  const mcpServer = new McpServer({
    name: "jira-mcp",
    version: "2.0.0",
  });

  // -------------------------------------
  // list_projects – unchanged
  // -------------------------------------
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
            {
              type: "text",
              text: JSON.stringify(projects, null, 2),
            },
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

  // -------------------------------------
  // get_issues – still available (debug/general)
  // -------------------------------------
  mcpServer.tool(
    "get_issues",
    "Get Jira issues by issue key or JQL (for general use)",
    {
      issueKey: z.string().optional(),
      jql: z.string().optional(),
      maxResults: z.number().optional().default(50),
    },
    async ({ issueKey, jql, maxResults }) => {
      console.log("=== get_issues called ===");
      try {
        if (issueKey) {
          const { data } = await jira.get(`/rest/api/3/issue/${issueKey}`);
          const issue = {
            key: data.key,
            summary: data.fields.summary,
            description: extractDescription(data.fields.description),
            status: data.fields.status?.name,
            assignee: data.fields.assignee?.displayName || "Unassigned",
          };
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ mode: "single", issue }, null, 2),
              },
            ],
          };
        }

        if (jql) {
          const url =
            `/rest/api/3/search/jql` +
            `?jql=${encodeURIComponent(jql)}` +
            `&maxResults=${maxResults}` +
            `&fields=key,summary,status,assignee,description,issuetype,resolutiondate,duedate,statuscategorychangedate,status`;
          const { data } = await jira.get(url);

          const issues = data.issues.map((i) => ({
            key: i.key,
            summary: i.fields.summary,
            description: extractDescription(i.fields.description),
            status: i.fields.status?.name,
            assignee: i.fields.assignee?.displayName || "Unassigned",
            issueTypeName: i.fields.issuetype?.name,
            resolutionDate: i.fields.resolutiondate,
            dueDate: i.fields.duedate,
          }));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { mode: "search", total: issues.length, issues },
                  null,
                  2
                ),
              },
            ],
          };
        }

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

  // -------------------------------------
  // ✅ generate_weekly_report – MAIN TOOL
  // -------------------------------------
  mcpServer.tool(
    "generate_weekly_report",
    "Generate a weekly status report string for a Jira project (last 7 days and next 7 days)",
    {
      projectKey: z
        .string()
        .describe("Jira project key (e.g., AT)"),
      maxResults: z
        .number()
        .optional()
        .default(200),
    },
    async ({ projectKey, maxResults }) => {
      console.log("=== generate_weekly_report called ===", projectKey);

      const now = new Date();
      const lastWeekStart = addDays(now, -7);
      const nextWeekEnd = addDays(now, 7);

      // JQL: pull a reasonable window; filter precisely in code
      const jql = `project = ${projectKey} AND issuetype in (Story, Epic, Milestone) ORDER BY updated DESC`;

      try {
        const url =
          `/rest/api/3/search/jql` +
          `?jql=${encodeURIComponent(jql)}` +
          `&maxResults=${maxResults}` +
          `&fields=key,summary,status,assignee,description,issuetype,resolutiondate,duedate,status`;

        const { data } = await jira.get(url);

        const issues = data.issues.map((i) => {
          const fields = i.fields || {};
          const status = fields.status || {};

          return {
            key: i.key,
            summary: fields.summary || "",
            description: extractDescription(fields.description),
            statusName: status.name || "",
            statusCategoryKey:
              status.statusCategory?.key || "", // "new", "indeterminate", "done"
            assignee: fields.assignee?.displayName || "",
            issueTypeName: fields.issuetype?.name || "",
            resolutionDate: parseDate(fields.resolutiondate),
            dueDate: parseDate(fields.duedate),
          };
        });

        const report = buildWeeklyReport(projectKey, issues);

        // 🔒 HARDENING: return ONE plain string; no JSON, no markdown
        return {
          content: [
            {
              type: "text",
              text: report,
            },
          ],
        };
      } catch (error) {
        console.error("generate_weekly_report error:", error.message);
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
