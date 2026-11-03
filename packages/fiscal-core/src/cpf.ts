/** CPF with 11 digits and both check digits (modulo 11); repeated digits are refused. */
export function validCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += (value.charCodeAt(i) - 48) * (size + 1 - i);
    const digit = ((sum * 10) % 11) % 10;
    if (digit !== value.charCodeAt(size) - 48) return false;
  }
  return true;
}
