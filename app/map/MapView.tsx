"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

type MapContextValue = {
  map: mapboxgl.Map | null;
  onFlyToEnd?: () => void;
  stopRotation?: () => void;
};
const MapContext = createContext<MapContextValue>({ map: null });

type GeocodingFeature = {
  id: string;
  place_name: string;
  geometry: { coordinates: [number, number] };
  bbox?: [number, number, number, number];
};

function MapSearch() {
  const { map, onFlyToEnd, stopRotation } = useContext(MapContext);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodingFeature[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const justSelectedRef = useRef(false);

  const search = useCallback(async (q: string) => {
    if (!q.trim() || !MAPBOX_TOKEN) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({
        access_token: MAPBOX_TOKEN,
        limit: "6",
        types: "place,address,poi",
      });
      const res = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q.trim())}.json?${params}`
      );
      const data = await res.json();
      setResults(data.features ?? []);
      if (!justSelectedRef.current) setOpen(true);
      justSelectedRef.current = false;
    } catch {
      setResults([]);
      justSelectedRef.current = false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => search(query), 280);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  const flyTo = useCallback(
    (feature: GeocodingFeature) => {
      if (!map) return;
      stopRotation?.();
      justSelectedRef.current = true;
      setOpen(false);
      setResults([]);
      setQuery(feature.place_name);
      const [lng, lat] = feature.geometry.coordinates;
      const onMoveEnd = () => onFlyToEnd?.();
      if (feature.bbox) {
        map.fitBounds(
          [
            [feature.bbox[0], feature.bbox[1]],
            [feature.bbox[2], feature.bbox[3]],
          ],
          {
            padding: 80,
            duration: 1000,
            maxZoom: ORBIT_START_ZOOM,
            pitch: ORBIT_START_PITCH,
            bearing: ORBIT_START_BEARING,
          }
        );
      } else {
        map.flyTo({
          center: [lng, lat],
          zoom: ORBIT_START_ZOOM,
          pitch: ORBIT_START_PITCH,
          bearing: ORBIT_START_BEARING,
          duration: 1000,
        });
      }
      map.once("moveend", onMoveEnd);
    },
    [map, onFlyToEnd, stopRotation]
  );

  return (
    <div
      ref={containerRef}
      className="absolute left-2 right-2 top-2 z-10 w-[calc(100%-1rem)] max-w-sm sm:left-4 sm:right-auto sm:top-4"
      style={{ paddingTop: "env(safe-area-inset-top, 0)" }}
    >
      <div className="relative rounded-xl bg-black/40 md:bg-white/10 md:backdrop-blur-md border border-white/20 shadow-lg">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/50 sm:left-3" aria-hidden>
          <svg className="w-4 h-4 sm:w-[18px] sm:h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search place or address…"
          className="w-full rounded-xl bg-transparent py-3 pl-10 pr-11 min-h-[48px] text-base sm:py-2.5 sm:pl-10 sm:pr-4 sm:min-h-0 sm:text-sm text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-white/30"
          aria-label="Search for a place"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="map-search-results"
          id="map-search-input"
        />
        {loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50" aria-hidden>
            <svg className="animate-spin w-4 h-4 sm:w-[18px] sm:h-[18px]" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity={0.25} />
              <path fill="currentColor" d="M12 2a10 10 0 0 1 10 10H12a8 8 0 0 0-8 8Z" opacity={0.75} />
            </svg>
          </span>
        )}
      </div>
      {open && results.length > 0 && (
        <ul
          id="map-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1 max-h-[50vh] sm:max-h-64 overflow-auto rounded-xl border border-white/20 bg-black/90 md:bg-black/80 md:backdrop-blur-md py-1 shadow-lg overscroll-contain"
        >
          {results.map((feature) => (
            <li key={feature.id} role="option">
              <button
                type="button"
                onClick={() => flyTo(feature)}
                className="w-full px-4 py-3 min-h-[48px] text-left text-base sm:py-2.5 sm:text-sm text-white/90 hover:bg-white/10 focus:bg-white/10 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white/30 active:bg-white/15 touch-manipulation"
              >
                {feature.place_name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// City centers with buildings for fly-to (downtown coords, zoom for 3D buildings)
type StateFlyTo = { name: string; cityCenter: [number, number]; zoom: number };
const US_STATES: StateFlyTo[] = [
  { name: "Alabama", cityCenter: [-86.9023, 33.5207], zoom: 16 }, // Birmingham
  { name: "Alaska", cityCenter: [-149.9003, 61.2181], zoom: 15 }, // Anchorage
  { name: "Arizona", cityCenter: [-112.074, 33.4484], zoom: 16 }, // Phoenix
  { name: "Arkansas", cityCenter: [-92.3731, 34.7465], zoom: 16 }, // Little Rock
  { name: "California", cityCenter: [-122.4194, 37.7749], zoom: 16 }, // San Francisco
  { name: "Colorado", cityCenter: [-104.9903, 39.7392], zoom: 16 }, // Denver
  { name: "Connecticut", cityCenter: [-72.9352, 41.3083], zoom: 16 }, // Hartford
  { name: "Delaware", cityCenter: [-75.5277, 39.7391], zoom: 16 }, // Wilmington
  { name: "Florida", cityCenter: [-80.1918, 25.7617], zoom: 16 }, // Miami
  { name: "Georgia", cityCenter: [-84.388, 33.749], zoom: 16 }, // Atlanta
  { name: "Hawaii", cityCenter: [-157.8583, 21.3069], zoom: 16 }, // Honolulu
  { name: "Idaho", cityCenter: [-116.215, 43.615], zoom: 16 }, // Boise
  { name: "Illinois", cityCenter: [-87.6298, 41.8781], zoom: 16 }, // Chicago
  { name: "Indiana", cityCenter: [-86.1581, 39.7684], zoom: 16 }, // Indianapolis
  { name: "Iowa", cityCenter: [-93.6208, 41.5868], zoom: 16 }, // Des Moines
  { name: "Kansas", cityCenter: [-94.6275, 39.1142], zoom: 16 }, // Kansas City KS
  { name: "Kentucky", cityCenter: [-84.512, 38.2527], zoom: 16 }, // Lexington
  { name: "Louisiana", cityCenter: [-90.0715, 29.9511], zoom: 16 }, // New Orleans
  { name: "Maine", cityCenter: [-70.2553, 43.6591], zoom: 16 }, // Portland
  { name: "Maryland", cityCenter: [-76.6122, 39.2904], zoom: 16 }, // Baltimore
  { name: "Massachusetts", cityCenter: [-71.0589, 42.3601], zoom: 16 }, // Boston
  { name: "Michigan", cityCenter: [-83.0458, 42.3314], zoom: 16 }, // Detroit
  { name: "Minnesota", cityCenter: [-93.265, 44.9778], zoom: 16 }, // Minneapolis
  { name: "Mississippi", cityCenter: [-90.1848, 32.2988], zoom: 16 }, // Jackson
  { name: "Missouri", cityCenter: [-90.1994, 38.627], zoom: 16 }, // St. Louis
  { name: "Montana", cityCenter: [-112.0391, 46.5891], zoom: 16 }, // Billings
  { name: "Nebraska", cityCenter: [-95.9345, 41.2565], zoom: 16 }, // Omaha
  { name: "Nevada", cityCenter: [-115.1398, 36.1699], zoom: 16 }, // Las Vegas
  { name: "New Hampshire", cityCenter: [-71.4548, 42.9926], zoom: 16 }, // Manchester
  { name: "New Jersey", cityCenter: [-74.006, 40.7128], zoom: 16 }, // Newark
  { name: "New Mexico", cityCenter: [-106.6504, 35.0844], zoom: 16 }, // Albuquerque
  { name: "New York", cityCenter: [-73.9352, 40.7306], zoom: 16 }, // NYC
  { name: "North Carolina", cityCenter: [-80.8431, 35.2271], zoom: 16 }, // Charlotte
  { name: "North Dakota", cityCenter: [-96.7898, 46.8772], zoom: 16 }, // Fargo
  { name: "Ohio", cityCenter: [-81.6944, 41.4993], zoom: 16 }, // Cleveland
  { name: "Oklahoma", cityCenter: [-97.5164, 35.4676], zoom: 16 }, // Oklahoma City
  { name: "Oregon", cityCenter: [-122.6765, 45.5231], zoom: 16 }, // Portland
  { name: "Pennsylvania", cityCenter: [-75.1652, 39.9526], zoom: 16 }, // Philadelphia
  { name: "Rhode Island", cityCenter: [-71.4128, 41.824], zoom: 16 }, // Providence
  { name: "South Carolina", cityCenter: [-81.0348, 34.0007], zoom: 16 }, // Columbia
  { name: "South Dakota", cityCenter: [-96.7313, 43.5446], zoom: 16 }, // Sioux Falls
  { name: "Tennessee", cityCenter: [-86.7816, 36.1627], zoom: 16 }, // Nashville
  { name: "Texas", cityCenter: [-97.7431, 30.2672], zoom: 16 }, // Austin
  { name: "Utah", cityCenter: [-111.891, 40.7608], zoom: 16 }, // Salt Lake City
  { name: "Vermont", cityCenter: [-73.2121, 44.4759], zoom: 16 }, // Burlington
  { name: "Virginia", cityCenter: [-77.436, 37.5407], zoom: 16 }, // Richmond
  { name: "Washington", cityCenter: [-122.3321, 47.6062], zoom: 16 }, // Seattle
  { name: "West Virginia", cityCenter: [-81.6326, 38.3498], zoom: 16 }, // Charleston WV
  { name: "Wisconsin", cityCenter: [-87.9065, 43.0389], zoom: 16 }, // Milwaukee
  { name: "Wyoming", cityCenter: [-104.8201, 41.1401], zoom: 16 }, // Cheyenne
  { name: "District of Columbia", cityCenter: [-77.0369, 38.9072], zoom: 17 }, // DC
];

function StatesNavList({
  statesSheetOpen,
  onStatesSheetOpenChange,
}: {
  statesSheetOpen: boolean;
  onStatesSheetOpenChange: (open: boolean) => void;
}) {
  const { map, onFlyToEnd, stopRotation } = useContext(MapContext);

  const flyToState = useCallback(
    (state: StateFlyTo) => {
      if (!map) return;
      stopRotation?.();
      onStatesSheetOpenChange(false);
      map.flyTo({
        center: state.cityCenter,
        zoom: ORBIT_START_ZOOM,
        pitch: ORBIT_START_PITCH,
        bearing: ORBIT_START_BEARING,
        duration: 1000,
      });
      map.once("moveend", () => onFlyToEnd?.());
    },
    [map, onFlyToEnd, stopRotation, onStatesSheetOpenChange]
  );

  const listContent = (
    <div className="p-3 md:p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-white/70 mb-3 px-2">
        Where We Operate
      </h2>
      <ul className="space-y-0.5 text-sm">
        {US_STATES.map((state) => (
          <li key={state.name}>
            <button
              type="button"
              onClick={() => flyToState(state)}
              className="w-full rounded-lg px-3 py-3 min-h-[44px] text-left text-white/90 hover:bg-white/10 hover:text-white focus:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/30 active:bg-white/15"
            >
              {state.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <>
      {/* Mobile: states dropdown trigger — top, below search */}
      <button
        type="button"
        onClick={() => onStatesSheetOpenChange(true)}
        className="fixed left-2 right-2 z-20 flex items-center justify-between gap-2 rounded-xl border border-white/20 bg-black/60 px-4 py-3 shadow-lg min-h-[48px] md:hidden touch-manipulation w-[calc(100%-1rem)]"
        style={{ top: "calc(4rem + env(safe-area-inset-top, 0px))" }}
        aria-label="Where we operate"
      >
        <span className="text-sm font-medium text-white/90">Where we operate</span>
        <svg className="w-5 h-5 text-white/70 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Mobile: bottom sheet — only block clicks when open */}
      <div
        className={`fixed inset-0 z-30 md:hidden ${statesSheetOpen ? "pointer-events-auto" : "pointer-events-none"}`}
        aria-hidden={!statesSheetOpen}
      >
        <div
          className={`absolute inset-0 bg-black/50 transition-opacity ${statesSheetOpen ? "" : "invisible"}`}
          onClick={() => onStatesSheetOpenChange(false)}
          aria-hidden
        />
        <div
          className="absolute left-0 right-0 bottom-0 max-h-[85vh] rounded-t-2xl border-t border-white/20 bg-black/95 shadow-2xl flex flex-col transition-transform duration-300 ease-out"
          style={{
            paddingBottom: "env(safe-area-inset-bottom, 0)",
            transform: statesSheetOpen ? "translateY(0)" : "translateY(100%)",
          }}
        >
          <div className="flex justify-center pt-3 pb-2">
            <div className="w-12 h-1 rounded-full bg-white/30" aria-hidden />
          </div>
          <nav className="overflow-auto flex-1 overscroll-contain" aria-label="States we operate in">
            {listContent}
          </nav>
        </div>
      </div>

      {/* Desktop: sidebar */}
      <nav
        className="hidden md:block absolute right-4 top-20 bottom-4 z-10 w-48 overflow-auto rounded-xl border border-white/20 bg-white/10 backdrop-blur-xl shadow-xl"
        style={{
          paddingTop: "env(safe-area-inset-top, 0)",
          maxHeight: "calc(100vh - 6rem)",
        }}
        aria-label="States we operate in"
      >
        {listContent}
      </nav>
    </>
  );
}

function MapContentPanel({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose?: () => void;
}) {
  const [panelExpanded, setPanelExpanded] = useState(false);
  const dragStartY = useRef(0);
  const handleRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    dragStartY.current = e.clientY;
    handleRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      handleRef.current?.releasePointerCapture(e.pointerId);
      const delta = dragStartY.current - e.clientY;
      if (delta > 30) setPanelExpanded(true);
      else if (delta < -30) setPanelExpanded(false);
    },
    []
  );

  return (
    <aside
      className={`fixed md:absolute bottom-0 left-0 right-0 md:bottom-auto md:left-4 md:top-20 md:right-auto md:bottom-4 z-20 md:z-10 w-full md:max-w-md flex flex-col overflow-hidden rounded-t-2xl md:rounded-xl border-0 md:border border-t border-white/20 md:border-white/20 bg-black/50 backdrop-blur-xl md:bg-white/10 shadow-xl transition-[transform,opacity,max-height] duration-500 ease-out md:transition-[transform,opacity] ${
        panelExpanded ? "max-h-[100dvh] md:max-h-[calc(100vh-6rem)]" : "max-h-[35vh] md:max-h-[calc(100vh-6rem)]"
      } ${visible ? "translate-y-0 md:translate-x-0 opacity-100" : "translate-y-full md:-translate-x-full opacity-0 pointer-events-none"}`}
      style={{
        paddingBottom: "env(safe-area-inset-bottom, 0)",
        paddingLeft: "env(safe-area-inset-left, 0)",
        paddingRight: "env(safe-area-inset-right, 0)",
      }}
      aria-label="Content"
      aria-hidden={!visible}
    >
      {/* Mobile: draggable handle — drag up for full height, drag down for 35% */}
      <div
        ref={handleRef}
        className="md:hidden flex flex-col items-center pt-2 pb-1 cursor-grab active:cursor-grabbing touch-none"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        role="button"
        tabIndex={0}
        aria-label="Drag to resize"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPanelExpanded((v) => !v);
          }
        }}
      >
        <div className="w-12 h-1 rounded-full bg-white/40 shrink-0" aria-hidden />
        <span className="mt-1.5 flex items-center gap-1 text-white/60 text-xs">
          {panelExpanded ? (
            <>
              <span>Drag down to collapse</span>
              <svg className="w-4 h-4 animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </>
          ) : (
            <>
              <span>Drag up for full view</span>
              <svg className="w-4 h-4 animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
            </>
          )}
        </span>
      </div>
      <div className="flex-1 min-h-0 p-4 sm:p-5 pb-8 text-white/90 text-sm leading-relaxed space-y-3 overflow-auto overscroll-contain">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="md:hidden absolute top-2 right-4 z-10 rounded-full p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-white/80 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/30 touch-manipulation"
            style={{ top: "max(0.5rem, env(safe-area-inset-top))" }}
            aria-label="Close"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        <header className="pr-12 md:pr-0">
          <h2 className="text-lg font-semibold text-white">Addressing the Colorado Teacher Shortage</h2>
          <p className="text-xs text-white/60 mt-1">student using a screen · Talk to Us</p>
        </header>
        <p className="text-white/70 italic">A room full of computers with a large screen in the front.</p>

        <section>
          <h3 className="font-semibold text-white">A Learning Model Built for Student Success</h3>
          <p>
            Proximity Learning delivers interactive, live instruction so students in your district receive the
            consistent, high-quality instruction they deserve. With 15+ years of experience, the model stimulates a
            classroom environment through always-live instruction from certified teachers, delivered via livestreamed
            video — never pre-recorded lectures.
          </p>
        </section>

        <section>
          <h3 className="font-semibold text-white">The Proximity Learning Difference</h3>
          <h4 className="font-medium text-white/95 mt-2">Live, Synchronous Instruction</h4>
          <p>
            Certified teachers are livestreamed directly into your classrooms. Each course is designed to align with
            your school&apos;s bell schedule, LMS, and curriculum standards, so your students get the right instruction
            at the right time. Unlike short-term fixes like long-term substitutes, this approach keeps learning
            consistent and effective.
          </p>
          <p className="text-xs text-white/50 mt-2">A young boy wearing glasses and a green shirt.</p>
          <p className="text-xs text-white/50">A woman with red hair smiling and wearing a black shirt.</p>
        </section>

        <section>
          <h4 className="font-medium text-white/95">Built by Educators, for Educators</h4>
          <p>
            Our partnership directors include former superintendents, principals, and experienced teachers who know
            firsthand how vacancies impact students. They understand the urgency created by the educator shortage and
            help districts implement solutions that prioritize learning and stability.
          </p>
        </section>

        <p className="font-medium text-white">Teach With us</p>

        <section>
          <h3 className="font-semibold text-white">Certified Teachers in Colorado</h3>
          <p className="text-xs text-white/60 mb-2">student using a screen · Talk to Us</p>
          <p>
            Licensed teachers in Colorado can join our network to teach across the country through live, synchronous
            instruction. If you hold a Colorado professional license or standard teaching license, Proximity Learning
            helps navigate reciprocity when needed. This makes it simple for aspiring educators and even retired teachers
            to continue making a difference in students&apos; lives while teaching from anywhere.
          </p>
          <p>
            Teaching online provides a better work-life balance while supporting districts struggling with the
            shortage. Proximity Learning teachers are certified, background-checked, and experienced. They&apos;re also
            dynamic, engaging, and caring. Learn more about online teaching jobs in Colorado.
          </p>
          <p className="text-xs text-white/50 mt-2">A group of children sitting in front of a laptop.</p>
          <p className="text-xs text-white/50">A man and a child are working on a project together.</p>
        </section>

        <section>
          <h3 className="font-semibold text-white">Teacher Shortage in Colorado</h3>
          <p>
            The Colorado teacher shortage is creating serious challenges for districts, leaving gaps in instruction that
            impact student achievement. According to the Colorado Department of Education, &quot;Of the 6,911 teaching
            positions to hire, 635 (9%) remained unfilled for the school year and 1,756 (25%) were filled through a
            shortage mechanism.&quot; Shortage mechanisms include uncertified hires and long-term substitutes.
          </p>
          <p>
            When vacancies are filled this way, students miss the consistent instruction they need. This aligns with
            national data from the Teacher Shortage report, estimating over 49,000 unfilled teacher positions across the
            United States. Without immediate action, more low-income students and rural communities will continue to feel
            the impact.
          </p>
        </section>
      </div>
    </aside>
  );
}

const ROTATION_DURATION_MS = 45000; // one full 360° orbit
const EARTH_RADIUS_M = 6371000;
const FALLBACK_ORBIT_RADIUS_M = 220;
const FALLBACK_ORBIT_ALTITUDE_M = 380;
// FlyTo end view (used when we don't have free camera state yet)
const ORBIT_START_BEARING = 180;
const ORBIT_START_PITCH = 60;
const ORBIT_START_ZOOM = 16;

// Distance (m) and bearing (deg from north) from (lng1, lat1) to (lng2, lat2)
function distanceAndBearing(
  lng1: number,
  lat1: number,
  lng2: number,
  lat2: number
): { distanceM: number; bearingDeg: number } {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const x = Math.cos(φ2) * Math.sin(Δλ);
  const y = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let bearingDeg = (Math.atan2(x, y) * 180) / Math.PI;
  if (bearingDeg < 0) bearingDeg += 360;
  const a =
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceM = EARTH_RADIUS_M * c;
  return { distanceM, bearingDeg };
}

// Point at distance (m) and bearing (degrees) from [lng, lat]
function destination(
  lng: number,
  lat: number,
  distanceM: number,
  bearingDeg: number
): [number, number] {
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const br = (bearingDeg * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distanceM / EARTH_RADIUS_M) +
      Math.cos(lat1) * Math.sin(distanceM / EARTH_RADIUS_M) * Math.cos(br)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(distanceM / EARTH_RADIUS_M) * Math.cos(lat1),
      Math.cos(distanceM / EARTH_RADIUS_M) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

function updateFreeCamera(
  mapInstance: mapboxgl.Map,
  position: [number, number],
  altitude: number,
  target: [number, number]
) {
  const camera = mapInstance.getFreeCameraOptions();
  camera.position = mapboxgl.MercatorCoordinate.fromLngLat(position, altitude);
  camera.lookAtPoint(target);
  mapInstance.setFreeCameraOptions(camera);
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<mapboxgl.Map | null>(null);
  const [showContentPanel, setShowContentPanel] = useState(false);
  const rotationActiveRef = useRef(false);
  const rotationFrameRef = useRef<number | null>(null);
  const rotationStartTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!MAPBOX_TOKEN || !containerRef.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    const mapInstance = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/standard",
      config: {
        basemap: {
          lightPreset: "dusk",
          showPlaceLabels: false,
          showPointOfInterestLabels: false,
          showRoadLabels: false,
          showTransitLabels: false,
        },
      },
      center: [-83.05336, 42.332],
      zoom: 16.12,
      bearing: 0.0,
      pitch: 67.5,
    });

    setMap(mapInstance);

    return () => {
      mapInstance.remove();
    };
  }, []);

  const stopRotation = useCallback(() => {
    rotationActiveRef.current = false;
    if (rotationFrameRef.current != null) {
      cancelAnimationFrame(rotationFrameRef.current);
      rotationFrameRef.current = null;
    }
  }, []);

  const startRotation = useCallback(
    (targetLngLat?: [number, number]) => {
      if (!map) return;
      const target: [number, number] =
        targetLngLat ?? [map.getCenter().lng, map.getCenter().lat];
      const camera = map.getFreeCameraOptions();
      const pos = camera.position;
      let orbitRadiusM: number;
      let orbitAltitudeM: number;
      let initialBearingDeg: number;
      if (pos) {
        const camLngLat = pos.toLngLat();
        const camAlt = pos.toAltitude();
        const { distanceM, bearingDeg } = distanceAndBearing(
          target[0],
          target[1],
          camLngLat.lng,
          camLngLat.lat
        );
        orbitRadiusM = distanceM > 1 ? distanceM : FALLBACK_ORBIT_RADIUS_M;
        orbitAltitudeM = camAlt > 1 ? camAlt : FALLBACK_ORBIT_ALTITUDE_M;
        initialBearingDeg = bearingDeg;
      } else {
        orbitRadiusM = FALLBACK_ORBIT_RADIUS_M;
        orbitAltitudeM = FALLBACK_ORBIT_ALTITUDE_M;
        initialBearingDeg = ORBIT_START_BEARING;
      }
      rotationActiveRef.current = true;
      rotationStartTimeRef.current = 0;
      let lastTime = 0;

      const frame = (time: number) => {
        if (!rotationActiveRef.current || !map) return;
        const elapsed = lastTime === 0 ? 0 : time - lastTime;
        lastTime = time;
        rotationStartTimeRef.current += elapsed;
        const phase =
          (rotationStartTimeRef.current % ROTATION_DURATION_MS) /
          ROTATION_DURATION_MS;
        const bearingDeg = initialBearingDeg + phase * 360;
        const position = destination(
          target[0],
          target[1],
          orbitRadiusM,
          bearingDeg
        );
        updateFreeCamera(map, position, orbitAltitudeM, target);
        rotationFrameRef.current = requestAnimationFrame(frame);
      };
      rotationFrameRef.current = requestAnimationFrame(frame);
    },
    [map]
  );

  useEffect(() => {
    if (!map) return;
    const stopOnUserInteraction = () => stopRotation();
    map.getContainer().addEventListener("mousedown", stopOnUserInteraction);
    map.getContainer().addEventListener("touchstart", stopOnUserInteraction, {
      passive: true,
    });
    return () => {
      map.getContainer().removeEventListener("mousedown", stopOnUserInteraction);
      map.getContainer().removeEventListener("touchstart", stopOnUserInteraction);
    };
  }, [map, stopRotation]);

  const onFlyToEnd = useCallback(() => {
    setShowContentPanel(true);
    if (!map) return;
    const target = map.getCenter();
    const targetLngLat: [number, number] = [target.lng, target.lat];
    map.once("idle", () => startRotation(targetLngLat));
  }, [map, startRotation]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="h-screen flex items-center justify-center bg-black text-white/80">
        <p className="text-center max-w-md">
          Add <code className="bg-white/10 px-1 rounded">NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN</code> to{" "}
          <code className="bg-white/10 px-1 rounded">.env.local</code> to view the map.
        </p>
      </div>
    );
  }

  const [statesSheetOpen, setStatesSheetOpen] = useState(false);

  return (
    <MapContext.Provider value={{ map, onFlyToEnd, stopRotation }}>
      <div className="relative w-full min-h-[100dvh] min-h-screen h-screen touch-pan-x touch-pan-y">
        {/* Map container: full viewport for Mapbox */}
        <div
          ref={containerRef}
          className="absolute inset-0 w-full h-full min-h-[100dvh]"
        />
        <StatesNavList
          statesSheetOpen={statesSheetOpen}
          onStatesSheetOpenChange={setStatesSheetOpen}
        />
        <MapContentPanel
          visible={showContentPanel}
          onClose={() => setShowContentPanel(false)}
        />
        <MapSearch />
      </div>
    </MapContext.Provider>
  );
}
