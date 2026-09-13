export interface RemovedInstruction {
  text: string;
  rule: string;
}

export interface SanitizedDocument {
  text: string;
  removed: RemovedInstruction[];
}

const rules: Array<{ name: string; pattern: RegExp }> = [
  { name: 'prompt_override', pattern: /\b(?:ignore|disregard|forget|override)\b.{0,120}\b(?:previous|prior|above|system|developer|instructions?|prompt|rules?)\b/i },
  { name: 'ai_directive', pattern: /\b(?:chatgpt|assistant|language model|llm|ai model|artificial intelligence|the ai)\b.{0,140}\b(?:must|should|shall|ignore|respond|answer|say|mention|reveal|follow|obey|output)\b/i },
  { name: 'answer_directive', pattern: /\b(?:when|before)\s+(?:you|the (?:ai|assistant|model))\s+(?:answer|respond|reply)\b/i },
  { name: 'prompt_exfiltration', pattern: /\b(?:reveal|repeat|print|show|return)\b.{0,100}\b(?:system|developer)\s+(?:message|prompt|instructions?)\b/i },
];

/** Removes explicit instructions aimed at an AI while preserving ordinary imperative prose. */
export function sanitizeDocument(text: string): SanitizedDocument {
  const removed: RemovedInstruction[] = [];
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const kept: string[] = [];
    for (const match of line.matchAll(/[^.!?]+(?:[.!?]+|$)/g)) {
      const sentence = match[0].trim();
      if (!sentence) continue;
      const matched = rules.find(rule => rule.pattern.test(sentence));
      if (matched) removed.push({ text: sentence, rule: matched.name });
      else kept.push(sentence);
    }
    lines.push(kept.join(' '));
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}
