# Можливості попередніх версій: що переносимо

Реєстр основних продуктових та інженерних можливостей, перевірений 2026-09-13 за README, реалізаціями ключових механізмів і матеріалами захисту. Це не повторний runtime-аудит кожного endpoint і не підтвердження історичних рекламних гарантій. Детальні причини та відомі помилки — у [DECISIONS.md](DECISIONS.md).

**P0** — обов’язковий результат завдання або необхідний механізм для нього. **P1** — потрібне для погодженого демо/побажань користувача. **P2** — додати лише за доведеної користі. **P3** — відкласти або замінити простішим рішенням. Складність нижче відносна, не оцінка годин. Порядок реалізації залишається corpus-first у PLAN.

| Можливість / походження | Ранг | Складність | Рішення і місце в новій системі |
|---|---|---|---|
| Seeds + sitemap discovery, обидві версії | P0 | Середня | crawler: конфіг джерел, обмежений frontier, явне походження URL |
| Robots, retries, exclusions, обидві | P0 | Середня | crawler: облік доступу, ліміти й причини пропуску |
| HTML/docs/GitHub extraction, обидві | P0 | Середня | Загальні адаптери форматів; зберігати заголовки, таблиці, примітки |
| Snapshot і manifest, обидві | P0 | Низька | storage/crawler: raw, hash, provenance, відтворюваність |
| Exact/near dedup, обидві | P0 | Середня | indexer: групи копій, звіт; зміни фактів не знищувати як копії |
| BM25 + embeddings, обидві | P1 | Середня | search: один простий fusion; виміряти виграш проти baseline |
| Bounded read + контекст поруч, обидві | P0 | Низька | search: дочитати умови й уточнення, реєструвати видимий уривок |
| Цикл search/read/submit, обидві | P1 | Середня | answer: обмежений цикл, один registry tools, stop коли немає нових доказів |
| Калькулятор, обидві | P1 | Низька | evidence: тільки дозволена арифметика, джерела операндів та припущення |
| Актуальність і часовий синтез, обидві | P0 | Середня | Загальний claim/time contract; історія й поточна сторінка не рівнозначні |
| Авторитет та stated/reported, обидві | P0 | Середня | evidence: хто стверджує, про що і з якою підставою; не абсолютна правота бренду |
| Точні цитати й числові gates, обидві | P0 | Середня | evidence: refs, scope, units, dates; збіг числа не доводить зміст |
| Partial/no reliable answer/error, обидві | P0 | Низька | Явні типи status, інфраструктурний збій окремо |
| Sanitation index/read + tagged data, обидві | P0 | Середня | evidence: єдина межа обробки, не просто інструкція в prompt |
| Allowlisted tools/URLs, обидві | P0 | Низька | Сервер обмежує доступ; текст документа не керує shell/network |
| Poisoned-copy adversarial, Claude; adversarial Codex | P0 | Середня | Короткий набір інваріантів через реальну індексацію копії БД |
| 20Q і окремий invented count, обидві | P0 | Середня | evaluation: actual answers, незалежна змістова оцінка, всі невдачі |
| Evaluation UI: основні 20, складність кожного питання | P1 | Середня | Погоджено користувачем: один набір із 20, збережені verdict/джерела/ціна, спільний report із EVAL.md |
| Single-shot baseline, Claude | P1 | Низька | Один корпус, модель і gates; лише без агентного повторного пошуку |
| MCP comparison, обидві | P0 | Низька | Один чесний абзац на перевірених прикладах; live-цифри не змішувати зі static |
| Єдиний API ledger і stage metrics, Claude | P0 | Середня | measurements: всі виклики, повтори, stage/run IDs, CPU/RAM/wall |
| Itemised receipt і Cost view, Claude | P1 | Низька | costs: одна SQL-основа з COST.md, не другий лічильник у UI |
| ×50 arithmetic, обидві | P0 | Низька | Виміряні одиниці + явно зазначені припущення масштабування |
| Нумеровані джерела справа, Claude | P1 | Низька | answer-sources: картки зі screenshot, точні уривки й дати |
| Таймери, Claude | P1 | Низька | live-search: реальний elapsed, cleanup, відрізняти серверний час |
| Нові/повторні/відкинуті результати, Codex | P1 | Середня | live-search: події реальних tool results, причини фільтрації |
| Verification checks, Codex | P1 | Низька | verification: список фактично виконаних перевірок з обмеженнями |
| Trust Score breakdown, обидві | P1 | Середня | trust: проста формула в коді, без model self-confidence |
| Corpus explorer і coverage, обидві | P1 | Низька | Мінімальний список документів/дат/статусів і посилання на звіт |
| Conditional refresh/hash cache, обидві | P1 | Середня | crawler/indexer: зберігати попередні snapshots, тільки змінені embeddings |
| Due scheduler і refresh now, обидві | P1 | Низька | Погоджено: планова/позачергова перевірка джерел, один worker; без конструктора політик |
| YouTube discovery, Soniox і Gemini speaker-review | P1 | Середня | Погоджено: відбір, timed turns, підтвердження особи, контекстний аудит і окремі Costs; див. YOUTUBE_PLAN.md |
| PDF/image extraction, матеріали blind spots | P2* | Середня | Цільовий extractor; стає необхідним, якщо без нього втрачаються обов’язкові докази |
| People registry/sync, обидві | P3 | Середня | Не будувати глобальний список посад; зберігати атрибуцію уривка й перевірене походження |
| Фіксований реєстр 21 fact key, Claude | P3 | Висока | Замінити локальними claims конкретного запиту; retrieval старої версії не обмежений лише цим ledger |
| Глобальні contradiction penalties, обидві | P3 | Висока | Зіставляти subject/metric/unit/time/scope в поточних доказах; не карати за чужі числа |
| CEO/метрика → спеціальні URL, Codex | P3 | Середня | Прибрати question-specific routing; source config не має знати правильну відповідь |
| Signed receipts/hash chain, Codex | P3 | Висока | Зберегти run IDs, snapshots, hashes; криптопідпис не доводить істинність цитати |
| Live MCP/динамічні показники, обидві | P3 | Середня | Поза corpus-only основним шляхом; для порівняння чітко окремі умови |
| Власний MCP server, обидві | P2 | Середня | Після основного API; не потрібен для порівняння з MCP компанії |
| Freshness calculator/policy presets, обидві | P3 | Середня | Статична пояснена ×50 таблиця й лог refresh замість складного екрана |
| Live settings/Trust weight editor, обидві | P3 | Середня | Редагований config + тест достатні для живої зміни; ваги eval заморожені |
| Fact timeline/contradictions dashboard, Claude | P2 | Середня | Спершу історія прямо у відповіді; окремий dashboard тільки за потреби |
| Refusal analytics/instruction explorer, Claude | P2 | Низька | Спершу звіт і debug artifact, не нові UI-розділи |
| Agents/skills/prompts як файли, обидві | P0 | Низька | Реальні prompts і agent config завантажуються; skill викликає наявний CLI/API |
| BM25-only fallback, Claude | P2 | Низька | Позначений degraded mode; окремі метрики, не приховувати зміну умов |
| Багато model providers і live перемикання, обидві | P3 | Середня | Мінімальні потрібні клієнти; конфіг, явні помилки й виміри всіх attempts |
| Responsive UI, обидві | P1 | Низька | Дві колонки desktop, джерела нижче mobile; keyboard navigation |
| Theme/settings decoration, обидві | P3 | Низька | Один читабельний вигляд достатній до виміряного результату |
| Production ACL/private calls scale, REPORT/defence | P3 | Висока | Лише місячна перспектива; не заявляти реалізоване в публічному демо |
| Business finding, defence 12 | P1 | Низька | Один підтверджений дефект корпусу та його вплив; без вигаданої бізнес-користі |
| Part B + Process Discovery, defence 13 | P0 | Низька | Одна сторінка та репетиція питань; не створювати Slack-інтеграцію |
| Live change/blind questions, defence 14–15 | P0 | Середня | Переносимі тести й пояснення коду; не кнопка з підігнаною відповіддю |

