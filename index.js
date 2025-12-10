// index.js – Combined: Jira MCP + Document Generation (FREE - PptxGenJS)
// Version: 2.3.0 - Fixed PPTX corruption issues

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

app.use((req, res, next) => {
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
let riskData = { lastUpdated: null, filename: null, risks: [], headers: [] };

// === Jira Client ===
const jira = axios.create({
  baseURL: process.env.JIRA_BASE_URL,
  timeout: 15000,
  auth: { username: process.env.JIRA_EMAIL, password: process.env.JIRA_API_TOKEN }
});

// === Colors (6-digit hex, NO # prefix) ===
const COLORS = {
  PRIMARY: "1E3A5F",
  SECONDARY: "2E86AB",
  ACCENT: "F18F01",
  SUCCESS: "28A745",
  WARNING: "FFC107",
  DANGER: "DC3545",
  DARK: "333333",
  LIGHT: "F5F5F5",
  WHITE: "FFFFFF",
  BORDER: "CCCCCC"
};

// === Helpers ===
function parseExcel(base64Data, filename) {
  try {
    const buffer = Buffer.from(base64Data, "base64");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    return { success: true, filename, headers: Object.keys(data[0] || {}), data, rowCount: data.length };
  } catch (e) { return { success: false, error: e.message }; }
}

async function fetchJiraProject(projectKey) {
  const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(`project = ${projectKey}`)}&maxResults=100&fields=key,summary,status,assignee,priority,issuetype`;
  const { data } = await jira.get(url);
  const issues = data.issues.map(i => ({
    key: i.key,
    summary: i.fields.summary || "",
    status: i.fields.status?.name || "Unknown",
    assignee: i.fields.assignee?.displayName || "Unassigned",
    priority: i.fields.priority?.name || "None",
    type: i.fields.issuetype?.name || "Task"
  }));
  
  const byStatus = {}, byType = {}, byAssignee = {};
  issues.forEach(i => {
    byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    byType[i.type] = (byType[i.type] || 0) + 1;
    byAssignee[i.assignee] = (byAssignee[i.assignee] || 0) + 1;
  });
  
  return { project: projectKey, issues, totalIssues: issues.length, byStatus, byType, byAssignee };
}

// === PPTX Generation (Simplified & Robust) ===
function generatePPTX(projectData, risks) {
  const pptx = new PptxGenJS();
  
  // Set presentation properties
  pptx.author = "Status Report Generator";
  pptx.title = "Status Report - " + projectData.project;
  pptx.subject = "Weekly Status Report";
  pptx.company = "Tavant";
  
  // Use standard layout
  pptx.defineLayout({ name: "CUSTOM", width: 10, height: 5.625 });
  pptx.layout = "CUSTOM";

  // ========== SLIDE 1: Title ==========
  let slide = pptx.addSlide();
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 5.625,
    fill: { color: COLORS.PRIMARY }
  });
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 4.5, w: 10, h: 0.5,
    fill: { color: COLORS.ACCENT }
  });
  slide.addText("Weekly Status Report", {
    x: 0.5, y: 1.5, w: 9, h: 1,
    fontSize: 40, bold: true, color: COLORS.WHITE, fontFace: "Arial"
  });
  slide.addText("Project: " + projectData.project, {
    x: 0.5, y: 2.6, w: 9, h: 0.5,
    fontSize: 22, color: COLORS.LIGHT, fontFace: "Arial"
  });
  slide.addText("Generated: " + new Date().toLocaleDateString(), {
    x: 0.5, y: 4.6, w: 4, h: 0.3,
    fontSize: 11, color: COLORS.WHITE, fontFace: "Arial"
  });

  // ========== SLIDE 2: Summary ==========
  slide = pptx.addSlide();
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.8,
    fill: { color: COLORS.PRIMARY }
  });
  slide.addText("Project Summary", {
    x: 0.3, y: 0.2, w: 9, h: 0.4,
    fontSize: 24, bold: true, color: COLORS.WHITE, fontFace: "Arial"
  });

  // Summary boxes
  var summaryData = [
    { label: "Total Issues", value: projectData.totalIssues || 0, color: COLORS.PRIMARY },
    { label: "In Progress", value: projectData.byStatus["In Progress"] || 0, color: COLORS.SECONDARY },
    { label: "Done", value: projectData.byStatus["Done"] || 0, color: COLORS.SUCCESS },
    { label: "To Do", value: projectData.byStatus["To Do"] || 0, color: COLORS.WARNING }
  ];

  for (var i = 0; i < summaryData.length; i++) {
    var item = summaryData[i];
    var x = 0.4 + (i * 2.4);
    slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
      x: x, y: 1.1, w: 2.2, h: 1.1,
      fill: { color: item.color }
    });
    slide.addText(String(item.value), {
      x: x, y: 1.2, w: 2.2, h: 0.6,
      fontSize: 32, bold: true, color: COLORS.WHITE, align: "center", fontFace: "Arial"
    });
    slide.addText(item.label, {
      x: x, y: 1.8, w: 2.2, h: 0.3,
      fontSize: 10, color: COLORS.WHITE, align: "center", fontFace: "Arial"
    });
  }

  // Status breakdown
  var statusEntries = Object.entries(projectData.byStatus || {});
  if (statusEntries.length > 0) {
    slide.addText("Status Breakdown", {
      x: 0.4, y: 2.5, w: 4, h: 0.3,
      fontSize: 14, bold: true, color: COLORS.DARK, fontFace: "Arial"
    });
    
    var statusTableData = [];
    for (var j = 0; j < statusEntries.length; j++) {
      statusTableData.push([
        { text: statusEntries[j][0], options: { color: COLORS.DARK } },
        { text: String(statusEntries[j][1]), options: { color: COLORS.DARK, align: "center" } }
      ]);
    }
    
    slide.addTable(statusTableData, {
      x: 0.4, y: 2.9, w: 4, h: statusEntries.length * 0.35,
      fontFace: "Arial",
      fontSize: 11,
      border: { type: "solid", pt: 0.5, color: COLORS.BORDER },
      colW: [3, 1]
    });
  }

  // Type breakdown
  var typeEntries = Object.entries(projectData.byType || {});
  if (typeEntries.length > 0) {
    slide.addText("Issue Types", {
      x: 5.2, y: 2.5, w: 4, h: 0.3,
      fontSize: 14, bold: true, color: COLORS.DARK, fontFace: "Arial"
    });
    
    var typeTableData = [];
    for (var k = 0; k < typeEntries.length; k++) {
      typeTableData.push([
        { text: typeEntries[k][0], options: { color: COLORS.DARK } },
        { text: String(typeEntries[k][1]), options: { color: COLORS.DARK, align: "center" } }
      ]);
    }
    
    slide.addTable(typeTableData, {
      x: 5.2, y: 2.9, w: 4, h: typeEntries.length * 0.35,
      fontFace: "Arial",
      fontSize: 11,
      border: { type: "solid", pt: 0.5, color: COLORS.BORDER },
      colW: [3, 1]
    });
  }

  // ========== SLIDE 3: In Progress ==========
  var inProgress = projectData.issues.filter(function(issue) {
    return issue.status && issue.status.toLowerCase().indexOf("progress") !== -1;
  });
  
  slide = pptx.addSlide();
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.8,
    fill: { color: COLORS.SECONDARY }
  });
  slide.addText("In Progress", {
    x: 0.3, y: 0.2, w: 9, h: 0.4,
    fontSize: 24, bold: true, color: COLORS.WHITE, fontFace: "Arial"
  });

  if (inProgress.length > 0) {
    var ipHeaderRow = [
      { text: "Key", options: { bold: true, fill: { color: COLORS.SECONDARY }, color: COLORS.WHITE } },
      { text: "Summary", options: { bold: true, fill: { color: COLORS.SECONDARY }, color: COLORS.WHITE } },
      { text: "Assignee", options: { bold: true, fill: { color: COLORS.SECONDARY }, color: COLORS.WHITE } }
    ];
    
    var ipDataRows = [];
    var ipMax = Math.min(inProgress.length, 8);
    for (var m = 0; m < ipMax; m++) {
      var issue = inProgress[m];
      var summary = issue.summary || "";
      if (summary.length > 55) summary = summary.substring(0, 55) + "...";
      ipDataRows.push([
        { text: issue.key, options: { color: COLORS.DARK } },
        { text: summary, options: { color: COLORS.DARK } },
        { text: issue.assignee, options: { color: COLORS.DARK } }
      ]);
    }
    
    var ipTable = [ipHeaderRow].concat(ipDataRows);
    slide.addTable(ipTable, {
      x: 0.3, y: 1.0, w: 9.4, h: 0.4 + ipDataRows.length * 0.4,
      fontFace: "Arial",
      fontSize: 10,
      border: { type: "solid", pt: 0.5, color: COLORS.BORDER },
      colW: [1.2, 6, 2.2]
    });
    
    if (inProgress.length > 8) {
      slide.addText("+ " + (inProgress.length - 8) + " more issues...", {
        x: 0.3, y: 4.8, w: 9, h: 0.3,
        fontSize: 10, italic: true, color: COLORS.SECONDARY, fontFace: "Arial"
      });
    }
  } else {
    slide.addText("No issues currently in progress", {
      x: 0.3, y: 2.5, w: 9.4, h: 0.5,
      fontSize: 14, color: COLORS.DARK, align: "center", fontFace: "Arial"
    });
  }

  // ========== SLIDE 4: Completed ==========
  var done = projectData.issues.filter(function(issue) {
    return issue.status && issue.status.toLowerCase().indexOf("done") !== -1;
  });
  
  slide = pptx.addSlide();
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.8,
    fill: { color: COLORS.SUCCESS }
  });
  slide.addText("Recently Completed", {
    x: 0.3, y: 0.2, w: 9, h: 0.4,
    fontSize: 24, bold: true, color: COLORS.WHITE, fontFace: "Arial"
  });

  if (done.length > 0) {
    var doneHeaderRow = [
      { text: "Key", options: { bold: true, fill: { color: COLORS.SUCCESS }, color: COLORS.WHITE } },
      { text: "Summary", options: { bold: true, fill: { color: COLORS.SUCCESS }, color: COLORS.WHITE } }
    ];
    
    var doneDataRows = [];
    var doneMax = Math.min(done.length, 10);
    for (var n = 0; n < doneMax; n++) {
      var doneIssue = done[n];
      var doneSummary = doneIssue.summary || "";
      if (doneSummary.length > 70) doneSummary = doneSummary.substring(0, 70) + "...";
      doneDataRows.push([
        { text: doneIssue.key, options: { color: COLORS.DARK } },
        { text: doneSummary, options: { color: COLORS.DARK } }
      ]);
    }
    
    var doneTable = [doneHeaderRow].concat(doneDataRows);
    slide.addTable(doneTable, {
      x: 0.3, y: 1.0, w: 9.4, h: 0.4 + doneDataRows.length * 0.35,
      fontFace: "Arial",
      fontSize: 10,
      border: { type: "solid", pt: 0.5, color: COLORS.BORDER },
      colW: [1.2, 8.2]
    });
  } else {
    slide.addText("No completed issues", {
      x: 0.3, y: 2.5, w: 9.4, h: 0.5,
      fontSize: 14, color: COLORS.DARK, align: "center", fontFace: "Arial"
    });
  }

  // ========== SLIDE 5: Risks ==========
  slide = pptx.addSlide();
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.8,
    fill: { color: COLORS.DANGER }
  });
  slide.addText("Risk Management", {
    x: 0.3, y: 0.2, w: 9, h: 0.4,
    fontSize: 24, bold: true, color: COLORS.WHITE, fontFace: "Arial"
  });

  // Risk count box
  var riskCount = (risks && risks.risks) ? risks.risks.length : 0;
  slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
    x: 0.4, y: 1.1, w: 2, h: 1,
    fill: { color: COLORS.WARNING }
  });
  slide.addText(String(riskCount), {
    x: 0.4, y: 1.2, w: 2, h: 0.5,
    fontSize: 28, bold: true, color: COLORS.DARK, align: "center", fontFace: "Arial"
  });
  slide.addText("Total Risks", {
    x: 0.4, y: 1.7, w: 2, h: 0.3,
    fontSize: 10, color: COLORS.DARK, align: "center", fontFace: "Arial"
  });

  if (riskCount > 0) {
    var riskHeaders = Object.keys(risks.risks[0]).slice(0, 4);
    
    var riskHeaderRow = [];
    for (var rh = 0; rh < riskHeaders.length; rh++) {
      riskHeaderRow.push({
        text: riskHeaders[rh],
        options: { bold: true, fill: { color: COLORS.DANGER }, color: COLORS.WHITE }
      });
    }
    
    var riskDataRows = [];
    var riskMax = Math.min(risks.risks.length, 6);
    for (var r = 0; r < riskMax; r++) {
      var riskRow = [];
      for (var rhi = 0; rhi < riskHeaders.length; rhi++) {
        var val = String(risks.risks[r][riskHeaders[rhi]] || "");
        if (val.length > 30) val = val.substring(0, 30) + "...";
        riskRow.push({ text: val, options: { color: COLORS.DARK } });
      }
      riskDataRows.push(riskRow);
    }
    
    var riskTable = [riskHeaderRow].concat(riskDataRows);
    var riskColW = [];
    for (var rc = 0; rc < riskHeaders.length; rc++) {
      riskColW.push(9.4 / riskHeaders.length);
    }
    
    slide.addTable(riskTable, {
      x: 0.3, y: 2.3, w: 9.4, h: 0.4 + riskDataRows.length * 0.4,
      fontFace: "Arial",
      fontSize: 9,
      border: { type: "solid", pt: 0.5, color: COLORS.BORDER },
      colW: riskColW
    });
  } else {
    slide.addText("No risk data uploaded", {
      x: 3, y: 2, w: 6, h: 0.5,
      fontSize: 14, color: COLORS.DARK, fontFace: "Arial"
    });
  }

  // ========== SLIDE 6: Team ==========
  slide = pptx.addSlide();
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.8,
    fill: { color: COLORS.PRIMARY }
  });
  slide.addText("Team Allocation", {
    x: 0.3, y: 0.2, w: 9, h: 0.4,
    fontSize: 24, bold: true, color: COLORS.WHITE, fontFace: "Arial"
  });

  var assigneeEntries = Object.entries(projectData.byAssignee || {});
  assigneeEntries.sort(function(a, b) { return b[1] - a[1]; });

  if (assigneeEntries.length > 0) {
    var teamHeaderRow = [
      { text: "Team Member", options: { bold: true, fill: { color: COLORS.SECONDARY }, color: COLORS.WHITE } },
      { text: "Issues", options: { bold: true, fill: { color: COLORS.SECONDARY }, color: COLORS.WHITE, align: "center" } }
    ];
    
    var teamDataRows = [];
    var teamMax = Math.min(assigneeEntries.length, 10);
    for (var t = 0; t < teamMax; t++) {
      teamDataRows.push([
        { text: assigneeEntries[t][0], options: { color: COLORS.DARK } },
        { text: String(assigneeEntries[t][1]), options: { color: COLORS.DARK, align: "center" } }
      ]);
    }
    
    var teamTable = [teamHeaderRow].concat(teamDataRows);
    slide.addTable(teamTable, {
      x: 1.5, y: 1.1, w: 7, h: 0.4 + teamDataRows.length * 0.35,
      fontFace: "Arial",
      fontSize: 11,
      border: { type: "solid", pt: 0.5, color: COLORS.BORDER },
      colW: [5, 2]
    });
  } else {
    slide.addText("No team data available", {
      x: 0.3, y: 2.5, w: 9.4, h: 0.5,
      fontSize: 14, color: COLORS.DARK, align: "center", fontFace: "Arial"
    });
  }

  // ========== SLIDE 7: Thank You ==========
  slide = pptx.addSlide();
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 5.625,
    fill: { color: COLORS.PRIMARY }
  });
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 4.5, w: 10, h: 0.5,
    fill: { color: COLORS.ACCENT }
  });
  slide.addText("Thank You", {
    x: 0.5, y: 2, w: 9, h: 0.8,
    fontSize: 44, bold: true, color: COLORS.WHITE, align: "center", fontFace: "Arial"
  });
  slide.addText("Questions?", {
    x: 0.5, y: 2.9, w: 9, h: 0.5,
    fontSize: 20, color: COLORS.LIGHT, align: "center", fontFace: "Arial"
  });

  return pptx;
}

// === MCP Server ===
function createMcpServer() {
  const mcpServer = new McpServer({ name: "jira-docgen-mcp", version: "2.3.0" });

  mcpServer.tool("list_projects", "List Jira projects", {}, async () => {
    try {
      const { data } = await jira.get("/rest/api/3/project/search?maxResults=100");
      return { content: [{ type: "text", text: JSON.stringify({ success: true, projects: data.values.map(p => ({ key: p.key, name: p.name })) }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true }; }
  });

  mcpServer.tool("search_issues", "Search issues", { jql: z.string(), maxResults: z.number().optional().default(50) }, async ({ jql, maxResults }) => {
    try {
      const url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=key,summary,status,assignee,priority,issuetype`;
      const { data } = await jira.get(url);
      const issues = data.issues.map(i => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, assignee: i.fields.assignee?.displayName || "Unassigned", priority: i.fields.priority?.name, type: i.fields.issuetype?.name }));
      return { content: [{ type: "text", text: JSON.stringify({ success: true, total: issues.length, issues }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true }; }
  });

  mcpServer.tool("get_project_summary", "Get project summary", { projectKey: z.string() }, async ({ projectKey }) => {
    try {
      const data = await fetchJiraProject(projectKey);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, ...data }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true }; }
  });

  mcpServer.tool("upload_risk_file", "Upload risk Excel", { base64Data: z.string(), filename: z.string().optional() }, async ({ base64Data, filename }) => {
    const parsed = parseExcel(base64Data, filename || "risk.xlsx");
    if (!parsed.success) return { content: [{ type: "text", text: JSON.stringify(parsed) }], isError: true };
    riskData = { lastUpdated: new Date().toISOString(), filename: parsed.filename, risks: parsed.data, headers: parsed.headers };
    return { content: [{ type: "text", text: JSON.stringify({ success: true, totalRisks: parsed.rowCount, headers: parsed.headers }, null, 2) }] };
  });

  mcpServer.tool("get_risk_data", "Get risk data", {}, async () => {
    return { content: [{ type: "text", text: JSON.stringify(riskData.risks.length ? { success: true, ...riskData } : { success: false, message: "No risk data" }, null, 2) }] };
  });

  mcpServer.tool("generate_status_report", "Generate JSON report", { projectKey: z.string(), includeRisks: z.boolean().optional().default(true) }, async ({ projectKey, includeRisks }) => {
    try {
      const data = await fetchJiraProject(projectKey);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, generatedAt: new Date().toISOString(), ...data, risks: includeRisks ? riskData : null }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true }; }
  });

  mcpServer.tool("generate_pptx_report", "Generate PPTX (returns base64)", { projectKey: z.string(), includeRisks: z.boolean().optional().default(true) }, async ({ projectKey, includeRisks }) => {
    try {
      const data = await fetchJiraProject(projectKey);
      const pptx = generatePPTX(data, includeRisks ? riskData : null);
      const base64 = await pptx.write({ outputType: "base64" });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, filename: "status_report_" + projectKey + ".pptx", base64Length: base64.length, note: "Use /api/generate-pptx endpoint to download file" }, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message }) }], isError: true }; }
  });

  return mcpServer;
}

