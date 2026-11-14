import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: true,
  // The ordinary Next build/start flow stays available. Docker requests a
  // traced standalone artifact without changing the private preview runtime.
  output: process.env.TROPA_STANDALONE === 'true' ? 'standalone' : undefined,
};

export default nextConfig;
