# Local Trade — оцінка придатності як каркаса для Everstake knowledge-асистента

Дата: 11.09.2026

## 1. Де знайдено

Знайдено **два** артефакти з назвою Local Trade — це різні речі.

| # | Що | Шлях на Mac | Шлях на сервері | Свіжість |
|---|---|---|---|---|
| 1 | **LocalTrade v2 / «Cypher»** — робочий TS-монорепо (pnpm + turbo), Fastify gateway + Preact SPA | `~/Desktop/projects/jamal/localTrade/v2/` | `/opt/cypher-v2/` (systemd `cypher-v2.service`, порт **4313**) | HEAD `b908477` від **05.05.2026** («docs: prepare repo for client handoff»); файли на сервері теж від 05.05 → **версії ідентичні**, Mac авторитетний |
| 2 | **localtrade-prototype** — ранній однофайловий прототип, `server.mjs` 66 KB + vanilla-JS фронт | `~/Desktop/projects/personal/localtrade-prototype/` | `/root/projects/personal/localtrade-prototype/` (systemd `localtrade-prototype.service`, активний) | 06.04.2026, обидві копії однакові |

Решта в `~/Desktop/projects/jamal/localTrade/` — це **документи, не код**: `LocalTrade_Technical_Documentation_FULL.md`, `MCP/` (WBS + PDF), `Funnels/`, `ICP_Funnels/`, скріншоти, call-summary. Коду там немає.

Скопійовано сюди (rsync, без `.git`/`node_modules`/`dist`/`.turbo`):
- `reference/localtrade/` — монорепо v2 (7.0 MB)
- `reference/localtrade-prototype/` — прототип (136 KB)

## 2. Стан сервера Hetzner (89.167.19.222)

**Reverse proxy — Caddy** (`/etc/caddy/Caddyfile`), слухає `:80` і `:443`, автоматичні сертифікати через **ZeroSSL** (`acme_ca https://acme.zerossl.com/v2/DV90`, email `admin@translator.app`). Nginx/Traefik неактивні.

⚠️ **Домени пишуться через ДЕФІСИ, не крапки:** `<name>.89-167-19-222.sslip.io`. Це важливо — sslip.io резолвить обидві форми, але весь наявний конфіг на дефісах.

Шаблон для нового сервісу — рівно два рядки:

```caddy
everstake.89-167-19-222.sslip.io {
    reverse_proxy localhost:4320
}
```
далі `systemctl reload caddy` — сертифікат видається автоматично.

Уже зайняті хости: корінь (`:3001`, ai-translator), `cypher`, `v2` (обидва → `:4313`), `quantra` (`:4315`), `cloudlock-docs`, `terminal-demo`, `brand`, `brand-v2`, `alina`, `alina-v2`, `alina-v3` (останні — статика з `/var/www/*`).

**Зайняті порти:** 80, 443, 3001, 3100, 3303, 3000, 4305, 4313, 4315, 4327-4330, 4480, 5488, 6969, 8081-8082, 8123, 8643, 18300, 27017. **Вільно, пропоную 4320.**

**Docker:** 17 контейнерів (stt-bot, uc3-pilot ×4, mono-p2p, llm-live-editor, hermes ×2, home-assistant, postgres ×2, mongo, bark…). Жоден не стосується LocalTrade — v2 деплоїться **не в Docker, а systemd-юнітом**.

**Деплой v2 зроблено через GitHub Actions** (`.github/workflows/deploy.yml`): build → `scp-action` у `/opt/cypher-v2` → heredoc створює systemd-юніт → `systemctl restart` → цикл очікування `is-active` до 15 с. Робочий, перевірений шаблон.

**Ресурси:** `/` — 75 G, зайнято 64 G, **вільно лише 8.6 G (89 %)**; окремий пул `/data` — 1.1 T, вільно 1013 G. RAM 7 G, з них вільно ~2 G, swap майже вичерпаний. Для нашого сервісу місця вистачає (корпус 200 сторінок + SQLite ≈ десятки МБ), але великі артефакти краще класти в `/data`.

Нічого не зупинено й не видалено.

## 3. Структура LocalTrade v2

```
v2/
├─ apps/gateway/   Fastify 5 + SSE, sql.js, MCP SDK — 10 620 рядків TS
│  ├─ services/    funnel-builder 1276, mcp-client 1028, state-machine 989,
│  │               prompt-builder 745, tool-registry 436, agent-orchestrator 435…
│  ├─ routes/      turn 464, tts 361, turn-stream 307, user, voice, health
│  └─ persistence/ db.ts (sql.js), user-store 328, summary-gen 435…
├─ apps/web/       Preact + Vite — 6 041 рядок (ChatPanel 824, DebugPanel 479, global.css 3035)
├─ packages/       icp-engine (скоринг лідів), shared-types, runtime-assets
├─ services/       tts, stt (заглушки по 26-30 рядків)
└─ .github/workflows/deploy.yml
```

Суть системи: **AI-агент продажів для криптобіржі** — веде діалог із лідом, класифікує його по ICP, рахує скоринг воронки, викликає інструменти біржі через MCP (баланс, навігація, ордери), говорить голосом (ElevenLabs/Soniox). Тобто це **не** retrieval-система.

## 4. Оцінка по компонентах

