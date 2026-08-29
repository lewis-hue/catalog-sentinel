import './globals.css';
import type { ReactNode } from 'react';
import { Plus_Jakarta_Sans, Inter, IBM_Plex_Mono } from 'next/font/google';
import { AppShell } from './_components/AppShell';

// Plus Jakarta Sans, a clean modern geometric sans, is the display face (headings, big numbers) for
// the tech-SaaS look. Kept under the `--font-space` variable name so `--font-display` resolves to it.
const space = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-space', display: 'swap', weight: ['500', '600', '700'] });
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '600'], variable: '--font-plex-mono', display: 'swap' });

export const metadata = {
  title: 'Catalog Sentinel, catalog operations',
  description: 'Verify where every distributed track is live across music platforms, find gaps, and generate distributor-ready evidence. Read-only, confidence-scored.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${space.variable} ${inter.variable} ${plexMono.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
