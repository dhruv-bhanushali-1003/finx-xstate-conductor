/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/proxy/:path*",         // frontend calls this
        destination: "http://52.66.238.28:8127/api/:path*", // your Conductor backend
      },
    ];
  },
};

module.exports = nextConfig;
