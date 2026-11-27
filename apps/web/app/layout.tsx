import type { ReactNode } from 'react';

export const metadata = { title: 'GroupOS', description: 'Plan together. Decide faster.' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#f7f8fb', color: '#14213d' }}>{children}</body></html>;
}
