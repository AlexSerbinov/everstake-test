export function date(value: string | null | undefined): string {
  if (!value) return "Unknown";
  // Preserve the precision provided by the source, including year/month-only dates.
  if (!value.includes("T")) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const utc = parsed.toISOString();
  return `${utc.slice(0, 10)} · ${utc.slice(11, 16)} UTC`;
}
export function authority(value: number): string {
  return value === 1
    ? "Official source"
    : value === 2
      ? "Supporting source"
      : "Third-party source";
}
