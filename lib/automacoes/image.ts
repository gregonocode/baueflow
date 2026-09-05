export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";

const extensions: Record<string, readonly string[]> = {
  "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/webp": ["webp"],
};

export function validateImage(file: { name: string; type: string; size: number }): string | null {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (!extensions[file.type]?.includes(extension)) return "Selecione uma imagem PNG, JPEG ou WebP com extensão e tipo correspondentes.";
  if (file.size === 0) return "A imagem está vazia.";
  if (file.size > MAX_IMAGE_BYTES) return "Cada imagem deve ter no máximo 10 MB.";
  return null;
}

export function sanitizedImageName(name: string): string {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (!["png", "jpg", "jpeg", "webp"].includes(extension)) throw new Error("Extensão de imagem inválida.");
  const base = name.slice(0, -(extension.length + 1)).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  return `${base || "imagem"}.${extension}`;
}

export async function hasImageSignature(file: File): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (file.type === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (file.type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (file.type === "image/webp") {
    return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}
