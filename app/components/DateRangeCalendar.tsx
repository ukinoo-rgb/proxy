"use client";

import { useState, useMemo } from "react";

function toISO(date: Date) {
  return date.toISOString().slice(0, 10);
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

export interface DateRangeCalendarProps {
  onSelect: (phrase: string) => void;
  className?: string;
}

export function DateRangeCalendar({ onSelect, className = "" }: DateRangeCalendarProps) {
  const today = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);

  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const firstDay = weekday(monthStart);
  const daysCount = daysInMonth(month);
  const pad = firstDay;

  const days: (number | null)[] = [];
  for (let i = 0; i < pad; i++) days.push(null);
  for (let d = 1; d <= daysCount; d++) days.push(d);

  const handleCellClick = (day: number) => {
    const iso = toISO(new Date(month.getFullYear(), month.getMonth(), day));
    if (start === null) {
      setStart(iso);
      setEnd(iso);
    } else if (end === null || start === end) {
      const s = start;
      if (iso < s) {
        setStart(iso);
        setEnd(s);
      } else {
        setEnd(iso);
      }
    } else {
      setStart(iso);
      setEnd(iso);
    }
  };

  const applyRange = () => {
    if (start && end) {
      onSelect(start === end ? start : `${start} to ${end}`);
    }
  };

  const presets = [
    { label: "Last 7 days", phrase: "last 7 days" },
    { label: "Last 28 days", phrase: "last 28 days" },
    { label: "Last month", phrase: "last month" },
  ] as const;

  const prevMonth = () => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));
  const nextMonth = () => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1));
  const monthLabel = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return (
    <div className={`rounded-xl border border-white/10 bg-white/05 p-3 ${className}`}>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {presets.map(({ label, phrase }) => (
          <button
            key={phrase}
            type="button"
            onClick={() => onSelect(phrase)}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-white/10 text-white/90 hover:bg-white/20 active:bg-white/25 transition"
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={prevMonth}
          aria-label="Previous month"
          className="p-1.5 rounded-lg text-white/70 hover:bg-white/10 hover:text-white transition"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-xs font-medium text-white/90">{monthLabel}</span>
        <button
          type="button"
          onClick={nextMonth}
          aria-label="Next month"
          className="p-1.5 rounded-lg text-white/70 hover:bg-white/10 hover:text-white transition"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="text-[10px] text-white/50 py-0.5">
            {d}
          </div>
        ))}
        {days.map((day, i) => {
          if (day === null) return <div key={`pad-${i}`} />;
          const iso = toISO(new Date(month.getFullYear(), month.getMonth(), day));
          const isStart = iso === start;
          const isEnd = iso === end;
          const isInRange =
            start && end && iso >= start && iso <= end;
          const isToday = iso === toISO(today);
          return (
            <button
              key={day}
              type="button"
              onClick={() => handleCellClick(day)}
              className={`
                min-w-[28px] h-7 rounded-md text-xs font-medium transition
                ${isStart || isEnd ? "bg-white text-slate-900" : ""}
                ${isInRange && !isStart && !isEnd ? "bg-white/20 text-white" : ""}
                ${!isStart && !isEnd && !isInRange ? "text-white/80 hover:bg-white/10" : ""}
                ${isToday && !isStart && !isEnd ? "ring-1 ring-white/40" : ""}
              `}
            >
              {day}
            </button>
          );
        })}
      </div>
      {start && (
        <div className="mt-3 pt-2 border-t border-white/10 flex items-center justify-between gap-2">
          <span className="text-[10px] text-white/60">
            {start === end ? start : `${start} → ${end}`}
          </span>
          <button
            type="button"
            onClick={applyRange}
            className="text-xs px-3 py-1.5 rounded-lg bg-white text-slate-900 font-medium hover:bg-white/95 active:bg-white/90 transition"
          >
            Use this range
          </button>
        </div>
      )}
    </div>
  );
}