// === REST API ===
app.post("/api/upload-risk", (req, res) => {
  const { base64Data, filename } = req.body;
  if (!base64Data) return res.status(400).json({ success: false, error: "base64Data required" });
  const parsed = parseExcel(base64Data, filename);
  if (!parsed.success) return res.status(400).json(parsed);
  riskData = { lastUpdated: new Date().toISOString(), filename: parsed.filename, risks: parsed.data, headers: parsed.headers };
  res.json({ success: true, message: "Risk file uploaded", totalRisks: parsed.rowCount, headers: parsed.headers, filename: parsed.filename });
});

app.get("/api/risks", (req, res) => res.json(riskData));

app.post("/api/generate-pptx", async (req, res) => {
  try {
    const { projectKey, includeRisks } = req.body;
    const shouldIncludeRisks = includeRisks !== false;
    
    if (!projectKey) return res.status(400).json({ error: "projectKey required" });
    
    console.log("Generating PPTX for project: " + projectKey);
    const data = await fetchJiraProject(projectKey);
    console.log("Fetched " + data.totalIssues + " issues");
    
    const pptx = generatePPTX(data, shouldIncludeRisks ? riskData : null);
    
    // Write to buffer first, then to file
    const uint8Array = await pptx.write({ outputType: "uint8array" });
    const filename = "status_report_" + projectKey + "_" + Date.now() + ".pptx";
    const filepath = path.join("/tmp", filename);
    
    fs.writeFileSync(filepath, Buffer.from(uint8Array));
    console.log("PPTX written to: " + filepath);
    
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", "attachment; filename=\"" + filename + "\"");
    
    const fileStream = fs.createReadStream(filepath);
    fileStream.pipe(res);
    fileStream.on("end", function() {
      fs.unlink(filepath, function() {});
    });
    
  } catch (e) {
    console.error("PPTX generation error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/risks", (req, res) => {
  riskData = { lastUpdated: null, filename: null, risks: [], headers: [] };
  res.json({ success: true });
});

app.get("/api/status", (req, res) => {
  res.json({
    riskData: {
      loaded: riskData.risks.length > 0,
      filename: riskData.filename,
      riskCount: riskData.risks.length
    }
  });
});

// === MCP Endpoint ===
app.use("/mcp", (req, res, next) => {
  const key = req.headers["x-api-key"] || (req.headers["authorization"] ? req.headers["authorization"].replace("Bearer ", "") : "");
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = createMcpServer();
    res.on("close", function() { transport.close(); mcpServer.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.get("/health", (req, res) => res.json({ status: "ok", version: "2.3.0", riskDataLoaded: riskData.risks.length > 0 }));

const port = process.env.PORT || 3000;
app.listen(port, function() {
  console.log("\n" +
    "╔═══════════════════════════════════════════════════════════════╗\n" +
    "║     JIRA + DOC GEN MCP SERVER v2.3.0 (FREE - PptxGenJS)       ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║  Server: http://localhost:" + port + "                                ║\n" +
    "║  MCP:    http://localhost:" + port + "/mcp                            ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║  MCP Tools:                                                   ║\n" +
    "║    • list_projects       • search_issues                      ║\n" +
    "║    • get_project_summary • upload_risk_file                   ║\n" +
    "║    • get_risk_data       • generate_status_report             ║\n" +
    "║    • generate_pptx_report                                     ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║  REST API:                                                    ║\n" +
    "║    POST /api/upload-risk   POST /api/generate-pptx            ║\n" +
    "║    GET  /api/risks         DELETE /api/risks                  ║\n" +
    "║    GET  /api/status                                           ║\n" +
    "╠═══════════════════════════════════════════════════════════════╣\n" +
    "║  🎉 NO PAID APIs - 100% FREE with PptxGenJS!                  ║\n" +
    "╚═══════════════════════════════════════════════════════════════╝\n"
  );
});
