import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDir = process.env.OUTPUT_DIR || "outputs/latest";
const primaryModel = process.env.GEMMA_MODEL || "gemini-2.5-flash-lite";
const groundingModel = process.env.GROUNDING_MODEL || "gemini-2.5-flash-lite";
const claimText = process.env.CLAIM_TEXT || "";
const extraUrls = splitLines(process.env.CLAIM_URLS || "");
const notes = process.env.NOTES || "";

if (!claimText.trim()) {
  throw new Error("CLAIM_TEXT is required.");
}

const claimPackage = {
  rootText: claimText.trim(),
  threadText: [claimText.trim(), notes.trim()].filter(Boolean).join("\n\n"),
  urls: Array.from(new Set([...extractUrls(claimText), ...extraUrls])),
  files: [],
  slackMessages: []
};

await mkdir(outputDir, { recursive: true });

const searchPlan = await generateSearchPlan(claimPackage);
const evidence = await searchEvidence(searchPlan);
const report = await generateReport(claimPackage, evidence);

const result = {
  ok: true,
  generatedAt: new Date().toISOString(),
  claimPackage,
  searchPlan,
  evidence,
  report
};

await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
await writeFile(path.join(outputDir, "article.html"), `${report.article_html || ""}\n`);
await writeFile(path.join(outputDir, "metadata.md"), renderMetadata(report));

console.log(`Generated draft: ${report.title || "(untitled)"}`);
console.log(`Output directory: ${outputDir}`);

async function generateSearchPlan(input) {
  const prompt = [
    "你是台灣事實查核編輯。請從使用者提供的謠言線索萃取需要查核的主張，並產出搜尋計畫。",
    "只輸出 JSON，不要 markdown。",
    "JSON schema:",
    '{"claim":"","rumor_text":"","keywords":[""],"queries":[""],"entities":[""],"media_to_verify":[""],"risk_notes":[""]}',
    "",
    JSON.stringify(input, null, 2)
  ].join("\n");
  return generateGemmaJson(prompt);
}

async function searchEvidence(searchPlan) {
  const queries = Array.from(new Set((searchPlan.queries || []).filter(Boolean))).slice(0, 6);
  const results = [];
  for (const queryText of queries) {
    results.push(await generateGroundedEvidence(queryText, searchPlan));
  }
  const items = uniqueEvidenceItems(results.flatMap((result) => result.items || []));
  return {
    mode: items.length ? "gemini_google_search_grounding" : "manual_required",
    note: items.length ? "Evidence sources were extracted from Gemini groundingMetadata.groundingChunks." : "Gemini Google Search grounding returned no usable sources; manual verification is required.",
    queries,
    items,
    results
  };
}

async function generateGroundedEvidence(queryText, searchPlan) {
  const prompt = [
    "你是事實查核研究員。請使用 Google Search grounding 查找可驗證來源。",
    "請聚焦於原始來源、官方聲明、可信媒體、反向搜圖可用線索。",
    "用繁體中文輸出短摘要，列出哪些資訊支持或反駁待查主張。",
    "",
    `查詢：${queryText}`,
    "",
    "待查主張與搜尋計畫：",
    JSON.stringify(searchPlan, null, 2)
  ].join("\n");
  const grounded = await generateGroundedText(prompt);
  const chunks = grounded.groundingMetadata?.groundingChunks || [];
  return {
    query: queryText,
    summary: grounded.text,
    webSearchQueries: grounded.groundingMetadata?.webSearchQueries || [],
    items: chunks.map((chunk) => ({
      title: chunk.web?.title || chunk.retrievedContext?.title || "",
      link: chunk.web?.uri || chunk.retrievedContext?.uri || "",
      snippet: ""
    })).filter((item) => item.link)
  };
}

async function generateReport(input, evidence) {
  const prompt = [
    "你是繁體中文事實查核記者，風格參考 MyGoPen，但不得複製任何來源文字。",
    "根據使用者提供的謠言線索與搜尋結果，產出可供人工審稿的 Blogger 草稿。",
    "重要規則：",
    "1. 沒有證據支持的句子要保守表述，不能編造來源。",
    "2. HTML 必須符合使用者指定結構。",
    "3. 資料來源只列 evidence.items、evidence.results.items 或謠言線索 urls 中真的存在的連結；如果沒有可用連結，資料來源段落只能寫「待人工補充資料來源」，不可自行新增任何 URL。",
    "4. 如果 evidence.mode 是 manual_required，請明確把草稿標記為待人工查證，不要寫成已完成定稿。",
    "只輸出 JSON，不要 markdown。",
    "JSON schema:",
    '{"title":"","article_html":"","tags":[""],"permalink":"","search_description":""}',
    "",
    "謠言線索：",
    JSON.stringify(input, null, 2),
    "",
    "搜尋證據：",
    JSON.stringify(evidence, null, 2),
    "",
    "Blogger HTML 模板：",
    bloggerTemplate()
  ].join("\n");
  const report = await generateGemmaJson(prompt);
  sanitizeReportLinks(report, allowedEvidenceLinks(input, evidence));
  return report;
}

