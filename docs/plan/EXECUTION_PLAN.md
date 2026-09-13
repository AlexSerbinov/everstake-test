# План виконання: пакети робіт, субагенти й worktree

Статус: **підготовлено для перегляду та затвердження**. Цей документ розкладає погоджений обсяг на виконувані пакети й не скорочує жоден детальний підплан. Підготовка PDF не запускає реалізацію, платний збір, новий відлік часу, commit/push чи deployment. Раніше створені dev/archive/worktree зберігаються у фактичному стані.

## Як читати й використовувати

Спочатку цей маршрут і W00–W20; потім PLAN.md та відповідні підплани. Кожен пакет містить owner, dependencies, дозволені файли, роботу, перевірюваний результат і межі. Детальні правила джерел, YouTube, Trust, cost та evaluation залишаються в оригінальних документах і включені в повний PDF без скорочення. При суперечності застосовуємо останнє явно погоджене рішення й фіксуємо виправлення, не тихо викидаємо вимогу.

Актуальні рішення: один основний evaluation із 20 питань; 200 документів — мінімум, широкий corpus; YouTube включений із Soniox та одним Gemini 3.8 Flash identity/role/consistency проходом; одна TypeScript-реалізація; актуальний remote main як база dev; dev integration без squash; окремий sslip.io demo. Перший milestone — пробний ingestion, не чат.

## Команда та правила паралельної роботи

Головний агент координує й інтегрує. Одночасно максимум три worker-субагенти, кожен має одну обмежену задачу. Роль A/B/C переважно позначає слот, а не постійно окрему модель чи сервіс. Дослідник і coding worker можуть бути різними запусками; доступ до source files не означає право редагувати чужу зону.

Кожний coding worker працює у власному **Git worktree й task branch** від конкретного вже інтегрованого commit dev. Корінь worktree поза repo: `everstake-test-worktrees/wNN-topic`, гілка `task/wNN-topic`. Існуючий `rebuild` — integration checkout dev; старий original checkout main не робоча зона нових агентів. Для read-only дослідження окреме середовище не обов’язкове, але записаний research artifact належить task branch, якщо його публікуємо.

Перед запуском root перевіряє git status, зберігає вже наявні дозволені правки, готує стабільний base commit. Самовільного commit/push немає: після затвердження початку execution фіксуємо дозволений Git scope і далі працюємо в його межах, не перепитуючи для кожної вже дозволеної дії. Публікація та main/deploy мають власні межі чинної авторизації. Цей PDF не підміняє її.

Спільні файли редагує root: package.json/lock, contracts.ts, config schemas, DB migrations/schema.sql, API route mounting, main.ts/CLI registry, web/app.ts/shared contracts, кореневі README/REPORT/COST/EVAL. Worker може запропонувати точний patch/інтерфейс; root застосовує й перевіряє один раз. Worker не запускає npm install із несумісними lockfile changes на спільному checkout.

Власні module files/tests/README — відповідальність worker. Якщо наступна задача має змінити той самий файл, перша спочатку інтегрується, а новий worktree стартує від свіжого dev. Зміна контракту повідомляється споживачам; вони не вгадують сигнатури та не редагують shared files у відповідь. Fixtures дозволяють розробляти споживача паралельно з provider, але реальна інтеграція лишається окремим gate.

Кожний worktree має власні SQLite/runtime data, artifact namespace і локальний порт. Спільно можна читати лише незмінний frozen corpus; запис у спільну live DB заборонений. Платний масовий збір і фінальний evaluation координує root, не запускає незалежно кожний worker. Читання корпусу на fixtures не означає дублювання його оплаченої індексації.

Handoff worker: task ID, base SHA, фактично змінені файли, summary поведінки, команди й результати перевірок, artifact IDs, usage/cost, незавершене та точні інтеграційні потреби. Root переглядає diff, виконує потрібні integration checks і за дозволеного Git scope зливає task branch у dev зі збереженням історії. Конфлікти виправляються звичайними правками, без reset/stash/rebase/force. Worktree прибирається тільки після integration і перевірки, що його робота збережена.

## Черги виконання

