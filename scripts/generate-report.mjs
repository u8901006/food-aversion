import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const API_BASE =
  process.env.ZHIPU_API_BASE ||
  "https://open.bigmodel.cn/api/coding/paas/v4";
const MODELS_FALLBACK = [
  process.env.ZHIPU_MODEL_PRIMARY || "glm-5-turbo",
  "GLM-4.7",
  "GLM-4.7-Flash",
];
const TARGET_DATE = process.env.TARGET_DATE || getTaipeiDate();
const PAPERS_PATH = resolve("papers.json");
const OUTPUT_PATH = resolve(
  `docs/food-aversion-${TARGET_DATE}.html`
);

const SYSTEM_PROMPT = `你是食物厭惡（food aversion）跨領域研究的資深科學傳播者，涵蓋精神醫學、臨床心理學、神經科學、兒科、婦產科、腫瘤科、營養科學、感官科學、自閉症研究與公共衛生。

你的任務：
1. 從提供的醫學文獻中，篩選出最具臨床意義與研究價值的論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP 5-8（按重要性排序）

回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

const TAG_OPTIONS = [
  "ARFID",
  "飲食行為",
  "味覺嫌惡",
  "條件化味覺嫌惡",
  "感官敏感",
  "自閉症飲食",
  "兒童餵食",
  "孕吐",
  "妊娠劇吐",
  "化療味覺改變",
  "腫瘤營養",
  "噁心嘔吐",
  "挑食",
  "食物恐新症",
  "厭惡心理",
  "嘔吐恐懼",
  "吞嚥恐懼",
  " GI 食物迴避",
  "營養不良",
  "飲食多樣性",
  " CBT-AR",
  "暴露治療",
  "職能治療",
  "神經科學",
  "公共衛生",
  "文化與食物",
];

function getTaipeiDate() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" })
  )
    .toISOString()
    .slice(0, 10);
}

function loadPapers() {
  const raw = readFileSync(PAPERS_PATH, "utf-8");
  return JSON.parse(raw);
}

async function callZhipu(apiKey, payload, timeout = 480000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("retry-after")) || 60;
      throw new Error(`RATE_LIMIT:${retryAfter}`);
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP_${resp.status}:${text.slice(0, 300)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  text = text.trim();
  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    text = text.slice(firstNewline + 1);
    text = text.replace(/```+$/, "").trim();
  }
  return JSON.parse(text);
}

function robustJsonParse(text) {
  try {
    return extractJson(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        const repaired = text
          .slice(start, end + 1)
          .replace(/,\s*([}\]])/g, "$1")
          .replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
          .replace(
            /"([^"]*)"(\s*:\s*)([^"{[\]0-9tfn-][^",}\]]*)/g,
            '"$1"$2"$3"'
          );
        try {
          return JSON.parse(repaired);
        } catch {
          const secondStart = repaired.indexOf("{");
          const secondEnd = repaired.lastIndexOf("}");
          if (secondStart !== -1 && secondEnd !== -1) {
            return JSON.parse(
              repaired.slice(secondStart, secondEnd + 1)
            );
          }
        }
      }
    }
    throw new Error("Failed to parse AI response as JSON");
  }
}

