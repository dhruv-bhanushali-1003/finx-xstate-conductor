/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    './public/**/*.html',         // if you render raw HTML
    './node_modules/react-formio/**/*.{js,jsx}' // include react-formio output
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
