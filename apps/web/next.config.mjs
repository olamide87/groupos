/** @type {import('next').NextConfig} */
const config = {
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${process.env.GROUPOS_API_ORIGIN ?? 'http://127.0.0.1:4100'}/api/v1/:path*` }];
  },
};
export default config;
