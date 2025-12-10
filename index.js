// index.js – Jira MCP Server with Tavant-Styled PPTX Status Reports
// Version: 3.0.0
// Features: Weekly/Biweekly/Custom date range, Issue descriptions, Tavant template styling

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const XLSX = require("xlsx");
const PptxGenJS = require("pptxgenjs");

const app = express();
const API_KEY = process.env.MCP_API_KEY || "123456";
const REPORTS_DIR = path.join(__dirname, "reports");

// Ensure reports folder exists
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// Serve generated reports
app.use("/reports", express.static(REPORTS_DIR));

app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, x-api-key, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "50mb" }));

console.log("\n=== Configuration ===");
console.log("JIRA_BASE_URL:", process.env.JIRA_BASE_URL || "[NOT SET]");

// === Storage ===
var riskData = { lastUpdated: null, filename: null, risks: [], headers: [] };

// === Jira Client ===
var jira = axios.create({
  baseURL: process.env.JIRA_BASE_URL,
  timeout: 20000,
  auth: { username: process.env.JIRA_EMAIL, password: process.env.JIRA_API_TOKEN },
  headers: { Accept: "application/json", "Content-Type": "application/json" }
});

var JIRA_BROWSE_BASE_URL = process.env.JIRA_BROWSE_BASE_URL || process.env.JIRA_BASE_URL;

// === Tavant Colors (from template) ===
var COLORS = {
  PRIMARY: "000000",      // Black (title slide background)
  ACCENT: "F26522",       // Tavant Orange
  WHITE: "FFFFFF",
  BLACK: "000000",
  DARK_GRAY: "333333",
  LIGHT_GRAY: "F5F5F5",
  TABLE_HEADER: "F26522", // Orange header
  TABLE_BORDER: "000000",
  STATUS_GREEN: "00B050",
  STATUS_YELLOW: "FFFF00",
  STATUS_RED: "FF0000",
  STATUS_ORANGE: "FFC000"
};

// === Utility Functions ===
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function parseDate(v) {
  return v ? new Date(v) : null;
}

function formatDate(d) {
  if (!d) return "N/A";
  var month = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  var year = d.getFullYear();
  return month + "/" + day + "/" + year;
}

function formatDateISO(d) {
  return d ? d.toISOString().split("T")[0] : "N/A";
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
  return texts.join("").trim();
}

function getStatusColor(status) {
  var s = (status || "").toLowerCase();
  if (s.indexOf("done") !== -1 || s.indexOf("complete") !== -1) return COLORS.STATUS_GREEN;
  if (s.indexOf("progress") !== -1) return COLORS.STATUS_YELLOW;
  if (s.indexOf("blocked") !== -1 || s.indexOf("risk") !== -1) return COLORS.STATUS_RED;
  return COLORS.STATUS_ORANGE;
}

