import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The project root, stated: a stray package-lock.json in the home folder made Next infer the home folder as the
  // workspace root, which broke file watching in development (stale CSS) and warned on every build.
  turbopack: { root: process.cwd() },
};

export default nextConfig;
