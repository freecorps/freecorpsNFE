/**
 * Street and number from Stripe's single address line. "Rua das Flores, 120" and "120 Main St"
 * both split; anything else keeps the whole line as the street and `missingNumber` as the
 * number. Each flow chooses it: the automatic request writes "S/N", the console prefill leaves
 * the field empty for the person to complete.
 */
export function splitStreet(line1: string, missingNumber: string) {
  const trailing = /^(.+?),\s*(\d[\w\-/]*)\b(.*)$/.exec(line1);
  if (trailing) return { street: `${trailing[1]}${trailing[3]}`.trim(), number: trailing[2]! };
  const leading = /^(\d[\w\-/]*)\s+(.+)$/.exec(line1);
  if (leading) return { street: leading[2]!, number: leading[1]! };
  return { street: line1, number: missingNumber };
}
