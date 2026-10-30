"use client";

import type { ReactNode } from "react";

import { usePathname } from "next/navigation";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/hooks/use-current-user";

import { AccountSwitcher } from "./sidebar/account-switcher";
import { LanguageSwitcher } from "./sidebar/language-switcher";
import { LayoutControls } from "./sidebar/layout-controls";
import { SearchDialog } from "./sidebar/search-dialog";
import { ThemeSwitcher } from "./sidebar/theme-switcher";

// 仅任务【详情】页满屏（自带头部/Tabs/内边距）；任务【列表】等其它页保留全局头部（含主题切换/账号）。
// 注意静态导出带尾斜杠，故 /function/tasks/ 会误配，必须精确到 detail。
function isFullBleed(pathname: string) {
  const p = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  })();
  return p.startsWith("/function/tasks/detail");
}

// 聊天页自己管理内边距与高度：外边距给小一点，避免会话框两侧出现大片空白。
function isChatPage(pathname: string) {
  return pathname.startsWith("/chat");
}

export function MainContent({ children }: { children: ReactNode }) {
  const currentUser = useCurrentUser();
  const pathname = usePathname();

  if (isFullBleed(pathname)) {
    return <>{children}</>;
  }

  // 工作区页面（聊天 / 仪表盘）占满宽度：centered 布局的 max-w 只作用于其余页面，
  // 否则宽屏上会话框两侧会留出很大空白。
  const workspace = pathname.startsWith("/chat") || pathname.startsWith("/dashboard");

  return (
    <>
      <header
        data-full-bleed={workspace ? "" : undefined}
        className={cn(
          "flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12",
          "[html[data-navbar-style=sticky]_&]:sticky [html[data-navbar-style=sticky]_&]:top-0 [html[data-navbar-style=sticky]_&]:z-50 [html[data-navbar-style=sticky]_&]:overflow-hidden [html[data-navbar-style=sticky]_&]:rounded-t-[inherit] [html[data-navbar-style=sticky]_&]:bg-background/50 [html[data-navbar-style=sticky]_&]:backdrop-blur-md",
        )}
      >
        <div className="flex w-full items-center justify-between px-4 lg:px-6">
          <div className="flex items-center gap-1 lg:gap-2">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
            />
            <SearchDialog />
          </div>
          <div className="flex items-center gap-2">
            <LayoutControls />
            <LanguageSwitcher />
            <ThemeSwitcher />
            <AccountSwitcher users={[currentUser]} />
          </div>
        </div>
      </header>
      <div
        data-full-bleed={workspace ? "" : undefined}
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-x-hidden",
          // 工作区页面自己管滚动。高度不再用视口减法（inset 变体还有 m-2 外边距，
          // 减不准就会多出几像素让 body 滚动），而是走 flex 链：
          // SidebarProvider(h-svh) → SidebarInset(flex-1) → 这里(flex-1) → 页面(h-full)。
          workspace && "flex min-h-0 flex-1 flex-col overflow-hidden",
          isChatPage(pathname) ? "p-0" : "p-4 md:p-6",
          "has-data-[content-padding=false]:p-0 md:has-data-[content-padding=false]:p-0",
        )}
      >
        {children}
      </div>
    </>
  );
}
