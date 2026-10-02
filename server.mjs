import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const SIGNING_SECRET = String(process.env.SIGNING_SECRET || '');

if (!ADMIN_PASSWORD) {
  console.error('Missing ADMIN_PASSWORD environment variable.');
  process.exit(1);
}

if (SIGNING_SECRET.length < 32) {
  console.error('SIGNING_SECRET must be at least 32 characters long.');
  process.exit(1);
}

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const RESOURCE_KEY_RE = /^[A-Za-z0-9_-]{1,300}$/;
const QUALITIES = [
  'Original',
  '360p',
  '480p',
  '720p',
  '1080p',
  '1440p',
  '2160p'
];

function parseDriveLink(input) {
  const raw = String(input || '').trim();

  if (!raw) {
    throw new Error('Google Drive link is required.');
  }

  if (FILE_ID_RE.test(raw)) {
    return {
      fileId: raw,
      resourceKey: ''
    };
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a valid Google Drive link.');
  }

  const allowedHosts = new Set([
    'drive.google.com',
    'docs.google.com',
    'drive.usercontent.google.com'
  ]);

  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error('Only Google Drive links are accepted.');
  }

  const pathMatch = url.pathname.match(
    /\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/
  );

  const fileId =
    pathMatch?.[1] ||
    url.searchParams.get('id') ||
    '';

  if (!FILE_ID_RE.test(fileId)) {
    throw new Error(
      'Could not find a valid Google Drive file ID.'
    );
  }

  const maybeResourceKey =
    url.searchParams.get('resourcekey') ||
    url.searchParams.get('resourceKey') ||
    '';

  return {
    fileId,
    resourceKey:
      RESOURCE_KEY_RE.test(maybeResourceKey)
        ? maybeResourceKey
        : ''
  };
}

function normalizeTitle(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Private video';
}

function getKey() {
  return crypto
    .createHash('sha256')
    .update(SIGNING_SECRET, 'utf8')
    .digest();
}

function encryptConfig(config) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    getKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify(config),
      'utf8'
    ),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return [iv, encrypted, tag]
    .map((part) =>
      part.toString('base64url')
    )
    .join('.');
}

function decryptConfig(token) {
  try {
    const parts =
      String(token || '').split('.');

    if (parts.length !== 3) {
      throw new Error();
    }

    const iv =
      Buffer.from(
        parts[0],
        'base64url'
      );

    const encrypted =
      Buffer.from(
        parts[1],
        'base64url'
      );

    const tag =
      Buffer.from(
        parts[2],
        'base64url'
      );

    if (
      iv.length !== 12 ||
      tag.length !== 16 ||
      encrypted.length === 0 ||
      encrypted.length > 8192
    ) {
      throw new Error();
    }

    const decipher =
      crypto.createDecipheriv(
        'aes-256-gcm',
        getKey(),
        iv
      );

    decipher.setAuthTag(tag);

    const payload =
      JSON.parse(
        Buffer.concat([
          decipher.update(encrypted),
          decipher.final()
        ]).toString('utf8')
      );

    /*
      Compatibility with the first version.
    */
    if (
      payload?.v === 1 &&
      FILE_ID_RE.test(payload.f)
    ) {
      return {
        title:
          normalizeTitle(payload.t),

        exp:
          Number(payload.exp || 0),

        sources: [
          {
            quality: 'Original',
            fileId: payload.f,
            resourceKey: ''
          }
        ]
      };
    }

    if (
      payload?.v !== 3 ||
      !Array.isArray(payload.sources) ||
      !payload.sources.length
    ) {
      throw new Error();
    }

    const sources =
      payload.sources.map(
        (source) => {
          const quality =
            String(
              source?.quality || ''
            );

          const fileId =
            String(
              source?.fileId || ''
            );

          const resourceKey =
            String(
              source?.resourceKey || ''
            );

          if (
            !QUALITIES.includes(
              quality
            )
          ) {
            throw new Error();
          }

          if (
            !FILE_ID_RE.test(
              fileId
            )
          ) {
            throw new Error();
          }

          if (
            resourceKey &&
            !RESOURCE_KEY_RE.test(
              resourceKey
            )
          ) {
            throw new Error();
          }

          return {
            quality,
            fileId,
            resourceKey
          };
        }
      );

    const exp =
      Number(payload.exp || 0);

    if (
      exp &&
      Math.floor(Date.now() / 1000) >
        exp
    ) {
      const error =
        new Error(
          'This watch link has expired.'
        );

      error.status = 410;

      throw error;
    }

    return {
      title:
        normalizeTitle(
          payload.title
        ),

      exp,
      sources
    };
  } catch (error) {
    if (
      error?.status === 410
    ) {
      throw error;
    }

    throw Object.assign(
      new Error(
        'Invalid or damaged watch link.'
      ),
      {
        status: 400
      }
    );
  }
}

