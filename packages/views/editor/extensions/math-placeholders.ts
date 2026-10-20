/** Generated identifiers only; never used to recognize authored TeX. */
export function mathPlaceholderPrefix(source: string): string {
  let prefix = "$multicamath";
  while (source.includes(prefix)) prefix += "x";
  return prefix;
}

export function mathPlaceholderPattern(prefix: string): RegExp {
  // Prefixes contain only a dollar and ASCII letters. Match this invocation's
  // prefix, so adjacent authored dollar text cannot consume a marker's opener.
  return new RegExp(`${prefix.replaceAll("$", "\\$")}\\d+\\$`, "g");
}
