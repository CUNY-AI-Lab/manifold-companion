import { ManifoldLogo } from './Header';

const NOISE_SVG = "data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E";

const partners = [
  { name: 'The Graduate Center, CUNY', url: 'https://gc.cuny.edu/', img: '/images/partners/gc-logo-white.png', h: 'h-8' },
  { name: 'Graduate Center Digital Initiatives', url: 'https://gcdi.commons.gc.cuny.edu/', img: '/images/partners/logo-gcdi.png', h: 'h-7', invert: true },
  { name: 'Teaching and Learning Center', url: 'https://tlc.commons.gc.cuny.edu/', img: '/images/partners/TLC-Logo-v4-No-GC-white.png', h: 'h-7', invert: true },
  { name: 'Mina Rees Library', url: 'https://library.gc.cuny.edu/', img: '/images/partners/MRS_logo_One_Search.png', h: 'h-7', invert: true },
  { name: 'American Social History Project', url: 'https://ashp.cuny.edu/', img: '/images/partners/ashp-logo-blue.png', h: 'h-7', invert: true },
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
          <p className="text-xs text-gray-500">&copy; {new Date().getFullYear()} CUNY AI Lab</p>

          <div className="flex flex-wrap items-center gap-6">
            {partners.map((p) => (
              <a
                key={p.name}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="opacity-60 hover:opacity-100 transition-opacity"
              >
                <img
                  src={p.img}
                  alt={p.name}
                  className={`${p.h} w-auto ${p.invert ? 'brightness-0 invert' : ''}`}
                />
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
