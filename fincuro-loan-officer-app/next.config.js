/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    appDir: true,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'https://base-api.fincuro.in/gateway/ui-workflow/api/:path*',
      },
    ]
  },
}

module.exports = nextConfig