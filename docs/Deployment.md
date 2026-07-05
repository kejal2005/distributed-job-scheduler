# Deploying to Render (Manual Dashboard Setup)

This guide walks you through deploying the Distributed Job Scheduler manually using the Render dashboard. 

### Step 1 — Render (backend + database)

1. Go to [render.com](https://render.com), sign up (GitHub login is easiest — connects your repo automatically).
2. **New → PostgreSQL** — create a free Postgres instance, name it `job-scheduler-db`. 
   * Copy its "Internal Database URL" once created.
3. **New → Web Service** — connect your GitHub repo, set:
   * **Root directory:** `backend`
   * **Build command:** `npm install`
   * **Start command:** `npm start`
   * **Add environment variables:** `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` (get these from the Postgres instance's connection details), plus `JWT_SECRET` (set this to any random secure string).
4. Once it deploys, run your migration against that database. 
   * Render gives you a "Connect" shell/psql command in the database dashboard. Run it, then execute the contents of `backend/migrations/001_init_schema.sql`.
5. **New → Background Worker** — connect the same repo, set:
   * **Root directory:** `backend`
   * **Build command:** `npm install`
   * **Start command:** `npm run worker`
   * **Environment variables:** Use the exact same `PG*` variables as above, plus `PROJECT_ID` and `PROJECT_API_KEY` (you can set these later after you register a project in the deployed dashboard).
6. Copy your Web Service's public URL (e.g., `https://your-app.onrender.com`) — that's your backend API's live address.

### Step 2 — Frontend

Because the frontend is a purely static site, you can host it anywhere (Render Static Site, Netlify, Vercel, or GitHub Pages).

Before deploying the frontend, update your `frontend/index.html` to point to your new Render backend URL by adding this inside the `<head>` tag:

```html
<script>
  window.SCHEDULER_API_BASE = 'https://your-app.onrender.com/api';
</script>
```

Then deploy the `frontend` folder!
