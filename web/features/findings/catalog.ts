export const findings = [
  {
    id: "principal-risk",
    title: "Контроль ключів не усуває ризику втрати капіталу",
    category: "Комунікація ризиків",
    status: "Неточне формулювання",
    summary:
      "Таблиця для фінансового директора обмежує втрати винагородами, хоча інший розділ того ж документа визнає ризик слешингу капіталу.",
  },
  {
    id: "tax-reporting",
    title: "Винагорода за стейкінг і продаж токенів — різні події",
    category: "Податкова звітність",
    status: "Проблема в змісті",
    summary:
      "Посібник пов’язує винагороди з формою 1099-DA, тоді як матеріали IRS розділяють отримання доходу та продаж цифрових активів.",
  },
  {
    id: "insurance-scope",
    title: "«Застраховано» — але що саме покриває страховка?",
    category: "Перевірка постачальника",
    status: "Бракує доказів",
    summary:
      "Власний чекліст Everstake вимагає назви страховика та лімітів. Заява на сторінці Ethereum сама по собі цих відповідей не дає.",
  },
  {
    id: "nist-certification",
    title: "Хто підтвердив відповідність NIST CSF і що перевіряли?",
    category: "Підтвердження безпеки",
    status: "Потрібне уточнення",
    summary:
      "NIST не видає сертифікатів CSF. Потрібно відрізнити застосування фреймворку від незалежної оцінки та назвати її виконавця.",
  },
] as const;

export function findFinding(id: string) {
  return findings.find((finding) => finding.id === id);
}

export type FindingsLanguage = "en" | "uk";

const englishFindings = [
  {
    id: "principal-risk",
    title: "Control of keys does not eliminate principal loss risk",
    category: "Risk communication",
    status: "Imprecise wording",
    summary:
      "The CFO comparison table limits losses to rewards, while another section of the same guide acknowledges the risk of slashing principal.",
  },
  {
    id: "tax-reporting",
    title: "Staking rewards and token sales are different events",
    category: "Tax reporting",
    status: "Content issue",
    summary:
      "The guide associates rewards with Form 1099-DA, while IRS materials distinguish receiving income from selling digital assets.",
  },
  {
    id: "insurance-scope",
    title: "Insured — but what does the policy actually cover?",
    category: "Provider due diligence",
    status: "Evidence gap",
    summary:
      "Everstake’s own checklist asks for a named insurer and policy limits. The statement on the Ethereum page does not provide these answers on its own.",
  },
  {
    id: "nist-certification",
    title: "Who assessed NIST CSF alignment, and what was reviewed?",
    category: "Security assurance",
    status: "Clarification needed",
    summary:
      "NIST does not issue CSF certifications. Framework adoption should be distinguished from an independent assessment, with the assessor identified.",
  },
] as const;

export function localizedFindings(language: FindingsLanguage) {
  return language === "uk" ? findings : englishFindings;
}
