"use client";

import { useState, useMemo } from "react";

function toISO(d: Date) {
  return d.toISOString().slice(0, 10);
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function daysInMonth(d: Date) {
  return endOfMonth(d).getDate();
}

function weekday(d: Date) {
  return d.getDay();
}

export interface DatePickerPanelProps {
  onSelect: (phrase: string) => void;
  onCancel: () => void;
  /** Short hint from the AI (e.g. "Pick the period to compare 2025 to") */
  hint?: string;
  /** When true, show Compare toggle and label for comparison period */
  compareMode?: boolean;
}

const PRESETS: { label: string; phrase: string }[] = [
  { label: "Today", phrase: "today" },
  { label: "Yesterday", phrase: "yesterday" },
  { label: "Last 7 days", phrase: "last 7 days" },
  { label: "Last 28 days", phrase: "last 28 days" },
  { label: "Last 30 days", phrase: "last 30 days" },
  { label: "Last week", phrase: "last week" },
  { label: "Last month", phrase: "last month" },
  { label: "Last 90 days", phrase: "last 90 days" },
  { label: "This month", phrase: "this month" },
  { label: "Quarter to date", phrase: "quarter to date" },
];

function getPresetPhrase(label: string): string {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  if (label === "Today") return toISO(today);
  if (label === "Yesterday") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return toISO(yesterday);
  }
  if (label === "This month") {
    const start = new Date(y, m, 1);
    return `${toISO(start)} to ${toISO(today)}`;
  }
  if (label === "Quarter to date") {
    const start = new Date(y, Math.floor(m / 3) * 3, 1);
    return `${toISO(start)} to ${toISO(today)}`;
  }
  const p = PRESETS.find((x) => x.label === label);
  return p ? p.phrase : label;
}

