import { ManifoldLogo } from './Header';

const NOISE_SVG = "data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.4'/%3E%3C/svg%3E";

const partners = [
  { name: 'GC CUNY', url: 'https://www.gc.cuny.edu/' },
  { name: 'GCDI', url: 'https://gcdi.commons.gc.cuny.edu/' },
  { name: 'TLC', url: 'https://tlc.commons.gc.cuny.edu/' },
  { name: 'Mina Rees Library', url: 'https://library.gc.cuny.edu/' },
  { name: 'ASHP', url: 'https://ashp.cuny.edu/' },
];

export default function Footer() {
  return (
    <footer className="relative bg-cail-stone text-white overflow-hidden">
      {/* Noise texture overlay */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{ backgroundImage: `url("${NOISE_SVG}")` }}
      />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <p className="text-xs text-gray-500">&copy; 2026 CUNY AI Lab</p>

          <div className="flex flex-wrap items-center gap-6">
            {partners.map((p) => (
              <a
                key={p.name}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-gray-400 opacity-60 hover:opacity-100 transition-opacity font-medium tracking-wide uppercase"
              >
                {p.name}
              </a>
            ))}

            <a
              href="https://manifoldapp.org"
              target="_blank"
              rel="noopener noreferrer"
              className="opacity-60 hover:opacity-100 transition-opacity text-gray-400 hover:text-white"
              aria-label="Manifold"
            >
              <ManifoldLogo className="w-6 h-6" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
