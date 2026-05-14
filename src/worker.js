const COMMAND_PATTERN = /(?:^|\s)(?:查核|factcheck|\/factcheck)(?:\s|$)/i;
const JOB_TTL_SECONDS = 60 * 60 * 24 * 14;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.redirect(new URL("/jobs", url).toString(), 302);
    }

    if (request.method === "GET" && url.pathname === "/jobs") {
      return renderJobsPage(env, url);
    }

    if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
      const id = decodeURIComponent(url.pathname.slice("/jobs/".length));
      const job = await env.FACTCHECK_JOBS.get(jobKey(id), "json");
      return job ? html(renderJobPage(normalizeJobForOutput(job), url)) : html(renderNotFoundPage(id), 404);
    }

    if (request.method === "GET" && url.pathname.startsWith("/jobs/") && url.pathname.endsWith("/review")) {
      const id = decodeURIComponent(url.pathname.slice("/jobs/".length, -("/review".length)));
      const job = await env.FACTCHECK_JOBS.get(jobKey(id), "json");
      return job ? html(renderReviewPage(normalizeJobForOutput(job), url)) : html(renderNotFoundPage(id), 404);
    }

    if (request.method === "POST" && url.pathname.startsWith("/jobs/") && url.pathname.endsWith("/review")) {
      const id = decodeURIComponent(url.pathname.slice("/jobs/".length, -("/review".length)));
      return handleReviewUpdate(request, env, id);
    }


    if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const id = url.pathname.split("/").pop();
      const job = await env.FACTCHECK_JOBS.get(jobKey(id), "json");
      return job ? json(normalizeJobForOutput(job)) : json({ ok: false, error: "job_not_found" }, 404);
    }

    if (request.method === "POST" && url.pathname === "/api/draft") {
      return handleDraftRequest(request, env);
    }

    if (request.method === "POST" && url.pathname === "/slack/events") {
      return handleSlackEvent(request, env, ctx);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processQueuedJobs(env));
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
  const payload = JSON.parse(rawBody);
  if (payload.type === "url_verification") {
    return new Response(payload.challenge, { headers: { "content-type": "text/plain;charset=UTF-8" } });
  }

  const verified = await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET);
  if (!verified) return json({ ok: false, error: "invalid_signature" }, 401);

  if (payload.type !== "event_callback") return json({ ok: true });

  const event = payload.event || {};
  if (event.bot_id || event.subtype === "bot_message") return json({ ok: true });
  if (!isFactcheckTrigger(event)) return json({ ok: true, ignored: true });

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

  // Keep Slack's Events API response fast. The scheduled worker processes queued jobs.
  if (env.PROCESS_IMMEDIATELY === "true") {
    const work = runFactcheckJob(env, { jobId, channel, threadTs });
    if (typeof ctx?.waitUntil === "function") ctx.waitUntil(work);
    else await work;
  }

  return json({ ok: true, jobId });
}

async function handleReviewUpdate(request, env, jobId) {
  const formData = await request.formData();
  const title = formData.get("title");
  const articleHtml = formData.get("article_html");
  const tags = formData.get("tags");
  const permalink = formData.get("permalink");
  const searchDescription = formData.get("search_description");

  const currentJob = (await env.FACTCHECK_JOBS.get(jobKey(jobId), "json")) || { id: jobId };

  const updatedReport = {
    ...currentJob.report,
    title: title || "",
    article_html: articleHtml || "",
    tags: tags ? tags.split(",").map(tag => tag.trim()).filter(Boolean) : [],
    permalink: permalink || "",
    search_description: searchDescription || "",
  };

  await updateJob(env, jobId, {
    report: updatedReport,
    status: "reviewed", // 可以新增一個狀態表示已人工審核
    updatedAt: new Date().toISOString(),
  });

  // Redirect back to the job detail page
  return Response.redirect(publicUrl(env, `/jobs/${encodeURIComponent(jobId)}`), 302);
}

async function processQueuedJobs(env) {
  const list = await env.FACTCHECK_JOBS.list({ prefix: "job:", limit: 20 });
  // 這裡可以考慮增加 limit，並透過並行處理提升吞吐量
  const list = await env.FACTCHECK_JOBS.list({ prefix: "job:", limit: 10 });
  const queued = [];
  
  for (const key of list.keys || []) {
    // 如果 KV 支援 metadata，可以直接從 key.metadata 判斷 status，不用 get
    const job = await env.FACTCHECK_JOBS.get(key.name, "json");
    if (job?.status === "queued") queued.push(job);
    if (queued.length >= 2) break;
    if (queued.length >= 5) break; // 提高每分鐘處理上限
  }

  for (const job of queued) {
    await runFactcheckJob(env, {
  if (queued.length === 0) return;

  // 使用 Promise.allSettled 並行執行，避免序列等待
  await Promise.allSettled(queued.map(job => 
    runFactcheckJob(env, {
      jobId: job.id,
      channel: job.channel,
      threadTs: job.threadTs
    });
  }
    })
  ));
}

