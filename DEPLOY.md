# Med Review AI v2 - Setup & Free Deployment

Stack: React (Vite) + Node/Express + MongoDB Atlas (free M0) + Groq-hosted open-source Llama (free) -> hosted on Render (free).
The backend serves the built React app, so you deploy ONE service.

## 1. Database - MongoDB Atlas (free)
1. Sign up at mongodb.com/atlas, create a free **M0** cluster.
2. Database Access -> Add user (username + password). Keep the password simple (letters/numbers).
3. Network Access -> Add IP -> **Allow access from anywhere (0.0.0.0/0)** (Render free has no fixed IP).
4. Connect -> Drivers -> copy the connection string, put your password in it and add the db name:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/medreview?retryWrites=true&w=majority`

## 2. AI - how it works once deployed
Ollama only runs on your own PC, so a deployed site cannot reach it. Instead the backend talks to ANY
OpenAI-compatible API. Both Ollama and Groq offer one, so only environment variables change:

| Where | AI_BASE_URL | AI_API_KEY | AI_MODEL |
|---|---|---|---|
| Local (your Ollama) | http://localhost:11434/v1 | ollama | llama3.1:8b |
| Deployed (Groq, free, open-source Llama) | https://api.groq.com/openai/v1 | your Groq key | llama-3.3-70b-versatile |

Get a free key (no card): console.groq.com/keys. Model names change over time, so check
console.groq.com/docs/models. For scan images set `AI_VISION_MODEL` to a Groq vision model
(e.g. meta-llama/llama-4-scout-17b-16e-instruct). Free tier is rate-limited, which is fine for a demo.

## 3. Run locally
```bash
cd backend && cp .env.example .env     # fill in MONGODB_URI, JWT_SECRET, REGISTRATION_CODE, AI_*
npm install && npm start               # http://localhost:5000
cd ../frontend && npm install && npm run dev   # http://localhost:5173  (second terminal)
```
Open the site -> "Create an account" -> enter your REGISTRATION_CODE.

## 4. Deploy on Render (free)
1. Push this folder to a GitHub repo (`.env` is git-ignored - never commit secrets).
2. render.com -> New -> **Web Service** -> connect the repo.
3. Runtime **Node**, Instance type **Free**, Build Command `npm run build`, Start Command `npm start`.
4. Environment variables: `NODE_ENV=production`, `MONGODB_URI`, `JWT_SECRET` (long random string),
   `REGISTRATION_CODE`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_VISION_MODEL`.
5. Deploy. Your site is at `https://<name>.onrender.com`.

## 5. Free-tier things to know
- Render free sleeps after 15 min idle; the first request then takes ~1 minute. Before your demo, open the site once,
  or ping `https://<name>.onrender.com/api/health` every 10 min with a free cron service (cron-job.org / UptimeRobot).
- Uploaded files and PDFs are stored inside MongoDB (not on disk), so nothing is lost when Render restarts.
  Max 8 MB per file; Atlas free gives 512 MB.
- Use fictional patient data for your semester demo. Real patient data would need HIPAA/GDPR-level compliance,
  and this setup sends report text to a third-party AI provider.
