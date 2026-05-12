const COMMAND_PATTERN = /(?:^|\s)(?:查核|factcheck|\/factcheck)(?:\s|$)/i;
const JOB_TTL_SECONDS = 60 * 60 * 24 * 14;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "factcheck-slack-worker",
        endpoints: ["/slack/events", "/api/jobs/:id"]
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const id = url.pathname.split("/").pop();
      const job = await env.FACTCHECK_JOBS.get(jobKey(id), "json");
      return job ? json(job) : json({ ok: false, error: "job_not_found" }, 404);
    }

    if (request.method === "POST" && url.pathname === "/api/draft") {
      return handleDraftRequest(request, env);
    }

    if (request.method === "POST" && url.pathname === "/slack/events") {
      return handleSlackEvent(request, env, ctx);
    }

    return json({ ok: false, error: "not_found" }, 404);
  }
};

async function handleDraftRequest(request, env) {
  const input = await request.json();
  const claimPackage = {
    rootText: input.text || input.rootText || "",
    threadText: input.threadText || input.text || "",
    urls: input.urls || extractUrls(input.text || ""),
    files: input.files || [],
    slackMessages: input.slackMessages || []
  };
  const searchPlan = await generateSearchPlan(env, claimPackage);
  const evidence = await searchEvidence(env, searchPlan);
  const report = await generateReport(env, claimPackage, evidence);
  return json({ ok: true, claimPackage, searchPlan, evidence, report });
}

async function handleSlackEvent(request, env, ctx) {
  const rawBody = await request.text();
  const verified = await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET);
  if (!verified) return json({ ok: false, error: "invalid_signature" }, 401);

  const payload = JSON.parse(rawBody);
  if (payload.type === "url_verification") {
    return new Response(payload.challenge, { headers: { "content-type": "text/plain;charset=UTF-8" } });
  }

  if (payload.type !== "event_callback") return json({ ok: true });

  const event = payload.event || {};
  if (event.bot_id || event.subtype === "bot_message") return json({ ok: true });
  if (!COMMAND_PATTERN.test(stripSlackMentions(event.text || ""))) return json({ ok: true, ignored: true });

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const jobId = `${channel}-${threadTs}`.replace(/[^A-Za-z0-9_-]/g, "-");

  await saveJob(env, jobId, {
    ok: true,
    id: jobId,
    status: "queued",
    channel,
    threadTs,
    createdAt: new Date().toISOString()
  });

  await postSlackMessage(env, channel, threadTs, `收到，開始整理查核線索。Job ID: \`${jobId}\``);

  // Keep Slack's Events API response fast; Cloudflare will continue the async work when possible.
  const work = runFactcheckJob(env, { jobId, channel, threadTs });
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(work);
  else await work;

  return json({ ok: true, jobId });
}

async function runFactcheckJob(env, { jobId, channel, threadTs }) {
  try {
    await updateJob(env, jobId, { status: "collecting_slack_context" });
    const thread = await fetchSlackThread(env, channel, threadTs);
    const claimPackage = buildClaimPackage(thread);

    await updateJob(env, jobId, { status: "planning_search", claimPackage });
    const searchPlan = await generateSearchPlan(env, claimPackage);

    await updateJob(env, jobId, { status: "searching_evidence", searchPlan });
    const evidence = await searchEvidence(env, searchPlan);

    await updateJob(env, jobId, { status: "writing_report", evidence });
    const report = await generateReport(env, claimPackage, evidence);

    const result = {
      status: "done",
      finishedAt: new Date().toISOString(),
      claimPackage,
      searchPlan,
      evidence,
      report
    };
    await updateJob(env, jobId, result);

    await postSlackMessage(
      env,
      channel,
      threadTs,
      [
        `查核草稿完成：\`${report.title || "未命名草稿"}\``,
        `Job: /api/jobs/${jobId}`,
        `永久連結建議：\`${report.permalink || ""}\``
      ].join("\n")
    );
  } catch (error) {
    await updateJob(env, jobId, {
      status: "failed",
      error: String(error?.message || error),
      failedAt: new Date().toISOString()
    });
    await postSlackMessage(env, channel, threadTs, `查核草稿產生失敗：${String(error?.message || error)}`);
  }
}

async function fetchSlackThread(env, channel, threadTs) {
  const response = await slackApi(env, "conversations.replies", {
    channel,
    ts: threadTs,
    limit: 30,
    inclusive: true
  });
  if (!response.ok) throw new Error(`Slack conversations.replies failed: ${response.error}`);
  return response.messages || [];
}

