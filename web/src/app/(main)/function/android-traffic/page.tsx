"use client";

import * as React from "react";

import { DownloadIcon, LockIcon, RadioTowerIcon, RefreshCwIcon, SmartphoneIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import type { AndroidCapture, AndroidFlow, DeviceInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

// 安卓流量：设备端 tcpdump 抓到的 pcap，按"一份抓包 → 多条连接"展示。
// 与 Web 流量页同一套版式（左列表 + 右明细）。关键取舍：浏览器/App 流量几乎全是
// HTTPS，不能解密就不该显示空白——所以每条 TCP 连接都会列出，TLS 的用 SNI 表明
// "连的是谁"，DNS 查询也单列一条，让人能看到"确实抓到流量了"。

function fmtSize(bytes: number): string {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

function fmtTime(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

const KIND_STYLE: Record<string, string> = {
  http: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  tls: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  dns: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  quic: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  tcp: "border-border bg-muted text-muted-foreground",
};

function kindLabel(kind: string): string {
  switch (kind) {
    case "http":
      return "HTTP";
    case "tls":
      return "TLS";
    case "dns":
      return "DNS";
    case "quic":
      return "QUIC";
    default:
      return "TCP";
  }
}

export default function AndroidTrafficPage() {
  const { t } = useTranslation();
  const [captures, setCaptures] = React.useState<AndroidCapture[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [flows, setFlows] = React.useState<AndroidFlow[]>([]);
  const [summary, setSummary] = React.useState<AndroidCaptureDetailLite | null>(null);
  const [active, setActive] = React.useState<AndroidFlow | null>(null);
  const [loading, setLoading] = React.useState(false);
  // 抓包控制：设备端 tcpdump 在写文件，必须"拉取"或"停止"后才会落到控制台列表。
  const [devices, setDevices] = React.useState<DeviceInfo[]>([]);
  const [deviceKey, setDeviceKey] = React.useState("");
  const [capturing, setCapturing] = React.useState(false);
  const [capNote, setCapNote] = React.useState("");

  const loadCaptures = React.useCallback(async () => {
    try {
      const res = await api.androidCaptures();
      setCaptures(res.captures ?? []);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  React.useEffect(() => {
    void loadCaptures();
    void api
      .devices()
      .then((list) => {
        setDevices(list);
        if (!deviceKey && list.length > 0) setDeviceKey(list[0].key);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadCaptures]);

  const openCapture = React.useCallback(async (name: string) => {
    setSelected(name);
    setActive(null);
    setLoading(true);
    try {
      const res = await api.androidFlows(name, 800);
      setFlows(res.flows ?? []);
      setSummary({
        packets: res.packets,
        http_flows: res.http_flows,
        tls_flows: res.tls_flows,
        dns_queries: res.dns_queries,
        quic_flows: res.quic_flows,
        other_tcp: res.other_tcp,
        truncated: res.truncated,
      });
    } catch (e) {
      toast.error((e as Error).message);
      setFlows([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, []);

  async function startCapture() {
    if (!deviceKey) return;
    try {
      setCapNote(t("androidTraffic.starting"));
      await api.deviceOp(deviceKey, "capture_start", {});
      setCapturing(true);
      setCapNote(t("androidTraffic.capturingHint"));
    } catch (e) {
      setCapNote("");
      toast.error((e as Error).message);
    }
  }

  async function pullLive() {
    if (!deviceKey) return;
    try {
      setCapNote(t("androidTraffic.pulling"));
      const res = await api.androidCapturePull(deviceKey);
      setCapNote(t("androidTraffic.pulled", { name: res.capture?.name ?? "", size: fmtSize(res.capture?.size ?? 0) }));
      await loadCaptures();
      if (res.capture?.name) await openCapture(res.capture.name);
    } catch (e) {
      setCapNote("");
      toast.error((e as Error).message);
    }
  }

  async function stopCapture() {
    if (!deviceKey) return;
    try {
      setCapNote(t("androidTraffic.stopping"));
      const res = await api.deviceOp(deviceKey, "capture_stop", {});
      setCapturing(false);
      const name = (res.data as { name?: string } | undefined)?.name;
      setCapNote(t("androidTraffic.stopped", { name: name ?? "" }));
      await loadCaptures();
      if (name) await openCapture(name);
    } catch (e) {
      setCapNote("");
      toast.error((e as Error).message);
    }
  }

  async function removeCapture(name: string) {
    try {
      await api.deleteAndroidCapture(name);
      toast.success(t("androidTraffic.deleted"));
      if (selected === name) {
        setSelected(null);
        setFlows([]);
        setActive(null);
        setSummary(null);
      }
      await loadCaptures();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("androidTraffic.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("androidTraffic.subtitle")}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void loadCaptures()}>
          <RefreshCwIcon className="size-3.5" />
          {t("androidTraffic.refresh")}
        </Button>
      </div>

      {/* 抓包控制条：设备端抓的数据必须先"拉取/停止"才会出现在列表里 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs">
        <SmartphoneIcon className="size-4 text-muted-foreground" />
        <select
          value={deviceKey}
          onChange={(e) => setDeviceKey(e.target.value)}
          className="border-input bg-background h-7 rounded-md border px-2 text-xs"
        >
          {devices.length === 0 && <option value="">{t("androidTraffic.noDevice")}</option>}
          {devices.map((d) => (
            <option key={d.key} value={d.key}>
              {d.model || d.key}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={!deviceKey || capturing} onClick={() => void startCapture()}>
          {t("androidTraffic.startCapture")}
        </Button>
        <Button size="sm" variant="outline" disabled={!deviceKey} onClick={() => void pullLive()}>
          {t("androidTraffic.pullNow")}
        </Button>
        <Button size="sm" variant="outline" disabled={!deviceKey} onClick={() => void stopCapture()}>
          {t("androidTraffic.stopCapture")}
        </Button>
        <span className={cn("text-[11px]", capturing ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
          {capNote || t("androidTraffic.captureTip")}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[18rem_1fr] gap-4">
        {/* 左：抓包列表 */}
        <div className="bg-card flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
            <RadioTowerIcon className="size-3.5 text-muted-foreground" />
            {t("androidTraffic.captures")}
            <span className="text-muted-foreground ml-auto tabular-nums">{captures.length}</span>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-0.5 p-2">
              {captures.length === 0 && (
                <p className="text-muted-foreground px-2 py-6 text-center text-xs">{t("androidTraffic.empty")}</p>
              )}
              {captures.map((item) => (
                <div
                  key={item.name}
                  className={cn(
                    "group flex min-w-0 items-center gap-1 rounded-md pr-1 transition-colors",
                    selected === item.name ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <button
                    onClick={() => void openCapture(item.name)}
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2 py-1.5 text-left"
                  >
                    <span className="w-full truncate font-mono text-xs">{item.name}</span>
                    <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                      <SmartphoneIcon className="size-3" />
                      {item.device || "—"} · {fmtSize(item.size)}
                    </span>
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 opacity-0 group-hover:opacity-100"
                    onClick={() => window.open(api.androidCaptureUrl(item.name), "_blank")}
                    title={t("androidTraffic.download")}
                  >
                    <DownloadIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 opacity-0 group-hover:opacity-100"
                    onClick={() => void removeCapture(item.name)}
                    title={t("androidTraffic.delete")}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* 右：流量明细 */}
        <div className="bg-card flex min-h-0 flex-col overflow-hidden rounded-lg border">
          {summary && (
            <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2 text-xs">
              <span className="text-muted-foreground">{t("androidTraffic.packets", { count: summary.packets })}</span>
              <span className="text-sky-600 dark:text-sky-400">HTTP {summary.http_flows}</span>
              <span className="text-violet-600 dark:text-violet-400">TLS {summary.tls_flows}</span>
              <span className="text-emerald-600 dark:text-emerald-400">DNS {summary.dns_queries}</span>
              {summary.quic_flows > 0 && <span className="text-amber-600 dark:text-amber-400">QUIC {summary.quic_flows}</span>}
              <span className="text-muted-foreground">{t("androidTraffic.otherTcp", { count: summary.other_tcp })}</span>
              {summary.truncated && <Badge variant="outline">{t("androidTraffic.truncated")}</Badge>}
            </div>
          )}

          <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto]">
            <ScrollArea className="min-h-0">
              <div className="min-w-0 p-2">
                {loading && (
                  <p className="text-muted-foreground px-2 py-6 text-center text-xs">{t("common.loading")}</p>
                )}
                {!loading && flows.length === 0 && (
                  <p className="text-muted-foreground px-2 py-10 text-center text-xs">
                    {selected ? t("androidTraffic.noFlows") : t("androidTraffic.pick")}
                  </p>
                )}
                {!loading &&
                  flows.map((flow, index) => (
                    <button
                      key={`${flow.src}-${flow.dst}-${flow.src_port}-${index}`}
                      onClick={() => setActive(flow)}
                      className={cn(
                        "flex w-full min-w-0 items-start gap-2 overflow-hidden rounded px-2 py-1.5 text-left text-xs hover:bg-muted/50",
                        active === flow && "bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "w-12 shrink-0 rounded border px-1 text-center text-[10px] leading-4 font-medium",
                          KIND_STYLE[flow.kind] ?? KIND_STYLE.tcp,
                        )}
                      >
                        {kindLabel(flow.kind)}
                      </span>
                      <span className="text-muted-foreground w-14 shrink-0 font-mono tabular-nums">
                        {fmtTime(flow.time)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1 font-mono">
                          {flow.tls && <LockIcon className="size-3 shrink-0 text-violet-500" />}
                          <span className="truncate">
                            {flow.name || flow.dst}
                            {flow.kind === "http" ? flow.path : ""}
                          </span>
                        </span>
                        <span className="text-muted-foreground block truncate text-[11px]">
                          {flow.src}:{flow.src_port} → {flow.dst}:{flow.dst_port} · ↑{fmtSize(flow.req_bytes)} ↓
                          {fmtSize(flow.resp_bytes)}
                          {flow.content_type ? ` · ${flow.content_type}` : ""}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-mono tabular-nums",
                          flow.status?.startsWith("2")
                            ? "text-emerald-600 dark:text-emerald-400"
                            : flow.status
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground",
                        )}
                      >
                        {flow.status || flow.method || ""}
                      </span>
                    </button>
                  ))}
              </div>
            </ScrollArea>

            {active && (
              <div className="max-h-72 overflow-auto border-t bg-muted/20 p-2">
                <div className="text-muted-foreground mb-2 flex flex-wrap gap-3 text-[11px]">
                  <span>{new Date(active.time).toLocaleString()}</span>
                  <span className="font-mono">
                    {active.src}:{active.src_port} → {active.dst}:{active.dst_port}
                  </span>
                  <span>{active.packets} pkt</span>
                  <span>↑{fmtSize(active.req_bytes)} ↓{fmtSize(active.resp_bytes)}</span>
                  {active.tls && <span>{t("androidTraffic.encrypted")}</span>}
                </div>

                <div className="grid gap-2 md:grid-cols-2">
                  <div className="min-w-0">
                    <div className="text-muted-foreground mb-1 flex items-center justify-between text-[11px]">
                      <span>{t("androidTraffic.requestPacket")}</span>
                      <span className="tabular-nums">{active.req_bytes} B</span>
                    </div>
                    <pre className="max-h-52 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                      {active.req_preview || active.req_hex || t("androidTraffic.emptyPacket")}
                    </pre>
                  </div>
                  <div className="min-w-0">
                    <div className="text-muted-foreground mb-1 flex items-center justify-between text-[11px]">
                      <span>{t("androidTraffic.responsePacket")}</span>
                      <span className="tabular-nums">{active.resp_bytes} B</span>
                    </div>
                    <pre className="max-h-52 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                      {active.resp_preview || active.resp_hex || t("androidTraffic.emptyPacket")}
                    </pre>
                  </div>
                </div>

                {active.tls && !active.name && (
                  <p className="text-muted-foreground mt-1 text-[11px]">{t("androidTraffic.noHandshake")}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface AndroidCaptureDetailLite {
  packets: number;
  http_flows: number;
  tls_flows: number;
  dns_queries: number;
  quic_flows: number;
  other_tcp: number;
  truncated: boolean;
}