| Компонент | Що є в LocalTrade | Що треба для Everstake | Вердикт |
|---|---|---|---|
| HTTP-сервер | Fastify 5, `server.ts` — 55 рядків: CORS, static SPA, SPA-fallback, реєстрація роутів | `POST /ask` + віддача сторінки | **Береться як патерн** (переписати ~40 рядків) |
| Стрімінг | SSE через `reply.hijack()` + ручні заголовки, `routes/turn-stream.ts` | Опційно — красиво для живого демо | **Береться патерн** (~30 рядків) |
| БД | **sql.js** (SQLite у WASM): вся БД у памʼяті, `db.export()` + `writeFileSync` усього файлу з debounce 1 с | FTS5 + вектори як BLOB, 200+ документів, часті читання | **Переробляється.** sql.js для цього поганий: кожен запис переписує весь файл, немає нормального доступу до FTS5-токенізаторів. Потрібен `better-sqlite3` |
| Хелпери БД | `query/queryOne/insert/run` — чистий, зрозумілий шар ~40 рядків | те саме | **Береться як форма**, переписати під better-sqlite3 |
| Векторний пошук | **Відсутній повністю** — жодного embedding/cosine/FTS у коді | ядро завдання | **Дописується з нуля** |
| LLM-клієнт | `plugins/llm-providers.ts` — каталог Groq / Z.AI / OpenRouter через OpenAI-сумісний REST, `fetch` вручну, таймаут, fallback «local» | **`@anthropic-ai/sdk`**, Opus 5 + Haiku 4.5 | **Переробляється.** Anthropic SDK у проєкті немає взагалі. Варта збереження лише ідея «каталог провайдерів + `configured` + дефолт» — ~20 рядків |
| Облік токенів/вартості | **Немає.** Жодного `prompt_tokens`/`completion_tokens`/cost | п. 5.6 вимагає **виміряні** токени й вартість | **Дописується з нуля** |
| Логування LLM | Розсипані `console.log`/`app.log` без структури, без запису викликів | бажано журнал викликів для звіту | **Зайве**, робимо свій тонкий шар |
| UI | Preact + Vite, 6 k рядків, 3 035 рядків CSS, чат із голосом і дебаг-панеллю | одна сторінка: питання → відповідь → картки джерел | **Зайве.** Значно кращий орієнтир — `localtrade-prototype/public/` (index.html + app.js + styles.css, vanilla, без збірки) |
| Конфіг | `.env` + `node --env-file`, 21 ключ, читання `process.env` прямо в модулях | 3-5 ключів | **Береться підхід** `--env-file` (без бібліотек), решта зайва |
| Docker | **Немає** ні Dockerfile, ні compose | не обовʼязково | **Відсутнє** — і не треба, systemd простіший |
| Деплой | GH Actions → scp → systemd-юніт heredoc → очікування `is-active` | те саме | **Береться майже як є** — головна цінність усього репо |
| Тести | **Жодного** тест-файлу, жодного vitest/jest | eval на 20 питань | **Дописується з нуля** |
| Доменна логіка | funnel/ICP/state-machine/MCP-біржа/TTS/STT — ~9 000 рядків | нуль перетину | **Викидається** |

## 5. Вердикт

**Не брати монорепо як каркас. Взяти 5 файлів як довідку і стартувати чисто.**

Три причини:

1. **Перетин по суті майже нульовий.** З 16.6 k рядків коду релевантні приблизно 150-200: `server.ts`, SSE-заголовки, хелпери БД, форма каталогу провайдерів. Решта — воронка продажів, скоринг лідів, голос, MCP до біржі.
2. **Технологічно розходиться там, де болить.** Немає `@anthropic-ai/sdk` (є OpenAI-сумісний REST до Groq/OpenRouter), немає нічого про FTS5/embeddings, а `sql.js` — активно шкідливий вибір для корпусу з векторами.
3. **Пункт 10 завдання — «поясніть і змініть будь-який рядок».** Притягнути pnpm-workspace + turbo + preact + 3 000 рядків CSS означає внести в репо код, який на захисті доведеться або вирізати, або пояснювати. Це мінус, не плюс.

**Економія часу.** Чистий старт (`npm init` + Fastify/Hono + better-sqlite3 + `@anthropic-ai/sdk` + статичний `public/`) — приблизно **45-60 хв** до «сервер відповідає на `POST /ask`». LocalTrade скорочує це хіба що до 35-40 хв. Справжня економія — **не в коді, а в деплої**: готовий `deploy.yml`, знання шаблону Caddy з дефісами і схеми systemd-юніта економлять **~45-60 хв** і один цикл помилок із TLS. Разом: **≈1-1.5 год**, і лише за умови використання як довідки, а не як бази.

### Взяти

- `reference/localtrade/apps/gateway/src/server.ts` — скелет Fastify зі static + SPA-fallback.
- `reference/localtrade/apps/gateway/src/persistence/db.ts` — форма `query/queryOne/insert` (переписати на better-sqlite3).
- `reference/localtrade/apps/gateway/src/routes/turn-stream.ts`, рядки 33-50 — заголовки SSE через `reply.hijack()`.
- `reference/localtrade/.github/workflows/deploy.yml` — **головна цінність**: build → scp → systemd → перевірка `is-active`.
- `reference/localtrade-prototype/public/` — приклад односторінкового UI без збірки (index.html + app.js + styles.css).
- Шаблон Caddy з розділу 2 + вільний порт **4320**.

### Викинути

`packages/icp-engine`, `services/tts`, `services/stt`, `apps/web` (весь), `services/funnel-builder|state-machine|prompt-builder|agent-orchestrator|tool-registry|mcp-client|news-client`, `routes/tts|voice|user`, pnpm-workspace + turbo, `sql.js`, усіх LLM-провайдерів (Groq/Z.AI/OpenRouter).

### Дописати з нуля

Краулер + robots.txt, дедуп (SimHash/MinHash), схема SQLite з FTS5 і вектором-BLOB, embeddings, ранжування за датою й авторитетністю джерела, санітизація вбудованих у документи інструкцій (п. 5.4), `@anthropic-ai/sdk` з Opus 5 / Haiku 4.5, облік токенів і вартості, eval-ранер на 20 питань.
