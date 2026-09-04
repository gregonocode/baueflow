import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BaueFlow",
  description: "automação de Whatsapp",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="pt-br"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
