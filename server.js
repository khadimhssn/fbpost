// Debug route
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

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog("info", `🚀 Server running on http://localhost:${PORT}`);
});