function parseExcel(base64Data, filename) {
  try {
    var buffer = Buffer.from(base64Data, "base64");
    var workbook = XLSX.read(buffer, { type: "buffer" });
    var data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    return { success: true, filename: filename, headers: Object.keys(data[0] || {}), data: data, rowCount: data.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// === Fetch Jira Issues with Full Details ===
async function fetchJiraIssues(projectKey, startDate, endDate) {
  var jql = "project = " + projectKey;
  var url = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) + "&maxResults=200&fields=key,summary,description,assignee,status,issuetype,resolutiondate,duedate,priority";
  
  var response = await jira.get(url);
  var data = response.data;
  
  var issues = [];
  for (var i = 0; i < data.issues.length; i++) {
    var issue = data.issues[i];
    var f = issue.fields;
    issues.push({
      key: issue.key,
      summary: f.summary || "",
      description: extractDescription(f.description) || f.summary || "",
      assignee: f.assignee ? f.assignee.displayName : "Unassigned",
      status: f.status ? f.status.name : "Unknown",
      statusCategory: f.status && f.status.statusCategory ? f.status.statusCategory.key : "",
      issueType: f.issuetype ? f.issuetype.name : "Task",
      priority: f.priority ? f.priority.name : "Medium",
      resolutionDate: parseDate(f.resolutiondate),
      dueDate: parseDate(f.duedate)
    });
  }
  
  return issues;
}

// === Categorize Issues for Report ===
function categorizeIssues(issues, startDate, endDate) {
  var now = new Date();
  
  function isDone(issue) {
    return issue.statusCategory === "done";
  }
  
  function isStory(issue) {
    return issue.issueType === "Story" || issue.issueType === "Task";
  }
  
  function isMilestone(issue) {
    return issue.issueType === "Epic" || issue.issueType === "Milestone" || issue.issueType === "Story";
  }
  
  // Key Accomplishments - Done in the past period
  var accomplishments = issues.filter(function(i) {
    return isDone(i) && i.resolutionDate && i.resolutionDate >= startDate && i.resolutionDate <= now;
  }).sort(function(a, b) { return a.key.localeCompare(b.key); });
  
  // Top Priorities - Not done, due in next period
  var priorities = issues.filter(function(i) {
    return !isDone(i) && i.dueDate && i.dueDate <= endDate;
  }).sort(function(a, b) {
    if (a.dueDate && b.dueDate) return a.dueDate - b.dueDate;
    return a.key.localeCompare(b.key);
  });
  
  // Risks - Stories/Tasks not done (potential blockers)
  var risks = issues.filter(function(i) {
    return isStory(i) && !isDone(i) && (i.priority === "Highest" || i.priority === "High" || !i.dueDate);
  }).sort(function(a, b) { return a.key.localeCompare(b.key); });
  
  // Milestones - All milestones with their status
  var milestones = issues.filter(function(i) {
    return isMilestone(i);
  }).sort(function(a, b) {
    if (a.dueDate && b.dueDate) return a.dueDate - b.dueDate;
    return a.key.localeCompare(b.key);
  });
  
  // Upcoming Milestones - Due in next period
  var upcomingMilestones = milestones.filter(function(i) {
    return i.dueDate && i.dueDate >= now && i.dueDate <= endDate;
  });
  
  return {
    accomplishments: accomplishments,
    priorities: priorities,
    risks: risks,
    milestones: milestones,
    upcomingMilestones: upcomingMilestones
  };
}

// === Generate Tavant-Styled PPTX ===
function generateTavantPPTX(projectKey, categorized, dateRange, riskFileData) {
  var pptx = new PptxGenJS();
  
  pptx.author = "Status Report Generator";
  pptx.title = "Weekly Status Report - " + projectKey;
  pptx.subject = "Weekly Status Report";
  pptx.company = "Tavant";
  
  // Standard 16:9 layout
  pptx.defineLayout({ name: "CUSTOM", width: 13.33, height: 7.5 });
  pptx.layout = "CUSTOM";
  
  var slide;
  
  // ========== SLIDE 0: Title Slide (Dark Background with Orange Accent) ==========
  slide = pptx.addSlide();
  
  // Black background
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 0, w: 13.33, h: 7.5,
    fill: { color: COLORS.PRIMARY }
  });
  
  // Orange accent bar at bottom
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 6.8, w: 13.33, h: 0.15,
    fill: { color: COLORS.ACCENT }
  });
  
  // TAVANT logo text (top left)
  slide.addText("TAVANT", {
    x: 0.5, y: 0.4, w: 3, h: 0.5,
    fontSize: 24, bold: true, color: COLORS.ACCENT, fontFace: "Arial"
  });
  
  // Main title
  slide.addText("WEEKLY STATUS REPORT", {
    x: 0.5, y: 2.5, w: 10, h: 1,
    fontSize: 44, bold: true, color: COLORS.WHITE, fontFace: "Arial"
  });
  
  // Project name
  slide.addText("Project: " + projectKey, {
    x: 0.5, y: 3.6, w: 10, h: 0.5,
    fontSize: 24, color: COLORS.WHITE, fontFace: "Arial"
  });
  
  // Date
  slide.addText(formatDate(new Date()), {
    x: 0.5, y: 4.5, w: 4, h: 0.4,
    fontSize: 18, color: COLORS.ACCENT, fontFace: "Arial"
  });
  
  // Date range info
  slide.addText("Report Period: " + dateRange.label, {
    x: 0.5, y: 5.0, w: 6, h: 0.3,
    fontSize: 12, color: COLORS.WHITE, fontFace: "Arial"
  });
  
  // ========== SLIDE 1: Executive Summary ==========
  slide = pptx.addSlide();
  
  // Title with orange underline
  slide.addText("Executive Summary", {
    x: 0.36, y: 0.3, w: 12, h: 0.5,
    fontSize: 28, bold: true, color: COLORS.BLACK, fontFace: "Arial"
  });
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0.36, y: 0.8, w: 12.6, h: 0.05,
    fill: { color: COLORS.ACCENT }
  });
  
  // Section: Key Accomplishments
  slide.addText("Key Accomplishments for Last Period", {
    x: 0.36, y: 1.0, w: 5.5, h: 0.3,
    fontSize: 12, bold: true, color: COLORS.WHITE, fill: { color: COLORS.ACCENT }, fontFace: "Arial"
  });
  
  var accomplishmentText = "";
  var maxAccomp = Math.min(categorized.accomplishments.length, 5);
  for (var a = 0; a < maxAccomp; a++) {
    var acc = categorized.accomplishments[a];
    accomplishmentText += "• " + acc.key + ": " + acc.description.substring(0, 80) + (acc.description.length > 80 ? "..." : "") + "\n";
  }
  if (categorized.accomplishments.length === 0) {
    accomplishmentText = "No accomplishments recorded for this period.";
  }
  
  slide.addText(accomplishmentText, {
    x: 0.36, y: 1.35, w: 5.5, h: 1.2,
    fontSize: 9, color: COLORS.BLACK, fontFace: "Arial", valign: "top"
  });
  
  // Section: Top Priorities (Table)
  slide.addText("Top Priorities for Next Period", {
    x: 6.2, y: 1.0, w: 6.8, h: 0.3,
    fontSize: 12, bold: true, color: COLORS.WHITE, fill: { color: COLORS.ACCENT }, fontFace: "Arial"
  });
  
  var priorityTableData = [
    [
      { text: "#", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE, align: "center" } },
      { text: "Description", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } },
      { text: "Owner", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } }
    ]
  ];
  
  var maxPriorities = Math.min(categorized.priorities.length, 5);
  for (var p = 0; p < 5; p++) {
    if (p < maxPriorities) {
      var pri = categorized.priorities[p];
      priorityTableData.push([
        { text: String(p + 1), options: { align: "center" } },
        { text: pri.description.substring(0, 50) + (pri.description.length > 50 ? "..." : "") },
        { text: pri.assignee }
      ]);
    } else {
      priorityTableData.push([
        { text: String(p + 1), options: { align: "center" } },
        { text: "" },
        { text: "" }
      ]);
    }
  }
  
  slide.addTable(priorityTableData, {
    x: 6.2, y: 1.35, w: 6.8, h: 1.5,
    fontFace: "Arial",
    fontSize: 8,
    border: { type: "solid", pt: 0.5, color: COLORS.TABLE_BORDER },
    colW: [0.4, 4.5, 1.9]
  });
  
  // Section: Key Risks (Table)
  slide.addText("Key Risks, Issues and Action Items", {
    x: 0.36, y: 3.0, w: 12.6, h: 0.3,
    fontSize: 12, bold: true, color: COLORS.WHITE, fill: { color: COLORS.ACCENT }, fontFace: "Arial"
  });
  
  var riskTableData = [
    [
      { text: "#", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE, align: "center" } },
      { text: "Action Item", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } },
      { text: "Owner", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } },
      { text: "Target Date", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } },
      { text: "Status", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } }
    ]
  ];
  
  // Add risks from Jira
  var allRisks = categorized.risks.slice(0, 3);
  
  // Add risks from uploaded file if available
  if (riskFileData && riskFileData.risks && riskFileData.risks.length > 0) {
    var fileRisks = riskFileData.risks.slice(0, 3);
    for (var fr = 0; fr < fileRisks.length; fr++) {
      var fileRisk = fileRisks[fr];
      var riskDesc = fileRisk.Description || fileRisk.Risk || fileRisk["Action Item"] || Object.values(fileRisk)[0] || "";
      var riskOwner = fileRisk.Owner || fileRisk.Assignee || "TBD";
      var riskDate = fileRisk["Target Date"] || fileRisk.Date || "N/A";
      var riskStatus = fileRisk.Status || "Open";
      
      riskTableData.push([
        { text: String(riskTableData.length), options: { align: "center" } },
        { text: String(riskDesc).substring(0, 60) },
        { text: String(riskOwner) },
        { text: String(riskDate) },
        { text: String(riskStatus), options: { fill: { color: getStatusColor(riskStatus) } } }
      ]);
    }
  }
  
  // Add Jira risks
  for (var r = 0; r < allRisks.length && riskTableData.length < 6; r++) {
    var risk = allRisks[r];
    riskTableData.push([
      { text: String(riskTableData.length), options: { align: "center" } },
      { text: risk.description.substring(0, 60) + (risk.description.length > 60 ? "..." : "") },
      { text: risk.assignee },
      { text: formatDateISO(risk.dueDate) },
      { text: risk.status, options: { fill: { color: getStatusColor(risk.status) } } }
    ]);
  }
  
  // Fill empty rows
  while (riskTableData.length < 4) {
    riskTableData.push([
      { text: "", options: { align: "center" } },
      { text: "" },
      { text: "" },
      { text: "" },
      { text: "" }
    ]);
  }
  
  slide.addTable(riskTableData, {
    x: 0.36, y: 3.35, w: 12.6, h: 1.5,
    fontFace: "Arial",
    fontSize: 8,
    border: { type: "solid", pt: 0.5, color: COLORS.TABLE_BORDER },
    colW: [0.4, 7, 2, 1.5, 1.7]
  });
  
  // ========== SLIDE 2: Key Milestones ==========
  slide = pptx.addSlide();
  
  // Title
  slide.addText("Key Milestones", {
    x: 0.36, y: 0.3, w: 12, h: 0.5,
    fontSize: 28, bold: true, color: COLORS.BLACK, fontFace: "Arial"
  });
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0.36, y: 0.8, w: 12.6, h: 0.05,
    fill: { color: COLORS.ACCENT }
  });
  
  // Milestones Table
  slide.addText("Key Milestones and Status", {
    x: 0.36, y: 1.0, w: 12.6, h: 0.3,
    fontSize: 12, bold: true, color: COLORS.WHITE, fill: { color: COLORS.ACCENT }, fontFace: "Arial"
  });
  
  var milestoneTableData = [
    [
      { text: "#", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE, align: "center" } },
      { text: "Milestone Description", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } },
      { text: "Target Date", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } },
      { text: "Status", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } }
    ]
  ];
  
  var maxMilestones = Math.min(categorized.milestones.length, 6);
  for (var m = 0; m < maxMilestones; m++) {
    var mile = categorized.milestones[m];
    milestoneTableData.push([
      { text: String(m + 1), options: { align: "center" } },
      { text: mile.key + ": " + mile.description.substring(0, 60) + (mile.description.length > 60 ? "..." : "") },
      { text: formatDateISO(mile.dueDate) },
      { text: mile.status, options: { fill: { color: getStatusColor(mile.status) } } }
    ]);
  }
  
  // Fill empty rows
  while (milestoneTableData.length < 5) {
    milestoneTableData.push([
      { text: "", options: { align: "center" } },
      { text: "" },
      { text: "" },
      { text: "" }
    ]);
  }
  
  slide.addTable(milestoneTableData, {
    x: 0.36, y: 1.35, w: 12.6, h: 2.2,
    fontFace: "Arial",
    fontSize: 9,
    border: { type: "solid", pt: 0.5, color: COLORS.TABLE_BORDER },
    colW: [0.5, 8, 2, 2.1]
  });
  
  // Upcoming Milestones
  slide.addText("Upcoming Key Milestones", {
    x: 0.36, y: 3.8, w: 12.6, h: 0.3,
    fontSize: 12, bold: true, color: COLORS.WHITE, fill: { color: COLORS.ACCENT }, fontFace: "Arial"
  });
  
  var upcomingTableData = [
    [
      { text: "Milestone", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } },
      { text: "Target Date", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } },
      { text: "Owner", options: { bold: true, fill: { color: COLORS.ACCENT }, color: COLORS.WHITE } }
    ]
  ];
  
  var maxUpcoming = Math.min(categorized.upcomingMilestones.length, 4);
  for (var u = 0; u < maxUpcoming; u++) {
    var up = categorized.upcomingMilestones[u];
    upcomingTableData.push([
      { text: up.key + ": " + up.description.substring(0, 50) },
      { text: formatDateISO(up.dueDate) },
      { text: up.assignee }
    ]);
  }
  
  if (maxUpcoming === 0) {
    upcomingTableData.push([
      { text: "No upcoming milestones in this period" },
      { text: "" },
      { text: "" }
    ]);
  }
  
  slide.addTable(upcomingTableData, {
    x: 0.36, y: 4.15, w: 12.6, h: 1.2,
    fontFace: "Arial",
    fontSize: 9,
    border: { type: "solid", pt: 0.5, color: COLORS.TABLE_BORDER },
    colW: [8, 2.3, 2.3]
  });
  
  // ========== SLIDE 3: Thank You ==========
  slide = pptx.addSlide();
  
  // Black background
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 0, w: 13.33, h: 7.5,
    fill: { color: COLORS.PRIMARY }
  });
  
  // Orange accent bar at bottom
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 6.8, w: 13.33, h: 0.15,
    fill: { color: COLORS.ACCENT }
  });
  
  // Thank You text
  slide.addText("THANK YOU", {
    x: 0.5, y: 2.8, w: 12.33, h: 1.2,
    fontSize: 56, bold: true, color: COLORS.WHITE, align: "center", fontFace: "Arial"
  });
  
  // TAVANT branding
  slide.addText("TAVANT", {
    x: 8.5, y: 5.5, w: 4, h: 0.5,
    fontSize: 24, bold: true, color: COLORS.ACCENT, align: "right", fontFace: "Arial"
  });
  
  slide.addText("hello@tavant.com", {
    x: 8.5, y: 6.1, w: 4, h: 0.3,
    fontSize: 10, color: COLORS.WHITE, align: "right", fontFace: "Arial"
  });
  
  return pptx;
}

