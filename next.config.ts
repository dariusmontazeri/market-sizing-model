import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel bundles serverless functions via output file tracing; reads done
  // with fs at runtime are not always auto-detected. Explicitly ship the
  // per-component instruction files with every API route.
  outputFileTracingIncludes: {
    "/api/**": ["./instructions/*.md"],
  },
};

export default nextConfig;
