# Українська версія

## Частина B: як би я автоматизував звіти

### Як це працює в мене

Я вже робив таку систему у своїй компанії для нашого відділу девелоперів. Наприкінці робочого дня запускаю скіл, який збирає звіт. Оскільки девелопери більшість задач роблять саме через Claude Code чи Codex і в нас переважно надиктовують їх через голосовий застосунок, для нас це було найкраще джерело.

Цей застосунок перетворює голос на текст і зберігає записи з датою та часом на комп’ютері. За ними видно, які задачі я ставив протягом дня. Claude Code і Codex після задачі також записують у changelog, що й коли зробили, з точки зору бізнес-задачі. Скіл зіставляє ці записи й із цього будує звіт. У мене ноттейкер до цього скіла ще не підключений, але його можна підключити, щоб також витягувати інформацію зі дзвінків. Або хоча б підключити Google Calendar, щоб за розкладом бачити, скільки часу було заплановано на кожен дзвінок. До цієї частини ще руки не дійшли.

Після збору звіт летить у Telegram-бот, де я його підтверджую. Також автоматично логується час у Jira. Вранці є список задач на сьогодні, і час записується в них. Якщо я робив щось, чого немає в списку, під це або створюється нова задача, або час логується у відповідну загальну таску з описом у таймлогах. Таким чином наприкінці дня в мене автоматично логується час, а я витрачаю на це десь 5 хвилин.

Тож для девелоперів це працює простіше. В інших відділах будуть свої джерела і, скоріш за все, більше ручних доповнень. Але багато чого теж можна автоматизувати.

### Звідки брати інформацію в інших відділах

Тут я бачу два підходи. Перший — підключатися до робочих систем. Я б почав із нього. Людина працює у Slack і Google Meet — беремо погоджені канали у Slack, а для дзвінків дивимося розклад у Google Calendar. Якщо зустріч стоїть із 13:00 до 13:45, можна взяти ці 45 хвилин за основу для таймлогу. Це час із розкладу, тому перед логуванням людина підтверджує, що дзвінок справді стільки тривав.

Більш просунутий спосіб — підключитися через API до ноттейкера. Я бачив, що він у вас є. З нього можна було б витягувати, про що говорили й скільки тривав дзвінок, за часовими мітками запису. Треба перевірити, які саме дані він віддає.

Далі, наприклад, бухгалтерський відділ. Бухгалтер може працювати у своїй CRM чи обліковій системі, і до неї може бути важко підключитися для отримання звіту. Хоча за допомогою Claude Code я б усе одно спробував: якщо є готовий API й доступи, цілком може вийти налаштувати це хвилин за 20. Але залежить від конкретної системи. У кожного відділу буде свій набір джерел для звіту.

Другий — локальний трекер. Хоч він і локальний, мені цей варіант усе одно не подобається. Трекер робить скріншоти раз на хвилину або п’ять. Їх обробляє локальний агент працівника на його комп’ютері й пробує визначити, чим людина займалася. Компанії йде тільки звіт, самі знімки їй не передаються. Оскільки на них можуть бути особисті дані, такий збір треба погодити з людиною.

Повної картини це теж не дає — між кадрами й поза комп’ютером є робота. Але це допомагає з такими випадками, коли людина працює в Excel або іншій системі, до якої важко підключитися. За знімками можна приблизно відновити заняття, а час усе одно варто звірити з людиною.

Найкраще покриття, на мою думку, дасть поєднання двох методів. Але у працівників можуть бути занепокоєння щодо приватності, і це треба обговорити заздалегідь.

Але треба розуміти: якщо бухгалтер працює в системі, до якої ми не під’єднані, відсутність записів не означає відсутність роботи. Це якраз і відкриває наступне питання.

### Повністю автономна система чи частково ручна?

Ми можемо запустити систему, яка сама збирає дані, але тут можливі огріхи й навіть казуси. Не завжди класно, щоб вони йшли далі. Наприклад, хтось на роботі переписувався про те, як копати город, і це потрапило у звіт.

Повністю автономно й без перевірки я б це не запускав. Я все одно залишав би рішення за людиною. А от стимулювати людей вчасно подавати звіти — можна.

