/** Violação de UNIQUE no PostgreSQL (SQLSTATE 23505). */
export const isUniqueViolation = (err) => err?.code === '23505' || /duplicate key value|unique constraint/i.test(String(err?.message ?? ''));

/** Datas do PostgreSQL chegam como Date; a API sempre devolve ISO-8601 (string). */
export const toIso = (value) => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};
