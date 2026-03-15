# ⚡ X → Facebook Bot

Automatically monitors multiple X/Twitter accounts, rewrites their tweets using Claude AI, and posts the rewritten content to your Facebook Page — 24/7 on a cloud server.

---

## 🏗️ How It Works

```
X/Twitter ──poll──► New Tweet ──► Claude AI rewrite ──► Facebook Page Post
```

1. Every N minutes, the bot polls each Twitter account for new tweets
2. Each new tweet is sent to Claude AI which rewrites it for a Facebook audience
3. The rewritten post is published to your Facebook Page automatically
4. Everything is logged in a beautiful web dashboard

---

## 📋 What You Need (All Free Tiers Available)

| Service | Purpose | Cost |
|---|---|---|
| Twitter/X Developer Account | Read tweets | Free (limited) |
| Anthropic API Key | AI rewriting | ~$0.001 per tweet |
| Facebook Developer App | Post to your Page | Free |
| Railway.app | Cloud hosting | Free tier available |

---

## 🔑 STEP 1: Get Your Twitter/X Bearer Token

1. Go to **https://developer.twitter.com/en/portal/dashboard**
2. Click **"Sign up for Free Account"**
3. Fill in the use case form (say "monitoring public tweets for content curation")
4. Once approved, click **"Create Project"** → **"Create App"**
5. Go to your app → **"Keys and Tokens"** tab
6. Copy the **Bearer Token**

> ⚠️ Free tier allows ~500,000 tweet reads/month. For multiple accounts, this is plenty.

---

## 🔑 STEP 2: Get Your Anthropic (Claude) API Key

1. Go to **https://console.anthropic.com/settings/keys**
2. Sign up or log in
3. Click **"Create Key"**
4. Copy the key starting with `sk-ant-...`
5. Add $5 credit to your account (this will handle thousands of tweets)

---

## 🔑 STEP 3: Get Your Facebook Page Access Token

This is the most involved step. Follow carefully:

### 3a. Create a Facebook Developer App
1. Go to **https://developers.facebook.com/apps/**
2. Click **"Create App"**
3. Select **"Other"** → **"Business"**
4. Fill in app name (e.g. "My Twitter Bot")

### 3b. Add Pages API
1. In your app dashboard, click **"Add Product"**
2. Find **"Facebook Login for Business"** → click "Set Up"
3. Also add **"Pages API"**

### 3c. Get a Page Access Token
1. Go to **https://developers.facebook.com/tools/explorer/**
2. Select your app in the top right
3. Click **"Generate Access Token"** → log in with your Facebook account
4. Under **"Permissions"**, add: `pages_manage_posts`, `pages_read_engagement`
5. Click **"Generate Access Token"**
6. Copy the token

### 3d. Convert to Long-Lived Token (Important!)
Short tokens expire in 1 hour. Run this in your browser console or curl:

```
https://graph.facebook.com/v19.0/oauth/access_token?
  grant_type=fb_exchange_token&
  client_id=YOUR_APP_ID&
  client_secret=YOUR_APP_SECRET&
  fb_exchange_token=YOUR_SHORT_TOKEN
```

This gives you a 60-day token. You'll need to refresh it every 60 days.

### 3e. Get Your Page ID
1. Go to your Facebook Page
2. Click **"About"** section
3. Scroll down — you'll see **"Page ID"** (a long number)

---

## 🚀 STEP 4: Deploy to Railway (Free Cloud Hosting)

### 4a. Push to GitHub
1. Create a new GitHub repository
2. Upload all these files to it
3. Make sure `.env` is NOT included (it's in `.gitignore`)

### 4b. Deploy on Railway
1. Go to **https://railway.app** and sign up with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your repository
4. Railway will auto-detect Node.js and deploy

### 4c. Set Environment Variables on Railway
1. In your Railway project, click on your service
2. Go to **"Variables"** tab
3. Add each variable from `.env.example`:
   - `TWITTER_BEARER_TOKEN`
   - `ANTHROPIC_API_KEY`
   - `FACEBOOK_PAGE_ACCESS_TOKEN`
   - `FACEBOOK_PAGE_ID`
   - `POLL_INTERVAL_MINUTES` = `15`

### 4d. Get Your Dashboard URL
1. Go to **"Settings"** tab in Railway
2. Click **"Generate Domain"**
3. Your dashboard is now live at `https://your-app.railway.app`

---

## 🖥️ STEP 5: Using The Dashboard

1. Open your Railway URL in a browser
2. Go to **"Settings"** tab → click **"Run Test"** for each API to verify connections
3. Go to **"Accounts"** tab → add Twitter usernames you want to monitor
4. Click **"Poll Now"** on the Dashboard to do an immediate check
5. Watch the **"Logs"** tab to see activity in real time

---

## ⚙️ Configuration Options

### Polling Interval
Set `POLL_INTERVAL_MINUTES` in Railway variables. Recommended: `15` minutes.

### Custom AI Rewrite Prompt
In the dashboard → **Settings** tab, you can customize how Claude rewrites tweets.

Default behavior:
- Makes the post more conversational for Facebook
- Adds relevant emojis
- Keeps core facts intact
- Removes most hashtags

---

## 🛠️ Running Locally (For Testing)

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env
# Edit .env with your real keys

# Start the server
npm start

# Open dashboard
open http://localhost:3000
```

---

## 📊 API Limits Reference

| API | Free Limit | Notes |
|---|---|---|
| Twitter v2 Free | 1 app login/15min, 500K tweets/month | Good for 10+ accounts |
| Claude API | Pay per use | ~$0.001/tweet, $5 = 5,000 tweets |
| Facebook Graph API | No rate issues for posting | Normal page post limits apply |

---

## ❓ Troubleshooting

**"TWITTER_BEARER_TOKEN not set"** → Add it to Railway Variables tab

**Twitter 429 error** → You've hit the rate limit. Increase POLL_INTERVAL_MINUTES to 30

**Facebook "Invalid OAuth token"** → Your token expired. Generate a new long-lived token (Step 3d)

**No new tweets found** → The account might not have tweeted since the bot started. It only catches NEW tweets after you add the account.

---

## 📁 File Structure

```
x-to-facebook/
├── server.js          # Backend: polling, AI, Facebook posting
├── public/
│   └── index.html     # Web dashboard
├── package.json       # Dependencies
├── .env.example       # Environment variables template
├── .gitignore         # Excludes .env and bot.db from git
└── README.md          # This file
```

---

*Built with Node.js, Express, Claude AI, and caffeine ☕*
