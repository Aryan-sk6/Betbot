// Matching what a user typed ("aus", "2", "real madrid") to one of a market's options.

export const MAX_OPTIONS = 10;
export const MAX_LABEL = 40;

export const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

export type OptionMatch = { index: number } | { error: "none" | "ambiguous"; candidates: string[] };

/**
 * Exact name first, then a 1-based option number, then a unique name prefix.
 * Case and extra spaces are ignored.
 */
export function matchOption(labels: string[], input: string): OptionMatch {
  const want = norm(input);
  if (!want) return { error: "none", candidates: labels };
  const names = labels.map(norm);
  const exact = names.indexOf(want);
  if (exact !== -1) return { index: exact };
  if (/^\d+$/.test(want)) {
    const n = Number(want);
    if (n >= 1 && n <= labels.length) return { index: n - 1 };
  }
  const hits = names.flatMap((n, i) => (n.startsWith(want) ? [i] : []));
  if (hits.length === 1) return { index: hits[0] };
  return hits.length ? { error: "ambiguous", candidates: hits.map((i) => labels[i]) } : { error: "none", candidates: labels };
}

/** Validate the option list for /new. Returns an error message, or null if fine. */
export function validateOptions(labels: string[]): string | null {
  if (labels.length < 2) return "Give at least 2 options, e.g. options India, Australia, Draw.";
  if (labels.length > MAX_OPTIONS) return `At most ${MAX_OPTIONS} options.`;
  const seen = new Set<string>();
  for (const l of labels) {
    if (!l) return "Options can't be empty.";
    if (l.length > MAX_LABEL) return `Option names are limited to ${MAX_LABEL} characters.`;
    if (/^\d+$/.test(l)) return `Option "${l}" can't be just a number (numbers pick an option by position).`;
    if (l.includes("|")) return "Option names can't contain |.";
    const k = norm(l);
    if (seen.has(k)) return `Duplicate option "${l}".`;
    seen.add(k);
  }
  return null;
}

export const isYesNo = (labels: string[]): boolean => labels.length === 2 && norm(labels[0]) === "yes" && norm(labels[1]) === "no";

/** How an option is shown: YES/NO stay uppercase, custom names stay as typed. */
export const display = (label: string): string => (/^(yes|no)$/i.test(label) ? label.toUpperCase() : label);
