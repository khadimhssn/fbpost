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
    twitter_id TEXT,
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
  // Keep only last 500 logs
  db.prepare("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 500)").run();
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

// ─── TWITTER/X API ────────────────────────────────────────────────────────────
async function getTwitterUserId(username) {
  const token = process.env.TWITTER_BEARER_TOKEN;
  if (!token) throw new Error("TWITTER_BEARER_TOKEN not set");

  const res = await axios.get(
    `https://api.twitter.com/2/users/by/username/${username}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data.data.id;
}

async function getLatestTweets(userId, sinceId = null) {
  const token = process.env.TWITTER_BEARER_TOKEN;
  if (!token) throw new Error("TWITTER_BEARER_TOKEN not set");

  const params = {
    max_results: 5,
    "tweet.fields": "created_at,text",
    exclude: "retweets,replies",
  };
  if (sinceId) params.since_id = sinceId;

  const res = await axios.get(
    `https://api.twitter.com/2/users/${userId}/tweets`,
    { headers: { Authorization: `Bearer ${token}` }, params }
  );
  return res.data.data || [];
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
      messages: [
        {
          role: "user",
          content: `${customPrompt}\n\nOriginal tweet from @${username}:\n"${tweetText}"\n\nRewritten Facebook post:`,
        },
      ],
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
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

    // Resolve Twitter ID if not cached
    if (!account.twitter_id) {
      const id = await getTwitterUserId(account.username);
      db.prepare("UPDATE accounts SET twitter_id = ? WHERE id = ?").run(id, account.id);
      account.twitter_id = id;
    }

    const tweets = await getLatestTweets(account.twitter_id, account.last_tweet_id);

    if (!tweets || tweets.length === 0) {
      addLog("info", `No new tweets from @${account.username}`);
      return;
    }

    addLog("info", `Found ${tweets.length} new tweet(s) from @${account.username}`);

    // Process newest first (reverse so we process oldest→newest)
    const sorted = [...tweets].reverse();

    for (const tweet of sorted) {
      const tweetUrl = `https://twitter.com/${account.username}/status/${tweet.id}`;

      // Insert pending record
      const insertResult = db.prepare(
        "INSERT INTO posts (account_username, original_tweet, tweet_url, status) VALUES (?, ?, ?, 'processing')"
      ).run(account.username, tweet.text, tweetUrl);

      const postId = insertResult.lastInsertRowid;

      try {
        // Step 1: Rewrite
        addLog("info", `Rewriting tweet ${tweet.id} with Claude...`);
        const rewritten = await rewriteWithClaude(tweet.text, account.username);

        // Step 2: Post to Facebook
        addLog("info", `Posting to Facebook...`);
        const fbPostId = await postToFacebook(rewritten);

        // Update record as success
        db.prepare(
          "UPDATE posts SET rewritten_text = ?, fb_post_id = ?, status = 'posted' WHERE id = ?"
        ).run(rewritten, fbPostId, postId);

        addLog("info", `✅ Posted to Facebook! FB Post ID: ${fbPostId}`);
      } catch (err) {
        db.prepare(
          "UPDATE posts SET status = 'error', error = ? WHERE id = ?"
        ).run(err.message, postId);
        addLog("error", `Failed to process tweet ${tweet.id}: ${err.message}`);
      }

      // Update last seen tweet ID
      db.prepare("UPDATE accounts SET last_tweet_id = ? WHERE id = ?").run(tweet.id, account.id);
    }
  } catch (err) {
    addLog("error", `Error polling @${account.username}: ${err.message}`);
  }
}

async function pollAllAccounts() {
  const accounts = db.prepare("SELECT * FROM accounts WHERE active = 1").all();
  if (accounts.length === 0) {
    addLog("info", "No active accounts to poll.");
    return;
  }
  for (const account of accounts) {
    await pollAccount(account);
    await new Promise((r) => setTimeout(r, 2000)); // 2s delay between accounts
  }
}

// ─── CRON SCHEDULER ───────────────────────────────────────────────────────────
const POLL_INTERVAL = process.env.POLL_INTERVAL_MINUTES || "15";
let cronJob = null;

function startCron() {
  if (cronJob) cronJob.stop();
  const mins = parseInt(POLL_INTERVAL);
  const schedule = `*/${Math.max(1, Math.min(59, mins))} * * * *`;
  addLog("info", `Scheduler started: polling every ${mins} minute(s)`);
  cronJob = cron.schedule(schedule, () => {
    addLog("info", "⏰ Cron tick — starting poll cycle");
    pollAllAccounts();
  });
}

