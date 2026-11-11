"use client";

import * as React from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { CopyIcon, FolderIcon, KeyRoundIcon, PlayIcon, PlusIcon, RefreshCwIcon, SmartphoneIcon, TerminalIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { DeviceInfo, DeviceOpData, DeviceToken } from "@/lib/types";

// 设备页：左边是接入令牌，右边是在线设备与操作面板。
// 设备是反连进来的，所以这里的"在线"永远是实时状态——每 5 秒刷新一次。
export default function DevicesPage() {
  const { t } = useTranslation();
  const [devices, setDevices] = React.useState<DeviceInfo[]>([]);
  const [tokens, setTokens] = React.useState<DeviceToken[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [label, setLabel] = React.useState("");
  const [issued, setIssued] = React.useState<string | null>(null);
  const [active, setActive] = React.useState<DeviceInfo | null>(null);
  const [cmd, setCmd] = React.useState("id");
  const [path, setPath] = React.useState("/sdcard");
  const [output, setOutput] = React.useState("");
  const [screenshot, setScreenshot] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [d, tk] = await Promise.all([api.devices(), api.deviceTokens()]);
      setDevices(d);
      setTokens(tk);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function createToken() {
    try {
      const res = await api.createDeviceToken(label.trim());
      setIssued(res.token);
      setLabel("");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function revoke(id: number) {
    try {
      await api.revokeDeviceToken(id);
      toast.success(t("devices.toast.revoked"));
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function run(op: string, args: Record<string, unknown> = {}) {
    if (!active) return;
    setBusy(true);
    try {
      const res = await api.deviceOp(active.key, op, args);
      const data = res.data as DeviceOpData;
      if (op === "screencap") {
        const image = typeof data.image_b64 === "string" ? data.image_b64 : "";
        if (!image) throw new Error(t("devices.error.noImage"));
        setScreenshot(`data:image/png;base64,${image}`);
        return;
      }
      const text =
        (typeof data.stdout === "string" && data.stdout) ||
        (typeof data.text === "string" && data.text) ||
        JSON.stringify(data, null, 2);
      setOutput(text);
    } catch (e) {
      setOutput(`✕ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SmartphoneIcon className="size-4" />
          <h1 className="text-sm font-semibold">{t("devices.title")}</h1>
          <Badge variant="outline" className="text-[10px]">
            {t("devices.online", { count: devices.length })}
          </Badge>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* 令牌 */}
        <Card className="h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <KeyRoundIcon className="size-3.5" />
              {t("devices.tokens.title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("devices.tokens.labelPlaceholder")}
                className="h-8 text-xs"
              />
              <Button size="sm" onClick={() => void createToken()}>
                <PlusIcon className="size-3.5" />
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              {tokens.length === 0 && <div className="text-muted-foreground text-[11px]">{t("devices.tokens.empty")}</div>}
              {tokens.map((tk) => (
                <div key={tk.id} className="flex items-center justify-between rounded border px-2 py-1.5 text-[11px]">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{tk.label || t("devices.tokens.untitled")}</div>
                    <div className="text-muted-foreground font-mono">{tk.prefix}…</div>
                    <div className="text-muted-foreground">
                      {tk.last_seen_at ? t("devices.tokens.lastSeen", { at: tk.last_seen_at.slice(0, 19).replace("T", " ") }) : t("devices.tokens.neverUsed")}
                    </div>
                  </div>
                  {tk.revoked ? (
                    <Badge variant="outline" className="text-[9px]">{t("devices.tokens.revoked")}</Badge>
                  ) : (
                    <Button size="icon" variant="ghost" className="size-6" onClick={() => void revoke(tk.id)}>
                      <Trash2Icon className="size-3" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 设备 + 操作 */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs">{t("devices.list.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              {devices.length === 0 ? (
                <div className="text-muted-foreground py-6 text-center text-[11px]">
                  {t("devices.list.empty")}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {devices.map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => {
                        setActive(d);
                        setOutput("");
                      }}
                      className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                        active?.key === d.key ? "border-primary/50 bg-primary/5" : "hover:bg-muted/40"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{d.name}</div>
                        <div className="text-muted-foreground font-mono text-[10px]">
                          {d.model} · {d.android} · {d.arch} {d.root ? "· root" : ""}
                        </div>
                      </div>
                      <span className="text-muted-foreground font-mono text-[10px]">{d.key.slice(0, 16)}</span>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {active && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <TerminalIcon className="size-3.5" />
                  {t("devices.actions.title", { name: active.name })}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <div className="flex min-w-[240px] flex-1 gap-2">
                    <Input value={cmd} onChange={(e) => setCmd(e.target.value)} className="h-8 font-mono text-xs" />
                    <Button size="sm" disabled={busy} onClick={() => void run("exec", { cmd })}>
                      <PlayIcon className="size-3.5" />
                      {t("devices.actions.exec")}
                    </Button>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("screencap")}>
                    {t("devices.actions.screencap")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("logcat", { lines: 200 })}>
                    {t("devices.actions.logcat")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("packages")}>
                    {t("devices.actions.packages")}
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Input value={path} onChange={(e) => setPath(e.target.value)} className="h-8 flex-1 font-mono text-xs" />
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("file_list", { path })}>
                    <FolderIcon className="size-3.5" />
                    {t("devices.actions.list")}
                  </Button>
                </div>

                {output && (
                  <div className="relative">
                    <pre className="bg-muted/40 max-h-72 overflow-auto rounded-lg border p-3 font-mono text-[11px] whitespace-pre-wrap">
                      {output}
                    </pre>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="absolute top-1.5 right-1.5 size-6"
                      onClick={() => {
                        void navigator.clipboard.writeText(output);
                        toast.success(t("devices.toast.copied"));
                      }}
                    >
                      <CopyIcon className="size-3" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* 令牌明文只显示一次 */}
      <Dialog open={issued !== null} onOpenChange={(open) => !open && setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("devices.tokens.issuedTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-xs">{t("devices.tokens.issuedHint")}</p>
            <pre className="bg-muted/40 overflow-auto rounded border p-3 font-mono text-xs break-all whitespace-pre-wrap">{issued}</pre>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (issued) void navigator.clipboard.writeText(issued);
                  toast.success(t("devices.toast.copied"));
                }}
              >
                <CopyIcon className="size-3.5" />
                {t("devices.toast.copy")}
              </Button>
              <Button size="sm" onClick={() => setIssued(null)}>
                {t("devices.toast.done")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {screenshot && (
        <Dialog open onOpenChange={(open) => !open && setScreenshot(null)}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>{t("devices.screenshot.title")}</DialogTitle>
            </DialogHeader>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={screenshot} alt="screenshot" className="max-h-[70vh] w-auto rounded border" />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}