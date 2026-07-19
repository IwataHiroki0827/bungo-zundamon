export function hasAnyControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

export function hasUnsafeTextControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x08 || codePoint === 0x0b || codePoint === 0x0c || (codePoint >= 0x0e && codePoint <= 0x1f) || codePoint === 0x7f)
    ) return true;
  }
  return false;
}
