import './globals.css'

export const metadata = {
  title: "FinX loan officer Application",
  description: "Loan Officer Review App",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
        {children}
      </body>
    </html>
  );
}