function parseSources(body) {
  const fields = [
    [
      'Original',
      body.driveUrl
    ],

    [
      '360p',
      body.q360
    ],

    [
      '480p',
      body.q480
    ],

    [
      '720p',
      body.q720
    ],

    [
      '1080p',
      body.q1080
    ],

    [
      '1440p',
      body.q1440
    ],

    [
      '2160p',
      body.q2160
    ]
  ];

  const sources = [];

  for (
    const [
      quality,
      value
    ] of fields
  ) {
    if (
      !String(value || '')
        .trim()
    ) {
      continue;
    }

    sources.push({
      quality,
      ...parseDriveLink(
        value
      )
    });
  }

  if (
    !sources.length ||
    sources[0].quality !==
      'Original'
  ) {
    throw new Error(
      'Original Google Drive link is required.'
    );
  }

  return sources;
}

function expiryTimestamp(value) {
  const days =
    Number(value || 0);

  if (days === 0) {
    return 0;
  }

  if (
    ![
      1,
      7,
      30,
      90
    ].includes(days)
  ) {
    throw new Error(
      'Invalid expiry setting.'
    );
  }

  return Math.floor(
    (
      Date.now() +
      days *
        86400000
    ) / 1000
  );
}

function safeEqual(a, b) {
  const left =
    Buffer.from(
      String(a || ''),
      'utf8'
    );

  const right =
    Buffer.from(
      String(b || ''),
      'utf8'
    );

  if (
    left.length !==
    right.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    left,
    right
  );
}

function originFor(req) {
  const proto =
    String(
      req.headers[
        'x-forwarded-proto'
      ] || 'http'
    )
      .split(',')[0]
      .trim();

  const host =
    req.headers.host ||
    'localhost';

  return `${proto}://${host}`;
}

function securityHeaders() {
  return {
    'Content-Security-Policy':
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "media-src 'self' https://drive.usercontent.google.com https://drive.google.com https://*.googleusercontent.com",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'"
      ].join('; '),

    'Referrer-Policy':
      'no-referrer',

    'X-Content-Type-Options':
      'nosniff',

    'X-Frame-Options':
      'DENY',

    'Cache-Control':
      'no-store'
  };
}

function send(
  res,
  status,
  body = '',
  headers = {}
) {
  res.writeHead(
    status,
    {
      ...securityHeaders(),
      ...headers
    }
  );

  res.end(body);
}

function sendJson(
  res,
  status,
  data
) {
  send(
    res,
    status,
    JSON.stringify(data),
    {
      'Content-Type':
        'application/json; charset=utf-8'
    }
  );
}

function readJson(
  req,
  maxBytes =
    32 * 1024
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      let size = 0;

      const chunks = [];

      req.on(
        'data',
        (chunk) => {
          size +=
            chunk.length;

          if (
            size >
            maxBytes
          ) {
            reject(
              Object.assign(
                new Error(
                  'Request too large.'
                ),
                {
                  status: 413
                }
              )
            );

            req.destroy();

            return;
          }

          chunks.push(
            chunk
          );
        }
      );

      req.on(
        'end',
        () => {
          try {
            resolve(
              JSON.parse(
                Buffer.concat(
                  chunks
                ).toString(
                  'utf8'
                ) || '{}'
              )
            );
          } catch {
            reject(
              Object.assign(
                new Error(
                  'Invalid JSON.'
                ),
                {
                  status: 400
                }
              )
            );
          }
        }
      );

      req.on(
        'error',
        reject
      );
    }
  );
}