### Як стимулювати людей подавати звіти

Якщо у відділі звіт подають раз на тиждень, так і залишаємо. Система може збирати дані у фоні протягом тижня, а людині надсилати одну чернетку перед строком подання. Керівник перевіряє підсумковий звіт відділу перед публікацією.

Можна налаштувати loop — автоматичний запуск завдання у визначений час. Наприклад, у п’ятницю о 18:30 система збирає дані за тиждень й надсилає людині приватну чернетку у Slack чи Telegram. Людина читає, трохи поправляє й відправляє. Тут ключове, що все запускається само: уже є готовий текст, який легше перевірити, ніж згадувати весь тиждень із нуля. Це знімає значну частину навантаження.

Якщо люди все одно не подають звіти, можна за попередньою домовленістю зробити щось на кшталт Slack-бота: у день подання о 18:30 приходить чернетка, а о 19:30 система передає керівнику звіт як є. Перед цим перевіряє, чи людина вже подала звіт за цей тиждень у визначеному каналі. Якщо так — повторно нічого не йде. Якщо перевірка не спрацювала — повідомляємо про збій, а не відправляємо навмання.

Система має відділяти бізнес-задачі від особистих розмов і прибирати згадки про копання картоплі. Але модель теж може помилитися, тому чутливі або спірні пункти залишаються на підтвердження людині.

### Як зрозуміти, що це допомагає

Я б місяць спробував на одному відділі й виміряв три речі: загальний час людей на тижневий звіт разом із перевіркою та правками, частку підтверджених тверджень і частку важливого, що потрапило у звіт. Початкові цілі — менше 20 хвилин замість години, 70–80% підтверджених тверджень у вибірці та 95% результатів і блокерів зі списку, звіреного керівником. Це цілі для перевірки, не готові результати.

### Мінуси

Часто AI-система генерує «бездушні» звіти. Наприклад, людина нарешті подолала важку задачу або сейлз після довгих переговорів закрив складного клієнта. А у звіті побачимо просто: «Провели переговори з клієнтом X і домовилися про подальшу співпрацю». Формально все правильно, але загубилося, чому це важливий результат і скільки зусиль за ним стоїть. Якщо нас цікавлять не просто таймлоги, а конкретний опис зробленої роботи, краще все одно давати людині керувати змістом. Я у своїй компанії багато разів допрацьовував цей процес. Зараз система автоматично генерує звіти, але я їх усе одно перевіряю, бо іноді бувають невідповідності.

### Що може зламатися і де агент не потрібен

Наприклад, відвалився Slack, а звіт виглядає повним. До генерації код перевіряє доступи, потрібні дати й очікувані записи. Якщо джерело недоступне або даних незвично мало, система повідомляє відповідального до дедлайну, повторює збір і блокує автовідправлення до перевірки. Розклад, доступи, підрахунки, перевірку вже поданого звіту й відправку робить звичайний код: тут потрібні чіткі правила. Агент зіставляє записи й пише зрозуміло. Людина доповнює те, чого система не бачить, і вирішує, що можна надсилати.

---

# English version

## Part B: how I would automate reporting

### How it works for me

I have already built this kind of system at my company for our developer team. At the end of the working day, I run a skill that puts the report together. Since developers do most tasks through Claude Code or Codex, and our team mostly dictates them through a voice-to-text app, that was the best source for us.

The app converts speech to text and saves timestamped records on the computer. Those records show which tasks I asked for during the day. After a task, Claude Code and Codex also write a changelog entry explaining what they did and when, in terms of the business task. The skill matches these records and builds a report from them. I have not connected a notetaker to this skill yet, but it could be connected to pull in information from calls as well. Or at least Google Calendar could be connected to see how much time was scheduled for each call. I have not got around to that part yet.

Once the report is ready, it goes to a Telegram bot, where I confirm it. Time is also logged automatically in Jira. In the morning, I have a list of tasks for the day, and time is logged against them. If I did something outside that list, the system either creates a new task or logs the time against a suitable broader task, with a description in the worklog. So by the end of the day, my time is logged automatically, and I spend about five minutes on the process.

