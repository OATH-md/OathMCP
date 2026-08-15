import { defineConfig } from "blume";

const geist = {
  name: "Geist",
  fallback: "sans" as const,
  variants: [
    {
      src: "./fonts/Geist-Variable.woff2",
      weight: "100..900",
      style: "normal" as const,
    },
    {
      src: "./fonts/Geist-VariableItalic.woff2",
      weight: "100..900",
      style: "italic" as const,
    },
  ],
};

const geistMono = {
  name: "Geist Mono",
  fallback: "mono" as const,
  variants: [
    {
      src: "./fonts/GeistMono-Variable.woff2",
      weight: "100..900",
      style: "normal" as const,
    },
    {
      src: "./fonts/GeistMono-VariableItalic.woff2",
      weight: "100..900",
      style: "italic" as const,
    },
  ],
};

export default defineConfig({
  title: "OathMCP",
  description:
    "Clinical and technical documentation for OathMCP, an agent-native server for established clinical calculators.",
  logo: {
    image: {
      light: "/brand/oath-wordmark.svg",
      dark: "/brand/oath-wordmark-dark.svg",
      alt: "Oath",
    },
    text: "",
    href: "/",
  },
  content: {
    root: "docs",
  },
  github: {
    owner: "OATH-md",
    repo: "OathMCP",
    branch: "main",
    dir: "docs-site",
  },
  lastModified: false,
  theme: {
    accent: {
      light: "#3A66F8",
      dark: "#4B75F9",
    },
    action: "#3A66F8",
    background: {
      light: "#F9F7F5",
      dark: "#0D0F12",
    },
    fonts: {
      display: geist,
      body: geist,
      mono: geistMono,
    },
    radius: "sm",
    mode: "system",
  },
  navigation: {
    tabs: [
      { label: "Guides", path: "/guides", icon: "book-open" },
      { label: "Calculators", path: "/calculators", icon: "calculator" },
      { label: "Integration", path: "/integration", icon: "plug" },
      { label: "Reference", path: "/reference", icon: "braces" },
      { label: "Operations", path: "/operations", icon: "shield-check" },
    ],
    sidebar: {
      display: "page",
    },
    featured: [
      { label: "Responsible use", href: "/responsible-use", icon: "heart-pulse" },
      { label: "Hosted MCP", href: "https://mcp.oath.md/mcp", icon: "cloud" },
    ],
  },
  search: {
    provider: "orama",
  },
  markdown: {
    imageZoom: true,
    code: {
      icons: true,
      wrap: false,
    },
    codeBlocks: {
      theme: {
        light: "github-light",
        dark: "github-dark",
      },
    },
  },
  ai: {
    llmsTxt: true,
    mcp: {
      enabled: false,
    },
  },
  seo: {
    og: { enabled: true },
    sitemap: true,
    robots: true,
    structuredData: true,
    agentReadability: true,
  },
  deployment: {
    output: "static",
    base: "/docs",
    site: "https://mcp.oath.md",
  },
});
