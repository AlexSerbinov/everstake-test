# YouTube: від знайденого відео до датованої репліки з доказами

Погоджений підплан, 2026-09-13. **YouTube включаємо.** Базові субтитри допомагають відбирати матеріали; прийняті для корпусу відео обробляємо Soniox із діаризацією. Вихід — оригінальні репліки з часом, перевіреною або невідомою особою мовця та межами застосування. Платформа сама по собі не визначає довіру.

Це дизайн за аналізом локального коду й офіційних API-документів. Пошук конкретного каталогу Everstake на YouTube, підрахунок реальних відео/годин, завантаження аудіо й платна транскрипція ще не виконувалися. Імена й числа з усного прикладу користувача — ілюстрація, не факти про компанію.

## 1. Що вже є у власному пайплайні

Локальні джерела дослідження:

- [youtube-translate README](../projects/personal/translate-pipeline/youtube-translate/README.md), його AGENTS.md та `ytt/pipeline.py`: download → Soniox → сегменти, кеші та наступні етапи дубляжу.
- [Python Soniox client](../projects/personal/translate-pipeline/youtube-translate/ytt/soniox_client.py): upload, create, poll, transcript, cleanup; токени мають час, speaker label і мову.
- [Готовий TypeScript client](../projects/personal/translate-pipeline/voicebook-ts/src/providers/soniox.ts): той самий REST-підхід уже перенесений на TypeScript. Це найкоротша основа нового провайдера після адаптації.
- [diarize_check.py](../projects/personal/translate-pipeline/youtube-translate/ytt/diarize_check.py) і [його тести](../projects/personal/translate-pipeline/youtube-translate/tests/test_diarize.py): перевірка міток за аудіо; у коментарях задокументована заміна місцями ведучого й гостя після 20:16 у довгому відео. Це історичне спостереження, не свіжий тест Soniox.
- [download.py](../projects/personal/translate-pipeline/youtube-translate/ytt/download.py), [state.py](../projects/personal/translate-pipeline/youtube-translate/ytt/state.py), [usage.py](../projects/personal/translate-pipeline/youtube-translate/ytt/usage.py): yt-dlp, video ID, SQLite status, кеш і оцінка ціни по тривалості.

| Беремо | Змінюємо для Everstake | Не переносимо в цей модуль |
|---|---|---|
| Audio download, metadata, IDs, async Soniox, timed tokens | TypeScript-модуль, строгі response schemas, raw provider response та usage | Переклад у дубляж, TTS, підбір голосів, стать/F0, emotion tags, mux, Telegram watcher і платежі |
| Кеш артефактів і SQLite jobs | Ключі по audio/model/config revision, resume за provider job ID, єдиний ledger | Глобальний mutable usage із reset на кожному відео |
| Перевірку speaker drift як відомий ризик | Спочатку точковий audio QA і needs_review; автоматичний cross-check лише за підтвердженої потреби | Важкий ECAPA/Python стек як обов’язкову залежність першого TypeScript runtime |
| Розбиття оригінальної мови за speaker turns | Не зливати різних спікерів; зберігати контекст питання й виправлення | Дубляжний алгоритм парування перекладу з нульовими timestamps |

Старий pipeline рахує `usage.stt` після успішної транскрипції за тривалістю й явно називає costs estimates. Новий ledger записує attempt до submit, зберігає provider IDs і враховує вже оплачені помилки/повтори. Старе кешування за наявністю файла саме по собі не підтверджує сумісність версій. TypeScript-клієнт потребує збереження provider error type/request ID, перевірки невідомих полів, bounded upload і коректного status tracking; `any` та перетворення невідомого часу на 0 без прапорця не копіювати.

## 2. Зрозумілий маршрут

Пошук кандидатів → metadata й доступні captions → рішення про релевантність → перелік відео/годин і бюджет → audio → Soniox → speaker turns → контекстна перевірка Gemini 3.8 Flash → перевірка мовців і реплік → спільні sanitation/index → датовані цитати у відповідях.