const CSS = `
:root {
  color-scheme: dark;

  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  --bg: #070a12;
  --panel: #101521;
  --line: #263047;
  --text: #f6f8ff;
  --muted: #9da9c1;
  --accent: #2e72eb;
  --danger: #ff7b87;
}

* {
  box-sizing:
    border-box;
}

body {
  margin: 0;

  min-height:
    100vh;

  color:
    var(--text);

  background:
    radial-gradient(
      circle at top,
      #10172a 0,
      #070a12 52%
    );
}

a {
  color:
    inherit;
}

.shell {
  width:
    min(
      1180px,
      calc(
        100% - 28px
      )
    );

  margin:
    0 auto;
}

.topbar {
  min-height:
    76px;

  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  gap:
    16px;
}

.brand {
  display:
    flex;

  align-items:
    center;

  gap:
    10px;

  text-decoration:
    none;

  font-weight:
    800;
}

.brand-mark {
  width:
    38px;

  height:
    38px;

  display:
    grid;

  place-items:
    center;

  border:
    1px solid
    var(--line);

  border-radius:
    12px;
}

.admin-shell {
  max-width:
    920px;
}

.card,
.player-card {
  background:
    rgba(
      13,
      18,
      29,
      .96
    );

  border:
    1px solid
    var(--line);

  border-radius:
    20px;

  box-shadow:
    0 24px 80px
    rgba(
      0,
      0,
      0,
      .28
    );
}

.card {
  padding:
    28px;
}

h1 {
  margin:
    0 0 12px;

  font-size:
    clamp(
      26px,
      4vw,
      38px
    );
}

.eyebrow {
  margin:
    0 0 8px;

  color:
    #8db4ff;

  font-size:
    12px;

  font-weight:
    800;

  letter-spacing:
    .16em;
}

.lead,
.helper,
.message,
.footer {
  color:
    var(--muted);

  line-height:
    1.6;
}

.notice {
  margin:
    18px 0;

  padding:
    12px 14px;

  border-left:
    3px solid
    #5f93ef;

  border-radius:
    8px;

  background:
    #0a1120;

  color:
    #b9c5da;
}

.grid {
  display:
    grid;

  grid-template-columns:
    1fr 1fr;

  gap:
    16px;
}

.full {
  grid-column:
    1 / -1;
}

label {
  display:
    grid;

  gap:
    7px;

  font-size:
    14px;

  font-weight:
    700;

  color:
    #dce4f6;
}

input,
select,
button {
  font:
    inherit;
}

input,
select {
  width:
    100%;

  border:
    1px solid
    #33405b;

  background:
    #0a0f19;

  color:
    #fff;

  border-radius:
    12px;

  padding:
    13px 14px;

  outline:
    none;
}

input:focus,
select:focus {
  border-color:
    #6f9eff;

  box-shadow:
    0 0 0 3px
    rgba(
      111,
      158,
      255,
      .13
    );
}

.button-row {
  display:
    flex;

  flex-wrap:
    wrap;

  gap:
    10px;
}

button,
.button {
  border:
    0;

  border-radius:
    12px;

  padding:
    12px 17px;

  background:
    var(--accent);

  color:
    white;

  cursor:
    pointer;

  font-weight:
    800;

  text-decoration:
    none;
}

.secondary {
  background:
    #1a2232;

  border:
    1px solid
    #33405b;
}

button:disabled {
  opacity:
    .55;

  cursor:
    wait;
}

.hidden {
  display:
    none !important;
}

.result {
  margin-top:
    20px;

  padding:
    18px;

  border-radius:
    14px;

  background:
    #0b1425;

  border:
    1px solid
    #294164;
}

.error {
  color:
    var(--danger);
}

.player-card {
  overflow:
    hidden;
}

.state {
  min-height:
    460px;

  display:
    grid;

  place-items:
    center;

  text-align:
    center;

  padding:
    28px;
}

.state > div {
  max-width:
    700px;
}

.video-box {
  background:
    #000;

  min-height:
    300px;

  display:
    grid;

  place-items:
    center;
}

video {
  display:
    block;

  width:
    100%;

  max-height:
    76vh;

  background:
    #000;
}

.player-bottom {
  display:
    flex;

  align-items:
    end;

  justify-content:
    space-between;

  gap:
    18px;

  padding:
    20px 22px;
}

.options {
  display:
    flex;

  flex-wrap:
    wrap;

  gap:
    12px;
}

.options label {
  min-width:
    140px;
}

.footer {
  padding:
    18px;

  text-align:
    center;

  font-size:
    13px;
}

.message {
  min-height:
    24px;
}

@media (
  max-width:
  720px
) {

  .grid {
    grid-template-columns:
      1fr;
  }

  .full {
    grid-column:
      auto;
  }

  .card {
    padding:
      20px;
  }

  .player-bottom {
    flex-direction:
      column;

    align-items:
      stretch;
  }

  .video-box {
    min-height:
      220px;
  }
}
`;

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<meta
name="robots"
content="noindex,nofollow,noarchive"
>

