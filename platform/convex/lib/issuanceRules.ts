/**
 * Pure rules of the NFS-e issuance request, without database access, shared by the server
 * normalization and by the console form (which only uses them as feedback). Values stay as
 * decimal text: no float on the way.
 */

/** Competence as `AAAA-MM`. */
export const isCompetence = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
/** Positive amount with at most 13 integer digits and 2 decimals, no exponent, no sign. */
export const isAmount = (value: string) =>
  /^\d{1,13}(\.\d{1,2})?$/.test(value) && !/^0+(\.0+)?$/.test(value);
/**
 * ISS rate in percent, above 0 and at most 5 (LC 116/2003, art. 8º, II). The DPS writes it as
 * TSDec1V2 (2 places): up to 4 places are accepted, the last two only as zeros ("2.0100"), so
 * the value never has to be rounded.
 */
export function isIssRate(value: string) {
  const match = /^(\d)(?:\.(\d{1,4}))?$/.exec(value);
  return (
    !!match &&
    !/^0(\.0+)?$/.test(value) &&
    !/[1-9]/.test((match[2] ?? "").slice(2)) &&
    match[1]! <= "5" &&
    !(match[1] === "5" && /[1-9]/.test(match[2] ?? ""))
  );
}
