/** Public REST address; hosted builds set VITE_API_URL to the same Worker. */
export const publicApiUrl = "https://api.nfe.freecorps.com.br";
export function apiOrigin() {
  const origin: unknown = import.meta.env.VITE_API_URL;
  return typeof origin === "string" && origin.length > 0 ? origin : publicApiUrl;
}
