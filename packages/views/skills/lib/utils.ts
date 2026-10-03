export function isNameConflictError(msg: string): boolean {
  return /\b(409|conflict|already exists|unique constraint)\b/i.test(msg);
}

// The server's exact wording when an uploaded .skill/.zip holds several
// sibling skills (server/internal/handler/skill_import_archive.go). Matched
// rather than inferred from the 400 status, so the dialog can show the
// localized recovery instead of the English sentence (OL-106).
const MULTIPLE_SKILLS_ERROR = "archive contains multiple skills";
export function isMultipleSkillsError(msg: string): boolean {
  return msg.startsWith(MULTIPLE_SKILLS_ERROR);
}
