# Фінальний репозиторій: одна реалізація, зрозумілий вхід, справжня історія

План підготовки до здачі, 2026-09-13. Первісно це був лише Desktop-план. Після окремого прохання користувача перехід розпочато: створено локальні archive/dev і окремий worktree; детальний стан нижче. Commit/push/deploy та time logging у цьому кроці не виконуються. Поточний PDF залишається попереднім датованим зведенням; це доповнення до актуального Markdown-плану.

## 1. Поточний стан і рішення

Початкова read-only перевірка до переходу: локально була одна гілка `main`; у working tree багато modified/untracked файлів Claude, Codex і загальних документів. Кореневий README веде у дві реалізації. Є `docs/TIME.md` з історичним значенням 3.3 h станом на 2026-09-12 18:04 і описом реконструкції за подіями. Це не сьогоднішній актуальний підсумок і не точний секундомір; перерахунок зараз не виконувався.

Пропозиція: **той самий Git-репозиторій, одна нова TypeScript-реалізація у фінальному дереві, попередні експерименти доступні в історії та архівній гілці**. Новий orphan history або новий репозиторій не потрібні: вони ускладнюють показ справжнього процесу. Репозиторій може мати чистий поточний вигляд і водночас чесно зберігати старі рішення.

Нову роботу робити в окремому зареєстрованому worktree поза поточним checkout, наприклад `everstake-test-worktrees/rebuild`. Worktree створюється через Git, не копіюванням папки з `.git`. Операцію виконано після дозволу на початок переходу; точний шлях і база наведені нижче.

## 2. Гілки без зайвого GitFlow

| Гілка | Призначення |
|---|---|
| `main` | Наразі поточна історія; після окремо дозволеного фінального merge — перевірена єдина версія для reviewers |
| `archive/two-implementations` | Зафіксована база попередніх Claude/Codex експериментів; посилання з історії розвитку |
| `dev` | Нова TypeScript-реалізація в окремому worktree; реальні послідовні коміти |

`dev` можна назвати `rebuild/typescript`; для цього одноосібного демо це альтернативні назви однієї робочої гілки, а не потреба створити обидві. Не потрібно ще по гілці на кожну функцію, якщо немає незалежної паралельної розробки коду.

Архівна гілка з поточного HEAD зберігає лише вже закомічене. **Вона не зберігає нинішні незакомічені зміни.** Поточний checkout залишається на місці; перед видаленням/переміщенням чого-небудь потрібно окремо звірити modified/untracked і забезпечити їх збереження. Якщо вирішимо включати їх до архівної версії, це окремі перевірені коміти з чесним статусом; не змішувати всі чужі/невідомі зміни в один snapshot commit. Жодного stash/reset/clean.

Новий `dev` походить від перевіреного `origin/main`, тому спочатку бачить старе опубліковане дерево. Поступово пояснити перехід у README, додати нову структуру й реалізувати працюючі блоки. Старі implementation folders прибрати з фінального tracked tree окремою forward-зміною після покриття потрібної поведінки новою версією; assignment inputs зберегти. Це майбутня явно обмежена правка нової гілки, а не очищення поточної робочої папки. Git history продовжує містити обидві реалізації. Неперевірені локальні артефакти не переносити автоматично як результати нового коду.

Фінальний merge у `main`, push, зміна default branch і deployment — окремі дії етапу виконання, не наслідок прохання продумати план. Не squash/rebase і не вигадані ранні timestamps; зберегти змістовну історію. Архівна гілка на GitHub стане видимою лише після її дозволеної публікації. Старі сервіси не зупиняти під час роботи над новою гілкою.

## 3. Фінальне дерево для reviewers

