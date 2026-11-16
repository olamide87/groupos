/** @type {import('next').NextConfig} */
const config = {
  async headers() {
    return [{ source: '/invite', headers: [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
    ] }];
  },
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${process.env.GROUPOS_API_ORIGIN ?? 'http://127.0.0.1:4100'}/api/v1/:path*` }];
  },
};
export default config;
