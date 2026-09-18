import './globals.css';
import type { ReactNode } from 'react';
import { Fraunces, Inter, IBM_Plex_Mono } from 'next/font/google';
import { AppShell } from './_components/AppShell';

// Fraunces, an editorial serif with optical sizing, is the display face (brand, headings, and the
// catalogue letter-marks in the rail). Exposed as `--font-fraunces`, which `--font-display` resolves
// to. Inter carries running text; IBM Plex Mono sets eyebrows, data, and keyboard hints.
const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
});
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '600'], variable: '--font-plex-mono', display: 'swap' });

export const metadata = {
  title: 'Catalog Sentinel, catalog operations',
  description: 'Verify where every distributed track is live across music platforms, find gaps, and generate distributor-ready evidence. Read-only, confidence-scored.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable} ${plexMono.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
