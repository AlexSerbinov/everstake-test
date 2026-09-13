# Everstake — план нової реалізації

Створено 2026-09-13. Статус: планування; нова система ще не реалізована й не виміряна.

Назва папки `everstate_tests` збережена відповідно до прохання користувача.

- [PLAN.md](PLAN.md) — спочатку якісний corpus-v1, потім оновлення, baseline й асистент; TypeScript, Trust Score та критерії готовності.
- [ARCHITECTURE.md](ARCHITECTURE.md) — дерево GitHub, карта «екран → файл → механізм», папки сервісів і UI-блоків, короткі README та репетиція пояснення коду.
- [LIVE_EXPERIENCE.md](LIVE_EXPERIENCE.md) — живий пошук і причини відбору з Codex, таймер та датовані джерела справа з Claude; сценарії й перевірки UI.
- [DECISIONS.md](DECISIONS.md) — що беремо з Claude, Codex і матеріалів захисту; що спрощуємо й чому.
- [MEASUREMENTS.md](MEASUREMENTS.md) — окремий облік підготовки агентами, індексації й API-оновлень; ресурси, evaluation і baseline.
- [CRAWLER.md](CRAWLER.md) — широкий пошук усіх релевантних джерел, підготовка з Codex/субагентами через TypeScript-код і самостійне оновлення; 200 документів — лише мінімум.

Джерело вимог: [оригінальне завдання](../projects/personal/everstake-test/docs/TEST_ASSIGNMENT_EN.md).
Попередня реалізація: [Codex](../projects/personal/everstake-test/codex-work/README.md).
Референс обліку витрат: [Claude COST.md](../projects/personal/everstake-test/claude-work/COST.md).

Ці файли описують майбутню роботу. Вони не підтверджують виконання етапів, нові результати тестів або деплой. Попередні task-файли є історією, а не дозволом на commit чи deployment нового проєкту.

- [REQUIREMENTS.md](REQUIREMENTS.md) — пункт за пунктом: вимоги завдання, покриття планом і майбутні докази виконання.
- [FEATURE_PRIORITIES.md](FEATURE_PRIORITIES.md) — реєстр можливостей Claude/Codex і захисту, пріоритети та свідомі спрощення.

- [EVALUATION_PLAN.md](EVALUATION_PLAN.md) — 20 відібраних питань із базового та складного банків, повний прогін, тести evaluator та екран із поясненням складності кожного кейсу.

- [DATA_UPDATES.md](DATA_UPDATES.md) — нові дані під час демо, плановий/позачерговий збір, дати перенесених статей, дублікати та активація нового корпусу.

- [YOUTUBE_PLAN.md](YOUTUBE_PLAN.md) — відбір відео, Soniox, Gemini 3.8 Flash speaker-review, атрибуція реплік, дати, кеш та YouTube Costs.

- [REPOSITORY_PLAN.md](REPOSITORY_PLAN.md) — фінальний вигляд репозиторію, збереження прототипів, dev/worktree, реальна історія й тригодинний timebox майбутнього виконання.

- [EXECUTION_PLAN.md](EXECUTION_PLAN.md) — конкретні пакети W00–W20, хвилі паралельної роботи, worktree субагентів, залежності й критерії приймання; для затвердження перед виконанням.
