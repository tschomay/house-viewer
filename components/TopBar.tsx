"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const STEPS = [
  { href: "/", label: "1 · Listing" },
  { href: "/analyze", label: "2 · Analyze" },
  { href: "/tour", label: "3 · Tour" },
];

export default function TopBar() {
  const path = usePathname();
  return (
    <header className="topbar">
      <span className="brand">House Viewer</span>
      <nav className="steps">
        {STEPS.map((s) => (
          <Link key={s.href} href={s.href} aria-current={path === s.href ? "page" : undefined}>
            {s.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
