// index.js – Jira MCP Server (Standalone)
// Version: 3.0.0
// Completely independent Jira operations server

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { z } = require("zod");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.MCP_API_KEY || "123456";

app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, x-api-key, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "10mb" }));

// === Jira Client ===
var jira = axios.create({
  baseURL: process.env.JIRA_BASE_URL,
  timeout: 20000,
  auth: { username: process.env.JIRA_EMAIL, password: process.env.JIRA_API_TOKEN },
  headers: { Accept: "application/json", "Content-Type": "application/json" }
});

var JIRA_BROWSE_BASE_URL = process.env.JIRA_BROWSE_BASE_URL || process.env.JIRA_BASE_URL;

// === Utility Functions ===
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function parseDate(v) {
  return v ? new Date(v) : null;
}

function formatDateISO(d) {
  return d ? d.toISOString().split("T")[0] : null;
}

function buildIssueLink(key) {
  return JIRA_BROWSE_BASE_URL.replace(/\/$/, "") + "/browse/" + key;
}

function extractDescription(adf) {
  if (!adf || !Array.isArray(adf.content)) return "";
  var texts = [];
  for (var i = 0; i < adf.content.length; i++) {
    var block = adf.content[i];
    if (block.type === "paragraph" && block.content) {
      for (var j = 0; j < block.content.length; j++) {
        if (block.content[j].type === "text") {
          texts.push(block.content[j].text);
        }
      }
    }
  }
  return texts.join(" ").trim();
}

// === Fetch Issues ===
async function fetchJiraIssues(projectKey, options) {
  var jql = "project = " + projectKey;
  if (options && options.jql) {
    jql = options.jql;
  }
  
  var maxResults = (options && options.maxResults) || 200;
  var url = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) + "&maxResults=" + maxResults + "&fields=key,summary,description,assignee,status,issuetype,resolutiondate,duedate,priority,created,updated";
  
  var response = await jira.get(url);
  var issues = [];
  
  for (var i = 0; i < response.data.issues.length; i++) {
    var issue = response.data.issues[i];
    var f = issue.fields;
    issues.push({
      key: issue.key,
      link: buildIssueLink(issue.key),
      summary: f.summary || "",
      description: extractDescription(f.description) || f.summary || "",
      assignee: f.assignee ? f.assignee.displayName : "Unassigned",
      status: f.status ? f.status.name : "Unknown",
      statusCategory: f.status && f.status.statusCategory ? f.status.statusCategory.key : "",
      issueType: f.issuetype ? f.issuetype.name : "Task",
      priority: f.priority ? f.priority.name : "Medium",
      resolutionDate: formatDateISO(parseDate(f.resolutiondate)),
      dueDate: formatDateISO(parseDate(f.duedate)),
      created: formatDateISO(parseDate(f.created)),
      updated: formatDateISO(parseDate(f.updated))
    });
  }
  
  return issues;
}

// === Categorize Issues ===
function categorizeIssues(issues, startDate, endDate) {
  var start = new Date(startDate);
  var end = new Date(endDate);
  var now = new Date();
  
  function isDone(issue) {
    return issue.statusCategory === "done";
  }
  
  var accomplishments = issues.filter(function(i) {
    if (!isDone(i) || !i.resolutionDate) return false;
    var resDate = new Date(i.resolutionDate);
    return resDate >= start && resDate <= now;
  });
  
  var priorities = issues.filter(function(i) {
    if (isDone(i)) return false;
    if (!i.dueDate) return false;
    var dueDate = new Date(i.dueDate);
    return dueDate <= end;
  }).sort(function(a, b) {
    return new Date(a.dueDate) - new Date(b.dueDate);
  });
  
  var risks = issues.filter(function(i) {
    return !isDone(i) && (i.priority === "Highest" || i.priority === "High");
  });
  
  var milestones = issues.filter(function(i) {
    return i.issueType === "Epic" || i.issueType === "Story" || i.issueType === "Milestone";
  }).sort(function(a, b) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });
  
  var upcomingMilestones = milestones.filter(function(i) {
    if (!i.dueDate) return false;
    var dueDate = new Date(i.dueDate);
    return dueDate >= now && dueDate <= end;
  });
  
  return {
    accomplishments: accomplishments,
    priorities: priorities,
    risks: risks,
    milestones: milestones,
    upcomingMilestones: upcomingMilestones
  };
}

