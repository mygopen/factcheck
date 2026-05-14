# Slack AI 查核文章產生系統

這個專案是第一版 MVP：用 Cloudflare Worker 接 Slack thread 指令，抓取貼文線索，呼叫 Gemini / Gemma 與 Google Search grounding 產生查核草稿，並輸出適合 Google Blogger 的 HTML、標題、標籤、永久連結與 showcha 素材製作清單。

## 目前流程

1. 在 Slack 某個貼文底下留言 `@Factcheck`、`查核`、`factcheck` 或 `/factcheck`。
2. Slack Events API 呼叫 Cloudflare Worker 的 `/slack/events`。
3. Worker 先把 job 存進 Cloudflare KV 並回覆 Slack，避免 Slack 事件逾時。
4. Cloudflare Cron 每分鐘處理 queued job，抓取該 thread 原文、留言、連結與 Slack 附件 metadata。
5. Worker 請模型萃取主張與搜尋關鍵字，並用 Gemini Google Search grounding 找證據來源。
6. Worker 再請模型產出 Blogger HTML 草稿與素材清單。
7. 結果可從 Slack 回覆中的 `/jobs/:id` 網站頁面取得，也可用 `/api/jobs/:id` 讀 JSON。

後台列表頁：

```text
https://你的-worker網域/jobs
```

## 需要的帳號與設定

### 1. Slack App

建立 Slack App 後設定：

- Event Request URL: `https://你的-worker網域/slack/events`
- Bot Token Scopes:
  - `channels:history`
  - `groups:history`
  - `chat:write`
  - `files:read`
  - `app_mentions:read`
- Subscribe to bot events:
  - `app_mention`
  - `message.channels`
  - `message.groups`

如果你不想讓 bot 讀所有 channel 訊息，可以先只開 `app_mention`，使用方式改成在 thread 裡留言 `@你的bot`。

### 2. Google AI Studio

建立 API key，預設模型是：

```text
gemini-3.1-flash-lite
```

搜尋證據使用 Gemini Google Search grounding，不需要另外申請 Google Programmable Search 或 Custom Search JSON API。

## 本機開發

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

## 純 GitHub 版本

如果你想先不接 Cloudflare，也不接 Slack，可以直接用 GitHub Actions 產生查核草稿。

先到 GitHub repo 的 `Settings` -> `Secrets and variables` -> `Actions` 設定：

- `GOOGLE_AI_API_KEY`

接著到 `Actions` -> `Generate fact-check draft` -> `Run workflow`，填入：

- `claim_text`：謠言文字、社群貼文內容或待查核主張
- `claim_urls`：相關連結，一行一個
- `notes`：補充備註，例如已知截圖、影片來源、想查的方向

完成後可在該次 workflow run 下載 `factcheck-draft` artifact，裡面包含：

- `article.html`：可貼到 Blogger 的 HTML
- `metadata.md`：標題、標籤、永久連結、搜尋說明
- `showcha-assets.md`：cover.showcha.com 與 grid.showcha.com 製作清單
- `report.json`：完整機器可讀輸出

## Cloudflare 部署

建立 KV：

```bash
npx wrangler kv namespace create FACTCHECK_JOBS
npx wrangler kv namespace create FACTCHECK_JOBS --preview
```

把輸出的 KV id 填回 `wrangler.toml`。

設定 secrets：

```bash
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put GOOGLE_AI_API_KEY
```

部署：

```bash
npm run deploy
```

## 輸出格式

`/api/jobs/:id` 完成後會回傳：

- `report.title`
- `report.article_html`
- `report.tags`
- `report.permalink`
- `report.search_description`
- `report.showcha_assets.cover`
- `report.showcha_assets.grid`

接 Slack 前可以先用本機端點測草稿品質：

```bash
curl -X POST http://localhost:8787/api/draft \
  -H 'content-type: application/json' \
  -d '{"text":"網傳謠言文字貼在這裡，也可以附上社群連結。"}'
```

`article_html` 會以你指定的 Blogger HTML 結構產生：

```html
<div class="quote_style"><h3 style="text-align: center;">你可以先知道：</h3>說明破解資訊。</div><br />
<div class="intro_words">網傳「謠言內容」的影片訊息，前言描述。</div>
「首圖」
<!--more-->
<h2>大標的謠言</h2>
<br />原始謠傳版本：<br />
<blockquote class="tr_bq">謠言本體</blockquote>
...
```

## showcha 工具整合方式

目前 `cover.showcha.com` 與 `grid.showcha.com` 先以「製作清單」整合：

- `showcha_assets.cover` 會給你首圖標題、判定字樣、素材說明。
- `showcha_assets.grid.screenshots` 會列出建議截圖來源與用途。

也就是第一版會讓你一鍵取得應該放進 showcha 的內容，但實際下載圖片仍由你在 showcha 網頁完成。等確認這兩個工具有穩定公開 API 或可接受的自動化方式，再把這段改成真正自動產圖。

## 下一步

1. 加上 Slack 檔案下載與圖片送進 Gemma 3 vision 分析。
2. 加上人工審稿頁，讓你修改標題、HTML、標籤、永久連結。
3. 加上 R2 儲存產出的圖片與證據截圖。
4. 加上 Blogger API 草稿建立，從「貼上 HTML」升級成「直接建立 Blogger 草稿」。