Початкова підготовка: Codex і субагенти досліджують різні групи відео, а результати записують у спільний registry. Майбутній refresh виконує цей самий маршрут кодом/API. Невпевнені випадки стають needs_review; для них не потрібна вигадана автоматична впевненість.

## 3. Discovery: знайти релевантне, не музичний гурт

1. Почати з пошуку назви компанії, перевірених офіційних channel IDs, playlist і відеопосилань із її публічних сторінок. Далі — назва + interview/AMA/conference/podcast, продукти й підтверджені імена представників. Імена тут — discovery hints із джерел, не список правильних відповідей або автоматичне право говорити від компанії.
2. Зберегти metadata: videoId, URL, channelId, назву каналу, title/description, upload date, duration, languages, chapters, discovery query/URL, checkedAt. Усі результати дедуплікувати за videoId; пагінацію й обрізаний search scope показувати.
3. Якщо доступні — завантажити оригінальні ручні/автоматичні captions, зберегти track language, track type, час і raw. Прибрати повторювані rolling-caption фрази для аналізу, але зберегти оригінал. Captions є дешевим фільтром, не фінальною speaker-attributed транскрипцією.
4. Оцінити зв’язок із компанією: офіційні посилання, особи/ролі, предмет розмови й уривки про продукти/діяльність. Назва EVERSTAKE чи handle не є доказом тотожності. Не ставити універсальний поріг «три згадки бренду» або blacklist конкретного гурту.
5. Результат: accepted / excluded / needs_review, причини й уривки-підстави. Відео з музикою іншого бренду виключається за походженням і змістом; коротка реклама чи дубль окремо від справжнього інтерв’ю. Відсутність captions — captions_unavailable, не автоматичне «нерелевантно»; metadata, вступ або коротке прослуховування можуть обґрунтувати Soniox.
6. Блогерські огляди не відкидати лише за статусом автора: включати, якщо є корисне релевантне повідомлення, із third-party attribution. Розділяти власний коментар блогера й вставлений оригінальний виступ представника. Кліп із чужого інтерв’ю не є незалежним підтвердженням.

Довгі матеріали аналізувати за розділами/вікнами й показувати coverage; не приймати рішення за першими 1 000 символами, коли розмова про компанію починається пізніше. Для початкової вибірки агент переглядає сумнівне; для refresh той самий structured classifier може працювати через виміряний API. Source text не керує інструментами; captions проходять ту саму межу безпечного читання, що решта корпусу.

Підсумковий manifest: кількість discovered/accepted/excluded/needs_review, відома сумарна тривалість accepted, кількість unknown duration, нові та cached відео. Кількість відомих роликів не оголошуємо повним каталогом YouTube.

## 4. Soniox: мінімальний STT-прохід