function buildClaimPackage(messages) {
  const root = messages[0] || {};
  const allText = messages.map((message) => message.text || "").join("\n\n");
  const files = messages.flatMap((message) => (message.files || []).map(normalizeSlackFile));
  const urls = Array.from(new Set(extractUrls(allText)));
  return {
    rootText: stripSlackMentions(root.text || ""),
    threadText: stripSlackMentions(allText),
    urls,
    files,
    slackMessages: messages.map((message) => ({
      user: message.user,
      ts: message.ts,
      text: stripSlackMentions(message.text || ""),
      files: (message.files || []).map(normalizeSlackFile)
    }))
  };
}

function normalizeSlackFile(file) {
  return {
    id: file.id,
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    filetype: file.filetype,
    urlPrivate: file.url_private,
    thumb: file.thumb_1024 || file.thumb_720 || file.thumb_360
  };
}

async function generateSearchPlan(env, claimPackage) {
  const prompt = [
    "你是台灣事實查核編輯。請從 Slack 貼文線索萃取需要查核的主張，並產出搜尋計畫。",
    "只輸出 JSON，不要 markdown。",
    "JSON schema:",
    '{"claim":"","rumor_text":"","keywords":[""],"queries":[""],"entities":[""],"media_to_verify":[""],"risk_notes":[""]}',
    "",
    JSON.stringify(claimPackage, null, 2)
  ].join("\n");
  return generateGemmaJson(env, prompt);
}

async function searchEvidence(env, searchPlan) {
  const queries = Array.from(new Set((searchPlan.queries || []).filter(Boolean))).slice(0, 6);
  if (!env.GOOGLE_SEARCH_API_KEY || !env.GOOGLE_CSE_ID) {
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
    url.searchParams.set("key", env.GOOGLE_SEARCH_API_KEY);
    url.searchParams.set("cx", env.GOOGLE_CSE_ID);
    url.searchParams.set("q", queryText);
    url.searchParams.set("num", "5");
    const response = await fetch(url);
    const body = await response.json();
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

async function generateReport(env, claimPackage, evidence) {
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
    '{"title":"","article_html":"","tags":[""],"permalink":"","search_description":"","showcha_assets":{"cover":{"tool_url":"","headline":"","verdict":"","source_image_notes":""},"grid":{"tool_url":"","screenshots":[{"label":"","source_url":"","note":""}]}}}',
    "",
    "Slack 線索：",
    JSON.stringify(claimPackage, null, 2),
    "",
    "搜尋證據：",
    JSON.stringify(evidence, null, 2),
    "",
    "Blogger HTML 模板：",
    bloggerTemplate()
  ].join("\n");
  const report = await generateGemmaJson(env, prompt);
  report.showcha_assets ||= {};
  report.showcha_assets.cover ||= {};
  report.showcha_assets.grid ||= {};
  report.showcha_assets.cover.tool_url = env.COVER_TOOL_URL || "https://cover.showcha.com/";
  report.showcha_assets.grid.tool_url = env.GRID_TOOL_URL || "https://grid.showcha.com/";
  return report;
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

async function generateGemmaJson(env, prompt) {
  const text = await generateGemmaText(env, prompt);
  return parseJsonObject(text);
}

async function generateGemmaText(env, prompt) {
  if (!env.GOOGLE_AI_API_KEY) throw new Error("GOOGLE_AI_API_KEY is missing");
  const model = env.GEMMA_MODEL || "gemma-3-27b-it";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_AI_API_KEY}`, {
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

async function slackApi(env, method, payload) {
  if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is missing");
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json;charset=UTF-8"
    },
    body: JSON.stringify(payload)
  });
  return response.json();
}

async function postSlackMessage(env, channel, threadTs, text) {
  return slackApi(env, "chat.postMessage", {
    channel,
    thread_ts: threadTs,
    text,
    unfurl_links: false,
    unfurl_media: false
  });
}

async function verifySlackSignature(request, rawBody, signingSecret) {
  if (!signingSecret) throw new Error("SLACK_SIGNING_SECRET is missing");
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature") || "";
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const expected = `v0=${toHex(digest)}`;
  return timingSafeEqual(signature, expected);
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function saveJob(env, id, value) {
  await env.FACTCHECK_JOBS.put(jobKey(id), JSON.stringify(value), { expirationTtl: JOB_TTL_SECONDS });
}

async function updateJob(env, id, patch) {
  const current = (await env.FACTCHECK_JOBS.get(jobKey(id), "json")) || { id };
  await saveJob(env, id, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

function jobKey(id) {
  return `job:${id}`;
}

function stripSlackMentions(text) {
  return text.replace(/<@[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s>|]+/g) || [];
  return matches.map((url) => url.replace(/[),.。]+$/g, ""));
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" }
  });
}
