/** Ghép class có điều kiện (không kéo thêm thư viện). */
export type ClassValue = string | false | null | undefined;
export const cx = (...v: ClassValue[]): string => v.filter(Boolean).join(' ');