<title>
Admin · Private Stream
</title>

<link
rel="stylesheet"
href="/ui.css"
>

</head>

<body>

<main
class="shell admin-shell"
>

<header
class="topbar"
>

<a
class="brand"
href="/admin"
>

<span
class="brand-mark"
>
▶
</span>

<span>
Private Stream
</span>

</a>

<span>
ADMIN
</span>

</header>

<section
class="card"
>

<p
class="eyebrow"
>
GOOGLE DRIVE DIRECT PLAYER
</p>

<h1>
Create a watch link
</h1>

<p
class="lead"
>
Render serves only this website.
The video itself is requested directly
by the viewer's browser from Google Drive.
</p>

<div
class="notice"
>
Set every Drive video used here to
<b>Anyone with the link</b>.

For direct browser playback,
MP4 with H.264 video and AAC audio
is the safest format.
</div>

<form
id="form"
class="grid"
autocomplete="off"
>

<label>

<span>
Admin password
</span>

<input
id="password"
type="password"
required
autocomplete="current-password"
>

</label>

<label>

<span>
Video title
</span>

<input
id="title"
type="text"
maxlength="120"
placeholder="My video"
>

</label>

<label
class="full"
>

<span>
Original Google Drive link
</span>

<input
id="driveUrl"
type="url"
required
placeholder="https://drive.google.com/file/d/.../view"
>

</label>

<label>

<span>
Watch-link expiry
</span>

<select
id="expiryDays"
>

<option
value="0"
>
Never
</option>

<option
value="1"
>
1 day
</option>

<option
value="7"
>
7 days
</option>

<option
value="30"
>
30 days
</option>

<option
value="90"
>
90 days
</option>

</select>

</label>

<div>
</div>

<div
class="full"
>

<p>
<b>
Optional quality files
</b>
</p>

<p
class="helper"
>
For a real quality selector without
Google Drive's preview/transcoding player,
each quality must be a separate Drive video file.
</p>

</div>

<label>

<span>
360p Drive link
</span>

<input
id="q360"
type="url"
placeholder="Optional"
>

</label>

<label>

<span>
480p Drive link
</span>

<input
id="q480"
type="url"
placeholder="Optional"
>

</label>

<label>

<span>
720p Drive link
</span>

<input
id="q720"
type="url"
placeholder="Optional"
>

</label>

<label>

<span>
1080p Drive link
</span>

<input
id="q1080"
type="url"
placeholder="Optional"
>

</label>

<label>

<span>
1440p Drive link
</span>

<input
id="q1440"
type="url"
placeholder="Optional"
>

</label>

<label>

<span>
2160p Drive link
</span>

<input
id="q2160"
type="url"
placeholder="Optional"
>

</label>

<div
class="full button-row"
>

<button
id="createButton"
type="submit"
>
Create watch link
</button>

</div>

</form>

<p
id="formMessage"
class="message"
>
</p>

<div
id="result"
class="result hidden"
>

<b>
Watch link
</b>

<input
id="watchUrl"
readonly
>

<div
class="button-row"
style="margin-top:10px"
>