startCron();

// ─── REST API ROUTES ──────────────────────────────────────────────────────────

// Status
app.get("/api/status", (req, res) => {
  const accounts = db.prepare("SELECT COUNT(*) as c FROM accounts WHERE active=1").get();
  const posts = db.prepare("SELECT COUNT(*) as c FROM posts WHERE status='posted'").get();
  const errors = db.prepare("SELECT COUNT(*) as c FROM posts WHERE status='error'").get();
  res.json({
    running: true,
    poll_interval_minutes: parseInt(POLL_INTERVAL),
    active_accounts: accounts.c,
    total_posted: posts.c,
    total_errors: errors.c,
    twitter_configured: !!process.env.TWITTER_BEARER_TOKEN,
    facebook_configured: !!(process.env.FACEBOOK_PAGE_ACCESS_TOKEN && process.env.FACEBOOK_PAGE_ID),
    anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
  });
});

// Accounts CRUD
app.get("/api/accounts", (req, res) => {
  res.json(db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all());
});

app.post("/api/accounts", async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Username required" });
  const clean = username.replace("@", "").trim().toLowerCase();
  try {
    db.prepare("INSERT INTO accounts (username) VALUES (?)").run(clean);
    addLog("info", `Added account: @${clean}`);
    res.json({ success: true, message: `@${clean} added` });
  } catch (e) {
    res.status(400).json({ error: `@${clean} already exists` });
  }
});

app.delete("/api/accounts/:id", (req, res) => {
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM accounts WHERE id = ?").run(req.params.id);
  addLog("info", `Removed account: @${account.username}`);
  res.json({ success: true });
});

app.patch("/api/accounts/:id/toggle", (req, res) => {
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });
  const newActive = account.active ? 0 : 1;
  db.prepare("UPDATE accounts SET active = ? WHERE id = ?").run(newActive, req.params.id);
  res.json({ success: true, active: newActive });
});

// Posts log
app.get("/api/posts", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(db.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?").all(limit));
});

// Logs
app.get("/api/logs", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(db.prepare("SELECT * FROM logs ORDER BY created_at DESC LIMIT ?").all(limit));
});

// Manual poll trigger
app.post("/api/poll", async (req, res) => {
  addLog("info", "Manual poll triggered from dashboard");
  res.json({ success: true, message: "Poll started in background" });
  pollAllAccounts();
});

// Settings
app.get("/api/settings", (req, res) => {
  const prompt = getSetting("rewrite_prompt") || "";
  res.json({ rewrite_prompt: prompt });
});

app.post("/api/settings", (req, res) => {
  const { rewrite_prompt } = req.body;
  setSetting("rewrite_prompt", rewrite_prompt || "");
  res.json({ success: true });
});

// Test endpoints
app.post("/api/test/twitter", async (req, res) => {
  try {
    const { username } = req.body;
    const id = await getTwitterUserId(username || "elonmusk");
    res.json({ success: true, message: `Twitter API working! User ID: ${id}` });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post("/api/test/facebook", async (req, res) => {
  try {
    const msg = "🤖 Test post from X→Facebook Bot. If you see this, your Facebook connection is working!";
    const id = await postToFacebook(msg);
    res.json({ success: true, message: `Facebook API working! Post ID: ${id}` });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post("/api/test/claude", async (req, res) => {
  try {
    const result = await rewriteWithClaude("Just tested my new AI system and it works great! #AI #Tech", "testuser");
    res.json({ success: true, message: result });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ─── DEBUG ROUTE ──────────────────────────────────────────────────────────────
app.get("/api/debug", (req, res) => {
  res.json({
    twitter: process.env.TWITTER_BEARER_TOKEN ? "SET ✅" : "MISSING ❌",
    anthropic: process.env.ANTHROPIC_API_KEY ? "SET ✅" : "MISSING ❌",
    facebook_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN ? "SET ✅" : "MISSING ❌",
    facebook_id: process.env.FACEBOOK_PAGE_ID ? "SET ✅" : "MISSING ❌",
    node_env: process.env.NODE_ENV,
    port: process.env.PORT,
  });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog("info", `🚀 Server running on http://localhost:${PORT}`);
});
