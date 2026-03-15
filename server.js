require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ─── DATABASE SETUP ────────────────────────────────────────────────────────────
const db = new Database("bot.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    last_tweet_id TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_username TEXT,
    original_tweet TEXT,
    tweet_url TEXT,
    rewritten_text TEXT,
    fb_post_id TEXT,
    status TEXT DEFAULT 'pending',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function addLog(level, message) {
  console.log(`[${level.toUpperCase()}] ${message}`);
  db.prepare("INSERT INTO logs (level, message) VALUES (?, ?)").run(level, message);
  db.prepare("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 500)").run();
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

// ─── TWITTER SYNDICATION API ──────────────────────────────────────────────────
// This is the same API Twitter uses to power embedded timelines on websites.
// No API key needed, works from any server, very reliable.
async function fetchTweetsSyndication(username, lastTweetId = null) {
  // Step 1: Get the guest token (required by syndication API)
  const guestTokenRes = await axios.post(
    "https://api.twitter.com/1.1/guest/activate.json",
    {},
    {
      headers: {
        Authorization: "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    }
  );

  const guestToken = guestTokenRes.data.guest_token;
  if (!guestToken) throw new Error("Failed to get guest token");

  addLog("info", `Got guest token, fetching @${username} tweets...`);

  // Step 2: Fetch user timeline via syndication
  const timelineRes = await axios.get(
    `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${username}&count=10`,
    {
      headers: {
        Authorization: "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
        "x-guest-token": guestToken,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://platform.twitter.com/",
      },
      timeout: 15000,
    }
  );

  const data = timelineRes.data;

  // Parse tweets from response
  let tweets = [];

  if (data && data.body && data.body.items_html) {
    // Syndication HTML response — parse tweet IDs and text from HTML
    const html = data.body.items_html;
    const tweetRegex = /data-tweet-id="(\d+)"[\s\S]*?class="tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = tweetRegex.exec(html)) !== null) {
      const id = m[1];
      const text = m[2]
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();
      if (text) tweets.push({ id, text, url: `https://twitter.com/${username}/status/${id}` });
    }
  } else if (data && Array.isArray(data)) {
    tweets = data
      .filter(t => t.id_str && t.full_text && !t.retweeted_status)
      .map(t => ({
        id: t.id_str,
        text: t.full_text.replace(/https:\/\/t\.co\/\S+/g, "").trim(),
        url: `https://twitter.com/${username}/status/${t.id_str}`,
      }));
  } else if (data && data.globalObjects && data.globalObjects.tweets) {
    // GraphQL format
    tweets = Object.values(data.globalObjects.tweets)
      .filter(t => !t.retweeted_status_id_str)
      .map(t => ({
        id: t.id_str,
        text: (t.full_text || t.text || "").replace(/https:\/\/t\.co\/\S+/g, "").trim(),
        url: `https://twitter.com/${username}/status/${t.id_str}`,
      }))
      .sort((a, b) => BigInt(b.id) > BigInt(a.id) ? 1 : -1);
  }

  addLog("info", `Parsed ${tweets.length} tweets from syndication API`);

  if (!tweets.length) {
    // Fallback: try public embed endpoint
    return await fetchTweetsEmbed(username, lastTweetId);
  }

  // Filter to only new tweets
  let newTweets = tweets;
  if (lastTweetId) {
    newTweets = tweets.filter(t => {
      try { return BigInt(t.id) > BigInt(lastTweetId); }
      catch { return t.id !== lastTweetId; }
    });
  } else {
    newTweets = tweets.slice(0, 1); // First run: only grab latest 1
  }

  return newTweets;
}

// ─── FALLBACK: PIPED/PUBLIC RSS AGGREGATORS ───────────────────────────────────
async function fetchTweetsEmbed(username, lastTweetId = null) {
  addLog("info", `Trying fallback RSS aggregators for @${username}...`);

  const sources = [
    `https://rss.app/feeds/twitter/${username}.xml`,
    `https://fetchrss.com/rss/twitter/${username}`,
  ];

  for (const url of sources) {
    try {
      addLog("info", `Trying: ${url}`);
      const res = await axios.get(url, {
        timeout: 12000,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/rss+xml, text/xml, */*",
        },
      });

      const items = parseRSS(res.data);
      if (!items.length) continue;

      let newItems = lastTweetId
        ? items.filter(t => { try { return BigInt(t.id) > BigInt(lastTweetId); } catch { return t.id !== lastTweetId; } })
        : items.slice(0, 1);

      addLog("info", `✅ Fallback RSS success: ${newItems.length} new tweet(s)`);
      return newItems;
    } catch (e) {
      addLog("info", `Fallback ${url} failed: ${e.message}`);
    }
  }

  throw new Error("All tweet sources failed. Twitter may be blocking the server region.");
}

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch  = item.match(/<link>([\s\S]*?)<\/link>/);
    const guidMatch  = item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const descMatch  = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim();
    if (title.startsWith("RT @") || title.startsWith("R to @")) continue;
    let text = (descMatch ? descMatch[1] : title)
      .replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (!text || text.length < 5) continue;
    const link = (linkMatch ? linkMatch[1] : guidMatch ? guidMatch[1] : "").trim();
    const idMatch = link.match(/\/status\/(\d+)/);
    const id = idMatch ? idMatch[1] : Date.now().toString();
    items.push({ id, text, url: link });
  }
  return items;
}

// ─── CLAUDE AI REWRITE ────────────────────────────────────────────────────────
async function rewriteWithClaude(tweetText, username) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const customPrompt = getSetting("rewrite_prompt") ||
    `You are a social media expert. Rewrite the following tweet for a Facebook audience.
Make it more engaging, conversational, and suitable for Facebook (can be slightly longer).
Add relevant emojis. Do NOT include hashtags unless they are very relevant.
Keep the core message and facts intact. Return ONLY the rewritten post, nothing else.`;

  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: `${customPrompt}\n\nOriginal tweet from @${username}:\n"${tweetText}"\n\nRewritten Facebook post:` }],
    },
    { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
  );
  return res.data.content[0].text.trim();
}

// ─── FACEBOOK GRAPH API ───────────────────────────────────────────────────────
async function postToFacebook(message) {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!token || !pageId) throw new Error("Facebook credentials not set");
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/feed`,
    { message, access_token: token }
  );
  return res.data.id;
}

// ─── CORE POLL LOGIC ──────────────────────────────────────────────────────────
async function pollAccount(account) {
  try {
    addLog("info", `Polling @${account.username}...`);
    const tweets = await fetchTweetsSyndication(account.username, account.last_tweet_id);

    if (!tweets || tweets.length === 0) {
      addLog("info", `No new tweets from @${account.username}`);
      return;
    }

    addLog("info", `Found ${tweets.length} new tweet(s)`);
    const sorted = [...tweets].reverse();

    for (const tweet of sorted) {
      const insertResult = db.prepare(
        "INSERT INTO posts (account_username, original_tweet, tweet_url, status) VALUES (?, ?, ?, 'processing')"
      ).run(account.username, tweet.text, tweet.url);
      const postId = insertResult.lastInsertRowid;

      try {
        addLog("info", `Rewriting with Claude...`);
        const rewritten = await rewriteWithClaude(tweet.text, account.username);
        addLog("info", `Posting to Facebook...`);
        const fbPostId = await postToFacebook(rewritten);
        db.prepare("UPDATE posts SET rewritten_text = ?, fb_post_id = ?, status = 'posted' WHERE id = ?").run(rewritten, fbPostId, postId);
        addLog("info", `✅ Posted! FB Post ID: ${fbPostId}`);
      } catch (err) {
        db.prepare("UPDATE posts SET status = 'error', error = ? WHERE id = ?").run(err.message, postId);
        addLog("error", `Failed: ${err.message}`);
      }

      db.prepare("UPDATE accounts SET last_tweet_id = ? WHERE id = ?").run(tweet.id, account.id);
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (err) {
    addLog("error", `Error polling @${account.username}: ${err.message}`);
  }
}

async function pollAllAccounts() {
  const accounts = db.prepare("SELECT * FROM accounts WHERE active = 1").all();
  if (accounts.length === 0) { addLog("info", "No active accounts."); return; }
  for (const account of accounts) {
    await pollAccount(account);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ─── CRON SCHEDULER ───────────────────────────────────────────────────────────
const POLL_INTERVAL = process.env.POLL_INTERVAL_MINUTES || "15";
let cronJob = null;

function startCron() {
  if (cronJob) cronJob.stop();
  const mins = parseInt(POLL_INTERVAL);
  cronJob = cron.schedule(`*/${Math.max(1, Math.min(59, mins))} * * * *`, () => {
    addLog("info", "⏰ Cron tick — polling...");
    pollAllAccounts();
  });
  addLog("info", `Scheduler started: every ${mins} min`);
}

startCron();

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  const accounts = db.prepare("SELECT COUNT(*) as c FROM accounts WHERE active=1").get();
  const posts    = db.prepare("SELECT COUNT(*) as c FROM posts WHERE status='posted'").get();
  const errors   = db.prepare("SELECT COUNT(*) as c FROM posts WHERE status='error'").get();
  res.json({ running: true, poll_interval_minutes: parseInt(POLL_INTERVAL), active_accounts: accounts.c, total_posted: posts.c, total_errors: errors.c, twitter_configured: true, facebook_configured: !!(process.env.FACEBOOK_PAGE_ACCESS_TOKEN && process.env.FACEBOOK_PAGE_ID), anthropic_configured: !!process.env.ANTHROPIC_API_KEY });
});

app.get("/api/accounts", (req, res) => res.json(db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all()));

app.post("/api/accounts", async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Username required" });
  const clean = username.replace("@", "").trim().toLowerCase();
  try {
    db.prepare("INSERT INTO accounts (username) VALUES (?)").run(clean);
    addLog("info", `Added account: @${clean}`);
    res.json({ success: true, message: `@${clean} added` });
  } catch (e) { res.status(400).json({ error: `@${clean} already exists` }); }
});

app.delete("/api/accounts/:id", (req, res) => {
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM accounts WHERE id = ?").run(req.params.id);
  addLog("info", `Removed @${account.username}`);
  res.json({ success: true });
});

app.patch("/api/accounts/:id/toggle", (req, res) => {
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const newActive = account.active ? 0 : 1;
  db.prepare("UPDATE accounts SET active = ? WHERE id = ?").run(newActive, req.params.id);
  res.json({ success: true, active: newActive });
});

app.get("/api/posts", (req, res) => res.json(db.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?").all(parseInt(req.query.limit) || 50)));
app.get("/api/logs",  (req, res) => res.json(db.prepare("SELECT * FROM logs ORDER BY created_at DESC LIMIT ?").all(parseInt(req.query.limit) || 100)));

app.post("/api/poll", async (req, res) => {
  addLog("info", "Manual poll triggered");
  res.json({ success: true });
  pollAllAccounts();
});

app.get("/api/settings", (req, res) => res.json({ rewrite_prompt: getSetting("rewrite_prompt") || "" }));
app.post("/api/settings", (req, res) => { setSetting("rewrite_prompt", req.body.rewrite_prompt || ""); res.json({ success: true }); });

app.post("/api/test/twitter", async (req, res) => {
  try {
    const tweets = await fetchTweetsSyndication("elonmusk", null);
    res.json({ success: true, message: `✅ Working! Got ${tweets.length} tweet(s) — no API key needed!` });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post("/api/test/facebook", async (req, res) => {
  try {
    const id = await postToFacebook("🤖 Test post from X→Facebook Bot. Connection working!");
    res.json({ success: true, message: `✅ Facebook working! Post ID: ${id}` });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post("/api/test/claude", async (req, res) => {
  try {
    const result = await rewriteWithClaude("Just tested my new AI system and it works great! #AI #Tech", "testuser");
    res.json({ success: true, message: result });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.get("/api/debug", (req, res) => res.json({ mode: "Syndication API ✅", anthropic: process.env.ANTHROPIC_API_KEY ? "SET ✅" : "MISSING ❌", facebook_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN ? "SET ✅" : "MISSING ❌", facebook_id: process.env.FACEBOOK_PAGE_ID ? "SET ✅" : "MISSING ❌" }));

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog("info", `🚀 Server running on port ${PORT}`);
  addLog("info", `📡 Using Twitter Syndication API — no API key needed!`);
});
