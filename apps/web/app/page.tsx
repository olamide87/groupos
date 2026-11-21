import Link from 'next/link';

export default function Home() {
  return <main style={{ maxWidth: 780, margin: '12vh auto', padding: 24 }}>
    <p style={{ fontWeight: 700, letterSpacing: 2 }}>GROUPOS</p>
    <h1 style={{ fontSize: 'clamp(2.5rem, 7vw, 4.5rem)', lineHeight: 1.1 }}>Less chasing. More doing.</h1>
    <p style={{ fontSize: 20, lineHeight: 1.6 }}>Coordinate outings, collect responses, and turn group decisions into a plan everyone can follow.</p>
    <p><Link href="/account">Sign in or create an organizer account</Link></p>
    <p><Link href="/dashboard">Open your organizer dashboard</Link></p>
  </main>;
}