async function generateGemmaJson(prompt) {
  const text = await generateGemmaText(prompt);
  return parseJsonObject(text);
}

async function generateGroundedText(prompt) {
  if (!process.env.GOOGLE_AI_API_KEY) {
    throw new Error("GOOGLE_AI_API_KEY is required.");
  }
  const errors = [];
  const models = Array.from(new Set([groundingModel, "gemini-2.5-flash", "gemini-2.0-flash"]));

  for (const model of models) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1 }
      })
    });
    const body = await response.json();
    if (response.ok) {
      const candidate = body.candidates?.[0] || {};
      return {
        text: candidate.content?.parts?.map((part) => part.text || "").join("") || "",
        groundingMetadata: candidate.groundingMetadata || {}
      };
    }
    errors.push({ model, status: response.status, body });
    if (!isRetryableModelError(response.status, body)) break;
  }

  throw new Error(`Gemini grounding failed: ${JSON.stringify(errors)}`);
}

async function generateGemmaText(prompt) {
  if (!process.env.GOOGLE_AI_API_KEY) {
    throw new Error("GOOGLE_AI_API_KEY is required.");
  }

  const errors = [];
  for (const model of modelCandidates()) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    });
    const body = await response.json();
    if (response.ok) return body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";

    errors.push({ model, status: response.status, body });
    if (!isRetryableModelError(response.status, body)) break;
  }

  throw new Error(`Gemini API failed: ${JSON.stringify(errors)}`);
}

function modelCandidates() {
  return Array.from(new Set([
    primaryModel,
    ...(process.env.FALLBACK_MODELS || "gemini-2.5-flash-lite,gemma-3-27b-it").split(",").map((model) => model.trim()).filter(Boolean)
  ]));
}

function isRetryableModelError(status, body) {
  const code = body?.error?.status || "";
  return [429, 500, 503].includes(status) || ["RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE"].includes(code);
}

function uniqueEvidenceItems(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const link = item.link || item.url || "";
    if (!link || seen.has(link)) continue;
    seen.add(link);
    unique.push(item);
  }
  return unique;
}

function allowedEvidenceLinks(input, evidence) {
  return new Set([
    ...(input.urls || []),
    ...(evidence.items || []).map((item) => item.link),
    ...(evidence.results || []).flatMap((result) => (result.items || []).map((item) => item.link))
  ].filter(Boolean));
}

function sanitizeReportLinks(report, allowedLinks) {
  if (typeof report.article_html === "string") {
    report.article_html = report.article_html.replace(/<a\s+href="([^"]+)"([^>]*)>(.*?)<\/a>/g, (match, href, attrs, label) => {
      if (allowedLinks.has(href)) return match;
      return `<span${attrs}>${label}（待人工補連結）</span>`;
    });
  }

}

function parseJsonObject(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonText = extractFirstJsonObject(trimmed);
    if (!jsonText) throw new Error(`Model did not return JSON: ${text.slice(0, 400)}`);
    return JSON.parse(jsonText);
  }
}

function extractFirstJsonObject(value) {
  const text = String(value || "");
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return "";
}

function renderMetadata(report) {
  return [
    "# 查核草稿輸出",
    "",
    "## 標題",
    report.title || "",
    "",
    "## 標籤",
    (report.tags || []).join(","),
    "",
    "## 永久連結",
    report.permalink || "",
    "",
    "## 搜尋說明",
    report.search_description || "",
    ""
  ].join("\n");
}

function bloggerTemplate() {
  return `<div class="quote_style"><h3 style="text-align: center;">你可以先知道：</h3>說明破解資訊。</div><br />
<div class="intro_words">網傳「謠言內容」的影片訊息，前言描述。</div>
<br />[查核圖片]<br />
<!--more-->
<h2>大標的謠言</h2>
<br />原始謠傳版本：<br />
<blockquote class="tr_bq">謠言本體</blockquote>
<br />主要流傳這段影片<br /><br />
影片
<br /><br />
並在社群平台流傳：
<br />圖片<br />
查證解釋：<br />
<blockquote class="yestrue">
闢謠內容
</blockquote>
<br />資料來源：文獻 - <a href="https://www.blogger.com/#">文獻的標題內容</a><br />`;
}

function splitLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s>|]+/g) || [];
  return matches.map((url) => url.replace(/[),.。]+$/g, ""));
}