<button
id="copyButton"
type="button"
>
Copy link
</button>

<a
id="openButton"
class="button secondary"
target="_blank"
rel="noopener"
>
Open player
</a>

</div>

</div>

</section>

<footer
class="footer"
>
No video is uploaded to or proxied through Render.
</footer>

</main>

<script
src="/admin.js"
defer
>
</script>

</body>
</html>`;

const WATCH_HTML = `<!doctype html>
<html lang="en">

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1,viewport-fit=cover"
>

<meta
name="robots"
content="noindex,nofollow,noarchive"
>

<title>
Private Stream
</title>

<link
rel="stylesheet"
href="/ui.css"
>

</head>

<body>

<main
class="shell"
>

<header
class="topbar"
>

<a
class="brand"
href="/watch"
>

<span
class="brand-mark"
>
▶
</span>

<span>
Private Stream
</span>

</a>

<a
href="/admin"
>
Admin
</a>

</header>

<section
class="player-card"
>

<div
id="loading"
class="state"
>

<div>

<h1>
Preparing video…
</h1>

<p
class="helper"
>
Loading the direct Google Drive source.
</p>

</div>

</div>

<div
id="player"
class="hidden"
>

<div
class="video-box"
>

<video
id="video"
controls
playsinline
preload="metadata"
>
</video>

</div>

<div
class="player-bottom"
>

<div>

<p
class="eyebrow"
>
DIRECT FROM GOOGLE DRIVE
</p>

<h1
id="videoTitle"
>
Private video
</h1>

<p
id="playbackMessage"
class="helper"
>
</p>

</div>

<div
class="options"
>

<label
id="qualityWrap"
class="hidden"
>

<span>
Quality
</span>

<select
id="qualitySelect"
>
</select>

</label>

<label
id="audioWrap"
class="hidden"
>

<span>
Audio
</span>

<select
id="audioSelect"
>
</select>

</label>

</div>

</div>

</div>

<div
id="errorState"
class="state hidden"
>

<div>

<h1>
Direct playback failed
</h1>

<p
id="errorText"
class="helper"
>
</p>

<div
class="button-row"
style="justify-content:center"
>

<button
id="retryButton"
type="button"
>
Retry
</button>

<a
class="button secondary"
href="/admin"
>
Admin
</a>

</div>

</div>

</div>

</section>

<footer
class="footer"
>
Video bytes go from Google Drive to your browser,
not through Render.
</footer>

</main>

<script
src="/watch.js"
defer
>
</script>

</body>
</html>`;

const ADMIN_JS = `
const form =
  document.querySelector(
    '#form'
  );

const password =
  document.querySelector(
    '#password'
  );

const title =
  document.querySelector(
    '#title'
  );

const driveUrl =
  document.querySelector(
    '#driveUrl'
  );

const expiryDays =
  document.querySelector(
    '#expiryDays'
  );

const createButton =
  document.querySelector(
    '#createButton'
  );

const formMessage =
  document.querySelector(
    '#formMessage'
  );

const result =
  document.querySelector(
    '#result'
  );

const watchUrl =
  document.querySelector(
    '#watchUrl'
  );

const copyButton =
  document.querySelector(
    '#copyButton'
  );

const openButton =
  document.querySelector(
    '#openButton'
  );

form.addEventListener(
  'submit',

  async (
    event
  ) => {

    event.preventDefault();

    result.classList.add(
      'hidden'
    );

    formMessage.textContent =
      '';

    formMessage.className =
      'message';

    createButton.disabled =
      true;

    createButton.textContent =
      'Creating…';

    try {

      const response =
        await fetch(
          '/api/create',

          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json',

              'X-Admin-Password':
                password.value
            },

            body:
              JSON.stringify(
                {
                  title:
                    title.value,

                  driveUrl:
                    driveUrl.value,

                  expiryDays:
                    expiryDays.value,

                  q360:
                    document.querySelector(
                      '#q360'
                    ).value,

                  q480:
                    document.querySelector(
                      '#q480'
                    ).value,

                  q720:
                    document.querySelector(
                      '#q720'
                    ).value,

                  q1080:
                    document.querySelector(
                      '#q1080'
                    ).value,

                  q1440:
                    document.querySelector(
                      '#q1440'
                    ).value,

                  q2160:
                    document.querySelector(
                      '#q2160'
                    ).value
                }
              )
          }
        );

      const data =
        await response
          .json()
          .catch(
            () => ({})
          );

      if (
        !response.ok
      ) {
        throw new Error(
          data.error ||
          'Could not create watch link.'
        );
      }

      watchUrl.value =
        data.watchUrl;

      openButton.href =
        data.watchUrl;

      result.classList.remove(
        'hidden'
      );

      formMessage.textContent =
        'Watch link created.';

    } catch (
      error
    ) {

      formMessage.textContent =
        error.message ||
        'Could not create watch link.';

      formMessage.className =
        'message error';

    } finally {

      createButton.disabled =
        false;

      createButton.textContent =
        'Create watch link';
    }
  }
);

