/** RFB manual, example 12.ABC.345/01DE-35. Keep identity as text throughout. */
export function normalizeCnpj(input: string): string | null {
  if (/[^a-zA-Z0-9./-]/.test(input.trim())) return null;
  const text = input.trim().toUpperCase();
  if (
    !/^(?:[A-Z0-9]{12}\d{2}|[A-Z0-9]{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}\/[A-Z0-9]{4}-\d{2})$/.test(text)
  )
    return null;
  const value = text.replace(/[./-]/g, "");
  if (/^(\d)\1{13}$/.test(value)) return null;
  const digit = (base: string) => {
    let sum = 0;
    for (let i = base.length - 1, weight = 2; i >= 0; i--, weight = weight === 9 ? 2 : weight + 1)
      sum += (base.charCodeAt(i) - 48) * weight;
    const remainder = sum % 11;
    return String(remainder < 2 ? 0 : 11 - remainder);
  };
  const first = digit(value.slice(0, 12));
  return value.endsWith(first + digit(value.slice(0, 12) + first)) ? value : null;
}