```text
everstake-knowledge-assistant/
  README.md                     # Start here: assignment, demo, run, results
  REPORT.md                     # 2–3 pages: decisions, trade-offs, MCP, costs
  EVAL.md                       # One set of 20: actual answers and verdicts
  COST.md                       # Measured totals, build, query, x50
  PROCESS.md                    # One page, Part B
  TIMELINE.md                   # Development narrative with real evidence
  AGENTS.md                     # Short project rules, no personal machine data
  package.json
  package-lock.json
  tsconfig.json
  .env.example                  # Variable names and safe examples
  .gitignore
  assignment/
    TEST_ASSIGNMENT_EN.md       # Original wording
    TEST_ASSIGNMENT_UA.md       # Reading translation
    corpus_sources.csv          # Supplied seeds, preserved as input
  src/
    main.ts
    cli.ts
    api.ts
    contracts.ts
    workflows/
    services/                   # crawler, youtube, indexer, search, evidence,
                                # answer, trust, measurements, evaluation
    providers/
    storage/
  web/
    features/                   # Screen blocks matching backend capabilities
    shared/
    transport/
  config/
    sources.yaml
    youtube.yaml
    models.yaml
    policy.yaml
  agents/
  skills/
  prompts/
  eval/
    questions.json              # The selected 20, references stay out of corpus
    fixtures/                   # Small deterministic edge cases
  docs/
    README.md                   # Map of important documents
    ARCHITECTURE.md              # Screen -> function -> test
    CORPUS.md                   # Collection, coverage, dates, duplicates
    YOUTUBE.md                  # Speakers, evidence, update and cost boundaries
    DECISIONS.md                # Short rationale, alternatives, limitations
    DEFENCE.md                  # Ukrainian speaking notes and demo scenarios
    TIME.md                     # Actual time, method, uncertainty; if published
  artifacts/
    evaluation/                 # Selected sanitized runs and manifests
    corpus/                     # Coverage/exclusions, no uncontrolled data dump
  costs/
    YouTube/                    # Generated exports of the same cost ledger
  scripts/
  .github/
    workflows/                  # Small required checks
  data/                         # Ignored local raw, media, DB, caches
```

Tests для сервісів і UI залишаються поруч із кодом, як у ARCHITECTURE.md; `eval/fixtures` — дані для сценаріїв, не друга система тестів. Створювати лише потрібні файли. Actual agents/skills/prompts повинні використовуватись, а не бути декоративними папками. Під час фінальної перевірки підтвердити обсяг REPORT/PROCESS у читабельному вигляді.

GitHub сам визначає порядок дерева; не обіцяти, що assignment буде фізично першим рядком. Порядок знайомства задає README з прямими посиланнями на завдання й seeds у першому екрані. Не додавати десятки префіксів `00_`, `01_` лише заради сортування.

Поточні великі планувальні файли з Desktop не копіювати в submission всі підряд. Відібрати фінальні рішення й перетворити на короткі docs; повний план і PDF залишаються робочими матеріалами. На корені немає `claude-work/`, `codex-work/`, raw screenshots, тимчасових review dumps чи дубльованих звітів.

## 4. README як зрозуміла точка входу

Перший екран: що робить система одним реченням; посилання **Assignment / Seed sources / Demo / Evaluation / Costs**; короткий статус із датою перевіреного run. Немає вигаданого «production-ready», значків зелених тестів без відповідного CI чи старих 20/20 як результату нового коду.

Далі: короткий приклад dated answer із джерелами → шлях запуску → схема функціональних блоків → таблиця вимога/доказ → відомі обмеження. Запуск охоплює Node version, install, keys, спосіб отримати корпус/index, start і eval. Підставні дані позначені fixtures; історичний replay не видається за live-запит. Команди перевіряються з чистої теки.

README і reviewer-facing docs англійською; захисні нотатки українською. У TIMELINE/DECISIONS можна одним абзацом пояснити, що нова реалізація поєднала перевірені ідеї двох попередніх прототипів, із посиланням на архівну гілку/commit. Особисті адреси серверів, credentials, домашні шляхи й глобальні правила інших робочих проєктів не переносити до публічного AGENTS.md. До публікації перевірити весь публікований історичний scope; очищений поточний файл сам по собі не прибирає секрет зі старого commit.

## 5. Історія роботи, час і чесні межі

У межах цього планування змінювалися файли Desktop/everstate_tests; `docs/TIME.md` і `docs/time/events.csv` у репозиторії не доповнювалися нашими діями. Не робимо висновків про дії інших процесів за одним git status.

TIMELINE — історія рішень і завершених результатів. TIME — облік тривалості з методом. Costs — гроші/API usage. Це три різні речі. Історія комітів не вимірює час безперервної роботи автора; паралельні агенти не додаються до людських годин.

Майбутній narrative можна сформулювати так: “Reviewed both prototypes and redesigned the implementation around a shared TypeScript ingestion pipeline, measured costs and evidence-based answers.” Дату/період і тривалість додавати за фактичними session events або як явно позначену оцінку автора. «Прокинувся вранці», точний початок о 15:00/15:05, 40 хвилин планування чи минулі 2–3 години не записувати як виміряне без підтвердження.