| Хвиля | Паралельні задачі | Gate перед наступною |
|---|---|---|
| 0 | Root W00; після дозволу можна read-only W01–W03 | Узгоджений мінімальний contract/base й research examples |
| 1 | W04 measurements, W05 crawler, W06 sanitation/dedup | Probe ingestion працює, оплачувані виклики вже metered |
| 2 | Root W07; W08 Soniox, W09 Gemini на turn fixtures, W10 index/search | Реальна інтеграція video turns; якісний текстовий корпус |
| 3 | Root W11; W12 answer, W13 refresh, W14 evaluator | Повний corpus/version, answer/eval/update contracts перевірені |
| 4 | W15 answer UI, W16 management UI, W17 Part B/docs | Усі блоки читають реальні сумісні результати |
| 5 | Root W18 + обмежений QA-перегляд | Виміряний результат і відомі провали |
| 6 | W19 deployment, потім W20 final handoff | Одна версія, зрозумілий repo, перевірені docs/demo |

Залежності конкретного пакета важливіші за приблизну хвилю. Не починати платні STT/embedding calls до W04. Не оголошувати corpus-v1/evaluation фінальними, поки прийняті YouTube дані ще додаються. Підготовка evaluator і UI на fixtures може початися раніше, але вона не є measured evaluation чи доказом live роботи.

## Спільні критерії виконання

`planned → ready → in_progress → review → integrated → verified`. Задача ready лише з потрібними контрактами/fixtures/base; finished message worker не означає integrated. Blocked означає конкретну відсутню залежність, не мовчазне пропускання. При зміні бюджету зберігати частковий результат і явно описати scope change; не позначати planned як done.

Для коду потрібні перевірки істотної поведінки: unit/fixture, integration за межами модуля, UI smoke для екранів. Без автоматичного запуску всієї дорогої suite після кожної правки. Повний оплачуваний evaluation виконується на фінальному snapshot, відповідно до EVALUATION_PLAN.md. Перевірка doc links достатня для документації; не додавати тести, що лише повторюють текст реалізації.

Кожний run має code/corpus/config/model/policy versions, а фактичні зовнішні виклики — ledger запис. Паралельні відповіді не змішують metrics. Ніяких готових еталонів у corpus/prompts відповіді. Невідомі dates/cost/speaker identity й provider errors показуються як невідомі/помилки, не як успішні результати.

## Точні пакети

### W00. Підготувати основу для паралельної роботи

**Відповідальний:** Головний агент. **Залежності:** Затвердження цього пакета.

**Зона правок:** src/contracts.ts; src/config.ts; storage schema; package/lock; мінімальні CLI/API entrypoints.

**Повна специфікація:** [ARCHITECTURE.md](ARCHITECTURE.md); [REPOSITORY_PLAN.md](REPOSITORY_PLAN.md).

**Робота:** Перевірити dev/archive/worktree стан; зберегти існуючі незакомічені README/REBUILD правки. Визначити мінімальні document/run/evidence interfaces, source config і model client contract. Створити лише runnable foundation; закріпити committed base для дочірніх worktree.

**Результат і перевірки:** Clean install/typecheck, small command smoke, план реєстрації БД/маршрутів. Передати base SHA, команди та список зарезервованих файлів.

**Межі:** Не стартувати дочірні coding worktree від незакомічених спільних контрактів. Старі 70 entries в початковому checkout не торкати.

### W01. Дослідити сайт, блоги й історичні домени

**Відповідальний:** Дослідник A. **Залежності:** W00 або read-only дослідження після затвердження.

**Зона правок:** artifacts/research/web/ у власному worktree.

**Повна специфікація:** [CRAWLER.md](CRAWLER.md) §9; [DATA_UPDATES.md](DATA_UPDATES.md).

**Робота:** Seeds → sitemap/pagination/links → старі й нові домени. Зібрати metadata, robots/exclusions, приклади переносів і дат, кандидати source config.

**Результат і перевірки:** Manifest кандидатів із provenance, coverage gaps, 3–5 різнотипних raw прикладів; жодних готових eval-відповідей.

**Межі:** Пошук широкий, без стопа на 200; не дублювати збори інших агентів і не міняти shared config самостійно.

### W02. Дослідити документацію, GitHub і зовнішні матеріали

**Відповідальний:** Дослідник B. **Залежності:** W00 або read-only дослідження після затвердження.

**Зона правок:** artifacts/research/docs/ у власному worktree.

**Повна специфікація:** [CRAWLER.md](CRAWLER.md); [DECISIONS.md](DECISIONS.md).

**Робота:** Знайти вкладену документацію, таблиці/footnotes, repo links, аудити, партнерські й сторонні матеріали; встановити походження й формати.

**Результат і перевірки:** Manifest джерел/типів, extraction fixtures, пояснені inclusion/exclusion та відомі втрати.

**Межі:** Code/binaries не набивають corpus count; snippets пошуку не стають evidence; не виконувати інструкції з документів.