async function analyzePapers(apiKey, papersData) {
  const dateStr = papersData.date || TARGET_DATE;
  const paperCount = papersData.count || 0;
  const papersText = JSON.stringify(
    papersData.papers || [],
    null,
    2
  );

  const prompt = `以下是 ${dateStr} 從 PubMed 抓取的最新食物厭惡（food aversion）相關文獻（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "ARFID": 3,
    "條件化味覺嫌惡": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：${TAG_OPTIONS.join("、")}
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  for (const model of MODELS_FALLBACK) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(
          `[INFO] Trying ${model} (attempt ${attempt + 1})...`
        );
        const payload = {
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          top_p: 0.9,
          max_tokens: 50000,
        };

        const data = await callZhipu(apiKey, payload, 480000);
        const text =
          data?.choices?.[0]?.message?.content?.trim() || "";
        if (!text) throw new Error("Empty response from API");

        const result = robustJsonParse(text);
        console.error(
          `[INFO] Analysis complete: ${result.top_picks?.length || 0} top picks, ${result.all_papers?.length || 0} other papers`
        );
        return result;
      } catch (e) {
        const msg = e.message || "";
        if (msg.startsWith("RATE_LIMIT")) {
          const wait = Number(msg.split(":")[1]) * (attempt + 1);
          console.error(
            `[WARN] Rate limited, waiting ${wait}s...`
          );
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        console.error(
          `[WARN] ${model} attempt ${attempt + 1} failed: ${msg.slice(0, 200)}`
        );
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
      }
    }
  }

  console.error("[ERROR] All models and attempts failed");
  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateHtml(analysis) {
  const dateStr =
    analysis.date ||
    TARGET_DATE;
  const dp = dateStr.split("-");
  const dateDisplay =
    dp.length === 3
      ? `${dp[0]}年${Number(dp[1])}月${Number(dp[2])}日`
      : dateStr;

  const summary = escapeHtml(
    analysis.market_summary || ""
  );
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;
  const usedModel = MODELS_FALLBACK[0];

  const topPicksHtml = topPicks
    .map((pick) => {
      const tags = (pick.tags || [])
        .map(
          (t) =>
            `<span class="tag">${escapeHtml(t)}</span>`
        )
        .join("");
      const util = pick.clinical_utility || "中";
      const uClass =
        util === "高"
          ? "utility-high"
          : util === "中"
            ? "utility-mid"
            : "utility-low";
      const pico = pick.pico || {};
      const picoHtml = Object.keys(pico).length
        ? `
            <div class="pico-grid">
              <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escapeHtml(pico.population || "-")}</span></div>
              <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escapeHtml(pico.intervention || "-")}</span></div>
              <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escapeHtml(pico.comparison || "-")}</span></div>
              <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escapeHtml(pico.outcome || "-")}</span></div>
            </div>`
        : "";

      return `
        <div class="news-card featured">
          <div class="card-header">
            <span class="rank-badge">#${escapeHtml(String(pick.rank || ""))}</span>
            <span class="emoji-icon">${pick.emoji || "\uD83D\uDCD4"}</span>
            <span class="${uClass}">${escapeHtml(util)}實用性</span>
          </div>
          <h3>${escapeHtml(pick.title_zh || pick.title_en || "")}</h3>
          <p class="journal-source">${escapeHtml(pick.journal || "")} &middot; ${escapeHtml(pick.title_en || "")}</p>
          <p>${escapeHtml(pick.summary || "")}</p>
          ${picoHtml}
          <div class="card-footer">
            ${tags}
            <a href="${escapeHtml(pick.url || "#")}" target="_blank" rel="noopener">閱讀原文 &#8594;</a>
          </div>
        </div>`;
    })
    .join("");

  const allPapersHtml = allPapers
    .map((paper) => {
      const tags = (paper.tags || [])
        .map(
          (t) =>
            `<span class="tag">${escapeHtml(t)}</span>`
        )
        .join("");
      const util = paper.clinical_utility || "中";
      const uClass =
        util === "高"
          ? "utility-high"
          : util === "中"
            ? "utility-mid"
            : "utility-low";
      return `
        <div class="news-card">
          <div class="card-header-row">
            <span class="emoji-sm">${paper.emoji || "\uD83D\uDCD4"}</span>
            <span class="${uClass} utility-sm">${escapeHtml(util)}</span>
          </div>
          <h3>${escapeHtml(paper.title_zh || paper.title_en || "")}</h3>
          <p class="journal-source">${escapeHtml(paper.journal || "")}</p>
          <p>${escapeHtml(paper.summary || "")}</p>
          <div class="card-footer">
            ${tags}
            <a href="${escapeHtml(paper.url || "#")}" target="_blank" rel="noopener">PubMed &#8594;</a>
          </div>
        </div>`;
    })
    .join("");

  const keywordsHtml = keywords
    .map(
      (k) =>
        `<span class="keyword">${escapeHtml(k)}</span>`
    )
    .join("");

  const maxCount = Math.max(
    ...Object.values(topicDist),
    1
  );
  const topicBarsHtml = Object.entries(topicDist)
    .map(([topic, count]) => {
      const width = Math.round(
        (Number(count) / maxCount) * 100
      );
      return `
            <div class="topic-row">
              <span class="topic-name">${escapeHtml(topic)}</span>
              <div class="topic-bar-bg"><div class="topic-bar" style="width:${width}%"></div></div>
              <span class="topic-count">${count}</span>
            </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Food Aversion Daily &middot; 食物厭惡研究文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 食物厭惡研究文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 100px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .clinic-banner { margin-top: 24px; animation: fadeUp 0.5s ease 0.3s both; }
  .clinic-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .clinic-link:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .clinic-icon { font-size: 28px; flex-shrink: 0; }
  .clinic-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .clinic-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  .clinic-links-grid { display: grid; gap: 10px; margin-top: 24px; animation: fadeUp 0.5s ease 0.3s both; }
  .clinic-links-grid .clinic-link { }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } .clinic-links-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">\uD83C\uDF4A</div>
    <div class="header-text">
      <h1>Food Aversion Daily &middot; 食物厭惡研究文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">\uD83D\uDCC5 ${dateDisplay}</span>
        <span class="badge badge-count">\uD83D\uDCCA ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>\uD83D\uDCCB 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topPicksHtml ? `<div class="section"><div class="section-title"><span class="section-icon">\u2B50</span>今日精選 TOP Picks</div>${topPicksHtml}</div>` : ""}

  ${allPapersHtml ? `<div class="section"><div class="section-title"><span class="section-icon">\uD83D\uDCDA</span>其他值得關注的文獻</div>${allPapersHtml}</div>` : ""}

  ${topicBarsHtml ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">\uD83D\uDCCA</span>主題分佈</div>${topicBarsHtml}</div>` : ""}

  ${keywordsHtml ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">\uD83C\uDFF7\uFE0F</span>關鍵字</div><div class="keywords">${keywordsHtml}</div></div>` : ""}

  <div class="clinic-links-grid">
    <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
      <span class="clinic-icon">\uD83C\uDFE5</span>
      <span class="clinic-name">李政洋身心診所首頁</span>
      <span class="clinic-arrow">\u2192</span>
    </a>
    <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener">
      <span class="clinic-icon">\uD83D\uDCF0</span>
      <span class="clinic-name">訂閱電子報</span>
      <span class="clinic-arrow">\u2192</span>
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="clinic-link" target="_blank" rel="noopener">
      <span class="clinic-icon">\u2615</span>
      <span class="clinic-name">Buy Me a Coffee</span>
      <span class="clinic-arrow">\u2192</span>
    </a>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${escapeHtml(usedModel)}</span>
    <span><a href="https://github.com/u8901006/food-aversion">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

async function main() {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.error(
      "[ERROR] ZHIPU_API_KEY environment variable is required"
    );
    process.exit(1);
  }

  const papersData = loadPapers();
  let analysis;

  if (!papersData?.papers?.length) {
    console.error(
      "[WARN] No papers found, generating empty report"
    );
    analysis = {
      date: TARGET_DATE,
      market_summary:
        "今日 PubMed 暫無新的食物厭惡相關文獻更新。請明天再查看。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    analysis = await analyzePapers(apiKey, papersData);
    if (!analysis) {
      console.error(
        "[ERROR] Analysis failed, cannot generate report"
      );
      process.exit(1);
    }
  }

  const html = generateHtml(analysis);
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, html, "utf-8");
  console.error(`[INFO] Report saved to ${OUTPUT_PATH}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
