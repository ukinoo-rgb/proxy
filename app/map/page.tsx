import dynamic from "next/dynamic";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => (
    <div className="h-screen flex items-center justify-center bg-black text-white/60">
      <span>Loading map…</span>
    </div>
  ),
});

export default function MapPage() {
  return <MapView />;
}