export function DatePickerPanel({ onSelect, onCancel, hint, compareMode }: DatePickerPanelProps) {
  const today = useMemo(() => new Date(), []);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [customStart, setCustomStart] = useState<string | null>(null);
  const [customEnd, setCustomEnd] = useState<string | null>(null);
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const isCustom = activePreset === "Custom";

  const monthStart = startOfMonth(month);
  const firstDay = weekday(monthStart);
  const daysCount = daysInMonth(month);
  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let d = 1; d <= daysCount; d++) days.push(d);

  const handlePresetClick = (label: string) => {
    if (label === "Custom") {
      setActivePreset("Custom");
      if (!customStart || !customEnd) {
        const end = new Date(today);
        const start = new Date(today);
        start.setDate(start.getDate() - 27);
        setCustomStart(toISO(start));
        setCustomEnd(toISO(end));
      }
      return;
    }
    setActivePreset(label);
    const phrase = getPresetPhrase(label);
    onSelect(phrase);
  };

  const handleDayClick = (day: number) => {
    const iso = toISO(new Date(month.getFullYear(), month.getMonth(), day));
    if (!customStart || customEnd === null || customStart === customEnd) {
      setCustomStart(iso);
      setCustomEnd(iso);
    } else {
      if (iso < customStart) {
        setCustomStart(iso);
        setCustomEnd(customStart);
      } else {
        setCustomEnd(iso);
      }
    }
  };

  const handleApplyCustom = () => {
    if (customStart && customEnd) {
      onSelect(customStart === customEnd ? customStart : `${customStart} to ${customEnd}`);
    }
  };

  const prevMonth = () => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));
  const nextMonth = () => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1));
  const monthLabel = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return (
    <div className="flex h-full flex-col glass-strong border-l border-white/10 w-full max-w-[360px] min-w-[320px]">
      {/* Header + hint */}
      <div className="flex-shrink-0 px-4 pt-4 pb-2 border-b border-white/10">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-white/70 uppercase tracking-wider">Pick a period</span>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded-lg text-white/50 hover:bg-white/10 hover:text-white transition"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {hint && (
          <p className="mt-2 text-xs text-white/60 leading-snug">{hint}</p>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left: presets */}
        <div className="flex-shrink-0 w-[140px] border-r border-white/10 flex flex-col py-3 overflow-y-auto">
          {PRESETS.map(({ label }) => (
            <button
              key={label}
              type="button"
              onClick={() => handlePresetClick(label)}
              className={`text-left px-3 py-2 text-xs font-medium transition ${
                activePreset === label ? "bg-white/20 text-white" : "text-white/70 hover:bg-white/10 hover:text-white/90"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => handlePresetClick("Custom")}
            className={`text-left px-3 py-2 text-xs font-medium transition mt-1 ${
              activePreset === "Custom" ? "bg-white/20 text-white" : "text-white/70 hover:bg-white/10 hover:text-white/90"
            }`}
          >
            Custom
          </button>
          {compareMode && (
            <div className="mt-auto pt-3 px-3 border-t border-white/10">
              <p className="text-[10px] text-white/50 uppercase tracking-wider">Compare</p>
              <p className="text-[10px] text-white/40 mt-0.5">Pick one period; the other comes from your question.</p>
            </div>
          )}
        </div>

        {/* Right: custom range + calendar */}
        <div className="flex-1 min-w-0 flex flex-col p-3 overflow-y-auto">
          {isCustom && (
            <>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div>
                  <label className="block text-[10px] text-white/50 uppercase tracking-wider mb-1">Start date</label>
                  <div className="rounded-lg bg-white/10 px-2.5 py-2 text-xs text-white">
                    {customStart ? new Date(customStart + "Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-white/50 uppercase tracking-wider mb-1">End date</label>
                  <div className="rounded-lg bg-white/10 px-2.5 py-2 text-xs text-white">
                    {customEnd ? new Date(customEnd + "Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between mb-2">
                <button type="button" onClick={prevMonth} className="p-1.5 rounded-lg text-white/70 hover:bg-white/10" aria-label="Previous month">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                </button>
                <span className="text-xs font-medium text-white/90">{monthLabel}</span>
                <button type="button" onClick={nextMonth} className="p-1.5 rounded-lg text-white/70 hover:bg-white/10" aria-label="Next month">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
              <div className="grid grid-cols-7 gap-0.5 text-center mb-4">
                {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                  <div key={i} className="text-[10px] text-white/50 py-0.5">{d}</div>
                ))}
                {days.map((day, i) => {
                  if (day === null) return <div key={`pad-${i}`} />;
                  const iso = toISO(new Date(month.getFullYear(), month.getMonth(), day));
                  const isStart = iso === customStart;
                  const isEnd = iso === customEnd;
                  const isInRange = customStart && customEnd && iso >= customStart && iso <= customEnd;
                  const isToday = iso === toISO(today);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => handleDayClick(day)}
                      className={`min-w-[28px] h-7 rounded-md text-xs font-medium transition
                        ${isStart || isEnd ? "bg-white text-slate-900" : ""}
                        ${isInRange && !isStart && !isEnd ? "bg-white/20 text-white" : ""}
                        ${!isStart && !isEnd && !isInRange ? "text-white/80 hover:bg-white/10" : ""}
                        ${isToday && !isStart && !isEnd ? "ring-1 ring-white/40" : ""}`}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2 mt-auto pt-2 border-t border-white/10">
                <button type="button" onClick={onCancel} className="flex-1 py-2 rounded-xl text-xs font-medium text-white/80 hover:bg-white/10 transition">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApplyCustom}
                  disabled={!customStart || !customEnd}
                  className="flex-1 py-2 rounded-xl text-xs font-medium bg-white text-slate-900 hover:bg-white/95 disabled:opacity-40 disabled:pointer-events-none transition"
                >
                  Apply
                </button>
              </div>
            </>
          )}
          {!isCustom && (
            <p className="text-xs text-white/50 py-4">Choose a preset on the left or Custom to pick exact dates.</p>
          )}
        </div>
      </div>
    </div>
  );
}