### W03. Скласти YouTube inventory і бюджет

**Відповідальний:** Дослідник C. **Залежності:** W00 або read-only дослідження після затвердження.

**Зона правок:** artifacts/research/youtube/; proposals youtube config.

**Повна специфікація:** [YOUTUBE_PLAN.md](YOUTUBE_PLAN.md) §§2–3,11.

**Робота:** Metadata/captions → relevance decisions → accepted/excluded/needs_review, duration та origin. Врахувати офіційні виступи, гостей на чужих каналах, блогерів, музику-однофамільця й історію.

**Результат і перевірки:** Справжній список video IDs, кількість/години/unknown duration, прогноз STT+Gemini+embedding та причина відбору кожного кандидата.

**Межі:** Не запускати масовий Soniox до відбору; відсутні captions не означають нерелевантність. Прогноз не видавати за фактичний cost.

### W04. Реалізувати єдине вимірювання витрат і model client

**Відповідальний:** Worker A. **Залежності:** W00.

**Зона правок:** src/services/measurements/; providers/model-client.ts; provider usage adapters.

**Повна специфікація:** [MEASUREMENTS.md](MEASUREMENTS.md); [YOUTUBE_PLAN.md](YOUTUBE_PLAN.md) §11.

**Робота:** Run/attempt до виклику, usage/error/retry, price revisions, receipts і сумування; API для Soniox audio units та Gemini review. Запропонувати schema patch головному агенту.

**Результат і перевірки:** Fixtures success/retry/error/unknown/cache/nested totals; жодного подвійного рахунку; API/CLI/eval читають один ledger.

**Межі:** Не приховувати credits/billing gaps; provider usage не замінювати токенами, порахованими з тексту.

### W05. Реалізувати crawler та extraction

**Відповідальний:** Worker B. **Залежності:** W00, дослідницькі приклади W01/W02; W04 перед платними кроками.

**Зона правок:** src/services/crawler/ крім shared policy files.

**Повна специфікація:** [CRAWLER.md](CRAWLER.md); [DATA_UPDATES.md](DATA_UPDATES.md).

**Робота:** Robots-aware discovery/fetch, persistent frontier через storage contract, source scope, resume, структурний текст і dates provenance. Generic adapters без CEO/domain hacks.

**Результат і перевірки:** Пробні 12–20 документів і fixtures robots/redirects/pagination/tables/migration/unknown date; counts і причини пропусків.

**Межі:** Source/date logic не приймає source priority за authority; Last-Modified не перетворює стару статтю на нову.

### W06. Зробити sanitation, evidence registry і дедуплікацію

**Відповідальний:** Worker C. **Залежності:** W00; fixtures W01/W02.

**Зона правок:** services/evidence/sanitize-document.ts, register-evidence.ts; services/indexer/deduplicate.ts.

**Повна специфікація:** [ARCHITECTURE.md](ARCHITECTURE.md); [CRAWLER.md](CRAWLER.md); [DECISIONS.md](DECISIONS.md).

**Робота:** Одна sanitation межа index/read, stable refs, raw-clean зв’язки; exact/near duplicate groups, aliases vs materially revised versions.

**Результат і перевірки:** Clean/injected pairs, copy flood, same numbers different entities, stale/current versions; fixtures через normal ingestion.

**Межі:** Не видаляти історичний raw; не приймати однаковий host/URL за достатній доказ незалежності чи тотожності.

### W07. Побудувати початковий текстовий корпус і перевірити QA

**Відповідальний:** Головний агент + дослідники. **Залежності:** Інтегровані W04/W05/W06; W01/W02.

**Зона правок:** workflows/build-corpus.ts; shared storage integrations; corpus artifacts.

**Повна специфікація:** [CRAWLER.md](CRAWLER.md) §§A,9; [MEASUREMENTS.md](MEASUREMENTS.md).

**Робота:** Запустити пробну вертикаль, виправити загальні дефекти, розширити всі знайдені релевантні джерела порціями, скласти coverage.

**Результат і перевірки:** ≥200 meaningful docs як мінімум; provenance, aliases, pending/exclusions і QA кількість. Text snapshot має revision; не позначати весь корпус повним за вибіркою.

**Межі:** Це текстовий milestone, не фінальний eval corpus: accepted YouTube ще додається. Агенти перевіряють, але їхні перекази не індексуються.

### W08. Додати Soniox ingestion і timed turns

**Відповідальний:** Worker A. **Залежності:** W00/W03/W04/W06.