## Як використані матеріали захисту

[Аудіо-конспект](../everstake-defence-audio/README.md) охоплює 15 основних тем і короткі повторення. Теми 01–02 → критерії/межі демо; 03 → temporal/number traps; 04–05 → crawler/dedup/injection; 06 → attribution з відмовою від жорсткого fact ledger; 07–08 → tools/gates/Trust; 09 → eval/cost/MCP; 10 → refresh без великого калькулятора; 11 → перенос ідей Codex у TypeScript; 12 → перевірена знахідка; 13–15 → PROCESS і репетиція захисту. Технічні `_notes` містять історичні розбіжності: слова «гарантує» не переносяться без відповідної перевірки.

Посилання на інвентар інтерфейсів: [Claude README](../projects/personal/everstake-test/claude-work/README.md), [Codex README](../projects/personal/everstake-test/codex-work/README.md). UI-механізми звірено з `claude-work/public/app.js` (`renderSources`, `sourceCardHtml`, `sourceDateHtml`, `wireCitationClicks`) та `codex-work/web/app.js` (`describeToolResult`, `evidenceRow`, `renderToolEvidence`). Точні цитати й дати нового UI описані в [LIVE_EXPERIENCE.md](LIVE_EXPERIENCE.md).

## Межа простоти

P0/P1 не означають окремий мікросервіс або екран на кожний рядок: багато можливостей — функція чи поле в наявному блоці. Новий модуль виправданий окремою відповідальністю. P2 додаємо після конкретного провалу/потреби; P3 не потрібні для завершення плану. Першими при обмеженні часу скорочуємо dashboards, provider variety й допоміжні benchmarks, а не обов’язковий evaluation або здатність змінити код наживо.
