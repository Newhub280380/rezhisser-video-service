# rezhisser-video-service — «Режиссёр»

[![CI](https://github.com/Newhub280380/rezhisser-video-service/actions/workflows/ci.yml/badge.svg)](https://github.com/Newhub280380/rezhisser-video-service/actions/workflows/ci.yml)

Node.js service (built-in modules plus `pg` for PostgreSQL) with a Russian
web app for planning video ads and a commercial **Studio** (`/studio`):
accounts, subscriptions, payments, Seedance 2.5 generation and a content
library for the CIS and China. You write an ad brief in plain words. A
**rule-based director** turns it into a creative brief, a hook and call to
action, a shot list and a model prompt, then picks a video model from a
server-side allowlist and explains why.

> **Кратко по-русски.** Откройте адрес сервиса — там приложение «Режиссёр».
> Раскадровка строится **по правилам и шаблонам**, это не нейросеть. Видео,
> оплата, почта и автоматизация браузера ходят во **внешние API**, когда в
> окружении заданы ключи (`npm start` читает `.env`). Если ключа нет, API
> отвечает ошибкой и **перечисляет имена переменных**. Фейковый ролик, фейковый
> платёж и симуляция браузера не возвращаются. Платная генерация через
> Replicate по-прежнему закрыта, пока не включены все предохранители
> (см. [пошаговую инструкцию для Render](docs/DEPLOY_RENDER.md)).

## What you get

| Part | State |
| --- | --- |
| Web app at `/` and `/app/` (Russian, responsive, accessible) | ✅ Works without any external account. |
| Rule-based director (`rule-based-v1`) | ✅ Deterministic, free, offline. Labelled as "по правилам, без ИИ". |
| Recipe library (`recipes/`, 212 workflows) | ✅ `POST /api/director/recipes` picks a recipe and returns a dry-run plan. Live tool calls stay off until a per-job budget is set. |
| Model router (auto or manual choice with a rationale) | ✅ Demo profiles by default. Paid profiles only if the operator configures them. |
| Video without provider keys | ✅ Refused. `POST /api/jobs` returns `provider_not_configured` and the missing variable names. Nothing is stored as a successful render. |
| Paid render via Replicate | 🔒 Real HTTP client. Locked until `VIDEO_PROVIDER=replicate`, `REPLICATE_API_TOKEN`, a model profile, beta access and a budget are set. Needs a session, a quote and confirmation. |
| Optional LLM advisor | ⛔ Not implemented. `DIRECTOR_ADVISOR` accepts only `none`; any other value stops startup. |
| Studio at `/studio` (RU / 中文): register, login, password reset, dashboard, pricing, library, remix, video history | ✅ See [Production stack](#production-stack). |
| Browser task dashboard at `/automation`: user-owned URL, instruction, region and enabled state | ✅ Tasks, «Запустить» button, run status, log and history. |
| Owl Browser execution (`src/automation/`) | ✅ Real HTTP client when `OWL_BROWSER_URL` + `OWL_BROWSER_TOKEN` are set (the AI provider is configured on the Owl Browser server). Otherwise a run is **refused** with those variable names. |
| Desktop app (Electron, `desktop/`) | ✅ Windows/macOS/Linux installer. Opens the cloud service or runs the bundled server locally. See [Desktop app](#desktop-app). |
| Accounts (email + scrypt password, JWT), PostgreSQL | ✅ In-memory/JSON store when `DATABASE_URL` is not set (development only). |
| Payments: YooKassa (primary) + Stripe (fallback), RUB/KZT/USD/CNY | ✅ Real HTTP clients when the shop/secret keys are set. Without them checkout returns `payment_provider_unavailable` and the missing names. |
| Real video via ByteDance Seedance 2.5 (ModelArk) + S3/Backblaze storage | ✅ Real HTTP clients when `SEEDANCE_API_KEY`/`SEEDANCE_MODEL` and `S3_*` are set. Without the Seedance key, account jobs return `generation_unavailable`. |

> **Honest limitation:** no real Replicate model, price or input schema has
> been verified in this repository (replicate.com could not be reached from
> the build environment). The service therefore ships **only demo model
> profiles**. Real models must be added by the operator after checking the
> model's official API page and pricing (see
> [Model profiles](#model-profiles-video_model_profiles_json)).

## Screenshots (demo mode, local run)

| Landing and brief | Director plan (full page) | Demo result |
| --- | --- | --- |
| ![Landing](docs/screenshots/desktop-1-landing.jpg) | ![Plan](docs/screenshots/desktop-2-plan.jpg) | ![Demo job](docs/screenshots/desktop-3-job.jpg) |

Mobile: [plan](docs/screenshots/mobile-2-plan.jpg) · Beta login: [dialog](docs/screenshots/desktop-4-login.jpg)

## Local setup

Requires **Node.js 22+** (the test runner uses glob patterns, Node 21+; CI
runs 22 and 24).

```bash
npm ci             # install dependencies (only `pg` is required)
npm start          # http://0.0.0.0:3000 — open http://localhost:3000/
npm test           # node:test, no network, no keys
npm run lint       # parses every JS file (node --check), no linter deps
npm run smoke      # starts the service and checks GET /api/health
npm run check      # lint + test + smoke (what CI runs)
```

The service starts **without any keys** (`npm start`): no `DATABASE_URL` →
in-memory store, no video API → requests are refused and name the missing
variables, no Owl Browser → automation runs are refused, no payment or mail
keys → those endpoints say which variables are empty. `npm start` loads `.env`
when the file exists and does not override variables already set in the
environment.

Desktop app (Electron): `cd desktop && npm install && npm start` — see
[Desktop app](#desktop-app).

### Which variables to set (names only, no values)

Full template with comments: [`.env.example`](.env.example) — copy it to `.env`
and fill it in, or paste the same names into Railway / Render → Variables.
CI never needs any of them.

| Purpose | Variable names (without values) |
| --- | --- |
| Core / deploy | `NODE_ENV`, `PORT`, `HOST`, `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| PostgreSQL | `DATABASE_URL`, `DATABASE_SSL`, `DB_AUTO_MIGRATE` |
| Accounts (JWT) | `JWT_SECRET` (≥ 32 chars), `JWT_TTL_SECONDS` |
| Video generation (Seedance 2.5 / ModelArk) | `SEEDANCE_API_KEY`, `SEEDANCE_MODEL`, `SEEDANCE_API_BASE_URL`, `SEEDANCE_RESOLUTION`, `SEEDANCE_GENERATE_AUDIO`, `SEEDANCE_IMAGE_ROLE`, `SEEDANCE_EXTRA_INPUT_JSON`, `SEEDANCE_POLL_INTERVAL_MS`, `SEEDANCE_MAX_WAIT_MS`, `SEEDANCE_REQUEST_TIMEOUT_MS`, `SEEDANCE_MAX_CONCURRENT` |
| Video storage (S3 / Backblaze B2 / MinIO) | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `VIDEO_RETENTION_DAYS`, `VIDEO_URL_TTL_SECONDS` |
| Payments | `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, `YOOKASSA_CURRENCIES`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CURRENCIES`, `PRICES_JSON`, `PRO_VIDEOS_PER_PERIOD`, `STUDIO_VIDEOS_PER_PERIOD` |
| E-mail (password reset) | `RESEND_API_KEY`, `MAIL_FROM` |
| Legacy Replicate beta (optional) | `REPLICATE_API_TOKEN`, `VIDEO_PROVIDER`, `VIDEO_MODEL_PROFILES_JSON`, `PAID_GENERATION_ENABLED`, `BETA_ACCESS_KEY`, `PAID_DAILY_BUDGET_USD`, `PAID_DAILY_JOB_LIMIT`, `PAID_TOTAL_JOB_LIMIT` |
| Recipe runner (optional live calls) | `RECIPE_DRY_RUN`, `RECIPE_JOB_BUDGET_USD`, `RECIPE_JOB_BUDGET_CREDITS`, `RECIPE_STEP_HOLD_USD` |
| Owl Browser automation (optional) | `OWL_BROWSER_URL`, `OWL_BROWSER_TOKEN`, `OWL_BROWSER_API_PREFIX`, `OWL_BROWSER_ALLOW_HTTP`, `OWL_BROWSER_PROXIES_JSON`, `OWL_BROWSER_MAX_CONCURRENT` |
| Desktop app (Electron only) | `REZHISSER_URL`, `REZHISSER_START_PATH` |

## How it works

```
Brief (browser) ──► POST /api/director/plan ──► rule-based plan + model choice (free, local)
                    POST /api/jobs {brief}   ──► real provider, or 503 naming missing keys

Private beta only (paid; locked by default):
  POST /api/session {accessKey} ──► HttpOnly session cookie + CSRF token
  POST /api/quotes  {brief}     ──► operator estimate, valid for 10 min, bound to session+brief+model+image
  POST /api/jobs    {brief, quoteId, confirmPaid:true, idempotencyKey}
                                ──► spend limits checked ──► Replicate prediction
```

### The director (rule-based, not AI)

`src/director.js` validates the brief (product, offer, audience, goal,
platform, aspect ratio, duration, mood, voice, CTA, notes) and builds a plan
from fixed tables and templates:

- a hook and CTA picked from templates per goal (the user's own CTA wins), and a creative brief (objective, format, audience, key message, tone and voice, mandatory elements);
- a visual direction (mood, palette, light, camera, pacing, typography) from the mood preset;
- a shot list with visuals, camera, on-screen text and audio per shot, whose timings cover the full duration (5/10/15/30 s);
- a model prompt and negative prompt (English template wording around the user's text), plus style tags for routing.

The same brief always gives the same plan. The UI and the API label it
`engine: "rule-based-v1"` / «Правила и шаблоны (без ИИ, бесплатно)».

**LLM advisor.** The config setting `DIRECTOR_ADVISOR` is reserved for a
future optional, server-side LLM that could suggest wording. Only `none` is
supported now, and any other value makes the server refuse to start, so a
typo can never silently enable a paid API. Adding one would need its own
provider credentials, a spend cap, tests, and a UI label showing when it was
used.

### Библиотека рецептов

Режиссёр сам выбирает рецепт и собирает план. Клиент не проходит шаги руками:
один запрос `POST /api/director/recipes` с текстом (по-русски) и списком
файлов (`{ "request": "...", "files": [{ "name": "face.jpg", "kind": "face" }] }`).
Тот же текст можно передать полем `request` в `POST /api/director/plan`.

Сервис читает `recipes/recipes/*.yaml` (212 рецептов: намерение, `use_when`,
входы, шаги с дословным промптом). По тексту запроса ставятся теги намерения,
рецепт ранжируется по совпадению тегов и формулировки `use_when`, полноте
промпта и уверенности. В ответе — выбранный рецепт, причина, запасные варианты
и вопросы, если не хватает файла. Промпт не переписывается: файл клиента
подставляется только в уже существующий слот (`Image 1`, `@Image1`, `@Image 1`,
`[product]` и похожие). Кадры передаются по полю шага: предыдущий результат или
реальный последний кадр предыдущего ролика (локальный ffmpeg, фиксированные
аргументы, без оболочки).

По умолчанию это сухой прогон: в плане уже разрешённые промпты и шаги, но
платные API не вызываются. Чтобы разрешить живые вызовы, нужно одновременно
`RECIPE_DRY_RUN=false` и явный потолок на задачу — `RECIPE_JOB_BUDGET_USD`
и/или `RECIPE_JOB_BUDGET_CREDITS` (те же поля можно передать в запросе, они не
поднимут серверный потолок). В запросе дополнительно `"dryRun": false`. Без
потолка живой запуск отвечает `budget_required` и ничего не вызывает. Каждый
платный шаг резервирует локальный холд `RECIPE_STEP_HOLD_USD` (по умолчанию 1) —
это предохранитель, не цена провайдера. Секреты в репозиторий не кладутся.

Новый рецепт: положите исходные разборы `NNN_slug.md` в каталог и выполните
`python3 recipes/build.py <каталог-md>`. Скрипт перезапишет `recipes/recipes/*.yaml`,
`catalog.json`, `router.md`, `tools.md` и `duplicates.md`.

### Model routing

`src/models.js` holds the allowlist. Users never type a model id, URL or token:

- **Auto**: considers only profiles of the requested tier (`demo` or `paid`).
  It rejects incompatible ones (text-to-video when a photo was uploaded,
  image-to-video without a photo, unsupported aspect ratio), then scores the
  rest by style match and duration, then by the operator's estimate. The
  response lists the rationale and the rejected models with reasons.
- **Manual**: the chosen profile is validated and is **never replaced**. If
  it doesn't fit, the user gets an error such as `image_required`.
- There is **no fallback** from demo to paid or from one paid model to
  another. The model that is billed is exactly the one shown in the quote.

Demo profiles (`demo-cinematic`, `demo-social`, `demo-product-photo`) run on
the local simulation and cost nothing.

### Model profiles (`VIDEO_MODEL_PROFILES_JSON`)

Operator-only JSON array (1–20 items). Every field is validated at startup,
and a bad profile stops the server. **The names below are placeholders, not
recommendations.** Before adding a real model, open its page on Replicate,
check the **API** tab (input field names and types), **run it once**, note
the real price, and record the date.

```json
[
  {
    "id": "t2v-main",
    "label": "Текст → видео (основная)",
    "description": "Для сюжетов без фото продукта.",
    "kind": "text-to-video",
    "replicateModel": "OWNER/MODEL",
    "input": { "prompt": "prompt", "aspectRatio": "aspect_ratio", "duration": "duration" },
    "fixedInput": {},
    "aspectRatios": ["9:16", "16:9", "1:1"],
    "aspectRatioValues": { "9:16": "9:16" },
    "durations": [5, 10],
    "strengths": ["cinematic", "people"],
    "estimatedCostUsd": { "5": 0.5, "10": 1.0 },
    "priceVerifiedAt": "YYYY-MM-DD",
    "priceSource": "https://replicate.com/OWNER/MODEL (pricing section)",
    "schemaVerifiedAt": "YYYY-MM-DD"
  },
  {
    "id": "i2v-product",
    "kind": "image-to-video",
    "replicateModel": "OWNER/MODEL:VERSION",
    "input": { "prompt": "prompt", "image": "image" },
    "durations": [5],
    "estimatedCostUsd": 0.4
  }
]
```

| Field | Meaning |
| --- | --- |
| `kind` | `text-to-video` (must not map `image`) or `image-to-video` (must map `image`; the user must upload a photo). |
| `replicateModel` | `owner/model` → `POST /models/{owner}/{model}/predictions`; `owner/model:version` → `POST /predictions` with `version`. |
| `input` | Maps the director's values onto the model's **own** input field names: `prompt` (required), `negativePrompt`, `aspectRatio`, `duration`, `image`. Unmapped values are not sent. |
| `fixedInput` | Constant scalar inputs (e.g. resolution). |
| `aspectRatioValues` | Optional translation when a model uses different values (e.g. `"16:9": "landscape"`). |
| `durations` | Clip lengths the model can produce. Longer ads get the nearest shorter clip, and the UI says so. |
| `estimatedCostUsd` | **Operator's estimate** per clip (number, or object keyed by duration). A paid profile without an estimate can't be quoted. |

The uploaded photo (PNG/JPEG/WebP, checked by magic bytes, default limit
256 KB, compressed in the browser) is sent to the model as a `data:` URL.
Check the model's documentation for the image input formats and size limits
it accepts.

Legacy setup: if `VIDEO_MODEL_PROFILES_JSON` is empty, `REPLICATE_MODEL`
becomes the single `replicate-default` text-to-video profile (input: `prompt`
plus `REPLICATE_EXTRA_INPUT_JSON`). Its estimate comes from
`REPLICATE_ESTIMATED_COST_USD`.

## Production stack

The commercial product runs **next to** the legacy demo / private-beta API
(which is unchanged). Deployment: [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md)
(Railway + PostgreSQL + cron + Backblaze B2). All variables: [`.env.example`](.env.example).

| Part | Where |
| --- | --- |
| DB schema (users, video_jobs, payments, usage_events, projects, library_items, password_resets) | `src/db/schema.sql`, `src/db/postgres.js`, `src/db/memory.js`; `npm run db:migrate` |
| Auth: scrypt hashes, HS256 JWT bound to a token version (password reset revokes old tokens) | `src/accounts.js` |
| Billing: products, tiers, credits, checkout, webhooks, refunds | `src/billing/*` |
| Seedance 2.5 provider + job pipeline (poll, store, refund on failure, resume after restart) | `src/providers/seedance.js`, `src/pipeline.js` |
| S3 client (SigV4, presigned downloads) and 30-day cleanup cron | `src/storage/s3.js`, `src/cron/cleanup.js` (`npm run cron:cleanup`) |
| Content library: 53 CIS items (RU, KZ, TJ, UZ, KG) + 30 Chinese (中文) items | `src/library/sng.json`, `src/library/china.json` |

**Plans.** Free — demo only. Pro — $5 / 30 days, 50 videos. Studio — $20 /
30 days, unlimited. Credits (10 / 50 videos) are pay-as-you-go and are used
after the plan allowance. Prices for RUB/KZT/CNY are in `src/billing/plans.js`
and can be overridden with `PRICES_JSON`. A failed generation returns the
video/credit automatically.

**Payments.** RUB and KZT go to YooKassa, USD and CNY to Stripe (configurable).
YooKassa notifications are unsigned, so the server re-reads each payment from
the YooKassa API and checks amount and currency before granting anything.
Stripe events are verified with `STRIPE_WEBHOOK_SECRET`. Entitlements are
granted once per payment (guarded state transition) and revoked on full refunds.

**Content library.** Every card is a ready template: Russian/Chinese prompt,
an English model prompt with `{product}`, `{brand}`, `{photo}` placeholders,
negative prompt, format, duration and a shot list (and dialogue for memes,
e.g. «Два косметолога» lip-sync meme, expectation-vs-reality, «это не купишь
за деньги», 直播带货 live-commerce hooks). Memes use original dialogue
"in the style of" a comedy, never copyrighted film footage or audio.

### Account API

Account endpoints take the JWT in the `Authorization` header (`Bearer <token>`, same origin only).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/plans` | Tiers, products with prices, payment providers. |
| `POST` | `/api/auth/register` | `{ email, password, locale? }` → `{ token, expiresAt, user, subscription }`. |
| `POST` | `/api/auth/login` | `{ email, password }` → JWT. Rate limited. |
| `POST` | `/api/auth/forgot-password` / `/api/auth/reset-password` | Email link (needs `PUBLIC_ORIGIN` + Resend) / `{ token, password }`. |
| `GET` | `/api/user/profile` | User, subscription (tier, limits, credits) and usage. |
| `GET/POST` | `/api/automation/tasks` (with bearer token) | List or create up to 100 site tasks for the signed-in user. |
| `PUT/DELETE` | `/api/automation/tasks/:id` (with bearer token) | Edit or delete an owned site task. |
| `POST` | `/api/automation/tasks/:id/runs` (with bearer token) | Start a run of an enabled owned task → `202 { run }` (`queued`). One active run per task, at most 3 per user. |
| `GET` | `/api/automation/tasks/:id/runs` | Task run history as `{ runs }` (newest first, last 50 kept per task). |
| `GET` | `/api/automation/runs` | Account run history as `{ runs, executor: { name, simulated } }`. |
| `GET` | `/api/automation/runs/:id` | One run: `status` (`queued`/`running`/`succeeded`/`failed`), `log`, `summary`, `error`. |
| `POST` | `/api/payment/checkout` | `{ product: pro\|studio\|credits_10\|credits_50, currency, provider? }` → `{ payment, confirmationUrl }`. |
| `GET` | `/api/payment/history` | Payments and usage events. |
| `POST` | `/api/payment/webhook/yookassa`, `/api/payment/webhook/stripe` | Provider webhooks. |
| `POST` | `/api/library/search` | `{ query?, region?, country?, language?, category?, type?, trend?, limit?, offset? }` → `{ total, items, facets }`. Public. |
| `GET` | `/api/library/:id` | Full prompt + template. Public. |
| `GET/POST` | `/api/projects`, `DELETE /api/projects/:id` | Saved projects and favorite prompts. |
| `POST` | `/api/jobs` (with bearer token) | `{ brief }` or `{ prompt }` or `{ libraryItemId, fields? }`, plus `image?`, `aspect?`, `duration?`, `demo?` → Seedance job (uses plan/credits; `402` when nothing is left). |
| `GET` | `/api/jobs`, `/api/jobs/:id` (with bearer token) | Own jobs with signed video/download URLs. |

Without a bearer token `/api/jobs` keeps the legacy behaviour described below.

## Safety model for paid generation

Paid generation is available **only if all** of these are true (see
`GET /api/config` → `paid.reasons` for what is missing):

1. `VIDEO_PROVIDER=replicate` with a valid `REPLICATE_API_TOKEN` and at least one paid profile;
2. `PAID_GENERATION_ENABLED=true`;
3. `BETA_ACCESS_KEY` is set (≥ 24 characters, random);
4. `PAID_DAILY_BUDGET_USD` > 0 (plus `PAID_DAILY_JOB_LIMIT` / `PAID_TOTAL_JOB_LIMIT`);
5. at least one paid profile has `estimatedCostUsd`.

Even then, each paid job requires all of the following:

- **Private-beta session.** `POST /api/session` with the access key, from the
  service's own page (same `Origin`), rate limited per IP and globally. The
  server compares the key with HMAC and `timingSafeEqual` and creates a random
  in-memory session in an `HttpOnly; SameSite=Strict` cookie (`Secure` behind
  HTTPS). The key is never stored in the browser, the URL or the page.
- **CSRF protection.** Every state-changing session request needs the
  `X-CSRF-Token` header and `Origin` equal to the service's own origin. No
  cross-origin request can use the session: CORS never sends
  `Access-Control-Allow-Credentials`.
- **Server-issued quote.** It is bound to the session, profile, brief hash,
  image hash and clip length. It is valid for `QUOTE_TTL_MS` and single-use.
  The user must tick the checkbox and press the confirm button
  (`confirmPaid: true`). Price, cost, model and input fields sent by the
  client are rejected (`field_not_allowed`).
- **Idempotency key.** Repeating it returns the same job (`200
  idempotentReplay`) instead of starting a second prediction. The browser
  keeps the key on retry after a timeout.
- **Server-side limits, checked synchronously before the provider call:**
  the daily USD budget, daily job count, total job count, and
  `REPLICATE_MAX_CONCURRENT` (extra jobs get `503 provider_busy`). The
  estimate is counted when the job starts, **even if it later fails**.
- **Public API is demo-only.** The legacy prompt API (`POST /api/jobs
  {prompt}`) can never start a paid prediction (`401`). Paid jobs, briefs and
  plans are hidden from anonymous `GET /api/jobs`.

What this does **not** give you, read carefully:

- It is **not a provider-side spend cap**. The ledger counts the operator's
  *estimates*, not Replicate invoices. Also set a low limit in your Replicate
  billing settings, and don't rely on any vendor cap unless the vendor
  documents it for your account.
- **A timeout, cancel, error or restart may NOT reverse charges.** Replicate
  may bill for a prediction that already started. Jobs interrupted by a
  restart are marked `provider_interrupted` and are **not** retried.
- Sessions and quotes live in memory. The ledger and jobs are files in
  `DATA_DIR`. On the Render free plan the disk is **ephemeral**, so a
  restart, deploy or idle spin-down resets the daily/total counters and the
  job history. Use a persistent disk if you rely on these counters. Run
  **one instance only**, because nothing is shared between instances.
- One shared key is **not** a user-account system. Everyone with the key has
  the same rights and there is no per-user attribution.

**Before selling to the public** you still need: real user accounts
(registration, password reset or OAuth, per-user sessions), payments
(e.g. Stripe) with per-user prepaid credits deducted atomically in a database,
per-user quotas, persistent storage (a database plus object storage for
outputs, because provider output URLs may be temporary), provider webhooks with
signature checks, reconciliation against real provider invoices, terms of
service and a content moderation policy, monitoring and alerts, and a legal
review for your jurisdiction.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Bind address (Render sets `PORT`). |
| `ALLOWED_ORIGINS` | `https://business-41.pazi.dev` + local dev origins | CORS allowlist for **other** sites (demo API only, no credentials). The service's own page doesn't need to be listed. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `30` / `60000` | Per-IP limit for `/api/*`. |
| `DATA_DIR` | `<cwd>/data` | Job files and `spend-ledger.state`. |
| `SIMULATION_DURATION_MS` | `3000` | Demo job duration. |
| `VIDEO_PROVIDER` | `local-simulation` | `local-simulation` or `replicate`. |
| `DIRECTOR_ADVISOR` | `none` | Only `none` is supported; any other value fails startup. |
| `VIDEO_MODEL_PROFILES_JSON` | – | Paid model allowlist (see above). Used only when `VIDEO_PROVIDER=replicate`. |
| `PAID_GENERATION_ENABLED` | `false` | Must be exactly `true` to unlock paid jobs. |
| `BETA_ACCESS_KEY` | – | **Secret.** ≥ 24 characters. Set it only in the Render dashboard. |
| `PAID_DAILY_BUDGET_USD` | `0` (locked) | Daily limit on the sum of estimates (UTC day). |
| `PAID_DAILY_JOB_LIMIT` | `3` | Paid jobs per UTC day (1–100). |
| `PAID_TOTAL_JOB_LIMIT` | `20` | Paid jobs in total, for as long as the ledger file survives (1–10000). |
| `QUOTE_TTL_MS` | `600000` | Quote lifetime (1–60 min). |
| `SESSION_TTL_MS` | `28800000` | Beta session lifetime (5 min – 24 h). |
| `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` | `5` / `900000` | Login attempts per IP (global limit is 10×). |
| `IMAGE_MAX_BYTES` | `262144` | Max decoded upload size (16 KB – 5 MB). |
| `PUBLIC_ORIGIN` | – | Optional. Explicit origin (e.g. `https://rezhisser-video-service.onrender.com`, no path) used for the same-origin check and the `Secure` cookie flag; an invalid value stops startup. Otherwise it is derived from `Host` and `X-Forwarded-Proto`. |
| `REPLICATE_API_TOKEN` | – | **Secret.** Server-side only. |
| `REPLICATE_MODEL` | – | Legacy single model (`owner/model[:version]`). |
| `REPLICATE_ESTIMATED_COST_USD` | – | Estimate for the legacy profile. |
| `REPLICATE_EXTRA_INPUT_JSON` | – | Fixed inputs for the legacy profile. |
| `REPLICATE_API_BASE_URL` | `https://api.replicate.com/v1` | Must be `https`. |
| `REPLICATE_POLL_INTERVAL_MS` | `5000` | 1000–60000. |
| `REPLICATE_MAX_WAIT_MS` | `600000` | 10 s – 30 min. On timeout the prediction is cancelled (best effort; may still be billed). |
| `REPLICATE_REQUEST_TIMEOUT_MS` | `30000` | Per HTTP request. |
| `REPLICATE_MAX_CONCURRENT` | `1` | Concurrent predictions (1–10). |
| `OWL_BROWSER_URL` / `OWL_BROWSER_TOKEN` | – | Self-hosted Owl Browser server and its **secret** token. Set both for real automation runs; without them runs are simulated. |
| `OWL_BROWSER_API_PREFIX` | `/api` | Path prefix of the Owl Browser REST API. |
| `OWL_BROWSER_ALLOW_HTTP` | `false` | `true` allows an `http://` Owl URL (private network only). |
| `OWL_BROWSER_PROXIES_JSON` | – | Region → proxy URL, e.g. `{"EU":"socks5://eu-proxy.example:1080"}`. |
| `OWL_BROWSER_MAX_CONCURRENT` | `2` | Runs executed at once (1–20). |
| `OWL_BROWSER_POLL_INTERVAL_MS` / `OWL_BROWSER_MAX_WAIT_MS` / `OWL_BROWSER_REQUEST_TIMEOUT_MS` | `2000` / `600000` / `30000` | Job polling, max run time, per-request timeout. |

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/`, `/app/` | Web app (strict CSP, no inline scripts, no third-party origins). |
| `GET` | `/api/health` | `{ status, uptimeSeconds, timestamp, videoProvider, realVideoGeneration, paidGenerationEnabled }`. Render health check. |
| `GET` | `/api/config` | Brief options, public model profiles, director info, `paid: {available, reasons}`, auth state. Contains no secrets. |
| `POST` | `/api/director/plan` | `{ brief, modelId?, tier?, hasImage? }` → `{ plan, selection }`. Free. |
| `GET/POST/DELETE` | `/api/session` | Beta login/logout (same-origin only; DELETE needs CSRF). |
| `POST` | `/api/quotes` | Beta + CSRF. `{ brief, modelId?, image? }` → `{ quote, plan, selection, spend }`. |
| `POST` | `/api/jobs` | `{ brief, modelId?, image? }` → demo job. Paid: add `tier:"paid"`, `quoteId`, `confirmPaid:true`, `idempotencyKey`. Legacy `{ prompt, provider? }` still works for the local simulation. |
| `GET` | `/api/jobs`, `/api/jobs/:id` | Anonymous users see only demo jobs; paid jobs need a session. |

Every job says explicitly what it is: `provider`, `simulated`,
`realVideoGeneration`, `paid`, `modelId`. A demo job always ends with
`result: { simulated: true, videoUrl: null }`. The UI shows a player and a
download link **only** for a real `https` video URL.

## Film pipeline (`/film`)

Reels from your own photos, template reels and long films, assembled into one
MP4. Off by default (`FILM_ENABLED=true` turns it on; while it is off,
`/api/film/*` does not exist).

```
plan  ->  render every scene in parallel  ->  upscale  ->  assemble MP4
```

### Works with nothing but ffmpeg

With `FILM_ENABLED=true` and `ffmpeg`/`ffprobe` installed, these need no key,
no GPU, no network service and no paid provider:

- **Reel from your photos, one button** (`photoReel`). Each photo becomes a
  scene. The built-in studio (`src/film/studio.js`) moves a virtual camera over
  the photo and renders straight at the final size (4K by default), so there is
  no upscale step. The subject is never redrawn: its pixels are only moved,
  scaled and lit, so a label, a logo or a face cannot drift. With a cut-out the
  subject floats over a studio backdrop with a soft shadow; without one the
  whole photo is used. This is camera motion over a still image — people do not
  move and nothing new is drawn; such a job reports `infra.provider: "studio"`.
- **Photo clean-up.** Denoise, sharpen, Lanczos resize, transparency flattened,
  metadata stripped. It cleans a photo up; it does not invent detail.
- **Product shots** (`POST /api/film/inpaint`): `background` (keep the product,
  replace what is around it), `insert` (place a product into the marked area),
  `erase` (fill a small marked area from its surroundings). Compositing only;
  the result is also registered as a prepared photo, ready for a reel.
- **Long-film storyboard** when no language model is connected, and as the
  fallback when SGLang does not answer (`engine: "storyboard"`). It lays your
  own words over a fixed editorial rhythm; it does not write a story.
- **Captions** (one line per caption, spread over the film), burned-in
  subtitles, music with fades and loudness normalisation, voiceover ducking.

Two optional local tools are picked up automatically when installed:
`rembg` (background removal; without it reels use the whole photo and
`background` is unavailable) and `yt-dlp` (audio from a video link).

`FILM_STUDIO_FREE=true` makes studio reels not consume account generations
(they cost nothing to render). Off by default.

### Upgrades that need something you provide

| Stage | What runs | Needs |
| --- | --- | --- |
| Plan, long film | An SGLang server, asked for `shot_plan.json` with a JSON schema; validated again here, repaired once. If it fails, the built-in storyboard takes over and the job says so. | `SGLANG_BASE_URL`, `SGLANG_MODEL` |
| Render from text | A generative video model. In order of preference: an existing Ray cluster, a cluster rented with SkyPilot, or this machine (scenes in parallel through Seedance). Without any of them, films are made from photos only. | `RAY_DASHBOARD_URL`, or `SKYPILOT_*`, or `SEEDANCE_*` |
| Upscale of model clips | A command you configure, run once per clip. Without it clips are resized with ffmpeg (Lanczos) and the job says so. Studio clips skip this stage. | `RECAVSR_COMMAND` |
| Generative edit by mask | `replace`, `remove`, `extend`: a model draws inside the mask. | `INPAINT_BASE_URL`, `INPAINT_MODEL` |

With photos and a video model on this host, `photoMode` chooses: `studio`
(default for `photoReel`) or `ai` (the model animates the photos as first
frames). On a Ray/SkyPilot deployment photos are always rendered by the studio.

### What has and has not been run for real

- **Run for real** (tests execute them when the tools are installed): the ffmpeg
  assembly, photo clean-up, the studio renderer in every camera move, the three
  built-in product-shot modes, and one HTTP test that goes from uploaded photos
  to a downloaded 1080×1920 MP4 with no fakes for the film stages. `rembg`
  background removal is tested for real only where its model is already
  downloaded. Audio extraction with `yt-dlp` was run by hand against YouTube,
  not in the test suite (tests never use the network).
- **Tested against fakes only:** SGLang, Ray, SkyPilot, the upscaler command and
  the generative inpainting service. Their requests follow the public
  documentation, but none has been run against a live server from this
  repository. Try each on a small job before relying on it.
- **Not included:** a generative video model. On Ray or SkyPilot the driver
  (`python/rezhisser_film/film_job.py`) sends every scene to a render service
  you operate (`FILM_RENDER_ENDPOINT`, contract in the file header). ReCaVSR
  and a generative inpainting model are not included either; each is an
  adapter to a command or service you provide.
- The `erase` mode fills from neighbouring pixels: fine for a small mark on a
  plain surface, visible on a textured one.

### Templates

Six presets (`GET /api/film/templates`). The buyer fills in niche, subject,
location and style; the shots, their length, the camera move (Pan Left), 24 fps,
9:16 and the look are fixed, and any other parameter sent by a client is
ignored and listed in `ignoredFields`. The request is therefore identical on
every run. The video model is still generative: runs are consistent in framing
and pacing, not pixel-identical.

### Renting GPUs with SkyPilot

Requires the `sky` CLI and cloud credentials on the machine running this
service. `SKYPILOT_DRY_RUN=true` (the default) never starts a cluster.

- The cheapest offer is taken from the CLI price listing, limited to
  `FILM_ACCELERATORS`, `SKYPILOT_CLOUDS` and `SKYPILOT_MAX_HOURLY_USD`. If
  prices cannot be read, or no offer fits, nothing is launched. Without a price
  ceiling nothing is launched either.
- The cluster is destroyed three ways: `sky launch --down`, an explicit
  `sky down` when the job ends (success, failure or cancel), and a lease record
  that is torn down at the next service start if the process died.
- If teardown fails, the job is marked `needs_attention` and its error contains
  the exact `sky down <cluster>` command to run by hand.
- `costEstimateUsd` is rented time × listed hourly price — an estimate, not
  the provider's invoice.

### Billing and recovery

One film reserves one generation from the account (studio reels do not when
`FILM_STUDIO_FREE=true`). A failed or cancelled film returns it. Films interrupted by a restart are marked failed and refunded; they
are not resumed. Finished films are removed after `FILM_RETENTION_DAYS` by
`src/cron/cleanup.js`.

### API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/film` | The page: templates, own photos, long film, music, object replacement, jobs. |
| `GET` | `/api/film/capabilities` | What works now, which engine does it, and which variables an upgrade needs (names only). |
| `GET` | `/api/film/templates` | The presets and their locked parameters. |
| `POST` | `/api/film/presets` | `{ templateId, metadata }` → the fixed shot plan. Free; no provider is called. |
| `POST` | `/api/film/jobs` | Account. `{ photoReel: true, photoIds, aspect?, secondsPerPhoto?, backdrop?, cutout? }`, or `{ templateId, metadata }`, or `{ brief, scenes, durationSeconds, aspect }`. Optional for all: `photoIds`, `photoMode` (`studio` / `ai`), `captions`, `audio`, `voice` (`{ trackId }` or `{ downloadId }`). |
| `GET` | `/api/film/jobs` | Account. The caller's last 50 films. |
| `GET` | `/api/film/jobs/:id` | Account. Job, plan and per-scene status. |
| `GET` | `/api/film/jobs/:id/video` | Account. The MP4 (redirect to a signed link, or the file itself). |
| `POST` | `/api/film/jobs/:id/cancel` | Account. Stops the job, destroys its cluster, refunds it. |
| `POST` | `/api/film/photos/prepare` | Account. Up to 6 photos per request → ids, `cutout` (subject separated or not) and a per-step report. |
| `GET` | `/api/film/audio/library` | Account. Tracks from `FILM_MUSIC_DIR`. |
| `POST` | `/api/film/audio/link` | Account. Extracts the audio of a video page (allowed hosts only) → `downloadId`. |
| `POST` | `/api/film/inpaint` | Account. `{ image, mode, mask?, reference?, background?, backdrop?, prompt? }`. Built-in modes return `{ image (data URL), photoId }`; generative modes return `{ imageUrl }`. |

Use only music you have the rights to; extracting audio from a video page does
not grant any.

## Using it from business-41.pazi.dev

The new app is served **by this Render service** (same origin). **The Pazi
site has not been changed by this repository**, and its own `/app/` is a
separate thing. Options for the next step, done separately in the Pazi
project:

1. **Link** from Pazi to `https://rezhisser-video-service.onrender.com/app/`
   (simplest, and all features work, including beta login).
2. **Call the demo API** from Pazi's frontend (`/api/director/plan`,
   `POST /api/jobs {brief}` or legacy `{prompt}`). The origin is already in
   `ALLOWED_ORIGINS`. Paid actions are **not** available cross-origin by
   design (SameSite=Strict cookie, no credentialed CORS).
3. Paid generation from Pazi would require real accounts on a shared domain or
   a server-to-server integration with its own authentication. That isn't
   built.

Note: when `VIDEO_PROVIDER=replicate`, the legacy `POST /api/jobs {prompt}`
without `provider` returns `401` (it would otherwise be billable). Use the
brief flow with a paid model, a quote and confirmation. `provider: "local-simulation"`
is refused: it does not create a video.

## Desktop app

The desktop app (`desktop/`, Electron) shows the same `/automation`
dashboard (and `/studio`, `/`) in its own window. It is a separate npm
package, so the cloud deployment never installs Electron.

> **По-русски, что делать дальше:**
> 1. Установите Node.js 22.12+ (https://nodejs.org), требуется Electron 44.
> 2. В папке репозитория: `cd desktop && npm install && npm start` — откроется окно
>    «Режиссёр» с панелью задач Owl Browser. Без настроек сервер запускается
>    **на вашем компьютере** (127.0.0.1). Запуск задачи без `OWL_BROWSER_URL` и
>    `OWL_BROWSER_TOKEN` отклоняется и называет эти переменные.
> 3. Чтобы окно открывало **облачный** сервис: `REZHISSER_URL=https://ваш-сервис.onrender.com npm start`
>    (Windows PowerShell: `$env:REZHISSER_URL="https://…"; npm start`).
> 4. Чтобы задачи реально выполнялись в Owl Browser, задайте `OWL_BROWSER_URL` и
>    `OWL_BROWSER_TOKEN` на облачном сервере (Render → Environment) или перед `npm start`
>    в локальном режиме.
> 5. Установщик: `npm run dist:win` (Windows, `.exe`), `npm run dist:mac` (`.dmg`, собирать на Mac),
>    `npm run dist:linux` (`.AppImage`). Файлы появятся в `desktop/dist/`.

| Variable | Default | Description |
| --- | --- | --- |
| `REZHISSER_URL` | – | Cloud service origin (`https://…`; `http://` only for localhost). Without it the bundled server runs on `127.0.0.1` with a random port, data in the app's user-data folder and a stable local JWT secret. |
| `REZHISSER_START_PATH` | `/automation` | First page: `/automation`, `/studio` or `/`. |

Security: context isolation, sandboxed renderer and no Node.js in pages;
only pages of the service open inside the window, other `http(s)` links
(payment pages, docs) open in the system browser and other schemes are
blocked; all permission requests (camera, notifications, …) are denied.

## Deploying to Render

See **[docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md)** (Russian, step by step)
for the existing, **manually created** Web Service. `render.yaml` is only used
by Render Blueprints. It is **not** applied to a service created manually in
the dashboard, so env vars must be set there by hand.

## Tests

`npm test` runs everything with injected fake `fetch`. No token, no network,
no billing:

- `test/e2e.test.js`: health, CORS, preflight, security headers, rate limit, and refusal of unconfigured video jobs.
- `test/replicate.test.js`: the Replicate adapter (create/poll, timeouts, cancel, errors, URL extraction), plus the gated beta flow end to end, concurrency cap and restart interruption.
- `test/director.test.js`: determinism, validation, shot timings, "rule-based" labelling, fail-closed advisor setting.
- `test/models.test.js`: profile validation, auto/manual routing, no cross-tier fallback, per-model input mapping, and the **actual endpoint URL and request body** reaching the fake provider for versioned and unversioned profiles.
- `test/auth-spend.test.js`: locked-by-default reasons, each missing safeguard, and that unauthenticated, CSRF-less, cross-origin and legacy requests cause **zero predictions**. Also login rate limit, cookie flags, quotes (mismatch, expiry, single use, other session), idempotent replay, budget and job caps, ledger persistence, and private job listings.
- `test/db.test.js`: repository contract for the in-memory store and, with `TEST_DATABASE_URL=postgres://…` (a throwaway database — tables are dropped), for PostgreSQL.
- `test/accounts.test.js`: password hashing, JWT forgery/expiry, register/login/profile, password reset (single use, revokes old tokens, no Host-header links), login rate limit.
- `test/payments.test.js`: YooKassa and Stripe checkout, webhook verification (re-fetch, signature, amount mismatch, replay), refunds, provider outage.
- `test/generation.test.js`: Seedance requests, Free/Pro/Studio/credits accounting, refunds on failure, S3 SigV4 (AWS reference vector), library remix, projects, restart resume, cleanup cron.
- `test/library.test.js`, `test/studio.test.js`: library coverage and search; Studio CSP, sinks, ids and RU/中文 translations.
- `test/automation.test.js`, `test/automation-runs.test.js`: task CRUD, Owl Browser executor against a scripted Owl API, refusal when the token is missing, run queue limits, blocked internal URLs, run history per user.
- `test/desktop.test.js`: desktop config and navigation rules, local secret, the bundled local server (dashboard, runs, sign-in kept across restarts) and the hardened Electron settings. Electron is not needed to run it.
- `test/integrations.test.js`: missing-key reports for video, payments, mail and automation, and `.env` loading that does not override the process.
- `test/frontend.test.js`: UI routes and CSP, static allowlist (no traversal), no `innerHTML`/`eval`/third-party origins, no secrets in assets, every referenced element exists, accessibility basics, and a render refusal with network disabled.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request. It needs **no secrets** — the service starts with an in-memory store
and reports missing API keys instead of inventing results.

| Job | What it does |
| --- | --- |
| `test` (Node 22 and 24) | `npm ci` → `npm run lint` → `npm test` (140 tests, no network, no billing) |
| `smoke` (Node 24) | `npm ci` → `npm run smoke`: starts the service and asserts `GET /api/health` returns `{"status":"ok"}` |

Local equivalent: `npm run check`.

The Electron app in `desktop/` is not built in CI: it needs a large download and
`electron-builder` requires a native toolchain (MSVC on Windows) that the
runner does not provide. Its logic is still covered by `test/desktop.test.js`.

