# Private Stream — Google Drive video launcher for Render Free

A tiny, dependency-free Node.js app for personal video playback from Google Drive.

**The important architecture choice:** the video is **not** downloaded by Render, uploaded to Render, proxied through Render, transcoded on Render, or stored on Render. The watch page embeds Google Drive's player, so the viewer's browser streams the media from Google directly.

## What you get

- Password-protected admin page at `/admin`
- Paste a normal Google Drive share link
- Generates an encrypted + authenticated watch URL
- No database required
- No persistent disk required
- No Node package dependencies
- Google Drive's own video player handles seeking, volume, fullscreen, playback speed, captions and quality options that Drive makes available
- Recent generated links are stored only in that admin browser's `localStorage`
- Watch links can be permanent or expire after 1, 7, 30, or 90 days
- The Drive file ID is encrypted inside the watch token rather than being visible in the URL

## What it intentionally does NOT do

- It does not proxy video bytes through Render.
- It does not transcode video.
- It does not bypass Google Drive permissions, quotas, processing, or playback limits.
- It does not guarantee alternate-language audio-track selection. The embedded Drive player exposes whatever playback/audio controls Google supports for that file.
- It is video-on-demand from a stored Drive file, not RTMP/WebRTC live broadcasting.

## Drive setup

1. Upload your video to Google Drive.
2. Wait until Drive can play it normally in your browser.
3. Choose the sharing mode you want:
   - **Most private:** keep the file restricted to your Google account. The embedded player works when the browser viewing your site is signed into an account that has access.
   - **Share with specific people:** add those Google accounts in Drive sharing.
   - **Anyone with the link:** easiest, but anyone who obtains the Drive file URL/file ID can access it.
4. Copy the Drive share link. A standard link such as `https://drive.google.com/file/d/FILE_ID/view?...` works.

## Deploy to Render

### Option A — Blueprint (`render.yaml`)

1. Create a GitHub/GitLab repository and put these files in it.
2. In Render, create a new Blueprint from the repository.
3. Render will read `render.yaml`.
4. When prompted, set `ADMIN_PASSWORD` to a strong password.
5. `SIGNING_SECRET` is generated automatically by the Blueprint.
6. Deploy.
7. Open `https://YOUR-SERVICE.onrender.com/admin`.

### Option B — Manual Web Service

- Runtime: **Node**
- Plan: **Free**
- Build command: `echo "No build step"`
- Start command: `npm start`
- Health check: `/healthz`
- Environment variables:
  - `ADMIN_PASSWORD` = a strong password
  - `SIGNING_SECRET` = at least 32 random characters
  - `NODE_ENV` = `production`

## Use

1. Open `/admin`.
2. Enter the admin password, video title, and Google Drive link.
3. Click **Create private watch link**.
4. Copy/open the generated `/watch?v=...` link.
5. Use the gear/settings control inside the embedded Drive player for quality/captions/options Drive exposes.

## Why there is no database

Render Free web services have ephemeral local filesystems, and a free database is unnecessary for this use case. Instead, the video configuration is encrypted with AES-256-GCM into the watch token itself. The server decrypts the token when the watch page loads.

This has useful consequences:

- Render restarts do not destroy your generated links.
- There is no video metadata database to maintain.
- There is almost no outbound traffic from Render beyond HTML/CSS/JS and a tiny JSON response.

**Important:** if you change `SIGNING_SECRET`, previously generated watch links stop working.

## Render Free behavior

A Render Free web service can spin down after inactivity. That can make the first page load slower after an idle period. Once the Drive iframe is loaded, the actual video stream is between the viewer's browser and Google Drive, so Render is no longer carrying the media stream.

## Security notes

- Admin authentication is a header-based password check over HTTPS; the app never stores the password in browser storage.
- Failed admin logins are rate-limited in memory.
- Watch tokens use AES-256-GCM authenticated encryption.
- The app sends a restrictive Content Security Policy and other browser security headers.
- Search-engine indexing is discouraged (`noindex`, `robots` behavior depends on hosting state).
- A watch token is a bearer link: anyone who has the link can ask the app for the corresponding Drive preview URL. Drive permissions remain the final access control.

## Local test

```bash
export ADMIN_PASSWORD='dev-password'
export SIGNING_SECRET='replace-this-with-at-least-32-characters'
npm test
npm start
```

Then open `http://localhost:10000/admin`.

## Notes on quality and audio

Google Drive processes uploaded video for playback. The embedded Drive player can expose quality selection and other playback controls, depending on the file and Drive's current player behavior. Google Drive documents a maximum playback resolution of 1920×1080. If you need guaranteed 4K, custom HLS/DASH renditions, seamless manual bitrate switching, or selectable multiple audio-language tracks, Google Drive is not the right media backend; use a media/CDN service instead.