copyButton.addEventListener(
  'click',

  async () => {

    try {

      await navigator.clipboard
        .writeText(
          watchUrl.value
        );

      copyButton.textContent =
        'Copied';

      setTimeout(
        () => {
          copyButton.textContent =
            'Copy link';
        },

        1200
      );

    } catch {

      watchUrl.select();

      document.execCommand(
        'copy'
      );
    }
  }
);
`;

const WATCH_JS = `
const params =
  new URLSearchParams(
    location.search
  );

const token =
  params.get('v');

const loading =
  document.querySelector(
    '#loading'
  );

const player =
  document.querySelector(
    '#player'
  );

const errorState =
  document.querySelector(
    '#errorState'
  );

const errorText =
  document.querySelector(
    '#errorText'
  );

const retryButton =
  document.querySelector(
    '#retryButton'
  );

const video =
  document.querySelector(
    '#video'
  );

const videoTitle =
  document.querySelector(
    '#videoTitle'
  );

const playbackMessage =
  document.querySelector(
    '#playbackMessage'
  );

const qualityWrap =
  document.querySelector(
    '#qualityWrap'
  );

const qualitySelect =
  document.querySelector(
    '#qualitySelect'
  );

const audioWrap =
  document.querySelector(
    '#audioWrap'
  );

const audioSelect =
  document.querySelector(
    '#audioSelect'
  );

let config =
  null;

let currentIndex =
  0;

let urlVariant =
  0;

let switchingSource =
  false;

function showOnly(
  element
) {

  loading.classList.add(
    'hidden'
  );

  player.classList.add(
    'hidden'
  );

  errorState.classList.add(
    'hidden'
  );

  element.classList.remove(
    'hidden'
  );
}

function showError(
  message
) {

  errorText.textContent =
    message;

  showOnly(
    errorState
  );
}

function directDriveUrl(
  source,
  variant = 0
) {

  const params =
    new URLSearchParams();

  params.set(
    'id',
    source.fileId
  );

  params.set(
    'export',
    'download'
  );

  params.set(
    'confirm',
    't'
  );

  if (
    source.resourceKey
  ) {
    params.set(
      'resourcekey',
      source.resourceKey
    );
  }

  if (
    variant === 0
  ) {
    return (
      'https://drive.usercontent.google.com/download?' +
      params.toString()
    );
  }

  return (
    'https://drive.google.com/uc?' +
    params.toString()
  );
}

function buildQualityMenu() {

  qualitySelect
    .replaceChildren();

  config.sources.forEach(
    (
      source,
      index
    ) => {

      const option =
        document.createElement(
          'option'
        );

      option.value =
        String(index);

      option.textContent =
        source.quality;

      qualitySelect.append(
        option
      );
    }
  );

  qualityWrap.classList.toggle(
    'hidden',
    config.sources.length < 2
  );
}

function refreshAudioTracks() {

  const tracks =
    video.audioTracks;

  audioSelect
    .replaceChildren();

  if (
    !tracks ||
    tracks.length < 2
  ) {

    audioWrap.classList.add(
      'hidden'
    );

    return;
  }

  for (
    let i = 0;
    i < tracks.length;
    i += 1
  ) {

    const track =
      tracks[i];

    const option =
      document.createElement(
        'option'
      );

    option.value =
      String(i);

    option.textContent =
      track.label ||
      track.language ||
      (
        'Track ' +
        (i + 1)
      );

    option.selected =
      Boolean(
        track.enabled
      );

    audioSelect.append(
      option
    );
  }

  audioWrap.classList.remove(
    'hidden'
  );
}

