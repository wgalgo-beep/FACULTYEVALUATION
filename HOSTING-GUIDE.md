# Hosting the Faculty Evaluation online (free): GitHub + Render + Neon

You will use three free services:
- **Neon** – the database (PostgreSQL). Your data lives here and is not erased when the website restarts.
- **GitHub** – stores this code so Render can read it.
- **Render** – runs the website and gives students a public https:// link.

Why not keep the database on Render? A free Render web service loses any files it saved (like a SQLite file) whenever it restarts or sleeps,
and free Render databases expire 30 days after creation. Neon's free database stays available (it just pauses when idle and wakes in under a second).

## Step 1 – Create the database (Neon)
1. Go to https://console.neon.tech and sign up (no credit card needed for the Free plan).
2. Create a project (any name, e.g. `ccd-evaluation`; pick the region closest to the Philippines, e.g. Singapore).
3. On the project page click **Connect** and copy the **connection string**. It looks like
   `postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require`. Keep it secret – it is the key to your data.

## Step 2 – Put the code on GitHub
1. Create a free account at https://github.com, then **New repository** (name: `ccd-faculty-evaluation`, set it to **Private**).
2. Click **uploading an existing file**, drag in everything from this folder (server.js, package.json, render.yaml, .gitignore, the `public` folder),
   and click **Commit changes**. (Do not upload node_modules.)

## Step 3 – Publish the website (Render)
1. Go to https://render.com, sign up with your GitHub account.
2. **New > Web Service** > connect your `ccd-faculty-evaluation` repository.
3. Settings: Runtime **Node**, Build Command `npm install`, Start Command `npm start`, Instance Type **Free**.
4. Under **Environment Variables** add:
   - `DATABASE_URL` = the Neon connection string from Step 1
   - `ADMIN_PASSWORD` = a strong password of your choice (used the first time the system starts)
5. Click **Create Web Service**. After a few minutes the log says "Faculty Evaluation server running" and Render shows your address,
   e.g. `https://ccd-faculty-evaluation.onrender.com`.
   (Shortcut: **New > Blueprint** uses the included render.yaml and only asks for the two variables.)

## Step 4 – Set up and test
1. Open your address, click **Admin**, log in with your ADMIN_PASSWORD.
2. Import the Student IDs (Students tab) and the faculty/subjects (Teachers & Subjects tab).
3. Test with a test student ID on your phone, then **Settings > Delete all results** to clear test data.
4. Send the link to the students. They only need the link and their Student ID No.

## Things to know (free plans)
- **Sleeping:** Render spins a free web service down after 15 minutes without visitors; the next visitor waits about a minute while it wakes up.
  To avoid that, upgrade the service to a paid instance (about $7/month), or use a free uptime monitor (e.g. UptimeRobot) to open
  `https://YOUR-ADDRESS/healthz` every 5 minutes. Free services share 750 running hours per month, enough for one service all month.
- **Backups:** the free Neon plan only keeps a few hours of history. Use **Admin > Settings > Download backup** regularly and keep the file safe.
- **Security:** keep the Neon connection string and admin password private; never put them in GitHub files. Student ID No. is the only student login.
- **Editing later:** change the files on GitHub (public/index.html is the website, server.js is the server). Render redeploys automatically.
  If you change the number of rating statements, also change `N_ITEMS` in server.js.
- **Run it on your own computer for testing:** set `DATABASE_URL` to your Neon string and run `npm install` then `npm start`.
