// 字体统一走本机字体栈。
//
// 原实现用 next/font/google 在构建期下载 17 个字体文件：内网/CI 环境一旦拉不到，
// 静态导出会以 "module not found" 直接失败（本项目踩过两次）。字体只是外观，
// 因此改成纯 CSS 变量，构建不再依赖任何外网请求。

export const fontRegistry = {
  geist: { label: "Geist", variable: "--font-geist" },
  inter: { label: "Inter", variable: "--font-inter" },
  notoSans: { label: "Noto Sans", variable: "--font-noto-sans" },
  nunitoSans: { label: "Nunito Sans", variable: "--font-nunito-sans" },
  figtree: { label: "Figtree", variable: "--font-figtree" },
  roboto: { label: "Roboto", variable: "--font-roboto" },
  raleway: { label: "Raleway", variable: "--font-raleway" },
  dmSans: { label: "DM Sans", variable: "--font-dm-sans" },
  publicSans: { label: "Public Sans", variable: "--font-public-sans" },
  outfit: { label: "Outfit", variable: "--font-outfit" },
  geistMono: { label: "Geist Mono", variable: "--font-geist-mono" },
  geistPixelSquare: { label: "Geist Pixel Square", variable: "--font-geist-pixel-square" },
  jetBrainsMono: { label: "JetBrains Mono", variable: "--font-jetbrains-mono" },
  notoSerif: { label: "Noto Serif", variable: "--font-noto-serif" },
  robotoSlab: { label: "Roboto Slab", variable: "--font-roboto-slab" },
  merriweather: { label: "Merriweather", variable: "--font-merriweather" },
  lora: { label: "Lora", variable: "--font-lora" },
  playfairDisplay: { label: "Playfair Display", variable: "--font-playfair-display" },
} as const;

export type FontKey = keyof typeof fontRegistry;

// 变量在 globals.css 里声明，body 不再需要额外 class。
export const fontVars = "";

export const fontOptions = (Object.entries(fontRegistry) as Array<[FontKey, (typeof fontRegistry)[FontKey]]>).map(
  ([key, f]) => ({
    key,
    label: f.label,
    variable: f.variable,
  }),
);