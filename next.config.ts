import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },

  // Proxy all /api/* and /instruments-gz to the Fastify backend on :3001
  async rewrites() {
    return [
      {
        source: "/instruments-gz",
        destination: "http://localhost:3001/instruments-gz",
      },
      {
        source: "/api/:path*",
        destination: "http://localhost:3001/api/:path*",
      },
      {
        source: "/nubra-optionchains/:path*",
        destination: "https://api.nubra.io/optionchains/:path*",
      },
    ];
  },

  webpack(config, { isServer }) {
    // Match original Vite alias: @/ → ./src/
    config.resolve.alias = {
      ...config.resolve.alias,
      "@": path.resolve(__dirname, "src"),
    };

    // Buffer polyfill for browser (Protobuf + pako need it)
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: require.resolve("buffer/"),
        stream: false,
        fs: false,
        path: false,
        crypto: false,
      };
    }

    return config;
  },

  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
