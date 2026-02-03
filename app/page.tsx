"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    try {
      // Send full conversation history so the model has context (enterprise-grade multi-turn).
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, mode, history }),
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
  }, [input, loading, mode, messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <>
      <GridScanBackground active={loading} />

      {/* Glass top nav */}
      <nav className="fixed top-3 left-1/2 -translate-x-1/2 z-20 w-full max-w-2xl px-3 sm:top-4 sm:px-4" style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}>
        <div className="glass-nav rounded-xl px-3 py-2.5 sm:rounded-2xl sm:px-5 sm:py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Image src={logo} alt="ProxLearn" height={128} width={128} className="h-auto w-12 shrink-0 sm:w-20 object-contain" priority unoptimized />
          </div>
          <span className="text-xs sm:text-sm text-white/60 truncate">Ask away</span>
        </div>
      </nav>

      {/* Central chat area */}
      <div className="relative z-10 min-h-screen min-h-[100dvh] flex flex-col items-center justify-center px-3 pt-20 pb-6 sm:px-4 sm:pt-24 sm:pb-8" style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
        <div className="w-full max-w-xl flex flex-col items-center min-w-0">
          {/* Pill label */}
          <span className="glass rounded-full px-3 py-1.5 text-xs font-medium text-white/80 mb-3 sm:mb-4 inline-flex items-center gap-1.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
            Chat
          </span>
          {/* Tagline */}
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-white text-center mb-4 sm:mb-6 tracking-tight max-w-md px-1">
            Ask about our blog and analytics.
          </h1>

          {/* Mode only; date range is typed in the chat when needed */}
          <div className="w-full flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2 sm:gap-3 mb-4 sm:mb-6">
            <div className="flex rounded-xl glass border border-white/10 overflow-hidden p-0.5">
              {(["blog", "analytics", "combined"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 sm:flex-none min-h-[44px] sm:min-h-0 px-3 py-2.5 sm:px-4 sm:py-2 text-xs font-medium capitalize transition touch-manipulation ${
                    mode === m
                      ? "bg-white/20 text-white rounded-lg"
                      : "text-white/60 hover:text-white/80 active:text-white/90"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Glass chat card */}
          <div className="w-full flex flex-col rounded-xl sm:rounded-2xl glass-strong shadow-2xl max-h-[55vh] sm:max-h-[60vh] min-h-0 overflow-hidden" style={{ maxHeight: "min(55vh, calc(100dvh - 14rem))" }}>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 px-3 py-3 space-y-3 sm:px-4 sm:py-4 sm:space-y-4">
              {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} min-w-0`}
              >
                <div
                  className={`max-w-[90%] sm:max-w-[85%] rounded-xl sm:rounded-2xl px-3 py-2 sm:px-4 sm:py-2.5 min-w-0 ${
                    m.role === "user"
                      ? "bg-white text-slate-900 font-medium rounded-br-md shadow-lg"
                      : "glass text-white/95 rounded-bl-md"
                  }`}
                >
                  {m.error ? (
                    <p className={`text-xs sm:text-sm ${m.role === "user" ? "text-red-600" : "text-red-400"}`}>{m.error}</p>
                  ) : (
                    <>
                      {m.dataWindow && (
                        <p className="text-[10px] text-slate-500 mb-1">{m.dataWindow}</p>
                      )}
                      {m.role === "assistant" ? (
                        <div className="prose-chat text-xs sm:text-sm leading-relaxed break-words">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                              ul: ({ children }) => <ul className="my-2 list-disc pl-5 space-y-0.5">{children}</ul>,
                              ol: ({ children }) => <ol className="my-2 list-decimal pl-5 space-y-0.5">{children}</ol>,
                              li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                              strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                              h1: ({ children }) => <h1 className="text-sm font-bold mt-2 mb-1 first:mt-0">{children}</h1>,
                              h2: ({ children }) => <h2 className="text-sm font-bold mt-2 mb-1 first:mt-0">{children}</h2>,
                              h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h3>,
                              a: ({ href, children }) => (
                                <a href={href} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">
                                  {children}
                                </a>
                              ),
                              code: ({ className, children }) =>
                                className ? (
                                  <code className={`block text-[11px] sm:text-xs p-2 rounded bg-white/10 overflow-x-auto ${className}`}>{children}</code>
                                ) : (
                                  <code className="px-1 py-0.5 rounded bg-white/10 text-[11px]">{children}</code>
                                ),
                              pre: ({ children }) => <pre className="my-2 overflow-x-auto">{children}</pre>,
                              blockquote: ({ children }) => <blockquote className="border-l-2 border-white/30 pl-3 my-2 text-white/80">{children}</blockquote>,
                            }}
                          >
                            {m.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <div className="text-xs sm:text-sm leading-relaxed whitespace-pre-wrap break-words">{m.content}</div>
                      )}
                      {m.sources && m.sources.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-white/10">
                          <p className="text-[10px] text-slate-500 mb-1">Sources</p>
                          <ul className="text-xs space-y-0.5">
                            {m.sources.map((s, j) => (
                              <li key={j}>
                                <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">
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
                <div className="rounded-xl sm:rounded-2xl rounded-bl-md px-3 py-2 sm:px-4 sm:py-2.5 glass">
                  <span className="text-xs sm:text-sm text-white/70">Thinking…</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
            </div>

            {/* Input - glass bar */}
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
                  className="flex-1 min-w-0 bg-transparent px-3 py-3 sm:px-4 text-sm text-white placeholder:text-white/40 focus:outline-none min-h-[44px] sm:min-h-0"
                  disabled={loading}
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="shrink-0 rounded-xl bg-white text-slate-900 p-3 sm:px-4 sm:py-3 font-medium hover:bg-white/95 active:bg-white/90 disabled:opacity-40 disabled:pointer-events-none transition shadow-lg min-h-[44px] min-w-[44px] flex items-center justify-center touch-manipulation"
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
