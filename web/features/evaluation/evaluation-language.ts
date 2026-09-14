export type EvaluationLanguage = "en" | "uk";

/** Select display copy only; never rewrite a saved answer, score or measurement. */
export function evaluationText(language: EvaluationLanguage) {
  return (english: string, ukrainian: string): string =>
    language === "uk" ? ukrainian : english;
}
