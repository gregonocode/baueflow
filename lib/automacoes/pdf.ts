export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export function validatePdf(file: { name: string; type: string; size: number }): string | null {
  if (file.type !== "application/pdf" || !/\.pdf$/i.test(file.name)) return "Selecione apenas arquivos PDF (.pdf).";
  if (file.size === 0) return "O PDF está vazio.";
  if (file.size > MAX_PDF_BYTES) return "Cada PDF deve ter no máximo 20 MB.";
  return null;
}

export function sanitizedPdfName(name: string): string {
  const base = name.replace(/\.pdf$/i, "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  return `${base || "documento"}.pdf`;
}
