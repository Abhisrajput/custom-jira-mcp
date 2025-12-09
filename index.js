// index.js – Jira MCP Server (Render-ready, Word download support)

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { Document, Packer, Paragraph, TextRun } = require("docx");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const app = express();
app.use(express.json());

/* =====================================================
   CONFIG (RENDER SAFE)
===================================================== */
const API_KEY = process.env.MCP_API_KEY || "123456";
const PORT = process.env.PORT || 3000;

// ✅ MUST be set in Render
// BASE_URL=https://custom-jira-mcp.onrender.com
const BASE_URL =
  process.env.BASE_URL || `http://localhost:${PORT}`;

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_BROWSE_BASE_URL =
  process.env.JIRA_BROWSE_BASE_URL || JIRA_BASE_URL;

// ✅ Persistent disk path (Render)
const REPORTS_DIR =
  process.env.REPORTS_DIR ||
  path.join(__dirname, "reports");

// Ensure reports directory exists
fs.ensureDirSync(REPORTS_DIR);

// ✅ Serve Word documents publicly
app.use("/reports", express.static(REPORTS_DIR));

/* =====================================================
   JIRA CLIENT
===================================================== */
const jira = axios.create({
  baseURL: JIRA_BASE_URL,
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

/* =====================================================
   UTILITIES
===================================================== */
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const parseDate = (v) => (v ? new Date(v) : null);
const fmtDate = (d) => (d ? d.toISOString().split("T")[0] : "N/A");

const buildIssueLink = (key) =>
  `${JIRA_BROWSE_BASE_URL.replace(/\/$/, "")}/browse/${key}`;

const pad = (label, value) =>
  `  ${label.padEnd(14)}: ${value}`;

function extractDescription(adf) {
  if (!adf || !Array.isArray(adf.content)) return "";
  return adf.content
    .flatMap((b) =>
      b.type === "paragraph"
        ? (b.content || []).map((c) =>
            c.type === "text" ? c.text : ""
          )
        : []
    )
    .join("")
    .trim();
}

/* =====================================================
   PIXEL-PERFECT REPORT BUILDER
===================================================== */
function buildReport(projectKey, issues, period) {
  const now = new Date();
  const windowDays = period === "biweekly" ? 14 : 7;
  const pastStart = addDays(now, -windowDays);
  const futureEnd = addDays(now, windowDays);

  const isDone = (i) => i.statusCategory === "done";
  const isStory = (i) => i.issueType === "Story";
  const isMilestone = (i) =>
    i.issueType === "Epic" || i.issueType === "Milestone";

  const valid = issues.filter(
    (i) => i.description && (!isDone(i) || i.resolutionDate)
  );

  const accomplishments = valid
    .filter(
      (i) =>
        isDone(i) &&
        i.resolutionDate &&
        i.resolutionDate >= pastStart
    )
    .sort((a, b) => a.key.localeCompare(b.key));

  const priorities = valid
    .filter(
      (i) =>
        !isDone(i) &&
        i.dueDate &&
        i.dueDate <= futureEnd
    )
    .sort((a, b) => a.dueDate - b.dueDate);

  const risks = valid
    .filter((i) => isStory(i) && !isDone(i))
    .sort((a, b) => a.key.localeCompare(b.key));

  const milestones = valid
    .filter((i) => isMilestone(i))
    .sort((a, b) => a.key.localeCompare(b.key));

  const upcomingMilestones = milestones.filter(
    (i) => i.dueDate && i.dueDate <= futureEnd
  );

  let r = `Weekly Status Report: ${projectKey} (${period})\n\n`;

  const section = (title, list, render) => {
    if (!list.length) return;
    r += `${title}\n\n`;
    list.forEach(render);
    r += "\n";
  };

  section(
    "Key Accomplishments for Last Period",
    accomplishments,
    (i) => {
      r += `- ${i.key} (${buildIssueLink(i.key)})\n`;
      r += pad("Description", i.description) + "\n";
      r += pad("Owner", i.assignee) + "\n";
      r += pad("Status", i.status) + "\n\n";
    }
  );

  section(
    "Top Priorities for Next Period",
    priorities,
    (i) => {
      r += `- ${i.key} (${buildIssueLink(i.key)})\n`;
      r += pad("Description", i.description) + "\n";
      r += pad("Owner", i.assignee) + "\n\n";
    }
  );

  section(
    "Key Risks, Issues & Action Items",
    risks,
    (i) => {
      r += `- ${i.key} (${buildIssueLink(i.key)})\n`;
      r += pad("Description", i.description) + "\n";
      r += pad("Owner", i.assignee) + "\n";
      r += pad("Target Date", fmtDate(i.dueDate)) + "\n";
      r += pad("Status", i.status) + "\n\n";
    }
  );

  section(
    "Key Milestones & Status",
    milestones,
    (i) => {
      r += `- ${i.key}\n`;
      r += pad("Description", i.description) + "\n";
      r += pad("Target Date", fmtDate(i.dueDate)) + "\n";
      r += pad("Status", i.status) + "\n\n";
    }
  );

  section(
    "Upcoming Key Milestones",
    upcomingMilestones,
    (i) => {
      r += `- ${i.key}\n`;
      r += pad("Description", i.description) + "\n";
      r += pad("Status", i.status) + "\n\n";
    }
  );

  return r.trim();
}

/* =====================================================
   WORD DOCUMENT GENERATION
===================================================== */
async function generateWordDoc(filename, textContent) {
  const lines = textContent.split("\n");

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: lines.map(
          (line) =>
            new Paragraph({
              children: [
                new TextRun({
                  text: line,
                  font: "Courier New",
                  size: 22,
                }),
              ],
            })
        ),
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(path.join(REPORTS_DIR, filename), buffer);
}

/* =====================================================
   MCP SERVER
===================================================== */
function createMcpServer() {
  const server = new McpServer({
    name: "jira-mcp",
    version: "6.0.0",
  });

  server.tool(
    "generate_status_report",
    "Generate weekly or biweekly Jira status report (Word download)",
    {
      projectKey: z.string(),
      period: z.enum(["weekly", "biweekly"]),
    },
    async ({ projectKey, period }) => {
      const jql = `project = ${projectKey}`;
      const { data } = await jira.get(
        `/rest/api/3/search/jql?jql=${encodeURIComponent(
          jql
        )}&maxResults=200&fields=key,description,assignee,status,issuetype,resolutiondate,duedate`
      );

      const issues = data.issues.map((i) => ({
        key: i.key,
        description: extractDescription(i.fields.description),
        assignee:
          i.fields.assignee?.displayName || "Unassigned",
        status: i.fields.status?.name || "",
        statusCategory:
          i.fields.status?.statusCategory?.key || "",
        issueType: i.fields.issuetype?.name || "",
        resolutionDate: parseDate(
          i.fields.resolutiondate
        ),
        dueDate: parseDate(i.fields.duedate),
      }));

      const reportText = buildReport(
        projectKey,
        issues,
        period
      );

      const filename = `${projectKey}_${period}_status_${Date.now()}.docx`;
      await generateWordDoc(filename, reportText);

      const downloadUrl = `${BASE_URL}/reports/${filename}`;

      return {
        content: [
          {
            type: "text",
            text: `Weekly status report generated.\nDownload here: ${downloadUrl}`,
          },
        ],
      };
    }
  );

  return server;
}

/* =====================================================
   SERVER BOOTSTRAP
===================================================== */
app.use("/mcp", (req, res, next) => {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({});
  const server = createMcpServer();

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`✅ Jira MCP running on ${BASE_URL}`);
  console.log(`✅ Reports available at ${BASE_URL}/reports`);
});