That makes it easier for developers. Other departments will have their own sources and probably need more manual additions. But there is still plenty we can automate.

### Where to get information for other departments

I see two approaches. The first is to connect to work systems. I would start there. If someone uses Slack and Google Meet, collect the agreed Slack channels and check the call schedule in Google Calendar. If a meeting is scheduled from 13:00 to 13:45, those 45 minutes can be the basis for a worklog. That is the scheduled time, so the person confirms that the call actually lasted that long before it is logged.

A more advanced option is to connect to the notetaker through its API. I saw that you have one. It could provide what was discussed and how long the call lasted, based on the recording timestamps. We need to check which data it exposes.

Take the accounting department. An accountant might use their own CRM or accounting system, which could be difficult to connect to for reporting. I would still try with Claude Code: with an existing API and access, it might well take about 20 minutes to set up. But it depends on the particular system. Each department will have its own set of reporting sources.

The second approach is a local tracker. Even though it is local, I still do not like this option. The tracker takes screenshots every minute or five minutes. The employee’s local agent processes them on their computer and tries to work out what they were doing. The company receives only the report, not the screenshots themselves. Since screenshots can contain personal information, this collection needs to be agreed with the person.

This still does not give the full picture: work happens between screenshots and away from the computer too. But it helps when someone works in Excel or another system that is difficult to connect to. Screenshots can help reconstruct the activity roughly; the time still needs to be checked with the person.

I think combining the two methods would give the best coverage. But employees may have privacy concerns, and we need to discuss those in advance.

But we need to understand this: if the accountant works in a system we have not connected to, no records does not mean no work. That brings us to the next question.

### Fully autonomous or partly manual?

We can run a system that collects data on its own, but mistakes and awkward situations are possible. We do not always want those passed on. Someone might chat at work about digging their garden, and that ends up in the report.

I would not run this fully autonomously without review. I would still leave the decision to a person. But we can encourage people to submit their reports on time.

### How to encourage people to submit reports

If the department submits reports once a week, we keep that schedule. The system can collect data in the background during the week and send the person one draft before the submission deadline. The department head reviews the final department report before publication.

We can set up a loop: a task that runs automatically at a set time. For example, on Friday at 18:30, the system collects the week’s data and sends the person a private draft in Slack or Telegram. They read it, make a few edits and send it. The important thing is that it starts by itself: there is already a draft to check, instead of having to recall the whole week from scratch. That takes a lot of the effort away.

If people still do not submit reports, we could agree in advance to use something like a Slack bot: on the reporting day, the draft arrives at 18:30, and at 19:30 the system sends the report to the manager as it is. First, it checks whether the person has already submitted that week's report in the agreed channel. If they have, nothing is sent again. If the check fails, notify someone about the failure rather than sending blindly.

The system should separate business tasks from personal conversations and remove the bits about digging potatoes. But the model can make mistakes too, so sensitive or disputed items still need a person's confirmation.

### How to tell whether it helps

I would try this in one department for a month and measure three things: total human time spent on the weekly report, including review and edits; the share of supported claims; and the share of important work included. Initial targets would be under 20 minutes instead of an hour, 70–80% supported claims in a sample, and 95% of outcomes and blockers from a list checked by the department head. These are targets to test, not results we already have.

### Downsides

AI systems often produce “soulless” reports. For example, someone finally solves a difficult task, or a salesperson closes a challenging client after lengthy negotiations. The report just says: “Held talks with client X and agreed to work together.” Technically correct, but it loses why the result matters and how much effort went into it. If we want more than time logs and need a meaningful account of the work done, I would still let a person control the content. I have revised this process many times at my company. The system now generates reports automatically, but I still check them because there are sometimes inconsistencies.

### What could break, and where an agent is not needed

For example, Slack access fails, but the report looks complete. Before generation, code checks access, the reporting dates and expected records. If a source is unavailable or there is unusually little data, the system notifies the owner before the deadline, retries collection and blocks automatic sending until the issue is checked. Scheduling, permissions, counts, checking for an already submitted report and delivery are handled by ordinary code: these need clear rules. The agent matches records and writes clearly. A person fills in what the system cannot see and decides what can be sent.
