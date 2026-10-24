import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["*.e2b.app"],
  /* config options here */
  typescript: {
    // ignoreBuildErrors removed - fix actual TypeScript errors
  },
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          ...(process.env.NODE_ENV === 'production' ? [{ key: 'X-Frame-Options', value: 'DENY' }] : []),
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; " +
              "script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
              "style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data: https:; " +
              "connect-src 'self' https: wss:; " +
              "font-src 'self'; " +
              (process.env.NODE_ENV === 'production' ? "frame-ancestors 'none';" : "frame-ancestors 'self' https://*.arena.ai https://arena.ai https://*.e2b.app;"),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