async function renderJobsPage(env, url) {
  const list = await env.FACTCHECK_JOBS.list({ prefix: "job:", limit: 50 });
  const jobs = [];
  for (const key of list.keys || []) {
    const job = await env.FACTCHECK_JOBS.get(key.name, "json");
    if (job) jobs.push(job);
  }
  jobs.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  return html(renderJobsListPage(jobs, url));
}

function normalizeJobForOutput(job) {
  const copy = JSON.parse(JSON.stringify(job));
  if (copy.report) sanitizeReportLinks(copy.report, copy.claimPackage || {}, copy.evidence || {});
  return copy;
}

async function runFactcheckJob(env, { jobId, channel, threadTs }) {
  try {
    await updateJob(env, jobId, { status: "collecting_slack_context" });
    // 合併狀態更新，只在關鍵節點更新 KV
    await updateJob(env, jobId, { status: "processing" });
    
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
      // 將中間產物一併存入，減少 updateJob 呼叫次數
      claimPackage,
      searchPlan,
      finishedAt: new Date().toISOString(),
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
        `文章頁面：${publicUrl(env, `/jobs/${encodeURIComponent(jobId)}`)}`
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
  const relevantMessages = messages.filter(isRelevantClaimMessage);
  const allText = relevantMessages.map((message) => message.text || "").join("\n\n");
  const files = relevantMessages.flatMap((message) => (message.files || []).map(normalizeSlackFile));
  const urls = Array.from(new Set(extractUrls(allText)));
  return {
    rootText: stripSlackMentions(root.text || ""),
    threadText: stripSlackMentions(allText),
    urls,
    files,
    slackMessages: relevantMessages.map((message) => ({
      user: message.user,
      ts: message.ts,
      text: stripSlackMentions(message.text || ""),
      files: (message.files || []).map(normalizeSlackFile)
    }))
  };
}

function isRelevantClaimMessage(message) {
  if (message.bot_id || message.subtype === "bot_message") return false;
  const text = stripSlackMentions(message.text || "");
  const hasEvidencePayload = Boolean((message.files || []).length || extractUrls(text).length);
  if (hasEvidencePayload) return true;
  if (/^(查核|factcheck|\/factcheck)$/i.test(text.trim())) return false;
  if (/^(收到，開始整理查核線索|查核草稿產生失敗|查核草稿完成)/.test(text.trim())) return false;
  return Boolean(text.trim());
}

function isFactcheckTrigger(event) {
  const text = stripSlackMentions(event.text || "");
  if (COMMAND_PATTERN.test(text)) return true;
  if (event.type !== "app_mention") return false;
  return isMentionOnlyText(text);
}

function isMentionOnlyText(text) {
  return text.replace(/[\s:：,，.。!！?？-]/g, "").trim() === "";
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
  const queries = Array.from(new Set((searchPlan.queries || []).filter(Boolean))).slice(0, 3);
  const results = [];
  for (const queryText of queries) {
    results.push(await generateGroundedEvidence(env, queryText, searchPlan));
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

async function generateGroundedEvidence(env, queryText, searchPlan) {
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
  const grounded = await generateGroundedText(env, prompt);
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

async function generateReport(env, claimPackage, evidence) {
  const prompt = [
    "你是繁體中文事實查核記者，風格參考 MyGoPen，但不得複製任何來源文字。",
    "根據使用者提供的謠言線索與搜尋結果，產出可供人工審稿的 Blogger 草稿。",
    "重要規則：",
    "1. 沒有證據支持的句子要保守表述，不能編造來源。",
    "2. HTML 必須符合使用者指定結構。",
    "3. 資料來源只列 evidence.items、evidence.results.items 或 Slack 線索 urls 中真的存在的連結；必須直接使用 evidence 中的 link 欄位，不可自行新增任何 URL。",
    "4. showcha_assets 要包含 cover.showcha.com 首圖製作文案、grid.showcha.com 截圖組合清單。",
    "5. 如果 evidence.mode 是 manual_required，請明確把草稿標記為待人工查證，不要寫成已完成定稿。",
    "6. title 必須且只能用以下三種分類之一開頭：【錯誤】【誤導】【易誤解】；不得使用【闢謠】、【查核】、【謠言查證】或其他分類。",
    "7. 分類判斷：核心主張與事實不符用【錯誤】；挪用素材、斷章取義、時間地點脈絡錯置但含部分真實元素用【誤導】；文字本身未必全錯但容易造成錯誤理解、需補充脈絡用【易誤解】。",
    "8. 「你可以先知道」區塊必須放在 <div class=\"quote_style\"><h3 style=\"text-align: center;\">你可以先知道：</h3>...</div> 內，內容必須是（1）（2）（3）條列，至少 2 點、最多 4 點，項目之間使用 <br /><br />，不得寫成單段摘要。",
    "9. 「你可以先知道」每點應各自完整說明：傳言背景或來源、查核到的關鍵證據、傳言流傳脈絡或結論；語氣需像 MyGoPen，不要使用條列符號以外的格式。",
    "10. 查證解釋區塊必須寫成 MyGoPen 式分段長文：放在 <blockquote class=\"yestrue\"> 內，至少包含 2 個 <h3 style=\"text-align: left;\">小標</h3><br />，最後一個小標必須是「結論」。",
    "11. 查證解釋區塊的小節應依題材自然命名，例如「網傳影片的原始來源為何？」、「傳言流傳脈絡為何？」、「實際狀況為何？」、「結論」。",
    "12. 查證解釋區塊內的段落必須使用 <br /><br /> 分隔；可用（一）（二）（三）呈現查證步驟；重要查核句可用 <b><span style=\"color: red;\">重點文字</span></b> 標示。",
    "13. 不要只寫摘要式結論；查證解釋至少要清楚交代：原始來源或可追溯線索、流傳脈絡或主張形成方式、證據如何支持/反駁、結論。",
    "14. 不得插入任何 <img> 標籤，所有原本放置圖片、首圖或影片的位置，請統一改為使用 <br />[查核圖片]<br /> 取代。",
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
  normalizeReportTitle(report);
  normalizeQuickTake(report);
  normalizeFactcheckExplanation(report);
  sanitizeReportLinks(report, claimPackage, evidence);
  return report;
}

function bloggerTemplate() {
  return `<div class="quote_style"><h3 style="text-align: center;">你可以先知道：</h3>（1）第一點說明傳言背景、原始來源或事件脈絡。
<br /><br />
（2）第二點說明查核到的關鍵證據或正確資訊。
<br /><br />
（3）第三點說明傳言流傳脈絡、誤導之處或結論。</div><br />
<div class="intro_words">網傳「謠言內容」的影片訊息，前言描述。</div>
<br />[查核圖片]<br />
<!--more-->
<h2>大標的謠言</h2>
<br />原始謠傳版本：<br />
<blockquote class="tr_bq">謠言本體</blockquote>
<br />主要流傳這段影片<br /><br />
<br />[查核圖片]<br />
<br /><br />
並在社群平台流傳：
<br />[查核圖片]<br />
查證解釋：<br />
<blockquote class="yestrue">
<h3 style="text-align: left;">網傳內容的原始來源為何？</h3><br />（一）第一段查證內容，說明反搜、關鍵字搜尋或原始來源比對結果。<br /><br />（二）第二段查證內容，引用 evidence 中的資料來源連結，說明可驗證的事實。<br /><br /><h3 style="text-align: left;">傳言流傳脈絡為何？</h3><br />（一）說明傳言如何在社群平台流傳，或如何被截圖、剪輯、移花接木。<br /><br />（二）說明哪些說法缺乏證據、哪些說法可被來源支持。<br /><br /><h3 style="text-align: left;">結論</h3><br />用一段完整文字總結查核結果、錯誤或誤導之處，以及正確脈絡。
</blockquote>
<br />資料來源：文獻 - <a href="https://www.blogger.com/#">文獻的標題內容</a><br />`;
}

async function generateGemmaJson(env, prompt) {
  const text = await generateGemmaText(env, prompt);
  return parseJsonObject(text);
}

async function generateGroundedText(env, prompt) {
  if (!env.GOOGLE_AI_API_KEY) throw new Error("GOOGLE_AI_API_KEY is missing");
  const models = Array.from(new Set([
    env.GROUNDING_MODEL || "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.0-flash"
  ]));
  const errors = [];

  for (const model of models) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_AI_API_KEY}`, {
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

async function generateGemmaText(env, prompt) {
  if (!env.GOOGLE_AI_API_KEY) throw new Error("GOOGLE_AI_API_KEY is missing");
  const models = modelCandidates(env);
  const errors = [];

  for (const model of models) {
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
    if (response.ok) {
      return body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    }

    errors.push({ model, status: response.status, body });
    if (!isRetryableModelError(response.status, body)) break;
  }

  throw new Error(`Gemini API failed: ${JSON.stringify(errors)}`);
}

function modelCandidates(env) {
  return Array.from(new Set([
    env.GEMMA_MODEL || "gemini-2.5-flash-lite",
    ...(env.FALLBACK_MODELS || "").split(",").map((model) => model.trim()).filter(Boolean)
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

function sanitizeReportLinks(report, claimPackage, evidence) {
  const linkIndex = buildAllowedLinkIndex(claimPackage, evidence);
  if (typeof report.article_html === "string") {
    report.article_html = report.article_html.replace(/<a\s+href="([^"]+)"([^>]*)>(.*?)<\/a>/g, (match, href, attrs, label) => {
      if (linkIndex.allowed.has(href)) return match;
      const replacement = findBestEvidenceLink(label, linkIndex.candidates);
      if (replacement) return `<a href="${escapeAttr(replacement.link)}"${attrs}>${label}</a>`;
      return `<span${attrs}>${label}（待人工補連結）</span>`;
    });

    report.article_html = report.article_html.replace(/<span([^>]*)>(.*?)（待人工補連結）<\/span>/g, (match, attrs, label) => {
      const replacement = findBestEvidenceLink(label, linkIndex.candidates);
      if (!replacement) return match;
      return `<a href="${escapeAttr(replacement.link)}"${attrs}>${label}</a>`;
    });
  }

  const screenshots = report.showcha_assets?.grid?.screenshots || [];
  for (const screenshot of screenshots) {
    if (screenshot.source_url && !linkIndex.allowed.has(screenshot.source_url)) {
      const replacement = findBestEvidenceLink(`${screenshot.label || ""} ${screenshot.note || ""}`, linkIndex.candidates);
      if (replacement) {
        screenshot.source_url = replacement.link;
      } else {
        screenshot.note = [screenshot.note, `原建議連結「${screenshot.source_url}」未出現在 grounding evidence，需人工確認。`].filter(Boolean).join(" ");
        screenshot.source_url = "";
      }
    }
  }
}

function normalizeReportTitle(report) {
  if (typeof report.title !== "string") return;
  const allowed = ["錯誤", "誤導", "易誤解"];
  const original = report.title.trim();
  const match = original.match(/^【([^】]+)】(.+)$/);
  if (match && allowed.includes(match[1])) {
    report.title = `【${match[1]}】${match[2].trim()}`;
    return;
  }

  const label = pickTitleLabel(original, report.article_html || "");
  const titleText = original.replace(/^【[^】]+】/, "").trim() || "網傳訊息查核";
  report.title = `【${label}】${titleText}`;
}

function pickTitleLabel(title, articleHtml) {
  const text = `${title}\n${stripHtml(articleHtml)}`;
  if (/易誤解|容易誤解|需補充|需釐清|部分正確|脈絡/i.test(text)) return "易誤解";
  if (/誤導|斷章取義|挪用|移花接木|錯置|舊[影照聞圖]|非近期|非本次/i.test(text)) return "誤導";
  return "錯誤";
}

function normalizeQuickTake(report) {
  if (typeof report.article_html !== "string") return;
  report.article_html = report.article_html.replace(
    /<div class="quote_style"><h3 style="text-align: center;">你可以先知道：<\/h3>([\s\S]*?)<\/div>/,
    (match, content) => {
      if (/（1）[\s\S]+<br\s*\/?><br\s*\/?>[\s\S]*（2）/.test(content)) return match;
      const items = splitQuickTakeItems(content);
      if (!items.length) return match;
      const normalized = items.slice(0, 4).map((item, index) => `（${index + 1}）${item}`).join("\n<br /><br />\n");
      return `<div class="quote_style"><h3 style="text-align: center;">你可以先知道：</h3>${normalized}</div>`;
    }
  );
}

function splitQuickTakeItems(content) {
  const text = stripHtml(content)
    .replace(/你可以先知道：?/g, "")
    .replace(/[（(]\d+[）)]/g, "\n")
    .split(/\n|。(?=\S)/)
    .map((item) => item.replace(/^[-•\s]+/, "").trim())
    .filter((item) => item.length >= 8);
  return text.length ? text.map((item) => item.endsWith("。") ? item : `${item}。`) : [];
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?><br\s*\/?>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFactcheckExplanation(report) {
  if (typeof report.article_html !== "string") return;
  report.article_html = report.article_html.replace(
    /<blockquote class="yestrue">([\s\S]*?)<\/blockquote>/,
    (match, content) => {
      const hasHeading = /<h3\b[^>]*>/i.test(content);
      const hasConclusion = /<h3\b[^>]*>\s*結論\s*<\/h3>/i.test(content);
      if (hasHeading && hasConclusion) return match;

      const paragraphs = content
        .split(/<br\s*\/?><br\s*\/?>/i)
        .map((part) => part.trim())
        .filter(Boolean);
      if (!paragraphs.length) return match;

      const first = paragraphs.slice(0, Math.max(1, paragraphs.length - 1)).join("<br /><br />");
      const last = paragraphs[paragraphs.length - 1];
      const normalized = [
        hasHeading ? first : `<h3 style="text-align: left;">查證過程為何？</h3><br />${first}`,
        hasConclusion ? "" : `<h3 style="text-align: left;">結論</h3><br />${last}`
      ].filter(Boolean).join("<br /><br />");
      return `<blockquote class="yestrue">\n${normalized}\n</blockquote>`;
    }
  );
}

function buildAllowedLinkIndex(claimPackage, evidence) {
  const evidenceItems = uniqueEvidenceItems([
    ...(evidence.items || []),
    ...(evidence.results || []).flatMap((result) => result.items || [])
  ]);
  const slackItems = (claimPackage.urls || []).map((link) => ({
    title: domainFromUrl(link),
    link,
    source: "slack"
  }));
  const candidates = [...slackItems, ...evidenceItems]
    .filter((item) => item.link)
    .map((item) => {
      const domain = domainFromUrl(item.link) || domainFromTitle(item.title);
      return {
        title: item.title || domain,
        link: item.link,
        domain,
        normalizedTitle: normalizeForMatch(`${item.title || ""} ${domain} ${aliasesForDomain(domain)}`)
      };
    });
  return {
    allowed: new Set(candidates.map((item) => item.link)),
    candidates
  };
}

function findBestEvidenceLink(label, candidates) {
  const normalizedLabel = normalizeForMatch(label);
  if (!normalizedLabel) return null;

  let best = null;
  for (const candidate of candidates) {
    const score = linkMatchScore(normalizedLabel, candidate);
    if (!best || score > best.score) best = { ...candidate, score };
  }
  return best?.score >= 2 ? best : null;
}

function linkMatchScore(normalizedLabel, candidate) {
  const title = candidate.normalizedTitle || "";
  const domain = normalizeForMatch(candidate.domain || "");
  let score = 0;

  if (title && (title.includes(normalizedLabel) || normalizedLabel.includes(title))) score += 4;
  if (domain && (domain.includes(normalizedLabel) || normalizedLabel.includes(domain))) score += 4;

  const labelTokens = tokenSet(normalizedLabel);
  const titleTokens = tokenSet(`${title} ${domain}`);
  for (const token of labelTokens) {
    if (token.length >= 2 && titleTokens.has(token)) score += 3;
  }
  for (const token of titleTokens) {
    if (token.length >= 2 && normalizedLabel.includes(token)) score += 3;
  }

  return score;
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/（待人工補連結）/g, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{Script=Han}a-z0-9.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value) {
  return new Set(String(value || "").split(/\s+/).filter(Boolean));
}

function domainFromUrl(link) {
  try {
    const hostname = new URL(link).hostname.replace(/^www\./, "");
    if (hostname === "vertexaisearch.cloud.google.com") return "";
    return hostname;
  } catch {
    return "";
  }
}

function domainFromTitle(title) {
  const value = String(title || "").trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value) ? value.replace(/^www\./, "") : "";
}

function aliasesForDomain(domain) {
  const aliases = {
    "udn.com": "聯合新聞網 聯合報 udn",
    "chinatimes.com": "中國時報 中時新聞網",
    "ltn.com.tw": "自由時報 自由財經",
    "ettoday.net": "ETtoday 新聞雲",
    "storm.mg": "風傳媒",
    "thenewslens.com": "關鍵評論網 The News Lens",
    "yahoo.com": "Yahoo 奇摩",
    "tw.stock.yahoo.com": "Yahoo 奇摩 股市",
    "worldjournal.com": "世界日報",
    "forbes.com": "Forbes 富比士",
    "theguardian.com": "The Guardian 衛報",
    "scmp.com": "南華早報 SCMP",
    "cnyes.com": "鉅亨網",
    "aastocks.com": "AASTOCKS",
    "hk01.com": "香港01",
    "cmmedia.com.tw": "信傳媒",
    "peoplenews.tw": "民報",
    "gvm.com.tw": "遠見",
    "tvbs.com.tw": "TVBS",
    "facebook.com": "Facebook 臉書",
    "x.com": "X Twitter"
  };
  return aliases[domain] || "";
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
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    body.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
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

function renderJobsListPage(jobs, url) {
  const rows = jobs.length
    ? jobs.map((job) => {
      const title = job.report?.title || job.searchPlan?.claim || job.id;
      return `<a class="job-row" href="/jobs/${encodeURIComponent(job.id)}">
        <span class="status ${escapeAttr(job.status || "unknown")}">${escapeHtml(job.status || "unknown")}</span>
        <span>
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(job.updatedAt || job.createdAt || "")}</small>
        </span>
      </a>`;
    }).join("")
    : `<div class="empty">目前還沒有查核 job。到 Slack thread 留 <code>@Factcheck 查核</code> 後，完成結果會出現在這裡。</div>`;

  return layout("Factcheck Jobs", `
    <header class="page-head">
      <div>
        <p class="eyebrow">Factcheck</p>
        <h1>查核文章後台</h1>
      </div>
      <a class="button" href="${escapeAttr(url.origin)}">重新整理</a>
    </header>
    <section class="panel">
      <div class="panel-title">
        <h2>最近任務</h2>
        <span>${jobs.length} jobs</span>
      </div>
      <div class="job-list">${rows}</div>
    </section>
  `);
}

function renderJobPage(job, url) {
  const report = job.report || {};
  const cover = report.showcha_assets?.cover || {};
  const screenshots = report.showcha_assets?.grid?.screenshots || [];
  const articleHtml = report.article_html || "";
  const previewDocument = renderArticlePreviewDocument(report.title || "", articleHtml);
  const evidenceLinks = uniqueEvidenceItems(job.evidence?.items || []).slice(0, 12);
  return layout(report.title || "查核任務", `
    <header class="page-head">
      <div>
        <p class="eyebrow">Job ${escapeHtml(job.id)}</p>
        <h1>${escapeHtml(report.title || job.searchPlan?.claim || "查核任務")}</h1>
      </div>
      <a class="button" href="/jobs">返回列表</a>
      <a class="button primary" href="/jobs/${encodeURIComponent(job.id)}/review">編輯</a>
    </header>

    <section class="summary-grid">
      ${summaryCard("狀態", job.status || "unknown")}
      ${summaryCard("永久連結", report.permalink || "待補")}
      ${summaryCard("標籤", (report.tags || []).join(", ") || "待補")}
    </section>

    <section class="panel">
      <div class="panel-title">
        <h2>文章預覽</h2>
        <a class="button" href="#article-html">查看 HTML</a>
      </div>
      <iframe class="article-preview" title="文章預覽" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeAttr(previewDocument)}"></iframe>
    </section>

    <section class="panel">
      <div class="panel-title">
        <h2>Blogger HTML</h2>
        <button class="button primary" data-copy-target="article-html">複製 HTML</button>
      </div>
      <textarea id="article-html" spellcheck="false">${escapeHtml(articleHtml)}</textarea>
    </section>

    <section class="panel">
      <div class="panel-title">
        <h2>文章資訊</h2>
        <button class="button" data-copy-target="metadata">複製資訊</button>
      </div>
      <textarea id="metadata" spellcheck="false">${escapeHtml([
        `標題：${report.title || ""}`,
        `標籤：${(report.tags || []).join(",")}`,
        `永久連結：${report.permalink || ""}`,
        `搜尋說明：${report.search_description || ""}`
      ].join("\n"))}</textarea>
    </section>

    <section class="two-col">
      <div class="panel">
        <h2>首圖製作</h2>
        <dl>
          <dt>工具</dt><dd><a href="${escapeAttr(cover.tool_url || "https://cover.showcha.com/")}" target="_blank" rel="noreferrer">cover.showcha.com</a></dd>
          <dt>標題</dt><dd>${escapeHtml(cover.headline || "")}</dd>
          <dt>判定</dt><dd>${escapeHtml(cover.verdict || "")}</dd>
          <dt>素材備註</dt><dd>${escapeHtml(cover.source_image_notes || "")}</dd>
        </dl>
      </div>
      <div class="panel">
        <h2>截圖組合</h2>
        <p><a href="${escapeAttr(report.showcha_assets?.grid?.tool_url || "https://grid.showcha.com/")}" target="_blank" rel="noreferrer">grid.showcha.com</a></p>
        <ul class="plain-list">
          ${screenshots.map((item) => `<li><strong>${escapeHtml(item.label || "截圖")}</strong><br />${escapeHtml(item.note || "")}${item.source_url ? `<br /><a href="${escapeAttr(item.source_url)}" target="_blank" rel="noreferrer">${escapeHtml(item.source_url)}</a>` : ""}</li>`).join("") || "<li>待補截圖清單</li>"}
        </ul>
      </div>
    </section>

    <section class="panel">
      <h2>證據來源</h2>
      <ul class="plain-list">
        ${evidenceLinks.map((item) => `<li><a href="${escapeAttr(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || item.link)}</a></li>`).join("") || "<li>目前沒有 grounding 來源，需人工補充。</li>"}
      </ul>
    </section>

    <section class="panel">
      <div class="panel-title">
        <h2>API</h2>
        <a class="button" href="/api/jobs/${encodeURIComponent(job.id)}">開啟 JSON</a>
      </div>
      <code>${escapeHtml(new URL(`/api/jobs/${encodeURIComponent(job.id)}`, url).toString())}</code>
    </section>
  `);
}

function renderReviewPage(job, url) {
  const report = job.report || {};
  const jobId = job.id;

  return layout(`編輯查核任務 - ${report.title || "未命名"}`, `
    <header class="page-head">
      <div>
        <p class="eyebrow">Job ${escapeHtml(jobId)}</p>
        <h1>編輯查核任務</h1>
      </div>
      <a class="button" href="/jobs/${encodeURIComponent(jobId)}">返回任務</a>
    </header>

    <section class="panel">
      <form method="POST" action="/jobs/${encodeURIComponent(jobId)}/review">
        <div class="form-group">
          <label for="title">標題</label>
          <input type="text" id="title" name="title" value="${escapeAttr(report.title || "")}" required />
        </div>

        <div class="form-group">
          <label for="permalink">永久連結</label>
          <input type="text" id="permalink" name="permalink" value="${escapeAttr(report.permalink || "")}" />
        </div>

        <div class="form-group">
          <label for="tags">標籤 (逗號分隔)</label>
          <input type="text" id="tags" name="tags" value="${escapeAttr((report.tags || []).join(", "))}" />
        </div>

        <div class="form-group">
          <label for="search_description">搜尋說明</label>
          <textarea id="search_description" name="search_description" rows="3">${escapeHtml(report.search_description || "")}</textarea>
        </div>

        <div class="form-group">
          <label for="article_html">文章 HTML</label>
          <textarea id="article_html" name="article_html" rows="20" spellcheck="false">${escapeHtml(report.article_html || "")}</textarea>
        </div>

        <div class="form-actions">
          <button type="submit" class="button primary">儲存修改</button>
          <a href="/jobs/${encodeURIComponent(jobId)}" class="button">取消</a>
        </div>
      </form>
    </section>
  `);
}

function renderNotFoundPage(id) {
  return layout("找不到任務", `
    <section class="panel">
      <h1>找不到任務</h1>
      <p>Job <code>${escapeHtml(id)}</code> 不存在或已過期。</p>
      <a class="button" href="/jobs">返回列表</a>
    </section>
  `);
}

function summaryCard(label, value) {
  return `<div class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderArticlePreviewDocument(title, articleHtml) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base target="_blank" />
  <style>
    body { margin: 0; padding: 28px; color: #202124; background: #fff; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 17px; line-height: 1.75; }
    .preview-shell { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 30px; line-height: 1.28; margin: 0 0 18px; }
    h2 { font-size: 24px; line-height: 1.35; margin: 28px 0 12px; }
    h3 { font-size: 19px; margin: 0 0 10px; }
    a { color: #0969da; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    img, iframe, object, video { display: block; max-width: 100%; margin: 14px auto; }
    blockquote { margin: 14px 0; padding: 14px 18px; border-left: 4px solid #9ca3af; background: #f6f7f8; }
    .quote_style { margin: 0 0 18px; padding: 18px; border: 1px solid #cfe5dd; background: #eef8f4; border-radius: 8px; }
    .intro_words { margin: 0 0 18px; padding: 16px 0; font-size: 18px; }
    .tr_bq { border-left-color: #d97706; background: #fff7ed; }
    .yestrue { border-left-color: #0f766e; background: #f0fdfa; }
    .separator, .img_container, .video_container { clear: both; text-align: center; }
  </style>
</head>
<body>
  <article class="preview-shell">
    ${title ? `<h1>${escapeHtml(title)}</h1>` : ""}
    ${articleHtml || `<p>目前還沒有可預覽的文章 HTML。</p>`}
  </article>
</body>
</html>`;
}

function layout(title, body) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --bg: #f7f7f4; --ink: #1f2328; --muted: #687076; --line: #d9ddd7; --panel: #ffffff; --accent: #0f766e; --accent-ink: #ffffff; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; }
    main { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    h1, h2, p { margin-top: 0; }
    h1 { font-size: 30px; line-height: 1.2; margin-bottom: 0; }
    h2 { font-size: 18px; margin-bottom: 14px; }
    a { color: #0b5cad; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
    .eyebrow { color: var(--muted); font-size: 13px; margin-bottom: 6px; }
    .panel, .summary-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin-bottom: 16px; }
    .panel-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .panel-title h2 { margin: 0; }
    .button { appearance: none; border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 6px; padding: 9px 12px; font: inherit; text-decoration: none; cursor: pointer; white-space: nowrap; }
    .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    .job-list { display: grid; gap: 8px; }
    .job-row { display: grid; grid-template-columns: 150px 1fr; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; text-decoration: none; color: inherit; background: #fbfbfa; }
    .job-row small { display: block; color: var(--muted); margin-top: 3px; }
    .status { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 3px 8px; border-radius: 999px; background: #eef2f1; color: #36514d; font-size: 13px; }
    .status.done { background: #dff3e8; color: #11603d; }
    .status.reviewed { background: #dbeafe; color: #1e40af; } /* New status color for reviewed */
    .status.failed { background: #fde2e1; color: #9f1d1d; }
    .status.queued { background: #fff1cf; color: #7a4b00; }
    .status.processing { background: #e0f2fe; color: #0c4a6e; } /* Add processing status color */

    .summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .summary-card span { display: block; color: var(--muted); font-size: 13px; margin-bottom: 6px; }
    .summary-card strong { display: block; overflow-wrap: anywhere; }
    .article-preview { width: 100%; min-height: 720px; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
    textarea { width: 100%; min-height: 340px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; padding: 12px; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--ink); background: #fbfbfa; }
    #metadata { min-height: 150px; }
    .two-col { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    dl { display: grid; grid-template-columns: 80px 1fr; gap: 8px 12px; margin: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    .plain-list { margin: 0; padding-left: 20px; }

    /* Form styles */
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-weight: bold; margin-bottom: 6px; }
    .form-group input[type="text"], .form-group textarea { width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: 6px; font: inherit; background: #fbfbfa; color: var(--ink); }
    .form-group textarea { resize: vertical; }
    .form-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }


    .plain-list li { margin-bottom: 10px; overflow-wrap: anywhere; }
    .empty { color: var(--muted); padding: 20px 0; }
    code { overflow-wrap: anywhere; }
    @media (max-width: 760px) {
      main { width: min(100vw - 20px, 1120px); padding-top: 18px; }
      .page-head, .panel-title { align-items: stretch; flex-direction: column; }
      .summary-grid, .two-col, .job-row { grid-template-columns: 1fr; }
      h1 { font-size: 24px; }
      .article-preview { min-height: 560px; }
    }
  </style>
</head>
<body>
  <main>${body}</main>
  <script>
    document.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-copy-target]");
      if (!button) return;
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      await navigator.clipboard.writeText(target.value || target.textContent || "");
      const label = button.textContent;
      button.textContent = "已複製";
      setTimeout(() => { button.textContent = label; }, 1200);
    });
  </script>
</body>
</html>`;
}

function publicUrl(env, path) {
  const base = (env.PUBLIC_BASE_URL || "https://factcheck-slack-worker.charlestyyeh.workers.dev").replace(/\/+$/g, "");
  return `${base}${path}`;
}

function html(value, status = 200) {
  return new Response(value, {
    status,
    headers: { "content-type": "text/html;charset=UTF-8" }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" }
  });
}
