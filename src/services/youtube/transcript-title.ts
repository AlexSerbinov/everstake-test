import type { SpeakerReview } from "./review-speakers.js";

/** Display naming only; identities and roles must already be supported by the review. */
export function reviewedVideoTitle(
  video: { title: string; publishedAt: string | null },
  review: SpeakerReview,
): string {
  const date = video.publishedAt?.slice(0, 10) ?? "date-unknown";
  const people = review.speakers.filter(
    (s) => s.participantType === "employee" && s.name,
  );
  const identities = [
    ...new Set(
      people.map(
        (s) => `${shortRole(s.roleAtRecording)} — ${surnameFirst(s.name!)}`,
      ),
    ),
  ];
  return `${date} — ${identities.length ? identities.join(" + ") : "role-unconfirmed — person-unconfirmed"} — ${video.title}`;
}
function surnameFirst(name: string): string {
  const words = name.trim().split(/\s+/);
  return words.length > 1
    ? `${words.at(-1)} ${words.slice(0, -1).join(" ")}`
    : name;
}
function shortRole(role: string | null): string {
  if (!role) return "role-unconfirmed";
  const abbreviation = role.match(
    /\b(?:CEO|COO|CTO|CFO|CMO|CCDO|CBDO|CDO|CRO)\b/i,
  );
  if (abbreviation) return abbreviation[0].toUpperCase();
  const normalized = role.toLowerCase();
  const roles: Record<string, string> = {
    "chief executive officer": "CEO",
    "chief operating officer": "COO",
    "chief technology officer": "CTO",
    "chief financial officer": "CFO",
    "chief marketing officer": "CMO",
    "chief corporate development officer": "CCDO",
    "chief business development officer": "CBDO",
  };
  for (const [phrase, title] of Object.entries(roles))
    if (normalized.includes(phrase)) return title;
  return role.replace(/\s+at\s+.+$/i, "").trim();
}
