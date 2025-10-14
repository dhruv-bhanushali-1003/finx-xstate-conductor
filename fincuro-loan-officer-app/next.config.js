/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    esmExternals: false
  },
  async rewrites() {
    return [
      {
        source: "/api/proxy/:path*",
        destination: "http://52.66.238.28:8127/api/:path*",
      },
    ];
  },
};

module.exports = nextConfig;
