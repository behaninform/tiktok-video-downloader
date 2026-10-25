const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

function validTikTokUrl(u) {
  try {
    const url = new URL(u);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const h = url.hostname.toLowerCase();
    return /(^|\.)tiktok\.com$/.test(h);
  } catch { return false; }
}

function run(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args);
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Timeout")); }, timeoutMs);
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (err += d));
    p.on("error", e => { clearTimeout(t); reject(e); });
    p.on("close", code => {
      clearTimeout(t);
      if (code === 0) return resolve(out);
      const lines = err.trim().split("\n").filter(Boolean);
      const errLine = lines.reverse().find(l => l.includes("ERROR")) || lines[0] || "yt-dlp failed";
      console.error("yt-dlp error:", err);
      reject(new Error(errLine));
    });
  });
}

app.post("/api/info", async (req, res) => {
  const url = (req.body && req.body.url || "").trim();
  if (!validTikTokUrl(url)) return res.status(400).json({ error: "Please paste a valid TikTok link." });
  try {
    const out = await run(["-J", "--no-playlist", "--no-warnings", "--impersonate", "chrome", url]);
    const info = JSON.parse(out);
    const best = {};
    (info.formats || []).forEach(f => {
      if (f.vcodec && f.vcodec !== "none" && f.height) {
        const size = f.filesize || f.filesize_approx || 0;
        if (!best[f.height] || size > best[f.height]) best[f.height] = size;
      }
    });
    const heights = Object.keys(best).map(Number).sort((a, b) => b - a).map(h => ({ height: h, size: best[h] || null }));
    res.json({
      title: info.title || "TikTok video",
      thumbnail: info.thumbnail || null,
      duration: info.duration || null,
      uploader: info.uploader || info.channel || null,
      heights
    });
  } catch (e) {
    console.error("info error:", e.message);
    res.status(422).json({ error: "No downloadable video found. Make sure it is a public TikTok video." });
  }
});

app.get("/api/download", async (req, res) => {
  const url = (req.query.url || "").toString().trim();
  if (!validTikTokUrl(url)) return res.status(400).send("Invalid link");
  const audio = req.query.type === "audio";
  let h = parseInt(req.query.h, 10);
  if (!(h >= 144 && h <= 4320)) h = 0;
  const id = crypto.randomBytes(8).toString("hex");
  const base = path.join(os.tmpdir(), "tt_" + id);
  const args = audio
    ? ["-x", "--audio-format", "mp3", "-f", "ba/b"]
    : ["-f", h ? `b[height<=${h}]/bv*[height<=${h}]+ba/b` : "b/bv*+ba", "--merge-output-format", "mp4"];
  try {
    await run([...args, "--no-playlist", "--no-warnings", "--impersonate", "chrome",
      "-o", base + ".%(ext)s", url], 280000);
    const file = fs.readdirSync(os.tmpdir()).find(f => f.startsWith("tt_" + id));
    if (!file) throw new Error("No file");
    const full = path.join(os.tmpdir(), file);
    const name = audio ? "tiktok-audio" : "tiktok-video" + (h ? "-" + h + "p" : "");
    res.download(full, name + path.extname(file), () => fs.unlink(full, () => {}));
  } catch (e) {
    console.error("download error:", e.message);
    res.status(500).send("Download failed: " + e.message);
  }
});

app.get("/health", (_, res) => res.send("ok"));
app.listen(PORT, () => console.log("Server running on port " + PORT));