**Зона правок:** services/youtube/discover-videos.ts, screen-video.ts, transcribe-video.ts, build-speaker-turns.ts; providers/soniox.ts.

**Повна специфікація:** [YOUTUBE_PLAN.md](YOUTUBE_PLAN.md) §§1–4,10–11.

**Робота:** Мінімальний TS адаптер власного pipeline, audio/media hash, submit/poll/raw result, durable job IDs і segmentation без змішування мовців.

**Результат і перевірки:** Offline mock job recovery та token/turn fixtures; pilot на прийнятих відео з actual usage/unknown; no-change не платить вдруге.

**Межі:** Ніяких TTS/dubbing/voice gender dependencies; timeout після submit не створює автоматично новий STT job.

### W09. Додати Gemini identity/role та speaker review

**Відповідальний:** Worker B. **Залежності:** W00/W03/W04; turn contract W08.

**Зона правок:** services/youtube/review-speakers.ts, attribute-speakers.ts, build-video-evidence.ts; prompts/video-speaker-review.md.

**Повна специфікація:** [YOUTUBE_PLAN.md](YOUTUBE_PLAN.md) §§5–8.

**Робота:** Один Gemini 3.8 Flash прохід: name/role/organization/label evidence плюс drift checks; unknown/review states; question/assertion/correction links, date scope.

**Результат і перевірки:** Fixtures interviewer-introduces-guest, 2700→130, ambiguous name, role-at-time, swapped labels, overlap/windows; audio-backed pilot і costs.

**Межі:** Не робити два дубльовані LLM calls для identity та review; no_issue_found не гарантує verified identity; shared YouTube test files розділяються за module names.

### W10. Побудувати index і пошук

**Відповідальний:** Worker C. **Залежності:** W00/W04/W06; пробні документи W05.

**Зона правок:** services/indexer/build-index.ts, chunk.ts; services/search/.

**Повна специфікація:** [ARCHITECTURE.md](ARCHITECTURE.md); [CRAWLER.md](CRAWLER.md); [MEASUREMENTS.md](MEASUREMENTS.md).

**Робота:** Структурні chunks/overlap, FTS+embeddings, filtering before top-k, retrieval diversity, bounded read із сусідніми умовами; frozen doc version.

**Результат і перевірки:** Fixtures retrieval/units/negation/context, hash-based embedding reuse, measured index run; читання дає точні refs.

**Межі:** Не копіювати special routes CEO чи product fact keys; назви filters однакові для API та eval.

### W11. Завершити YouTube та заморозити повний corpus-v1

**Відповідальний:** Головний агент + QA. **Залежності:** W07/W08/W09/W10 інтегровані.

**Зона правок:** workflows/import-youtube.ts; corpus manifests; coverage/QA artifacts.

**Повна специфікація:** [YOUTUBE_PLAN.md](YOUTUBE_PLAN.md); [CRAWLER.md](CRAWLER.md); [DATA_UPDATES.md](DATA_UPDATES.md).

**Робота:** Обробити прийняті відео, перевірити критичні speaker/date intervals, включити валідні transcripts у спільний index. Unknown/excluded/pending лишаються видимими.

**Результат і перевірки:** Є code/parser/model/corpus hashes, indexed transcripts з timecodes, coverage/errors і actual total. Фінальна версія даних готова до звірки еталонів.

**Межі:** Не заморожувати eval на текстовому snapshot, а потім тихо додавати YouTube. Неповнота збору явно описана.

### W12. Зробити answer loop, gates і Trust Score

**Відповідальний:** Worker A. **Залежності:** W00/W04/W06/W10; fixtures доступні до W11.

**Зона правок:** services/answer/; evidence/verify-answer.ts, calculate.ts; services/trust/; answer prompts.

**Повна специфікація:** [PLAN.md](PLAN.md) §§4–5,8; [ARCHITECTURE.md](ARCHITECTURE.md); [YOUTUBE_PLAN.md](YOUTUBE_PLAN.md).

**Робота:** Search/read/calculate/submit, bounded loop, actual events, factual/synthesis/partial/error; deterministic refs/numbers/date gates і explainable Trust.

**Результат і перевірки:** Provider-mocked end-to-end fixtures, transfer CEO/CMO/company/URL, malformed refs, grounded calculation, no evidence, API error, old video; score не обходить gates.

**Межі:** Не називати структурну перевірку семантичною гарантією. Model confidence не входить у Trust. Public runtime не бачить evaluation gold.

### W13. Реалізувати refresh та активацію corpus

