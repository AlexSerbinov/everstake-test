import type { EvaluationLanguage } from "./evaluation-language.js";

// Exact saved wording is the key: a later assessment must never inherit an older translation.
const englishAssessments: Record<string, string> = {
  "130+ повторено з профілю MCP без розрізнення активних мереж і сумарного досвіду. Потрібний масштаб і суперечність з іншими джерелами не встановлено.":
    "Repeats 130+ from the MCP profile without distinguishing active networks from cumulative experience. The required scope and conflict with other sources are not established.",
  "20-денне обмеження повторної зміни валідатора відділено від доступних для отримання нагород. Немає твердження, що заблоковано весь гаманець.":
    "Separates the 20-day restriction on changing validators again from rewards available to claim. Does not claim the whole wallet is locked.",
  "20-денне обмеження повторної зміни валідатора відділено від доступних для отримання нагород. Немає твердження, що заблоковано весь гаманець. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Separates the 20-day restriction on changing validators again from rewards available to claim. Does not claim the whole wallet is locked. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "3 мс пояснено як медіану всередині регіону, а не гарантію для кожного повідомлення. Враховано розташування отримувача й доставку без гарантії.":
    "Explains 3 ms as an intra-region median, not a guarantee for every message. Accounts for receiver location and best-effort delivery.",
  "3 мс пояснено як медіану всередині регіону, а не гарантію для кожного повідомлення. Враховано розташування отримувача й доставку без гарантії. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Explains 3 ms as an intra-region median, not a guarantee for every message. Accounts for receiver location and best-effort delivery. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Є згадка одного аудиту ETH2 Batch Deposit Contract, але немає потрібного порівняння двох аудитів. Часткові відомості не закривають питання.":
    "Mentions one ETH2 Batch Deposit Contract audit but does not provide the required comparison of two audits. Partial information does not answer the question fully.",
  "Ім’я CEO правильне. Знижено оцінку за зайвий титул зі старішого огляду й непояснену різницю з актуальною сторінкою.":
    "The CEO's name is correct. Points were deducted for an extra title from an older review and the unexplained difference from the current page.",
  "Історичне партнерство Nexus Mutual датоване 2022 роком. Відповідь не вигадує ліміт полісу чи гарантію повернення всієї суми за будь-якого slashing.":
    "Dates the historical Nexus Mutual partnership to 2022. Does not invent a policy limit or promise full reimbursement for every slashing event.",
  "Гарантії та ліміт полісу не вигадано. Бракує окремої явної відповіді про невстановленого вигодонабувача.":
    "Does not invent guarantees or a policy limit. Lacks a separate explicit statement that the beneficiary is not established.",
  "Головний висновок і конфлікт регіонів правильні. Покриття Direct Shreds та Relayer по містах розібрано не повністю.":
    "The main conclusion and regional conflict are correct. Direct Shreds and Relayer coverage by city is not fully addressed.",
  "Дві окремо знайдені цифри помилково подано як рівні: 1 000 000 lamports і 0,0005 SOL. Жодне з наведених джерел не підтверджує цю рівність. Також пропущено умови місячного строку договору.":
    "Incorrectly equates two separately sourced figures: 1,000,000 lamports and 0.0005 SOL. None of the cited sources supports this equality. Also omits monthly contract terms.",
  "За наведеними місячними тарифами отримано 19 140 доларів за 12 місяців. Це прямо відділено від річної комерційної пропозиції та відсоткової комісії.":
    "Calculates $19,140 for 12 months using the quoted monthly rates. Explicitly distinguishes this from an annual commercial quote and a percentage fee.",
  "За наведеними місячними тарифами отримано 19 140 доларів за 12 місяців. Це прямо відділено від річної комерційної пропозиції та відсоткової комісії. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Calculates $19,140 for 12 months using the quoted monthly rates. Explicitly distinguishes this from an annual commercial quote and a percentage fee. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Знайдено правильне ім’я CEO, але відповідь спирається на огляд липня з подвійним титулом CEO & President. Актуальний склад керівництва зі сторінки компанії не перевірено; суперечність титулів не пояснено.":
    "Finds the correct CEO name but relies on a July review with the dual title CEO & President. Does not verify current leadership against the company page or explain the conflicting titles.",
  "Ключ транспортного доступу не переплутано з підписантом транзакції. Суперечність між необов’язковим tip і вимогою мінімального tip показано відкрито.":
    "Does not confuse the transport access key with the transaction signer. Clearly shows the conflict between an optional tip and a required minimum tip.",
  "Ключ транспортного доступу не переплутано з підписантом транзакції. Суперечність між необов’язковим tip і вимогою мінімального tip показано відкрито. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Does not confuse the transport access key with the transaction signer. Clearly shows the conflict between an optional tip and a required minimum tip. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Контроль ключів відділено від ризику slashing. Відповідь не обіцяє недоторканність основної суми чи конкретне відшкодування.":
    "Distinguishes control of keys from slashing risk. Does not promise protection of principal or a specific reimbursement.",
  "Контроль ключів відділено від ризику slashing. Відповідь не обіцяє недоторканність основної суми чи конкретне відшкодування. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Distinguishes control of keys from slashing risk. Does not promise protection of principal or a specific reimbursement. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Механізм і обмеження пояснено правильно. Варто чіткіше відділити звичайний вхід у пул від шляху Instant Stake.":
    "Explains the mechanism and restrictions correctly. Should distinguish ordinary pool entry from the Instant Stake route more clearly.",
  "Наведено лише призначення CEO у червні 2025 року. Запит про нинішнє керівництво залишився без перевіреної відповіді.":
    "Only cites the CEO appointment in June 2025. Leaves the question about current leadership without a verified answer.",
  "Названо основні сертифікації та рамки відповідності. DORA окремо описано як незалежну оцінку контролів, а не сертифікат.":
    "Names the main certifications and compliance frameworks. Separately describes DORA as an independent controls assessment, not a certificate.",
  "Названо підтверджені сертифікації й рамки відповідності; NIST та інші рамки не оголошено сертифікатами. Окрему оцінку DORA не згадано.":
    "Names supported certifications and compliance frameworks; does not call NIST or other frameworks certificates. Omits the separate DORA assessment.",
  "Не виводить частку транзакцій із кількості регіонів чи валідаторів. Пояснює залежність покриття від участі валідаторів.":
    "Does not infer transaction share from the number of regions or validators. Explains that coverage depends on validator participation.",
  "Не виводить частку транзакцій із кількості регіонів чи валідаторів. Пояснює залежність покриття від участі валідаторів. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Does not infer transaction share from the number of regions or validators. Explains that coverage depends on validator participation. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Описано зміни 2025 року й інституційні партнерства 2026-го. Немає повної траєкторії: пропущено початковий роздрібний фокус, VaaS, Blockspace та MCP. Формулювання про сертифікації взяте з ретроспективи, але потребує точнішого розрізнення.":
    "Describes 2025 changes and 2026 institutional partnerships. The trajectory is incomplete: omits the original retail focus, VaaS, Blockspace and MCP. Certification wording comes from a retrospective but needs more precise distinctions.",
  "Основні наведені факти взято з джерел, але траєкторія за два роки суттєво неповна, а сертифікації та рамки відповідності розділено нечітко.":
    "Sources support the main stated facts, but the two-year trajectory is substantially incomplete and certifications are not clearly distinguished from compliance frameworks.",
  "Перелік загалом правильний, DORA відділено від сертифікатів. Формулювання про NIST та інші рамки можна зробити точнішим.":
    "The list is broadly correct and distinguishes DORA from certificates. Wording about NIST and other frameworks could be more precise.",
  "Показано розбіжність між шістьма та сімома регіонами й відмінності покриття продуктів. Відповідь не обіцяє всі продукти в обох містах і не вигадує дату запуску.":
    "Shows the discrepancy between six and seven regions and differences in product coverage. Does not promise all products in both cities or invent a launch date.",
  "Показано різні способи авторизації та строки доступу для всіх чотирьох продуктів. Єдиного ключа й миттєвого доступу не обіцяно.":
    "Shows different authorization methods and access times for all four products. Does not promise a single key or instant access.",
  "Показано різні способи авторизації та строки доступу для всіх чотирьох продуктів. Єдиного ключа й миттєвого доступу не обіцяно. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Shows different authorization methods and access times for all four products. Does not promise a single key or instant access. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Пояснено різницю між підтвердженням внеску та початком нагород. Є шлях Instant Stake через зустрічний запит на виведення, без обіцянки строку активації.":
    "Explains the difference between deposit confirmation and the start of rewards. Includes the Instant Stake route through a matching withdrawal request without promising an activation time.",
  "Правильно відмовлено в точному загальному рахунку й наведено базовий тариф. Водночас вигадано рівність двох сум і пропущено частину умов договору.":
    "Correctly declines to give an exact total bill and cites the base rate. However, invents an equality between two amounts and omits some contract terms.",
  "Правильно названо мінімум 0,01 ETH для нових внесків із червня 2026 року. Окремо пояснено поріг 32 ETH для валідатора.":
    "Correctly identifies the 0.01 ETH minimum for new deposits from June 2026. Separately explains the 32 ETH validator threshold.",
  "Правильно названо мінімум 0,01 ETH для нових внесків із червня 2026 року. Окремо пояснено поріг 32 ETH для валідатора. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Correctly identifies the 0.01 ETH minimum for new deposits from June 2026. Separately explains the 32 ETH validator threshold. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Правильно не вигадує відсутні договірні умови, гарантії або точний результат. Це негативне питання: обмеження даних тут є правильною відповіддю.":
    "Correctly avoids inventing absent contract terms, guarantees or an exact outcome. This is a negative question: stating the data limitation is the correct answer.",
  "Правильно обчислено 64 × 32 = 2 048 ETH. Новий максимум одного валідатора не переплутано з мінімумом 32 ETH.":
    "Correctly calculates 64 × 32 = 2,048 ETH. Does not confuse the new maximum for one validator with the 32 ETH minimum.",
  "Правильно обчислено 64 × 32 = 2 048 ETH. Новий максимум одного валідатора не переплутано з мінімумом 32 ETH. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Correctly calculates 64 × 32 = 2,048 ETH. Does not confuse the new maximum for one validator with the 32 ETH minimum. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Рекламні строки запуску відділено від умов індивідуального договору. Точну компенсацію не вигадано.":
    "Distinguishes advertised launch times from individual contract terms. Does not invent an exact compensation amount.",
  "Рекламні строки запуску відділено від умов індивідуального договору. Точну компенсацію не вигадано. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Distinguishes advertised launch times from individual contract terms. Does not invent an exact compensation amount. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Розрізнено активні мережі та сумарний досвід. Розбіжність між 30+ і 35+ активних мереж не приховано.":
    "Distinguishes active networks from cumulative experience. Does not hide the discrepancy between 30+ and 35+ active networks.",
  "Розрізнено аудит інституційних внесків і аудит роздрібного протоколу. Один аудит не оголошено доказом перевірки обох потоків.":
    "Distinguishes the institutional deposit audit from the retail protocol audit. Does not treat one audit as proof that both flows were reviewed.",
  "Розрізнено аудит інституційних внесків і аудит роздрібного протоколу. Один аудит не оголошено доказом перевірки обох потоків. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Distinguishes the institutional deposit audit from the retail protocol audit. Does not treat one audit as proof that both flows were reviewed. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Розрізнено старий внесок 0,5 SOL і новий окремий внесок: старий не потрібно поповнювати, новий має відповідати порогу 1 SOL. Суперечливий текст старого гайда показано окремо.":
    "Distinguishes an existing 0.5 SOL stake from a separate new stake: the old stake needs no top-up; the new stake must meet the 1 SOL threshold. Separately identifies conflicting wording in the old guide.",
  "Розрізнено старий внесок 0,5 SOL і новий окремий внесок: старий не потрібно поповнювати, новий має відповідати порогу 1 SOL. Суперечливий текст старого гайда показано окремо. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Distinguishes an existing 0.5 SOL stake from a separate new stake: the old stake needs no top-up; the new stake must meet the 1 SOL threshold. Separately identifies conflicting wording in the old guide. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Розрізняє 35+ активних мереж і 130+ за весь час. Пропускає інше актуальне джерело з 30+ активних, тому не показує суттєву суперечність.":
    "Distinguishes 35+ active networks from 130+ over time. Misses another current source stating 30+ active networks, so does not show a material conflict.",
  "Схвалення відділено від активації, прогноз не подано як гарантію, позицію Everstake знайдено в тексті голосування.":
    "Distinguishes approval from activation, does not present a forecast as a guarantee, and finds Everstake's position in the voting text.",
  "Схвалення відділено від активації, прогноз не подано як гарантію, позицію Everstake знайдено в тексті голосування. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Distinguishes approval from activation, does not present a forecast as a guarantee, and finds Everstake's position in the voting text. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
  "Технічний збій перевіряльника: готової відповіді немає. Не зараховується як правильне «не знаю».":
    "Technical verifier failure: no final answer is available. This does not count as a correct abstention.",
  "Технічний збій: користувач не отримав відповіді. Це не оцінка прихованої чернетки.":
    "Technical failure: the user received no answer. This is not a grade of an unseen draft.",
  "У зафіксованих відповідях MCP немає потрібних деталей. Модель чесно вказала обмеження, але відповідь на це позитивне питання не надала; у нашому ширшому корпусі такі дані є.":
    "The captured MCP responses lack the required details. The model honestly states the limitation but does not answer this positive question; the broader corpus contains the information.",
  "Цифри мають джерела й різні масштаби правильно розділено. Не показано суперечність між двома актуальними оцінками кількості мереж.":
    "The figures are sourced and their scopes are correctly distinguished. Does not show the conflict between two current network-count estimates.",
  "Чесно відмовляється назвати точний час надходження ETH. Статичні сторінки не встановлюють стан черги й майбутній момент зарахування.":
    "Honestly declines to name an exact ETH arrival time. Static pages do not establish the queue state or future crediting time.",
  "Чесно відмовляється назвати точний час надходження ETH. Статичні сторінки не встановлюють стан черги й майбутній момент зарахування. За цими критеріями суттєвих пропусків не виявлено; це не гарантія безпомилковості.":
    "Honestly declines to name an exact ETH arrival time. Static pages do not establish the queue state or future crediting time. No material omissions were found against these criteria; this does not guarantee an error-free answer.",
};

/** Translate the displayed assessment while preserving the original stored result. */
export function assessmentText(
  text: string,
  language: EvaluationLanguage,
): string {
  return language === "en" ? (englishAssessments[text] ?? text) : text;
}