// === MCP Server ===
function createMcpServer() {
  var server = new McpServer({ name: "jira-status-mcp", version: "3.0.0" });

  // List Projects
  server.tool("list_projects", "List all Jira projects", {}, async function() {
    try {
      var response = await jira.get("/rest/api/3/project/search?maxResults=100");
      var projects = response.data.values.map(function(p) { return { key: p.key, name: p.name }; });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, projects: projects }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
    }
  });

  // Search Issues
  server.tool("search_issues", "Search Jira issues using JQL", { 
    jql: z.string(), 
    maxResults: z.number().optional().default(50) 
  }, async function(args) {
    try {
      var url = "/rest/api/3/search/jql?jql=" + encodeURIComponent(args.jql) + "&maxResults=" + args.maxResults + "&fields=key,summary,status,assignee,priority,issuetype,description";
      var response = await jira.get(url);
      var issues = response.data.issues.map(function(i) {
        return {
          key: i.key,
          summary: i.fields.summary,
          description: extractDescription(i.fields.description),
          status: i.fields.status ? i.fields.status.name : "Unknown",
          assignee: i.fields.assignee ? i.fields.assignee.displayName : "Unassigned",
          priority: i.fields.priority ? i.fields.priority.name : "Medium",
          type: i.fields.issuetype ? i.fields.issuetype.name : "Task"
        };
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, total: issues.length, issues: issues }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
    }
  });

  // Upload Risk File
  server.tool("upload_risk_file", "Upload risk management Excel file", { 
    base64Data: z.string(), 
    filename: z.string().optional() 
  }, async function(args) {
    var parsed = parseExcel(args.base64Data, args.filename || "risk.xlsx");
    if (!parsed.success) {
      return { content: [{ type: "text", text: JSON.stringify(parsed) }], isError: true };
    }
    riskData = { lastUpdated: new Date().toISOString(), filename: parsed.filename, risks: parsed.data, headers: parsed.headers };
    return { content: [{ type: "text", text: JSON.stringify({ success: true, message: "Risk file uploaded", totalRisks: parsed.rowCount, headers: parsed.headers }, null, 2) }] };
  });

  // Get Risk Data
  server.tool("get_risk_data", "Get uploaded risk data", {}, async function() {
    if (riskData.risks.length === 0) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, message: "No risk data uploaded" }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ success: true, ...riskData }, null, 2) }] };
  });

  // Generate Status Report (MAIN TOOL)
  server.tool("generate_status_report", "Generate weekly/biweekly PPTX status report with download link", {
    projectKey: z.string().describe("Jira project key (e.g., AT)"),
    period: z.enum(["weekly", "biweekly", "custom"]).describe("Report period: weekly (7 days), biweekly (14 days), or custom"),
    startDate: z.string().optional().describe("Start date for custom period (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("End date for custom period (YYYY-MM-DD)"),
    includeRisks: z.boolean().optional().default(true).describe("Include uploaded risk data")
  }, async function(args) {
    try {
      var now = new Date();
      var startDate, endDate, periodLabel;
      
      if (args.period === "custom") {
        if (!args.startDate || !args.endDate) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Custom period requires startDate and endDate" }) }], isError: true };
        }
        startDate = new Date(args.startDate);
        endDate = new Date(args.endDate);
        periodLabel = formatDateISO(startDate) + " to " + formatDateISO(endDate);
      } else if (args.period === "biweekly") {
        startDate = addDays(now, -14);
        endDate = addDays(now, 14);
        periodLabel = "Biweekly (" + formatDateISO(startDate) + " to " + formatDateISO(endDate) + ")";
      } else {
        // weekly
        startDate = addDays(now, -7);
        endDate = addDays(now, 7);
        periodLabel = "Weekly (" + formatDateISO(startDate) + " to " + formatDateISO(endDate) + ")";
      }
      
      // Fetch issues
      var issues = await fetchJiraIssues(args.projectKey, startDate, endDate);
      
      // Categorize
      var categorized = categorizeIssues(issues, startDate, endDate);
      
      // Generate PPTX
      var pptx = generateTavantPPTX(
        args.projectKey, 
        categorized, 
        { start: startDate, end: endDate, label: periodLabel },
        args.includeRisks ? riskData : null
      );
      
      // Save file
      var filename = args.projectKey + "_" + args.period + "_status_" + Date.now() + ".pptx";
      var filepath = path.join(REPORTS_DIR, filename);
      
      var uint8Array = await pptx.write({ outputType: "uint8array" });
      fs.writeFileSync(filepath, Buffer.from(uint8Array));
      
      var port = process.env.PORT || 3000;
      var downloadUrl = "http://localhost:" + port + "/reports/" + filename;
      
      // Build summary
      var summary = "Status report generated for project " + args.projectKey + "\n\n";
      summary += "Period: " + periodLabel + "\n\n";
      summary += "Summary:\n";
      summary += "- Key Accomplishments: " + categorized.accomplishments.length + " items\n";
      summary += "- Top Priorities: " + categorized.priorities.length + " items\n";
      summary += "- Risks/Issues: " + categorized.risks.length + " items\n";
      summary += "- Milestones: " + categorized.milestones.length + " items\n";
      summary += "- Upcoming Milestones: " + categorized.upcomingMilestones.length + " items\n\n";
      summary += "Download: " + downloadUrl;
      
      return { content: [{ type: "text", text: summary }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
    }
  });

  // Get Project Summary (JSON)
  server.tool("get_project_summary", "Get project summary data as JSON", {
    projectKey: z.string()
  }, async function(args) {
    try {
      var issues = await fetchJiraIssues(args.projectKey, addDays(new Date(), -30), addDays(new Date(), 30));
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
        byStatus: byStatus,
        byType: byType,
        byAssignee: byAssignee,
        issues: issues.slice(0, 20)
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
    }
  });

  return server;
}

// === REST API Endpoints ===
app.post("/api/upload-risk", function(req, res) {
  var base64Data = req.body.base64Data;
  var filename = req.body.filename;
  
  if (!base64Data) {
    return res.status(400).json({ success: false, error: "base64Data required" });
  }
  
  var parsed = parseExcel(base64Data, filename || "risk.xlsx");
  if (!parsed.success) {
    return res.status(400).json(parsed);
  }
  
  riskData = { lastUpdated: new Date().toISOString(), filename: parsed.filename, risks: parsed.data, headers: parsed.headers };
  res.json({ success: true, message: "Risk file uploaded", totalRisks: parsed.rowCount, headers: parsed.headers, filename: parsed.filename });
});

app.get("/api/risks", function(req, res) {
  res.json(riskData);
});

app.delete("/api/risks", function(req, res) {
  riskData = { lastUpdated: null, filename: null, risks: [], headers: [] };
  res.json({ success: true });
});

app.post("/api/generate-report", async function(req, res) {
  try {
    var projectKey = req.body.projectKey;
    var period = req.body.period || "weekly";
    var startDate = req.body.startDate;
    var endDate = req.body.endDate;
    var includeRisks = req.body.includeRisks !== false;
    
    if (!projectKey) {
      return res.status(400).json({ error: "projectKey required" });
    }
    
    var now = new Date();
    var start, end, periodLabel;
    
    if (period === "custom" && startDate && endDate) {
      start = new Date(startDate);
      end = new Date(endDate);
      periodLabel = formatDateISO(start) + " to " + formatDateISO(end);
    } else if (period === "biweekly") {
      start = addDays(now, -14);
      end = addDays(now, 14);
      periodLabel = "Biweekly";
    } else {
      start = addDays(now, -7);
      end = addDays(now, 7);
      periodLabel = "Weekly";
    }
    
    var issues = await fetchJiraIssues(projectKey, start, end);
    var categorized = categorizeIssues(issues, start, end);
    var pptx = generateTavantPPTX(projectKey, categorized, { start: start, end: end, label: periodLabel }, includeRisks ? riskData : null);
    
    var filename = projectKey + "_" + period + "_status_" + Date.now() + ".pptx";
    var filepath = path.join(REPORTS_DIR, filename);
    
    var uint8Array = await pptx.write({ outputType: "uint8array" });
    fs.writeFileSync(filepath, Buffer.from(uint8Array));
    
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", "attachment; filename=\"" + filename + "\"");
    
    var fileStream = fs.createReadStream(filepath);
    fileStream.pipe(res);
  } catch (e) {
    console.error("Report generation error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/status", function(req, res) {
  res.json({
    riskData: {
      loaded: riskData.risks.length > 0,
      filename: riskData.filename,
      riskCount: riskData.risks.length
    }
  });
});

// === MCP Endpoint ===
app.use("/mcp", function(req, res, next) {
  var key = req.headers["x-api-key"];
  if (!key && req.headers["authorization"]) {
    key = req.headers["authorization"].replace("Bearer ", "");
  }
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.post("/mcp", async function(req, res) {
  try {
    var transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    var server = createMcpServer();
    res.on("close", function() { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

app.get("/health", function(req, res) {
  res.json({ status: "ok", version: "3.0.0", riskDataLoaded: riskData.risks.length > 0 });
});

var port = process.env.PORT || 3000;
app.listen(port, function() {
  console.log("\n" +
    "╔═══════════════════════════════════════════════════════════════╗\n" +
    "║     JIRA STATUS REPORT MCP SERVER v3.0.0                      ║\n" +
    "║     Tavant-Styled PPTX Reports                                ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║  Server:  http://localhost:" + port + "                              ║\n" +
    "║  MCP:     http://localhost:" + port + "/mcp                          ║\n" +
    "║  Reports: http://localhost:" + port + "/reports                      ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║  MCP Tools:                                                   ║\n" +
    "║    • list_projects         - List Jira projects               ║\n" +
    "║    • search_issues         - Search with JQL                  ║\n" +
    "║    • upload_risk_file      - Upload risk Excel                ║\n" +
    "║    • get_risk_data         - Get uploaded risks               ║\n" +
    "║    • generate_status_report - Generate PPTX report            ║\n" +
    "║    • get_project_summary   - Get project summary JSON         ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║  Report Periods:                                              ║\n" +
    "║    • weekly    - Past 7 days + Next 7 days                    ║\n" +
    "║    • biweekly  - Past 14 days + Next 14 days                  ║\n" +
    "║    • custom    - Specify startDate and endDate                ║\n" +
    "╚═══════════════════════════════════════════════════════════════╝\n"
  );
});
