/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'cail-navy': '#1D3A83',
        'cail-blue': '#3B73E6',
        'cail-teal': '#2FB8D6',
        'cail-azure': '#2A6FB8',
        'cail-dark': '#0F172A',
        'cail-cream': '#FAFCF8',
        // Text and button blue: cail-blue (#3B73E6) gives white text only 4.4:1, below WCAG AA.
        'cail-link': '#2A5DC9',
        'cail-link-dark': '#93C5FD',
      },
      // System fonts only: the page CSP allows no third-party font host.
      fontFamily: {
        sans: ['system-ui', '-apple-system', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        doc: ['Charter', '"Iowan Old Style"', '"Palatino Linotype"', 'Palatino', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};