function loadSource(
  index,
  preservePlayback = false
) {

  const source =
    config?.sources?.[
      index
    ];

  if (
    !source
  ) {
    return;
  }

  const oldTime =
    preservePlayback &&
    Number.isFinite(
      video.currentTime
    )

      ? video.currentTime

      : 0;

  const shouldResume =
    preservePlayback &&
    !video.paused;

  const oldVolume =
    video.volume;

  const oldMuted =
    video.muted;

  const oldRate =
    video.playbackRate ||
    1;

  currentIndex =
    index;

  qualitySelect.value =
    String(index);

  switchingSource =
    preservePlayback;

  const onMetadata =
    async () => {

      video.removeEventListener(
        'loadedmetadata',
        onMetadata
      );

      if (
        preservePlayback &&
        oldTime > 0 &&
        Number.isFinite(
          video.duration
        )
      ) {

        video.currentTime =
          Math.min(
            oldTime,

            Math.max(
              0,
              video.duration -
              0.25
            )
          );
      }

      video.volume =
        oldVolume;

      video.muted =
        oldMuted;

      video.playbackRate =
        oldRate;

      refreshAudioTracks();

      switchingSource =
        false;

      if (
        shouldResume
      ) {

        try {
          await video.play();
        } catch {}
      }
    };

  video.addEventListener(
    'loadedmetadata',
    onMetadata
  );

  video.src =
    directDriveUrl(
      source,
      urlVariant
    );

  video.load();

  playbackMessage.textContent =
    'Direct source: Google Drive → this browser. Render is not carrying the video bytes.';
}

qualitySelect.addEventListener(
  'change',

  () => {

    urlVariant =
      0;

    loadSource(
      Number(
        qualitySelect.value
      ),

      true
    );
  }
);

audioSelect.addEventListener(
  'change',

  () => {

    const tracks =
      video.audioTracks;

    if (
      !tracks
    ) {
      return;
    }

    const selected =
      Number(
        audioSelect.value
      );

    for (
      let i = 0;
      i < tracks.length;
      i += 1
    ) {

      tracks[i].enabled =
        i === selected;
    }
  }
);

video.addEventListener(
  'loadedmetadata',
  refreshAudioTracks
);

video.addEventListener(
  'error',

  () => {

    if (
      !config ||
      switchingSource
    ) {
      return;
    }

    if (
      urlVariant === 0
    ) {

      urlVariant =
        1;

      playbackMessage.textContent =
        'Trying Google Drive compatibility URL…';

      setTimeout(
        () => {
          loadSource(
            currentIndex,
            false
          );
        },

        150
      );

      return;
    }

    showError(
      'Google Drive refused direct playback. ' +
      'Make sure the file is set to “Anyone with the link”. ' +
      'Also use a browser-playable video such as MP4 with H.264 video and AAC audio. ' +
      'This player intentionally does not use the Google Drive preview iframe.'
    );
  }
);

retryButton.addEventListener(
  'click',

  () => {

    urlVariant =
      0;

    showOnly(
      player
    );

    loadSource(
      currentIndex,
      false
    );
  }
);

async function start() {

  if (
    !token
  ) {

    showError(
      'No watch token was supplied. Create a watch link from /admin.'
    );

    return;
  }

  try {

    const response =
      await fetch(
        '/api/video?v=' +
        encodeURIComponent(
          token
        ),

        {
          cache:
            'no-store'
        }
      );

    const data =
      await response
        .json()
        .catch(
          () => ({})
        );

    if (
      !response.ok
    ) {

      throw new Error(
        data.error ||
        'Could not load this video.'
      );
    }

    config =
      data;

    videoTitle.textContent =
      data.title;

    document.title =
      data.title +
      ' · Private Stream';

    buildQualityMenu();

    showOnly(
      player
    );

    loadSource(
      0,
      false
    );

  } catch (
    error
  ) {

    showError(
      error.message ||
      'Could not load this video.'
    );
  }
}