Async-модель `stt-async-v5` на дату перевірки позначена active в [офіційному списку моделей](https://soniox.com/docs/stt/models). Перед реалізацією перевірити модель/ліміти знову й зафіксувати config revision. Використати `enable_speaker_diarization: true`, потрібні language hints або language identification. Для корпусу потрібна оригінальна мова, тому автоматичний переклад і всі етапи дубляжу вимкнені. Схема async: upload → submit → poll → download transcript. [Soniox async API](https://soniox.com/docs/stt/async/async-transcription).

Завантажувати audio-only через перевірений adapter yt-dlp, ffmpeg лише за потреби формату/нормалізації. TypeScript оркеструє ці CLI через argv без shell interpolation; це не запуск усього Python-застосунку дубляжу. Зберегти версії downloader/ffmpeg, аудіотривалість і hash. Blocking/access failure має окремий статус; старі нотатки про заблокований IP не доводять нинішню доступність. Не змінювати чужий чинний watcher чи його cookie jar.

Зберігати raw JSON, timed original tokens, confidence за наявності, null timestamps/speakers як unknown; діаризаційні labels краще лишати opaque strings. Групувати лише послідовні токени одного speaker у turns. Довгі turns розбивати по реченнях/темах, зберігаючи зв’язки й offset. Не об’єднувати всю мову Speaker 1 по всьому відео в один текст і не сортувати raw translation tokens із старих кешів за нульовим часом.

За можливості обробляти ціле прийняте відео: короткий уривок може втратити представлення гостя або подальше виправлення. Якщо потрібні частини через ліміти, кожна має mediaOffset і окремий namespace speaker labels; speaker_1 у частині A не стає speaker_1 частини B без перевірки. Покриті/пропущені інтервали й додатково оплачене overlap рахуються явно.

Provider файл/транскрипцію прибирати тільки після збереження локальних результатів і доступних cost evidence. Політика зберігання аудіо документована; transcript hash не замінює можливість перевірити сумнівний фрагмент. Невдала cleanup операція не запускає нову транскрипцію.

## 5. Діаризація і встановлення особи — різні кроки

Soniox повертає speaker labels на токенах, а не підтверджені імена людей. [Офіційний опис діаризації](https://soniox.com/docs/stt/concepts/speaker-diarization). Наша окрема прив’язка має вигляд: локальний label/інтервал → особа → її роль на момент запису → докази цієї прив’язки. Статуси: verified / proposed / unknown / disputed. Не використовувати стать, тембр чи припущення «хто говорить довше» для встановлення імені.

Докази: явне самопредставлення, звернення ведучого разом із наступною реплікою, титр у відповідному моменті, опис конкретного виступу й підтвердження ролі з офіційного джерела того періоду. Опис «інтерв’ю з X» сам по собі ще не визначає, чи X має label 1 або 2. Порядок перелічених гостей не є порядком спікерів. Відеокадр/титр можна перевірити при QA; розпізнавання особи за обличчям не потрібне.

Початковий corpus і нові відео: Gemini 3.8 Flash визначає запропоновані імена, ролі й speaker mapping із доказами; агент/reviewer звіряє неоднозначні та контрольні фрагменти. Без достатньої підстави відповідне поле лишається unknown. Перевірене походження каналу не робить усіх гостей працівниками компанії. Роль сьогодні не переноситься на інтерв’ю шестирічної давності, а колишня роль не оголошується чинною.

Перевірити вступ, середину, кінець і фрагменти, що підтримують важливі відповіді. Якщо label drift/overlap/монтаж викликає сумнів, обмежити перевірку особи конкретними інтервалами. Неперевірений сегмент не успадковує високу authority лише через однаковий label. Не заявляти повну точність speaker mapping за кількома прослуханими місцями.

Старий ECAPA cross-check корисний як майбутня діагностика сталості labels, але не називає людей і не є доказом їхніх посад. Спочатку достатні контрольні прослуховування й needs_review. Якщо speaker drift стає повторюваною проблемою, окремо виміряти користь автоматичної перевірки та вибрати доступний TS-сумісний adapter; не включати весь ML-стек без потреби.

### Gemini визначає особу й роль мовця

Уточнення користувача: Gemini 3.8 Flash відповідає не лише за перевірку переплутаних labels, а й за **первинну атрибуцію: який label належить якій людині, як її звати, яку роль і зв’язок із компанією зазначено в записі**. Це два завдання одного контекстного проходу; не робити два однакові платні виклики заради назв етапів.

Порядок: знайти представлення/самопредставлення → виділити назване ім’я, посаду й організацію → простежити звернення та відповідь → прив’язати до speaker label/інтервалів → зіставити з доступними джерелами особи → перевірити сталість mapping далі. Фраза ведучого «у нас у гостях COO…» описує гостя, а не самого ведучого. Наступна репліка допомагає прив’язати гостя, але її позиція сама по собі не є достатнім доказом за кількох учасників чи монтажу.

Вихід для кожного мовця: `speakerLabel`, `nameAsSpoken`, `nameAsTranscribed`, `normalizedName`, `personId` або null, `roleAsIntroduced`, `normalizedRole`, `organization`, `conversationRole` (host/guest/panelist/unknown), `roleTimeScope`, `identityStatus`, `roleStatus`, `mappingStatus`, `evidenceTurnIds`, `externalEvidenceRefs`, `verifiedIntervals`, `ambiguities`. Поля `nameAsSpoken` та normalizedName заповнюються лише за доступним доказом; якщо модель отримала тільки текст ASR, вона не може стверджувати, що чула правильне написання прізвища. Нормалізація не змінює raw transcript.

Ім’я, посада й label mapping мають окремі стани: можна знати посаду гостя з представлення, але не знати, яка з двох міток його; можна правильно прив’язати мітку, але не встановити написання прізвища. `roleAsIntroduced` — роль, заявлена в цьому записі, а не незалежно перевірена чинна посада. Для `personId` потрібне зіставлення підтверджувальних ознак (ім’я/організація/роль/період/публічний профіль), не лише схожий рядок прізвища.

Варіанти імені, ініціали й транслітерації Gemini позначає як кандидати. Перевірка опису, титру, самопредставлення або пов’язаного офіційного профілю може підтвердити написання. При суперечності зберігаємо alternatives і needs_review; не зливаємо різних людей автоматично. Продиктований приклад «Богдан О. Пришко» є ілюстрацією цього правила, а не зафіксованим ім’ям/посадою у конфігурації або доказом про Everstake.

Код перевіряє schema, існування refs/інтервалів, consistency mapping і відсутність незаконного підвищення unknown до verified. Семантичну правильність імені та ролі сам валідатор JSON не доводить. Чітке представлення з правильно прив’язаними репліками може дати атрибутоване твердження «у цьому інтерв’ю представлений як COO»; поточну посаду й authority для іншої теми з цього автоматично не виводити.

Кеш містить transcript/model/prompt revision, metadata й identity-evidence hash. Об’єднаний Gemini-виклик обліковується один раз у `youtube_speaker_review`, із переліком задач `identity`, `role`, `label_consistency`. Додатковий запит для сумнівного імені або аудіоперевірки — окремий attempt/cost, без повторного Soniox. Прийняте уточнення mapping переобробляє лише залежні evidence/index artifacts.

Тести: ведучий представляє COO і сам не стає COO; двох гостей названо в іншому порядку, ніж вони говорять; однакові прізвища різних людей; ASR помиляється в імені; ініціали й транслітерація; гість змінив посаду після запису; ім’я відоме, label невідомий; label відомий, роль не підтверджена. Контрольні очікування фіксуються за репліками/джерелами, не за згодою другої моделі.

### Окремий контекстний аудит Gemini 3.8 Flash

Додано за прямим побажанням користувача: для нової прийнятої транскрипції після Soniox і побудови turns виконувати окремий етап `youtube_speaker_review` через `gemini-3.8-flash`. Назву/доступність моделі перевірити перед реалізацією, фактичний model ID зберігати в run; не підміняти іншою моделлю мовчки. Це обов’язковий додатковий етап нового YouTube-плану, його вартість входить у бюджет кожного відео.

Вхід: оригінальні timed turns із Soniox labels, metadata, представлення учасників, докази запропонованої identity mapping та попередні перевірені interval mappings. Не передавати еталон правильних company facts: «правильне число» не має визначати, кому приписати репліку. Джерела передавати як недовірені дані через спільний безпечний model client. Контекст надає підстави для перевірки, а не дозвіл виконувати текстові інструкції відео.

Завдання Gemini: визначити особи й заявлені ролі за правилами вище, а також знайти місця, де питання й відповідь, самопредставлення, звернення на ім’я, займенники або позиція мовця суперечать speaker labels. Наприклад, гість раптом ставить серію запитань собі й ведучий відповідає від першої особи про роботу в компанії. Це сигнал для перевірки, а не доказ помилки: ролі в інтерв’ю можуть змінюватися.

Structured output: `speakers[]` із identity/role/mapping evidence та `status = no_issue_found | suspected_mixup | insufficient_context`; список `turnIds`, `startMs/endMs`, `observedLabels`, `suggestedLabels` за наявності підстав, `evidenceTurnIds`, коротке `reason`, `needsAudioReview`, перелік перевірених/непокритих інтервалів. Gemini також може позначити сумнівний попередній identity mapping. Не вимагати від моделі довільних відсотків впевненості й не додавати її self-confidence до Trust Score.

Коротка розмова, яка вміщується в обмеження, перевіряється цілком. Довга — послідовними тематичними/часовими вікнами з контекстом до/після і anchor turns представлення. Фіксувати coverage, повторний input за overlap і незавершені вікна. Загальне summary не заміняє оригінальні репліки у кожному вікні. Повторно подавати лише змінені/зачеплені вікна, якщо збережено сумісну версію контексту й mapping.

Код перевіряє існування turn IDs, межі часу, labels і відсутність зміни тексту/чисел. Підозра створює review annotation, не переписує raw transcript. Однозначне контекстне виправлення можна зберегти як model-proposed mapping; це ще не verified identity. Для високодовіреної персональної цитати підтвердження спирається на джерела особи/часу й перевірені фрагменти; спірне переключення перевіряється за аудіо або лишається unknown. Після прийнятого виправлення переобробляються attribution/evidence/index, не Soniox.

`no_issue_found` означає, що цей модельний прохід не знайшов проблем у зазначених інтервалах, не «спікери гарантовано правильні». Помилка Gemini дає `speaker_review_failed/pending`; не підвищувати trust і не зображати аудит виконаним. Контекстний аналіз не здатен надійно встановити акустичну тотожність голосів. Прослуховування/цільова audio verification залишається способом перевірки неоднозначності; якщо для цього викликається модель, її audio usage теж окремо обліковується.

Costs: stage `youtube_speaker_review`, video/transcript/window IDs, input/output/cache/reasoning usage за фактичними provider fields, ціни на дату виклику, attempts, time, status. Сам прохід і повтори оплачуються окремо від Soniox та попереднього attribution. Cache key містить transcript hash, model/prompt/policy version, identity evidence/mapping revision і window/context hash; unchanged refresh читає audit artifact без нового виклику. У загальному total ці call IDs рахуються один раз. Тести: штучна заміна labels, природна зміна ролей у розмові без помилки, недостатній контекст, перекриття вікон, invalid output, failed run і cache reuse. Для якості — ручна перевірка audio-backed pilot, а не згода Gemini із власною попередньою оцінкою.

## 6. Питання ведучого не є фактом компанії

Зберігати turns із функцією репліки: question / assertion / correction / quotation / hypothesis / unknown. Прив’язувати виправлення/заперечення до попереднього висловлювання лише за evidence spans. Це model-derived annotation з перевіркою refs у коді, а не безпомилковий синтаксичний класифікатор. Знак питання чи «ні» самі по собі недостатні; мовці цитують третіх осіб і самі себе.

Контрольний synthetic-case:

- 10:00, interviewer: «Правильно, що ви підтримуєте 2700 мереж?»
- 10:08, verified representative: «Ні, зараз понад 130 мереж».
- До доказового контексту входять обидві репліки. 2700 — question premise із запереченням, не company fact; понад 130 — атрибутована відповідь станом на період інтерв’ю, не автоматично сьогоднішня кількість.

Не видаляти хибну передумову з raw: вона пояснює виправлення. `read` по passage повертає сусідні turns, потрібні для question-answer/correction зв’язку; якщо потрібна відповідь поза вікном — агент дочитує. Окремий рекламний фрагмент чи фраза без контексту не може отримати право підтверджувати число.

Семантична модель пропонує claim ↔ turn ↔ speaker/time links; сервер перевіряє їх існування, speaker status, bounds, числа/одиниці та заявлені обмеження. Верифікація цитати не доводить повного розуміння розмови. Якщо speaker/число/заперечення сумнівні — не надавати впевнену factual-відповідь на цій підставі. Точкове прослуховування або додаткове джерело краще за автоматичне «виправлення» транскрипту з пам’яті моделі.

## 7. Довіра до репліки, а не до платформи

Окремі осі: походження відео, встановлена особа, її повноваження щодо теми, роль висловлювання, часовий scope, якість транскрипції, незалежність джерела. Вони входять у чинні authority/temporal/grounding/agreement компоненти Trust, без нового другого score чи прихованого бонуса «CEO». T1/T2/T3 — пояснювальні категорії доказу для поточного питання, не глобальна immutable оцінка всього відео.

| Репліка / питання | Як використовуємо |
|---|---|
| Перевірений представник пояснює стратегію того періоду | Сильне пряме джерело для історії заявленої стратегії; може бути T1 у цьому scope |
| Представник називає кількість мереж або тариф | Пряма заява на дату інтерв’ю; для поточного стану зіставити зі свіжими релевантними даними. T2 можливий, але не автоматичне правило для всіх factual питань |
| Представник заявляє «ми виконали план» | Доказ заяви; фактичний результат потребує відповідних підтверджень |
| Блогер переказує пресреліз | Атрибутований переказ, типовий T3; не незалежне підтвердження оригіналу |
| Незалежний експерт описує власне вимірювання | Оцінювати метод і предмет, не знижувати лише через відсутність роботи в компанії |
| Ведучий ставить питання, цитує чутку чи працівник говорить поза компетенцією | Не company fact; зберегти контекст і межі |
| Unknown speaker або спірна репліка | Не персональна authoritative цитата; можна показати невизначеність і шукати інші докази |

Не викидати історичні інтерв’ю через давність. Для «як компанія розвивалася» потрібні різні періоди. Для «що компанія планує зараз» старі плани — історія, не актуальний намір. Стабільний факт, наприклад дата заснування, може мати старе релевантне джерело; число мереж, посада чи умови продукту потребують часової перевірки. Стабільність визначати за властивістю та контекстом твердження, не тільки за словом CEO чи жанром synthesis. Не робити висновок «він сказав пізніше, отже завжди правий».

## 8. Час та цитати

Окремо: uploadAt, recordedAt/eventAt за доказом, fetchedAt, transcribedAt, claimEffectiveAt за явною підставою. Запис конференції 2020, опублікований у 2024, описує подію 2020. Якщо recording date невідома, показати дату публікації з цією межею; транскрипція сьогодні не омолоджує зміст. Зберігати precision, provenance та часові конфлікти.

Джерело у відповіді: `[n]`, title/channel, перевірене ім’я/роль або Speaker unknown, оригінальна цитата, інтервал `10:00–10:15`, дата запису/публікації та `https://www.youtube.com/watch?v=VIDEO_ID&t=600s`. За короткого виправлення посилання починається з питання або доступний показ попередніх turns. Якщо є переклад для UI, він явно позначений; оригінал залишається доказом. Video title/description і кадр із субтитром не заміняють того, що справді сказано в аудіо.

## 9. Простий TypeScript-модуль

Один модуль `src/services/youtube/`, спільні SQLite/jobs/measurements/evidence/indexer з рештою системи. Не мікросервіс і не залежність від приватного робочого шляху translate-pipeline. Під час реалізації адаптувати мінімальні потрібні функції, зафіксувати походження; незалежно перевірити ліцензію перед публічним переносом коду.

```text
src/services/youtube/
  README.md
  discover-videos.ts         # Candidate metadata and pagination
  screen-video.ts            # Captions, relevance and recorded decision
  transcribe-video.ts        # Audio, cached job and original transcript
  build-speaker-turns.ts     # Consecutive words into timed turns
  review-speakers.ts         # Metered Gemini contextual label audit
  attribute-speakers.ts      # Evidence-backed local identity mappings
  build-video-evidence.ts    # Dialogue links and shared evidence contract
  youtube.test.ts            # Offline invariants and failure cases
src/providers/soniox.ts      # Small typed async client, metered calls
src/workflows/import-youtube.ts
prompts/video-relevance.md
prompts/video-speaker-review.md # Identity, role and label consistency in one pass
config/youtube.yaml          # Source candidates, limits, model, policy
web/features/corpus/youtube-sources.ts
web/features/answer-sources/video-passage.ts
Costs/YouTube/README.md       # Accounting boundary, generated exports
```

`screen-video` використовує metadata/captions; attribution працює по transcript/доказах особи й не бачить evaluation references. `build-video-evidence` створює provenance/turn links, не готові відповіді про компанію. Типи в чинному contracts.ts: VideoCandidate, TranscriptRevision, SpeakerTurn, SpeakerAttribution, VideoEvidence. Не заводити глобальний реєстр усіх посад і всіх фактів.

Мінімальні поля: videoId/channelId/mediaHash, duration, дати/походження, transcript/model/policy revisions, turnId/startMs/endMs/text/speakerLabel; окрема mapping identity/roleAtTime/evidenceRefs/verifiedIntervals/status. Для evidence — turnIds, speechAct, relatedTurns, dateScope, modelDerived flags. Дані stages зберігаються в загальній БД і raw artifacts, а не у довільних mutable JSON globals.

## 10. Кеш і повторне оновлення

Discovery повторюється по каналах/пошуку; нові IDs проходять screening. Refresh не транскрибує всі відео знову. Стани: discovered → screened → accepted → queued → submitted → transcribed → attributed → indexed; excluded, needs_review, blocked, failed — явні відгалуження. Зберігати незалежний стан кожного етапу, щоб успішний STT не означав готовий corpus.

- Audio/download artifact ідентифікується video ID та реальною media revision/hash. Metadata/captions revision не завжди означає зміну аудіо. Для обрізаного/зміненого відео, повторного імпорту чи force-check валідувати duration/content; чесно позначати, коли media незмінність лише припущена. Не обіцяти виявлення кожної заміни без повторної перевірки медіа.
- STT cache key: media hash + provider/model + transcription config. Speaker-review key: transcript/window/context hash + Gemini model/prompt + mapping/evidence revision. Attribution key: transcript hash + attribution policy + identity evidence version. Index key: clean transcript/turns + sanitizer/chunker/embedding versions.
- Новий мовець/виправлена mapping переобробляє attribution/index, а не платить за Soniox знову. Нові chunks embedding-обробляються, незмінні повторно використовуються.
- Provider job ID зберігати відразу після submit. Poll timeout не є підставою створити новий платний job: відновити status за ID. Якщо create response втрачена, reconciliation через client reference/список jobs за підтримки API, інакше needs_reconciliation. Не припускати idempotency create без гарантії провайдера.
- Одне активне завдання на cache key; crash recovery, атомарні artifacts, cancel без автоматичного повторного submit. Retry обмежений за типом помилки, не всі 429 однакові. Невідоме списання лишається unknown до звірки.
- Reupload/short clip з іншого video ID — можливий duplicate recording: порівняти audio hash або текст і metadata, записати origin/clip relation. Спікери локальні для recording, не просто однакові labels між роликами. Незнайдений дублікат не має автоматично збільшувати independent agreement.

Початковий список verified identities може готувати агент із доказів; наступний API refresh не залежить від інтерактивного Codex. Невирішена атрибуція не блокує весь сайт-корпус і не перетворюється на високодовірений video fact. Активація нового snapshot та історичні відповіді працюють за загальним DATA_UPDATES contract.

## 11. Витрати: прогноз окремо від фактичного обліку

На 2026-09-13 Soniox описує async STT як приблизно $0.10/год, але таблиця тарифів є token-based: $1.50 за 1M input audio tokens, $3.50 за 1M input text та $3.50 за 1M output text. Діаризація включена. Перед оплатою перевірити чинний тариф. [Офіційні ціни](https://soniox.com/pricing).

Планова ціна: сума duration прийнятих нових відео / 3600 × $0.10. Наприклад, **умовні** 12 годин ≈ $1.20 лише STT, не фактичний каталог чи повна ціна модуля. Окремо screening/attribution LLM, обов’язковий Gemini speaker-review, embeddings, retries і можливі додаткові аудіопроходи; captions/download мають ресурсні витрати навіть без STT-рахунку. Unknown duration показати окремо.

Фактичний облік: audioTokens × 1.50/1M + inputTextTokens × 3.50/1M + outputTextTokens × 3.50/1M, коли токени справді доступні з provider usage. Не рахувати довільні слова транскрипту як billing tokens. GET transcription документує duration і job metadata, але переглянута response schema не містить повної token/cost деталізації: [API reference](https://soniox.com/docs/api-reference/stt/transcriptions/get_transcription). На першому pilot з’ясувати доступний usage/billing export. Якщо є лише aggregate charge, показати суму по scope та окремо method-labelled allocation, не вигадувати точну ціну конкретного відео.

У `Costs/YouTube/` зберігати exports спільного ledger: inventory до запуску, per-video/stage/attempt CSV або JSON, датований pricing snapshot, reconciliation notes й підсумковий звіт. Це папка звітів, не друга БД. У Costs UI є category=YouTube, загальний total містить ці витрати один раз; STT billed media seconds/tokens не змішуються з LLM text tokens без позначення одиниць.

Для відео: planned duration, measured/provider duration, job ID, stage, cache hit, estimate, accounted cost, billing status, model/config version, attempts/errors. Cached run має $0 нових STT-витрат, але зберігає посилання на первісну оплачену транскрипцію. Окремо показати integration/development API spend та incremental refresh. Відновлення чи видалення remote artifact не стирає cost history.

## 12. Перевірки й порядок реалізації

1. Зібрати реальний candidate inventory з captions/metadata, acceptance reasons та сумарною тривалістю; не запускати масовий STT до відбору. Зберегти skipped/unknown.
2. Підготувати TS adapter, contracts, ledger, offline fixtures, Gemini speaker-review й source speaker/date rules. Відокремити оригінальну транскрипцію від усіх функцій дубляжу.
3. Pilot: кілька відібраних різних відео — прямий виступ, інтерв’ю, старий запис/перепублікація, сторонній огляд за наявності. Перевірити audio text, labels, names і costs; кількість та години визначає inventory, не цей план.
4. Виправити загальні дефекти, обробити решту прийнятого. Непевну особу/репліку лишити needs_review. Виміряти користь відео для покриття історії/стратегії та сумнівних фактів.
5. Перевірити повторний no-change/new-video/mapping-change/crash run. Показати timed source cards і YouTube Costs. Потім включити новий snapshot у загальний evaluation.

| Fixture / сценарій | Що має довести |
|---|---|
| Музичний однойменний канал; справжній гість на сторонньому каналі | Відбір за походженням і змістом, не brand/host shortcut |
| Немає captions, але підтверджене інтерв’ю | Відсутність captions не виключає корисне відео |
| «2700?» → «Ні, понад 130» | Передумова не стає фактом; corrected claim має правильного мовця й дату |
| Гість цитує ведучого, іронія, «так, але…» | Speech act і достатній контекст; unknown за невпевненості |
| Speaker labels міняються місцями, overlap, монтаж, короткі «так» | Не приписати сумнівну репліку CEO за початковою mapping |
| Назви/числа розпізнані неправильно | Audio QA / warning; модель не домислює виправлення |
| Інтерв’ю 2020, upload 2024, transcription 2026 | Не видати старий факт чи намір за нинішній |
| Старий стабільний факт і стара змінна метрика | Різний часовий scope; історія збережена |
| Кліп/перепублікація/дві мовні доріжки | Один origin не стає кількома незалежними доказами |
| Повтор refresh, timeout після submit, crash після STT | Не дублювати оплату; recover job і cached artifacts |
| Зміна mapping або policy | Перебудувати потрібний етап, не транскрибувати повторно без причини |
| AI-інструкції в captions/description/audio | Ті самі ingestion/read safety invariants, ніяких tool commands із джерела |

Це локальні тести модуля, а не ще 20 обов’язкових платних питань. Основний evaluation лишається 20. E05 про історію/позиціювання використовує нові відеодокази лише після перевірки refs і фіксації нового corpus; E01 перевіряє, що старе інтерв’ю не перемагає актуальні докази автоматично. Окреме small ablation «із відео / без відео» можна зробити на релевантній підмножині з прозорою ціною, якщо потрібно довести користь включення відео.

Критерій готовності: релевантні записи знайдені й обліковані, accepted отримали transcript або явну причину відсутності; цитати мають timecodes і походження speaker/date; хибні передумови та unknown speakers не отримують автоматичну authority; повторний збір не оплачує незмінний STT; Costs показує measured/estimated/unknown окремо. Залишкові помилки ASR, attribution та неповнота discovery описані чесно.