Початок нового execution block фіксується, коли він реально почнеться; не переносити сьогоднішню попередню роботу за межі обліку, щоб вийшло рівно три години. Історичні оцінки зберігати з provenance; реконструкція за подіями має припущення. Цим планом секундомір не стартує й жодні години не логуються.

## 6. Тригодинний бюджет майбутнього виконання

Робоче припущення: 180 хвилин включають до 40 хв на завершення планування. Старт T0 — фактичний майбутній старт; 15:00/15:05 залишаються запропонованими часами. Це **timebox, не гарантія**, що весь широкий corpus, YouTube attribution, UI й повний benchmark вмістяться. Платні remote jobs можуть тривати окремо; їхній elapsed не ховається.

| Від T0 | Фокус | Контрольний результат |
|---|---|---|
| 0–40 хв | Узгодити остаточний scope, repo map та критерії | Є один маршрут, список 20 питань і зрозумілий бюджет |
| 40–70 хв | Worktree/layout, спільні contracts, metrics, пробний ingestion | Працює одна вертикаль завантаження/обробки, є артефакт і receipt |
| 70–95 хв | Корпус і мінімальний YouTube шлях | Покриття/черга видимі; STT/Gemini jobs та їхні статуси обліковані |
| 95–120 хв | Search/answer/evidence/Trust | Доказова відповідь або чесна відмова через єдиний runtime |
| 120–145 хв | Основні UI-блоки й refresh demo | Пошук, джерела, Costs і новий corpus зрозумілі на екрані |
| 145–165 хв | Evaluation і виправлення важливих провалів | Збережені actual outputs, completion/quality відомі |
| 165–180 хв | Підготовка репозиторію до здачі | README/docs/checks, один фінальний вигляд, чесний список незавершеного |

Це розподіл пріоритетів, не технічні estimates для кожного рядка. На контрольних точках переглядати залишок обсягу. Якщо до останньої частини немає завершеного measured evaluation, не витрачати решту на декор і не заявляти успіх. Зупинка за бюджетом означає partial delivery із результатами/прогалинами, а не намальовані результати. Зміна загального обсягу або продовження після timebox обговорюються за фактичним станом.

## 7. Послідовні коміти під час реалізації

Коміт — завершена зрозуміла зміна з перевіркою, не таймер на кожні п’ять хвилин. Орієнтовні теми нижче уточнюються за реальною роботою; не створювати їх ретроспективно:

1. `chore: establish the single-implementation layout` — assignment, inputs, мінімальний runnable skeleton, docs map.
2. `feat: collect versioned sources with measured usage` — working ingestion, date/dedup fixtures.
3. `feat: ingest speaker-attributed video evidence` — мінімальний Soniox/Gemini pipeline, cache й costs.
4. `feat: answer from corpus evidence with validation` — search/read/calculate/submit, Trust і перевірки.
5. `feat: refresh sources and publish corpus snapshots` — no-change/change/failure, прогрес.
6. `feat: show live search, citations and costs` — потрібні блоки UI, reuse backend results.
7. `test: record the twenty-question evaluation` — фактичний прогін і чесні verdict, без зшивання успіхів.
8. `docs: prepare the submission and defence walkthrough` — фінальні README/REPORT/EVAL/COST/PROCESS/TIMELINE.

Це не вимога восьми комітів рівно й не обіцянка, що кожен блок буде готовий в одному коміті. Великі функції можна ділити на менші працюючі зміни. Перед commit — потрібні перевірки саме зачепленого коду та перегляд diff; не включати чужі зміни, secrets, caches чи необґрунтовані metrics. Авторизація на execution/Git-дії визначається наступним запитом, а не цим планувальним документом.

## 8. Останній пункт плану — репозиторій готовий до передачі

- У фінальному tree одна реалізація; старі прототипи доступні через справжню історію/архів, незакомічене не втрачено.
- Assignment і seeds знаходяться з першого екрана README; важливі документи мають зрозумілі назви й місце.
- README-команди перевірені; demo URL відповідає вказаному code/corpus revision або чесно описано local-only стан.
- EVAL, COST, UI та artifacts стосуються тих самих відомих запусків; incomplete/unknown не приховані.
- Публічне дерево й дозволений до публікації scope перевірені на credentials та зайві персональні дані. Бази/медіа доступні через контрольований артефакт або відтворювані команди, не великий dump у Git.
- Історія комітів і time records мають реальні дати/джерела; немає backdating або переписаної історії під часовий бюджет.
- Автор може перейти від екрана до функції, тесту й невеликої живої зміни. Merge/push/deploy відбуваються лише в рамках окремо дозволеного execution.


