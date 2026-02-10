"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import GridScanBackground from "./components/GridScanBackground";
import { DatePickerPanel } from "./components/DatePickerPanel";
import logo from "@/data/logo.png";

const CHAT_LIST_KEY = "proxlearn_chat_list";
const LEGACY_CHAT_KEY = "proxlearn_chat";
const MAX_STORED_MESSAGES = 100;
const MAX_CHATS = 50;

type Mode = "blog" | "analytics" | "combined";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: { title: string; slug: string; url: string }[];
  dataWindow?: string;
  error?: string;
  ask_date_range?: boolean;
}

interface SavedChat {
  id: string;
  title: string;
  messages: Message[];
  mode: Mode;
  updatedAt: string;
}

function chatTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const t = firstUser.content.trim().slice(0, 40);
  return t + (firstUser.content.length > 40 ? "…" : "") || "New chat";
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function loadChatList(): { currentId: string; chats: SavedChat[] } {
  if (typeof window === "undefined") return { currentId: "", chats: [] };
  try {
    const raw = localStorage.getItem(CHAT_LIST_KEY);
    if (raw) {
      const data = JSON.parse(raw) as { currentId?: string; chats?: unknown[] };
      const chats = (Array.isArray(data.chats) ? data.chats : [])
        .filter((c): c is SavedChat => c && typeof c === "object" && typeof (c as SavedChat).id === "string" && Array.isArray((c as SavedChat).messages))
        .map((c) => ({
          id: (c as SavedChat).id,
          title: String((c as SavedChat).title || "New chat"),
          messages: ((c as SavedChat).messages as Message[]).filter((m): m is Message => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-MAX_STORED_MESSAGES),
          mode: (c as SavedChat).mode === "blog" || (c as SavedChat).mode === "analytics" || (c as SavedChat).mode === "combined" ? (c as SavedChat).mode : "combined",
          updatedAt: String((c as SavedChat).updatedAt || new Date().toISOString()),
        }))
        .slice(-MAX_CHATS);
      const currentId = typeof data.currentId === "string" && chats.some((c) => c.id === data.currentId) ? data.currentId : chats[chats.length - 1]?.id ?? "";
      return { currentId, chats };
    }
    const legacy = localStorage.getItem(LEGACY_CHAT_KEY);
    if (legacy) {
      const data = JSON.parse(legacy) as { messages?: unknown[]; mode?: string };
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const valid: Message[] = messages
        .filter((m): m is Message => m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({
          role: (m as Message).role,
          content: (m as Message).content,
          sources: (m as Message).sources,
          dataWindow: (m as Message).dataWindow,
          error: (m as Message).error,
          ask_date_range: (m as Message).ask_date_range,
        }))
        .slice(-MAX_STORED_MESSAGES);
      const mode = data.mode === "blog" || data.mode === "analytics" || data.mode === "combined" ? data.mode : "combined";
      const id = randomId();
      const chat: SavedChat = { id, title: chatTitle(valid), messages: valid, mode, updatedAt: new Date().toISOString() };
      localStorage.removeItem(LEGACY_CHAT_KEY);
      return { currentId: id, chats: valid.length > 0 ? [chat] : [] };
    }
    return { currentId: "", chats: [] };
  } catch {
    return { currentId: "", chats: [] };
  }
}

function saveChatList(currentId: string, chats: SavedChat[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHAT_LIST_KEY, JSON.stringify({ currentId, chats: chats.slice(-MAX_CHATS) }));
  } catch {
    // ignore
  }
}

