// Verdict matching -- a port of kernel.check_answer (kernel.py).
// Used by the backend function, which holds the answers.
//
// Both sides reduce to a bag of meaningful tokens (lowercase, "_" as a space,
// punctuation stripped, filler words dropped). A guess is right when it
// contains every token of at least one accepted answer or the target column.

const STOPWORDS = new Set([
  "the", "a", "an", "column", "columns", "field", "value", "values",
  "is", "are", "in", "of", "there", "has", "have", "problem", "issue",
  "hidden", "fault", "feature", "data", "row", "rows",
]);

export function normalizeTokens(text) {
  const cleaned = String(text).toLowerCase().replace(/_/g, " ").replace(/[^a-z0-9\s]/g, " ");
  return new Set(cleaned.split(/\s+/).filter((t) => t && !STOPWORDS.has(t)));
}

export function checkAnswer(userText, secret) {
  const user = normalizeTokens(userText);
  if (!user.size) return false;
  const candidates = [...(secret.accepted_answers || [])];
  if (secret.target_column) candidates.push(secret.target_column);
  return candidates.some((c) => {
    const tokens = normalizeTokens(c);
    return tokens.size > 0 && [...tokens].every((t) => user.has(t));
  });
}
