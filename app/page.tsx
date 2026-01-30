"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
import GridScanBackground from "./components/GridScanBackground";
import logo from "@/data/logo.png";

type Mode = "blog" | "analytics" | "combined";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: { title: string; slug: string; url: string }[];
  dataWindow?: string;
  error?: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("combined");
  const [dateRange, setDateRange] = useState(() => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 28);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  });
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, mode, dateRange }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((prev) => [...prev, { role: "assistant", content: "", error: data.error ?? "Request failed" }]);
        return;
      }
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer ?? "", sources: data.sources, dataWindow: data.dataWindow },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "", error: e instanceof Error ? e.message : "Network error" },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, mode, dateRange]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <>
      <GridScanBackground active={loading} />

      {/* Glass top nav - safe area aware */}
      <nav
        className="fixed left-1/2 -translate-x-1/2 z-20 w-full max-w-2xl px-3 sm:px-4"
        style={{ top: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <div className="glass-nav rounded-2xl px-4 sm:px-5 py-2.5 sm:py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 min-h-[44px] items-center">
            <Image src={logo} alt="ProxLearn" height={128} width={128} className="h-auto w-14 sm:w-20 object-contain" priority unoptimized />
          </div>
          <span className="text-sm text-white/60">Ask away</span>
        </div>
      </nav>

      {/* Central chat area - mobile first, safe area bottom */}
      <div
        className="relative z-10 min-h-screen flex flex-col items-center justify-center px-3 sm:px-4 w-full"
        style={{
          paddingTop: "max(5rem, calc(env(safe-area-inset-top) + 4rem))",
          paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
        }}
      >
        <div className="w-full max-w-xl flex flex-col items-center flex-1 min-h-0">
          {/* Pill label */}
          <span className="glass rounded-full px-4 py-2 text-xs font-medium text-white/80 mb-3 sm:mb-4 inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            Chat
          </span>
          {/* Tagline - readable on small screens */}
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-white text-center mb-4 sm:mb-6 tracking-tight max-w-md px-1">
            Ask about our blog and analytics.
          </h1>

          {/* Minimal options: mode + date range - 44px touch targets */}
          <div className="w-full flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-center gap-2 sm:gap-3 mb-4 sm:mb-6">
            <div className="flex rounded-xl glass border border-white/10 overflow-hidden p-0.5 min-h-[44px]">
              {(["blog", "analytics", "combined"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 sm:flex-none px-4 py-3 sm:py-2 text-sm sm:text-xs font-medium capitalize transition min-h-[44px] sm:min-h-0 touch-manipulation ${
                    mode === m
                      ? "bg-white/20 text-white rounded-lg"
                      : "text-white/60 hover:text-white/80 active:bg-white/10"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-xl glass px-3 py-2.5 border border-white/10 min-h-[44px]">
              <input
                type="date"
                value={dateRange.start}
                onChange={(e) => setDateRange((d) => ({ ...d, start: e.target.value }))}
                className="bg-transparent text-white/90 text-sm sm:text-xs border-0 focus:outline-none focus:ring-0 [color-scheme:dark] min-w-0 flex-1 touch-manipulation"
                aria-label="From date"
              />
              <span className="text-white/40 text-xs shrink-0">→</span>
              <input
                type="date"
                value={dateRange.end}
                onChange={(e) => setDateRange((d) => ({ ...d, end: e.target.value }))}
                className="bg-transparent text-white/90 text-sm sm:text-xs border-0 focus:outline-none focus:ring-0 [color-scheme:dark] min-w-0 flex-1 touch-manipulation"
                aria-label="To date"
              />
            </div>
          </div>

          {/* Glass chat card - use dvh on mobile for keyboard */}
          <div className="w-full flex flex-col rounded-2xl glass-strong shadow-2xl overflow-hidden flex-1 min-h-0 max-h-[50dvh] sm:max-h-[60vh] min-h-[200px]">
            {/* Messages */}
            <div className="flex-1 overflow-y-auto min-h-0 px-3 sm:px-4 py-3 sm:py-4 space-y-3 sm:space-y-4 overscroll-contain">
              {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                    m.role === "user"
                      ? "bg-white text-slate-900 font-medium rounded-br-md shadow-lg"
                      : "glass text-white/95 rounded-bl-md"
                  }`}
                >
                  {m.error ? (
                    <p className={`text-base sm:text-sm ${m.role === "user" ? "text-red-600" : "text-red-400"}`}>{m.error}</p>
                  ) : (
                    <>
                      {m.dataWindow && (
                        <p className="text-[10px] text-slate-500 mb-1">{m.dataWindow}</p>
                      )}
                      <div className="text-base sm:text-sm leading-relaxed whitespace-pre-wrap break-words">{m.content}</div>
                      {m.sources && m.sources.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-white/10">
                          <p className="text-[10px] text-slate-500 mb-1">Sources</p>
                          <ul className="text-xs space-y-0.5">
                            {m.sources.map((s, j) => (
                              <li key={j}>
                                <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline touch-manipulation">
                                  {s.title}
                                </a>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md px-4 py-2.5 glass">
                  <span className="text-base sm:text-sm text-white/70">Thinking…</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
            </div>

            {/* Input - glass bar, 48px touch targets, 16px font to prevent iOS zoom */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage();
              }}
              className="p-3 sm:p-4 border-t border-white/10"
            >
              <div className="flex gap-2 rounded-xl glass focus-within:ring-1 focus-within:ring-white/20 transition">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask a question…"
                  className="flex-1 min-w-0 bg-transparent px-4 py-3.5 sm:py-3 text-base sm:text-sm text-white placeholder:text-white/40 focus:outline-none min-h-[48px]"
                  disabled={loading}
                  autoComplete="off"
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="rounded-xl bg-white text-slate-900 p-3 sm:px-4 sm:py-3 font-medium hover:bg-white/95 active:bg-white/90 disabled:opacity-40 disabled:pointer-events-none transition shadow-lg min-h-[48px] min-w-[48px] flex items-center justify-center touch-manipulation"
                  aria-label="Send"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