export default function Home() {
  const [currentId, setCurrentId] = useState<string>("");
  const [chats, setChats] = useState<SavedChat[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("combined");
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [datePanelDismissed, setDatePanelDismissed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const { currentId: id, chats: list } = loadChatList();
    setCurrentId(id);
    setChats(list);
    const current = list.find((c) => c.id === id);
    if (current) {
      setMessages(current.messages);
      setMode(current.mode);
    } else {
      setMessages([]);
      setMode("combined");
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const title = chatTitle(messages);
    const updatedAt = new Date().toISOString();
    if (currentId) {
      setChats((prev) => {
        const idx = prev.findIndex((c) => c.id === currentId);
        const next = idx >= 0 ? [...prev] : [...prev, { id: currentId, title: "New chat", messages: [], mode: "combined" as Mode, updatedAt }];
        const i = idx >= 0 ? idx : next.length - 1;
        next[i] = { id: next[i].id, title: messages.length > 0 ? title : next[i].title, messages: messages.slice(-MAX_STORED_MESSAGES), mode, updatedAt };
        saveChatList(currentId, next);
        return next.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      });
    } else {
      const id = randomId();
      setCurrentId(id);
      setChats((prev) => {
        const next = [...prev, { id, title: messages.length > 0 ? title : "New chat", messages: messages.slice(-MAX_STORED_MESSAGES), mode, updatedAt }];
        saveChatList(id, next);
        return next.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      });
    }
  }, [messages, mode, hydrated, currentId]);

  const startNewChat = useCallback(() => {
    const newId = randomId();
    const now = new Date().toISOString();
    setChats((prev) => {
      let next = [...prev];
      const curIdx = prev.findIndex((c) => c.id === currentId);
      if (curIdx >= 0 && messages.length > 0) {
        next[curIdx] = { ...next[curIdx], title: chatTitle(messages), messages, mode, updatedAt: now };
      } else if (currentId && curIdx < 0) {
        next = [...next, { id: currentId, title: chatTitle(messages), messages, mode, updatedAt: now }];
      }
      next = [...next, { id: newId, title: "New chat", messages: [], mode, updatedAt: now }].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      saveChatList(newId, next);
      return next;
    });
    setCurrentId(newId);
    setMessages([]);
    setSidebarOpen(false);
  }, [mode, currentId, messages]);

  const switchChat = useCallback((chat: SavedChat) => {
    setCurrentId(chat.id);
    setMessages(chat.messages);
    setMode(chat.mode);
    setSidebarOpen(false);
  }, []);

  const sendRequest = useCallback(
    async (text: string, historyForRequest: { role: string; content: string }[]) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, mode, history: historyForRequest }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) {
          setMessages((prev) => [...prev, { role: "assistant", content: "", error: data.error ?? "Request failed" }]);
          return;
        }
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.answer ?? "",
            sources: data.sources,
            dataWindow: data.dataWindow,
            ask_date_range: data.ask_date_range === true,
          },
        ]);
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setMessages((prev) => [...prev, { role: "assistant", content: "Stopped.", ask_date_range: false }]);
          return;
        }
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "", error: e instanceof Error ? e.message : "Network error" },
        ]);
      } finally {
        setLoading(false);
        abortRef.current = null;
      }
    },
    [mode]
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    await sendRequest(text, history);
  }, [input, loading, messages, sendRequest]);

  const sendMessageWithText = useCallback(
    async (text: string) => {
      if (!text.trim() || loading) return;
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      await sendRequest(text, history);
    },
    [loading, messages, sendRequest]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const contentLooksLikeDatePrompt = (text: string) =>
    /\b(which|what)\s+period\b/i.test(text) ||
    /\bdate\s+range\b/i.test(text) ||
    /\bpull\s+those\s+numbers\b/i.test(text) ||
    /\bgive\s+(the\s+)?other\s+date\s+range\b/i.test(text) ||
    /\bwhat\s+period\s+should\s+i\s+compare\b/i.test(text) ||
    /\bcompare\s+\d{4}\s+with\s+another\s+period\b/i.test(text);
  const showDateCalendar =
    !loading &&
    !datePanelDismissed &&
    messages.length > 0 &&
    lastMessage?.role === "assistant" &&
    (lastMessage.ask_date_range === true || contentLooksLikeDatePrompt(lastMessage.content));

  useEffect(() => {
    setDatePanelDismissed(false);
  }, [messages.length]);
  const placeholder =
    lastMessage?.role === "assistant" && (lastMessage?.ask_date_range || contentLooksLikeDatePrompt(lastMessage?.content ?? ""))
      ? "e.g. last 28 days or pick below"
      : messages.length > 0
        ? "Continue or ask a follow-up…"
        : "Ask a question…";

  const sortedChats = [...chats].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return (
    <>
      <GridScanBackground active={loading} />

      {/* Sidebar: past chats + New chat (can be closed on all screens) */}
      <aside
        className={`fixed left-0 top-0 z-30 h-full w-[220px] flex-shrink-0 flex flex-col border-r border-white/10 glass-strong transition-transform duration-200 ease-out ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center justify-between gap-2 px-3 py-3 border-b border-white/10">
          <span className="text-xs font-medium text-white/70 uppercase tracking-wider">Chats</span>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="p-1.5 rounded-lg text-white/60 hover:bg-white/10 hover:text-white"
            aria-label="Close sidebar"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <button
          type="button"
          onClick={startNewChat}
          className="mx-2 mt-2 flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-white bg-white/10 hover:bg-white/20 transition"
        >
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New chat
        </button>
        <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2 space-y-0.5">
          {sortedChats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => switchChat(chat)}
              className={`w-full rounded-xl px-3 py-2.5 text-left text-xs transition ${
                chat.id === currentId ? "bg-white/20 text-white" : "text-white/70 hover:bg-white/10 hover:text-white/90"
              }`}
            >
              <span className="block truncate font-medium">{chat.title}</span>
              <span className="block truncate text-[10px] text-white/50 mt-0.5">
                {new Date(chat.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            </button>
          ))}
        </div>
      </aside>

      {/* Overlay when sidebar open on mobile */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Glass top nav — left offset only when sidebar is open */}
      <nav
        className={`fixed top-3 left-0 right-0 z-20 flex items-center gap-2 px-3 sm:top-4 sm:px-4 transition-[left] duration-200 ${sidebarOpen ? "md:left-[220px]" : ""}`}
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className={`p-2 rounded-xl glass text-white/80 hover:text-white ${sidebarOpen ? "hidden" : ""}`}
          aria-label="Open chats"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="flex-1 flex justify-center min-w-0">
          <div className="glass-nav rounded-xl px-3 py-2.5 sm:rounded-2xl sm:px-5 sm:py-3 flex items-center justify-between max-w-2xl w-full">
            <div className="flex items-center gap-2 min-w-0">
              <Image src={logo} alt="ProxLearn" height={128} width={128} className="h-auto w-12 shrink-0 sm:w-20 object-contain" priority unoptimized />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={startNewChat}
                className="hidden sm:flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white transition"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New chat
              </button>
              <span className="text-xs sm:text-sm text-white/60 truncate">Ask away</span>
            </div>
          </div>
        </div>
      </nav>

      {/* Right-side date picker panel — only when AI asked for a date; guides user to pick correct period */}
      {showDateCalendar && (
        <div
          className="fixed right-0 top-0 bottom-0 z-20 w-[320px] sm:w-[360px] flex flex-col"
          style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <DatePickerPanel
            hint={lastMessage?.role === "assistant" ? lastMessage.content.slice(0, 120).replace(/\n/g, " ").trim() : undefined}
            compareMode={lastMessage?.role === "assistant" && /\b(compare|other period)\b/i.test(lastMessage.content)}
            onSelect={(phrase) => sendMessageWithText(phrase)}
            onCancel={() => setDatePanelDismissed(true)}
          />
        </div>
      )}

      {/* Central chat area — left padding when sidebar open; right padding when date panel open */}
      <div
        className={`relative z-10 min-h-screen min-h-[100dvh] flex flex-col items-center justify-center pl-3 pr-3 pt-20 pb-6 sm:pl-4 sm:pr-4 sm:pt-24 sm:pb-8 transition-[padding] duration-200 ${sidebarOpen ? "md:pl-[220px]" : ""} ${showDateCalendar ? "pr-[320px] sm:pr-[360px]" : ""}`}
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
      >
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
                  placeholder={placeholder}
                  className="flex-1 min-w-0 bg-transparent px-3 py-3 sm:px-4 text-sm text-white placeholder:text-white/40 focus:outline-none min-h-[44px] sm:min-h-0"
                  disabled={loading}
                />
                {loading ? (
                  <button
                    type="button"
                    onClick={stopGeneration}
                    className="shrink-0 rounded-xl bg-red-500/90 text-white p-3 sm:px-4 sm:py-3 font-medium hover:bg-red-500 active:bg-red-600 transition shadow-lg min-h-[44px] min-w-[44px] flex items-center justify-center touch-manipulation"
                    aria-label="Stop"
                  >
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="6" width="12" height="12" rx="1" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim()}
                    className="shrink-0 rounded-xl bg-white text-slate-900 p-3 sm:px-4 sm:py-3 font-medium hover:bg-white/95 active:bg-white/90 disabled:opacity-40 disabled:pointer-events-none transition shadow-lg min-h-[44px] min-w-[44px] flex items-center justify-center touch-manipulation"
                    aria-label="Send"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}
