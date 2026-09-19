import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@blankcheck/shared"],
  // Allow phones on the LAN to load dev assets (passkeys still need HTTPS; see README).
  allowedDevOrigins: ["*.local", "192.168.*.*", "10.*.*.*", "*.trycloudflare.com"],
};

export default nextConfig;