// === MCP Server ===
function createMcpServer() {
  var server = new McpServer({ name: "jira-mcp-server", version: "3.0.0" });

  server.tool("list_projects", "List all accessible Jira projects", {}, async function() {
    try {
      var response = await jira.get("/rest/api/3/project/search?maxResults=100");
      var projects = response.data.values.map(function(p) {
        return { key: p.key, name: p.name, id: p.id };
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, count: projects.length, projects: projects }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
    }
  });

  server.tool("search_issues", "Search Jira issues using JQL query", {
    jql: z.string().describe("JQL query string"),
    maxResults: z.number().optional().default(50)
  }, async function(args) {
    try {
      var issues = await fetchJiraIssues(null, { jql: args.jql, maxResults: args.maxResults });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, count: issues.length, issues: issues }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
    }
  });

  server.tool("get_project_issues", "Get all issues for a project", {
    projectKey: z.string().describe("Jira project key (e.g., AT)"),
    maxResults: z.number().optional().default(100)
  }, async function(args) {
    try {
      var issues = await fetchJiraIssues(args.projectKey, { maxResults: args.maxResults });
      var byStatus = {}, byType = {}, byAssignee = {};
      
      for (var i = 0; i < issues.length; i++) {
        var issue = issues[i];
        byStatus[issue.status] = (byStatus[issue.status] || 0) + 1;
        byType[issue.issueType] = (byType[issue.issueType] || 0) + 1;
        byAssignee[issue.assignee] = (byAssignee[issue.assignee] || 0) + 1;
      }
      
      return { content: [{ type: "text", text: JSON.stringify({
        success: true,
        project: args.projectKey,
        totalIssues: issues.length,
        summary: { byStatus: byStatus, byType: byType, byAssignee: byAssignee },
        issues: issues
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
    }
  });

  server.tool("get_issue", "Get detailed information about a specific issue", {
    issueKey: z.string().describe("Issue key (e.g., AT-123)")
  }, async function(args) {
    try {
      var response = await jira.get("/rest/api/3/issue/" + args.issueKey);
      var f = response.data.fields;
      
      var issue = {
        key: response.data.key,
        link: buildIssueLink(response.data.key),
        summary: f.summary,
        description: extractDescription(f.description),
        assignee: f.assignee ? f.assignee.displayName : "Unassigned",
        reporter: f.reporter ? f.reporter.displayName : "Unknown",
        status: f.status ? f.status.name : "Unknown",
        issueType: f.issuetype ? f.issuetype.name : "Task",
        priority: f.priority ? f.priority.name : "Medium",
        created: f.created,
        updated: f.updated,
        dueDate: f.duedate,
        resolutionDate: f.resolutiondate
      };
      
      return { content: [{ type: "text", text: JSON.stringify({ success: true, issue: issue }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
    }
  });

  server.tool("create_issue", "Create a new Jira issue", {
    projectKey: z.string(),
    summary: z.string(),
    description: z.string().optional(),
    issueType: z.string().optional().default("Task"),
    priority: z.string().optional()
  }, async function(args) {
    try {
      var body = {
        fields: {
          project: { key: args.projectKey },
          summary: args.summary,
          issuetype: { name: args.issueType }
        }
      };
      
      if (args.description) {
        body.fields.description = {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: args.description }] }]
        };
      }
      
      if (args.priority) {
        body.fields.priority = { name: args.priority };
      }
      
      var response = await jira.post("/rest/api/3/issue", body);
      
      return { content: [{ type: "text", text: JSON.stringify({
        success: true,
        issue: { key: response.data.key, link: buildIssueLink(response.data.key) }
      }, null, 2) }] };
    } catch (e) {
      var errorMsg = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: errorMsg }) }], isError: true };
    }
  });

  server.tool("get_status_report_data", "Get categorized data for status report generation", {
    projectKey: z.string().describe("Jira project key"),
    period: z.enum(["weekly", "biweekly", "custom"]).describe("Report period"),
    startDate: z.string().optional().describe("Start date (YYYY-MM-DD) for custom"),
    endDate: z.string().optional().describe("End date (YYYY-MM-DD) for custom")
  }, async function(args) {
    try {
      var now = new Date();
      var startDate, endDate, periodLabel;
      
      if (args.period === "custom") {
        if (!args.startDate || !args.endDate) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Custom period requires startDate and endDate" }) }], isError: true };
        }
        startDate = args.startDate;
        endDate = args.endDate;
        periodLabel = startDate + " to " + endDate;
      } else if (args.period === "biweekly") {
        startDate = formatDateISO(addDays(now, -14));
        endDate = formatDateISO(addDays(now, 14));
        periodLabel = "Biweekly (" + startDate + " to " + endDate + ")";
      } else {
        startDate = formatDateISO(addDays(now, -7));
        endDate = formatDateISO(addDays(now, 7));
        periodLabel = "Weekly (" + startDate + " to " + endDate + ")";
      }
      
      var issues = await fetchJiraIssues(args.projectKey, { maxResults: 200 });
      var categorized = categorizeIssues(issues, startDate, endDate);
      
      return { content: [{ type: "text", text: JSON.stringify({
        success: true,
        project: args.projectKey,
        period: args.period,
        periodLabel: periodLabel,
        dateRange: { start: startDate, end: endDate },
        generatedAt: new Date().toISOString(),
        summary: {
          totalIssues: issues.length,
          accomplishments: categorized.accomplishments.length,
          priorities: categorized.priorities.length,
          risks: categorized.risks.length,
          milestones: categorized.milestones.length,
          upcomingMilestones: categorized.upcomingMilestones.length
        },
        data: categorized
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
    }
  });

  return server;
}

// === REST API ===
app.get("/api/projects", async function(req, res) {
  try {
    var response = await jira.get("/rest/api/3/project/search?maxResults=100");
    res.json({ success: true, projects: response.data.values.map(function(p) { return { key: p.key, name: p.name }; }) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/project/:key/issues", async function(req, res) {
  try {
    var issues = await fetchJiraIssues(req.params.key, { maxResults: 100 });
    res.json({ success: true, project: req.params.key, count: issues.length, issues: issues });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/project/:key/report-data", async function(req, res) {
  try {
    var period = req.query.period || "weekly";
    var now = new Date();
    var startDate, endDate, periodLabel;
    
    if (period === "custom") {
      startDate = req.query.startDate;
      endDate = req.query.endDate;
      periodLabel = startDate + " to " + endDate;
    } else if (period === "biweekly") {
      startDate = formatDateISO(addDays(now, -14));
      endDate = formatDateISO(addDays(now, 14));
      periodLabel = "Biweekly";
    } else {
      startDate = formatDateISO(addDays(now, -7));
      endDate = formatDateISO(addDays(now, 7));
      periodLabel = "Weekly";
    }
    
    var issues = await fetchJiraIssues(req.params.key, { maxResults: 200 });
    var categorized = categorizeIssues(issues, startDate, endDate);
    
    res.json({
      success: true,
      project: req.params.key,
      period: period,
      periodLabel: periodLabel,
      dateRange: { start: startDate, end: endDate },
      data: categorized
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === MCP Tools Definition ===
var mcpTools = [
  {
    name: "list_projects",
    description: "List all accessible Jira projects",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "search_issues",
    description: "Search Jira issues using JQL query",
    inputSchema: {
      type: "object",
      properties: {
        jql: { type: "string", description: "JQL query string" },
        maxResults: { type: "number", description: "Maximum results to return (default: 50)" }
      },
      required: ["jql"]
    }
  },
  {
    name: "get_project_issues",
    description: "Get all issues for a project with summary statistics",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "Jira project key (e.g., AT)" },
        maxResults: { type: "number", description: "Maximum results (default: 100)" }
      },
      required: ["projectKey"]
    }
  },
  {
    name: "get_issue",
    description: "Get detailed information about a specific issue",
    inputSchema: {
      type: "object",
      properties: {
        issueKey: { type: "string", description: "Issue key (e.g., AT-123)" }
      },
      required: ["issueKey"]
    }
  },
  {
    name: "create_issue",
    description: "Create a new Jira issue",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "Project key" },
        summary: { type: "string", description: "Issue summary/title" },
        description: { type: "string", description: "Issue description" },
        issueType: { type: "string", description: "Issue type (Task, Bug, Story, etc.)" },
        priority: { type: "string", description: "Priority (Highest, High, Medium, Low, Lowest)" }
      },
      required: ["projectKey", "summary"]
    }
  },
  {
    name: "get_status_report_data",
    description: "Get categorized data for status report generation (accomplishments, priorities, risks, milestones)",
    inputSchema: {
      type: "object",
      properties: {
        projectKey: { type: "string", description: "Jira project key" },
        period: { type: "string", enum: ["weekly", "biweekly", "custom"], description: "Report period" },
        startDate: { type: "string", description: "Start date (YYYY-MM-DD) for custom period" },
        endDate: { type: "string", description: "End date (YYYY-MM-DD) for custom period" }
      },
      required: ["projectKey", "period"]
    }
  }
];

// === MCP Tool Handlers ===
async function handleMcpTool(toolName, args) {
  switch (toolName) {
    case "list_projects":
      try {
        var response = await jira.get("/rest/api/3/project/search?maxResults=100");
        var projects = response.data.values.map(function(p) {
          return { key: p.key, name: p.name, id: p.id };
        });
        return { success: true, count: projects.length, projects: projects };
      } catch (e) {
        return { success: false, error: e.message };
      }

    case "search_issues":
      try {
        var issues = await fetchJiraIssues(null, { jql: args.jql, maxResults: args.maxResults || 50 });
        return { success: true, count: issues.length, issues: issues };
      } catch (e) {
        return { success: false, error: e.message };
      }

    case "get_project_issues":
      try {
        var issues = await fetchJiraIssues(args.projectKey, { maxResults: args.maxResults || 100 });
        var byStatus = {}, byType = {}, byAssignee = {};
        for (var i = 0; i < issues.length; i++) {
          var issue = issues[i];
          byStatus[issue.status] = (byStatus[issue.status] || 0) + 1;
          byType[issue.issueType] = (byType[issue.issueType] || 0) + 1;
          byAssignee[issue.assignee] = (byAssignee[issue.assignee] || 0) + 1;
        }
        return { success: true, project: args.projectKey, totalIssues: issues.length, summary: { byStatus: byStatus, byType: byType, byAssignee: byAssignee }, issues: issues };
      } catch (e) {
        return { success: false, error: e.message };
      }

    case "get_issue":
      try {
        var response = await jira.get("/rest/api/3/issue/" + args.issueKey);
        var f = response.data.fields;
        var issue = {
          key: response.data.key,
          link: buildIssueLink(response.data.key),
          summary: f.summary,
          description: extractDescription(f.description),
          assignee: f.assignee ? f.assignee.displayName : "Unassigned",
          reporter: f.reporter ? f.reporter.displayName : "Unknown",
          status: f.status ? f.status.name : "Unknown",
          issueType: f.issuetype ? f.issuetype.name : "Task",
          priority: f.priority ? f.priority.name : "Medium",
          created: f.created,
          updated: f.updated,
          dueDate: f.duedate,
          resolutionDate: f.resolutiondate
        };
        return { success: true, issue: issue };
      } catch (e) {
        return { success: false, error: e.message };
      }

    case "create_issue":
      try {
        var body = {
          fields: {
            project: { key: args.projectKey },
            summary: args.summary,
            issuetype: { name: args.issueType || "Task" }
          }
        };
        if (args.description) {
          body.fields.description = {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: args.description }] }]
          };
        }
        if (args.priority) {
          body.fields.priority = { name: args.priority };
        }
        var response = await jira.post("/rest/api/3/issue", body);
        return { success: true, issue: { key: response.data.key, link: buildIssueLink(response.data.key) } };
      } catch (e) {
        var errorMsg = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
        return { success: false, error: errorMsg };
      }

    case "get_status_report_data":
      try {
        var now = new Date();
        var startDate, endDate, periodLabel;
        
        if (args.period === "custom") {
          if (!args.startDate || !args.endDate) {
            return { success: false, error: "Custom period requires startDate and endDate" };
          }
          startDate = args.startDate;
          endDate = args.endDate;
          periodLabel = startDate + " to " + endDate;
        } else if (args.period === "biweekly") {
          startDate = formatDateISO(addDays(now, -14));
          endDate = formatDateISO(addDays(now, 14));
          periodLabel = "Biweekly (" + startDate + " to " + endDate + ")";
        } else {
          startDate = formatDateISO(addDays(now, -7));
          endDate = formatDateISO(addDays(now, 7));
          periodLabel = "Weekly (" + startDate + " to " + endDate + ")";
        }
        
        var issues = await fetchJiraIssues(args.projectKey, { maxResults: 200 });
        var categorized = categorizeIssues(issues, startDate, endDate);
        
        return {
          success: true,
          project: args.projectKey,
          period: args.period,
          periodLabel: periodLabel,
          dateRange: { start: startDate, end: endDate },
          generatedAt: new Date().toISOString(),
          summary: {
            totalIssues: issues.length,
            accomplishments: categorized.accomplishments.length,
            priorities: categorized.priorities.length,
            risks: categorized.risks.length,
            milestones: categorized.milestones.length,
            upcomingMilestones: categorized.upcomingMilestones.length
          },
          data: categorized
        };
      } catch (e) {
        return { success: false, error: e.message };
      }

    default:
      return { success: false, error: "Unknown tool: " + toolName };
  }
}

// === Custom MCP Endpoint (Compatible with Copilot Studio) ===
app.use("/mcp", function(req, res, next) {
  var key = req.headers["x-api-key"] || (req.headers["authorization"] || "").replace("Bearer ", "");
  if (key !== API_KEY) return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  next();
});

app.post("/mcp", async function(req, res) {
  try {
    var body = req.body;
    var id = body.id || null;
    var method = body.method;
    var params = body.params || {};

    console.log("MCP Request:", method, JSON.stringify(params).substring(0, 200));

    var response = { jsonrpc: "2.0", id: id };

    switch (method) {
      case "initialize":
        response.result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "jira-mcp-server", version: "3.0.0" }
        };
        break;

      case "notifications/initialized":
        response.result = {};
        break;

      case "tools/list":
        response.result = { tools: mcpTools };
        break;

      case "tools/call":
        var toolName = params.name;
        var toolArgs = params.arguments || {};
        try {
          var toolResult = await handleMcpTool(toolName, toolArgs);
          response.result = {
            content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }]
          };
        } catch (toolError) {
          response.result = {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: toolError.message }) }],
            isError: true
          };
        }
        break;

      case "ping":
        response.result = {};
        break;

      default:
        response.error = { code: -32601, message: "Method not found: " + method };
    }

    res.json(response);
  } catch (e) {
    console.error("MCP Error:", e);
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: e.message },
      id: req.body && req.body.id ? req.body.id : null
    });
  }
});

app.get("/health", function(req, res) {
  res.json({ status: "ok", service: "jira-mcp-server", version: "3.0.0" });
});

app.listen(PORT, function() {
  console.log("\n" +
    "╔═══════════════════════════════════════════════════════════════╗\n" +
    "║              JIRA MCP SERVER v3.0.0                           ║\n" +
    "║              Standalone Jira Operations                       ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║  Server:  http://localhost:" + PORT + "                              ║\n" +
    "║  MCP:     http://localhost:" + PORT + "/mcp                          ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║  MCP Tools:                                                   ║\n" +
    "║    • list_projects          - List all projects               ║\n" +
    "║    • search_issues          - Search with JQL                 ║\n" +
    "║    • get_project_issues     - Get project issues              ║\n" +
    "║    • get_issue              - Get issue details               ║\n" +
    "║    • create_issue           - Create new issue                ║\n" +
    "║    • get_status_report_data - Get categorized report data     ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║  REST API:                                                    ║\n" +
    "║    GET /api/projects                                          ║\n" +
    "║    GET /api/project/:key/issues                               ║\n" +
    "║    GET /api/project/:key/report-data?period=weekly            ║\n" +
    "╚═══════════════════════════════════════════════════════════════╝\n"
  );
});
