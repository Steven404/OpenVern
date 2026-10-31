/** Joins class names, skipping falsy values. (Utilities are not de-duplicated: pass non-conflicting classes.) */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