**Відповідальний:** Worker B. **Залежності:** W00/W04/W05/W06/W10; інтеграція відео W08/W09.

**Зона правок:** workflows/refresh-corpus.ts; crawler/check-source-changes.ts; storage activation patch через root.

**Повна специфікація:** [DATA_UPDATES.md](DATA_UPDATES.md); [YOUTUBE_PLAN.md](YOUTUBE_PLAN.md) §10.

**Робота:** Due/now/source/all scope, discovery/import, one worker durable jobs, staging/atomic activation, cache invalidation by revision, відновлення після restart.

**Результат і перевірки:** No-change/new/correction/migration/failure/duplicate jobs; active query pinning; identity revision reindexes без Soniox; old eval labelled old corpus.

**Межі:** Не змінювати authority через refresh priority; UI mutation доступний лише оператору; failed refresh не підміняє активну БД.

### W14. Підготувати evaluator і єдиний набір 20

**Відповідальний:** Worker C. **Залежності:** W00/W04; schema/fixtures одразу; W12 для runner integration; W11 для gold freeze.

**Зона правок:** services/evaluation/; eval/questions.json, fixtures/; judge prompt.

**Повна специфікація:** [EVALUATION_PLAN.md](EVALUATION_PLAN.md); [MEASUREMENTS.md](MEASUREMENTS.md).

**Робота:** 5 basic+15 hard, 5 negatives; actual answer runner, grading/partial/error/invented independent flag, baseline adapter, report object і Markdown export.

**Результат і перевірки:** Fixtures mixed metrics, judge outage, false abstention, grounded calculations, cost reconciliation; після W11 перевірити refs/negatives у повному corpus.

**Межі:** Рівно 20 основних питань. Reservoir не автозапускати. Baseline 20 — ще 20 відповідей, judge cost окремо або documented human grading.

### W15. Зробити question/live search/answer/source UI

**Відповідальний:** Worker A. **Залежності:** W12 contract; early mock events після W00; W09 video contract.

**Зона правок:** web/features/question, live-search, answer, answer-sources, verification, trust-score; transport/.

**Повна специфікація:** [LIVE_EXPERIENCE.md](LIVE_EXPERIENCE.md); [ARCHITECTURE.md](ARCHITECTURE.md); [YOUTUBE_PLAN.md](YOUTUBE_PLAN.md) §8.

**Робота:** Таймер, справжні search events, new/repeat/dropped, exact dated source sidebar, citation navigation, speaker/timecodes/history, readable Trust/errors.

**Результат і перевірки:** Long-running mock stream, UTF8/chunk/disconnect, keyboard/mobile, long URLs, several citations per page, no verified UI on error.

**Межі:** No fake thoughts/progress. API route mounting та shared app.ts лишаються root. Не дублювати backend score чи cost sums.

### W16. Зробити Costs/Corpus/Evaluation UI

**Відповідальний:** Worker B. **Залежності:** W04/W13/W14 contracts; ранні fixtures після W00.

**Зона правок:** web/features/costs, corpus, evaluation.

**Повна специфікація:** [MEASUREMENTS.md](MEASUREMENTS.md); [LIVE_EXPERIENCE.md](LIVE_EXPERIENCE.md); [EVALUATION_PLAN.md](EVALUATION_PLAN.md).

**Робота:** Per-answer/all-time Costs і YouTube stages, refresh progress/coverage, один eval set із difficulty/expected/actual/verdict/evidence та baseline.

**Результат і перевірки:** Mixed run states, filtering preserves totals, unknown costs, snapshots compatible baseline, read-only navigation не запускає API, role-gated refresh controls.

**Межі:** Reuse source/trace/receipt contracts; shared components змінювати через root or agreed owner, не одночасно з W15.

### W17. Підготувати Part B і короткі reviewer docs

**Відповідальний:** Worker C. **Залежності:** Оригінальне завдання; W00 decisions; actual numbers лише після W18.

**Зона правок:** PROCESS.md; docs/DEFENCE.md; draft REPORT.md sections без вигаданих metrics.

**Повна специфікація:** [REQUIREMENTS.md](REQUIREMENTS.md); [PLAN.md](PLAN.md) Part B; [REPOSITORY_PLAN.md](REPOSITORY_PLAN.md).

**Робота:** Односторінковий process redesign, 2–3metrics, proactive failure response, agent/code/human; defence walkthrough/live change/Process Discovery.

**Результат і перевірки:** Звірка з §7–10; короткий зрозумілий prose, facts vs plans позначені. Final measured sections fills root після W18.

