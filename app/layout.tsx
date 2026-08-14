import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") || "localhost:5173";
  const protocol = host.startsWith("localhost") ? "http" : "https";
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "Notely — music, at the speed of thought",
    description: "Compose accurate sheet music in shorthand and hear it instantly, from any device.",
    openGraph: { title: "Notely", description: "Music, at the speed of thought.", images: [image] },
    twitter: { card: "summary_large_image", title: "Notely", description: "Music, at the speed of thought.", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