## 9. Перехід розпочато: перевірений стан

Після `git fetch origin` 2026-09-13:

- Локальний `main`: `a88447f`, останній author/commit timestamp 2026-09-12 19:30:21 +02:00.
- GitHub `origin/main`: `3d85f20`, commit timestamp 2026-09-12 18:10:45 +02:00. GitHub repository `pushed_at`: 2026-09-12 16:25:55 UTC, тобто 18:25:55 Europe/Madrid. Це репозиторна metadata останнього push-оновлення, не повний audit усіх push або доказ часу роботи над файлами.
- Історії розійшлися: 31 commit лише локально, 29 лише на remote. Причину розходження цим кроком не встановлено; однакові повідомлення з різними hashes не означають автоматично тотожні patches.
- Перед переходом `git status --porcelain` показав 70 entries, з них 14 untracked entries (деякі можуть бути цілими папками). Це не оцінка тривалості роботи.

Створено локальну `archive/two-implementations` на `a88447f`, яка зберігає закомічену локальну історію. Незакомічені файли залишаються в оригінальному checkout на `main`. Створено `dev` від `origin/main` (`3d85f20`) в `/Users/serbinov/Desktop/projects/personal/everstake-test-worktrees/rebuild`. Автоматичний upstream до origin/main знято, щоб майбутній push dev не мав неоднозначної цілі. Публікація гілок не виконувалася.

Чому dev від remote: так нові коміти продовжують опубліковану історію. Потрібні локальні покращення аналізуються й переносяться вибірково як нові зміни з provenance; не мержити розбіжну main wholesale і не робити force-push. Обидві старі версії поки фізично присутні у новому worktree як успадкований код, із явним статусом prototypes.

## 10. Видимий поступовий перехід

1. README пояснює, навіщо об’єднуємо перевірені ідеї двох прототипів і який стан нової версії.
2. З’являються assignment inputs, короткі docs та мінімальний новий skeleton; reviewers можуть зрозуміти напрямок до завершення.
3. Кожний блок реалізується й перевіряється окремо, історія відображає реальні завершені зміни.
4. Коли нова реалізація покриває потрібну поведінку, старі folders прибираються з active tree; історія та archive branch зберігають контекст.
5. Фінальні docs/eval/checks, потім дозволений merge без squash. Fast-forward можливий лише якщо цільова main є предком dev. Якщо remote main змінився, спершу звірка й звичайний merge зі збереженням історії, без автоматичного rebase/force.

Один накопичений commit може чесно зберігати перевірені старі зміни, але його timestamp означає момент запису, а не кілька годин роботи ввечері. Не оформлювати його так, щоб створити хибне враження часу. У цьому кроці такий commit не робиться: зміни ще потребують окремого diff review і перевірок.

## 11. Місце й назва майбутнього деплою

Погоджена продуктова назва: **Everstate Knowledge Base**. Хостинг — **My Personal Server**, особистий сервер `89.167.19.222`; схема адресації — `sslip.io`.

Планова адреса: **https://everstate-knowledge-base.89-167-19-222.sslip.io**. Це ціль конфігурації, не підтверджений live URL. Написання Everstate збережене за запитом користувача; назва компанії/завдання в документах — Everstake.

Окремі application process/service, вільний внутрішній порт і data directory; не використовувати порти/БД чи рестарти чинних Claude/Codex сервісів. Перед розгортанням перевірити DNS, доступність порту, reverse proxy й TLS/ACME; sslip.io дає DNS-адресацію, HTTPS потребує окремого сертифіката й конфігурації проксі.

Deploy script вказує code revision, package lock/runtime, corpus revision і health check. Не перезбирає й не транскрибує всю базу під час кожного deploy; дані зберігаються поза каталогом релізу. Конкретну технологію запуску обрати після read-only огляду сервера. Фінально перевірити зовнішній HTTPS, streaming, джерела, Costs і незалежність старих сервісів. Зараз DNS/сервер не перевірялися, деплой не виконано.