**Межі:** Немає інтеграцій Slack/Jira у Part B; жодних time logs/повідомлень стороннім людям. Не вигадувати успіх пілота.

### W18. Інтегрувати, виміряти й перевірити повний результат

**Відповідальний:** Головний агент; QA worker для незалежного перегляду. **Залежності:** W11/W12/W13/W14/W15/W16.

**Зона правок:** Спільні API wiring/schema; actual evaluation artifacts, EVAL/COST; required checks.

**Повна специфікація:** [EVALUATION_PLAN.md](EVALUATION_PLAN.md); [REQUIREMENTS.md](REQUIREMENTS.md); [MEASUREMENTS.md](MEASUREMENTS.md).

**Робота:** Перевірити CLI/API/UI на одній версії, фінально заморозити corpus/config, 20 agent + зіставний baseline, усі verdict і invented counts, cost table/×50, static MCP comparison.

**Результат і перевірки:** Завершений measured run або явний incomplete; independent review failures, не зшивати повтори. New-data demo до/після має versions і реальні receipts.

**Межі:** Після суттєвого виправлення versions змінюються, affected smoke потім узгоджений final rerun. Budget не виправдовує вигадані зелені результати.

### W19. Розгорнути окремий демо-сервіс

**Відповідальний:** Головний агент; окремий deployment worker за дозволеного execution. **Залежності:** W18 прийнятний результат; перевірений deployment config.

**Зона правок:** scripts/deploy; потрібні service/proxy config; env.example лише імена.

**Повна специфікація:** [REPOSITORY_PLAN.md](REPOSITORY_PLAN.md) §11; [DATA_UPDATES.md](DATA_UPDATES.md).

**Робота:** Personal server 89.167.19.222, everstate-knowledge-base sslip.io hostname; окремі port/service/data, TLS/health/SSE, corpus persistence.

**Результат і перевірки:** Зовнішній HTTPS і запит до правильної code/corpus версії; прогрес не буферизується; старі demos не змінені; підтверджений actual deployment status.

**Межі:** Не перебудовувати весь corpus на deploy. Немає секретів у публічних artifacts. Сама підготовка PDF не дозволяє почати deployment.

### W20. Підготувати фінальний репозиторій і передачу

**Відповідальний:** Головний агент. **Залежності:** W17/W18; W19 якщо обрано hosted demo.

**Зона правок:** Root README/REPORT/EVAL/COST/PROCESS/TIMELINE; docs map; archive transition.

**Повна специфікація:** [REPOSITORY_PLAN.md](REPOSITORY_PLAN.md); [REQUIREMENTS.md](REQUIREMENTS.md).

**Робота:** Одна активна версія, assignment/seeds першим екраном README, остаточні docs, збережені prototypes у справжній історії; audit publish scope, clean-run instructions, готовність пояснити код.

**Результат і перевірки:** Усі §1–12 mapped на конкретні докази; final docs без старих метрик; worktree changes integrated; main integration без squash лише за чинного дозволу.

**Межі:** Не вважати задачу закінченою за наявністю тільки UI. Незакомічене оригінального main не втрачено; фінальний timeline не backdated.

## Що затверджуємо перед запуском

Порядок пакетів і збереження всього погодженого обсягу; team/worktree model; бюджети зовнішніх викликів; режим майбутніх Git-дій і момент старту фактичного execution. Наявний орієнтир три години, включно з плануванням, не є достовірним estimate двадцяти одного пакета. Без виміряного throughput/coverage/відеогодин не гарантуємо строк і не скорочуємо приховано YouTube, tests чи evaluation для красивої обіцянки.

Після затвердження перші дії: перевірити стан dev → W00, короткі W01–W03 → перша integrated ingestion вертикаль W04–W07. Модулі наступних хвиль одержують конкретні task briefs вище й власні worktree від зафіксованої бази. Час, оплату й статуси фіксуємо в момент реальної роботи в дозволених межах, не заднім числом.

## Комплект PDF без втрати деталей

PDF містить цей execution layer, головний PLAN, усі детальні підплани, вимоги/рішення/пріоритети, карту документів, оригінальний текст завдання й збережений візуальний референс джерел. Таблиці можуть бути перетворені на вертикальні картки для читання, але всі рядки й значення зберігаються. Публічні посилання клікабельні; внутрішні розділи мають PDF-закладки. Посилання на сторонні локальні source-code файли залишаються довідковими шляхами: самі кодові бази не є частиною PDF.