start();
`;

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host || 'localhost'}`
          );

        if (
          req.method ===
            'GET' &&
          url.pathname ===
            '/healthz'
        ) {

          return send(
            res,
            200,
            'ok',
            {
              'Content-Type':
                'text/plain; charset=utf-8'
            }
          );
        }

        if (
          req.method ===
            'GET' &&
          url.pathname ===
            '/admin'
        ) {

          return send(
            res,
            200,
            ADMIN_HTML,
            {
              'Content-Type':
                'text/html; charset=utf-8'
            }
          );
        }

        if (
          req.method ===
            'GET' &&
          (
            url.pathname ===
              '/' ||
            url.pathname ===
              '/watch'
          )
        ) {

          return send(
            res,
            200,
            WATCH_HTML,
            {
              'Content-Type':
                'text/html; charset=utf-8'
            }
          );
        }

        if (
          req.method ===
            'GET' &&
          url.pathname ===
            '/ui.css'
        ) {

          return send(
            res,
            200,
            CSS,
            {
              'Content-Type':
                'text/css; charset=utf-8',

              'Cache-Control':
                'public, max-age=3600'
            }
          );
        }

        if (
          req.method ===
            'GET' &&
          url.pathname ===
            '/admin.js'
        ) {

          return send(
            res,
            200,
            ADMIN_JS,
            {
              'Content-Type':
                'text/javascript; charset=utf-8',

              'Cache-Control':
                'public, max-age=3600'
            }
          );
        }

        if (
          req.method ===
            'GET' &&
          url.pathname ===
            '/watch.js'
        ) {

          return send(
            res,
            200,
            WATCH_JS,
            {
              'Content-Type':
                'text/javascript; charset=utf-8',

              'Cache-Control':
                'public, max-age=3600'
            }
          );
        }

        if (
          req.method ===
            'POST' &&
          url.pathname ===
            '/api/create'
        ) {

          if (
            !safeEqual(
              req.headers[
                'x-admin-password'
              ],

              ADMIN_PASSWORD
            )
          ) {

            return sendJson(
              res,
              401,
              {
                error:
                  'Incorrect admin password.'
              }
            );
          }

          const body =
            await readJson(
              req
            );

          const sources =
            parseSources(
              body
            );

          const title =
            normalizeTitle(
              body.title
            );

          const exp =
            expiryTimestamp(
              body.expiryDays
            );

          const token =
            encryptConfig(
              {
                v: 3,
                title,
                exp,
                sources
              }
            );

          return sendJson(
            res,
            201,
            {
              watchUrl:
                `${originFor(req)}/watch?v=${encodeURIComponent(token)}`,

              title,

              qualities:
                sources.map(
                  (
                    source
                  ) =>
                    source.quality
                )
            }
          );
        }

        if (
          req.method ===
            'GET' &&
          url.pathname ===
            '/api/video'
        ) {

          const token =
            url.searchParams.get(
              'v'
            );

          if (
            !token ||
            token.length >
              12000
          ) {

            return sendJson(
              res,
              400,
              {
                error:
                  'Missing or invalid watch token.'
              }
            );
          }

          try {

            const config =
              decryptConfig(
                token
              );

            return sendJson(
              res,
              200,
              config
            );

          } catch (
            error
          ) {

            return sendJson(
              res,
              error.status ||
                400,
              {
                error:
                  error.message
              }
            );
          }
        }

        return sendJson(
          res,
          404,
          {
            error:
              'Not found.'
          }
        );

      } catch (
        error
      ) {

        console.error(
          error
        );

        return sendJson(
          res,
          error.status ||
            500,
          {
            error:
              error.status
                ? error.message
                : 'Server error.'
          }
        );
      }
    }
  );

server.keepAliveTimeout =
  65_000;

server.headersTimeout =
  66_000;

server.requestTimeout =
  15_000;

server.listen(
  PORT,
  '0.0.0.0',

  () => {

    console.log(
      `Private stream listening on port ${PORT}`
    );
  }
);
