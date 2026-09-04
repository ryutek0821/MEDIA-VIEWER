import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "メディア仕分け",
  description: "画像と動画を端末内だけで、いる・いらないに仕分けます。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
