import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  agentRules: false,
  devIndicators: false,
  images: {
    formats: ["image/avif", "image/webp"],
    localPatterns: [{ pathname: "/demo/**" }],
  },
};

export default nextConfig;
