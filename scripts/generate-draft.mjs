import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDir = process.env.OUTPUT_DIR || "outputs/latest";
const model = process.env.GEMMA_MODEL || "gemma-3-27b-it";
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
await writeFile(path.join(outputDir, "showcha-assets.md"), renderShowchaAssets(report.showcha_assets || {}));

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
  if (!process.env.GOOGLE_SEARCH_API_KEY || !process.env.GOOGLE_CSE_ID) {
    return {
      mode: "manual_required",
      note: "Set GOOGLE_SEARCH_API_KEY and GOOGLE_CSE_ID to enable automatic evidence search.",
      queries,
      results: []
    };
  }

  const results = [];
  for (const queryText of queries) {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", process.env.GOOGLE_SEARCH_API_KEY);
    url.searchParams.set("cx", process.env.GOOGLE_CSE_ID);
    url.searchParams.set("q", queryText);
    url.searchParams.set("num", "5");
    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok) {
      results.push({ query: queryText, error: body.error?.message || response.statusText, items: [] });
      continue;
    }
    results.push({
      query: queryText,
      items: (body.items || []).map((item) => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet,
        displayLink: item.displayLink
      }))
    });
  }
  return { mode: "google_cse", queries, results };
}

async function generateReport(input, evidence) {
  const prompt = [
    "你是繁體中文事實查核記者，風格參考 MyGoPen，但不得複製任何來源文字。",
    "根據使用者提供的謠言線索與搜尋結果，產出可供人工審稿的 Blogger 草稿。",
    "重要規則：",
    "1. 沒有證據支持的句子要保守表述，不能編造來源。",
    "2. HTML 必須符合使用者指定結構。",
    "3. 資料來源只列 evidence 中真的存在的連結。",
    "4. showcha_assets 要包含 cover.showcha.com 首圖製作文案、grid.showcha.com 截圖組合清單。",
    "只輸出 JSON，不要 markdown。",
    "JSON schema:",
    '{"title":"","article_html":"","tags":[""],"permalink":"","search_description":"","showcha_assets":{"cover":{"tool_url":"https://cover.showcha.com/","headline":"","verdict":"","source_image_notes":""},"grid":{"tool_url":"https://grid.showcha.com/","screenshots":[{"label":"","source_url":"","note":""}]}}}',
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
  report.showcha_assets ||= {};
  report.showcha_assets.cover ||= {};
  report.showcha_assets.grid ||= {};
  report.showcha_assets.cover.tool_url ||= "https://cover.showcha.com/";
  report.showcha_assets.grid.tool_url ||= "https://grid.showcha.com/";
  return report;
}

async function generateGemmaJson(prompt) {
  const text = await generateGemmaText(prompt);
  return parseJsonObject(text);
}

async function generateGemmaText(prompt) {
  if (!process.env.GOOGLE_AI_API_KEY) {
    throw new Error("GOOGLE_AI_API_KEY is required.");
  }

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
  if (!response.ok) throw new Error(`Gemma API failed: ${JSON.stringify(body)}`);
  return body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
}

function parseJsonObject(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error(`Model did not return JSON: ${text.slice(0, 400)}`);
    return JSON.parse(trimmed.slice(start, end + 1));
  }
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

function renderShowchaAssets(showchaAssets) {
  const cover = showchaAssets.cover || {};
  const grid = showchaAssets.grid || {};
  const screenshots = grid.screenshots || [];

  return [
    "# showcha 素材清單",
    "",
    "## 首圖",
    `工具：${cover.tool_url || "https://cover.showcha.com/"}`,
    `標題：${cover.headline || ""}`,
    `判定：${cover.verdict || ""}`,
    `素材備註：${cover.source_image_notes || ""}`,
    "",
    "## 截圖組合",
    `工具：${grid.tool_url || "https://grid.showcha.com/"}`,
    "",
    ...screenshots.flatMap((item, index) => [
      `### 截圖 ${index + 1}`,
      `標籤：${item.label || ""}`,
      `來源：${item.source_url || ""}`,
      `備註：${item.note || ""}`,
      ""
    ])
  ].join("\n");
}

function bloggerTemplate() {
  return `<div class="quote_style"><h3 style="text-align: center;">你可以先知道：</h3>說明破解資訊。</div><br />
<div class="intro_words">網傳「謠言內容」的影片訊息，前言描述。</div>
「首圖」
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
