"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Compass, Navigation, Radio, Shield, BookOpen, Code2, Lock } from "lucide-react";

type PersonaId = "browse" | "routing" | "newsroom" | "security" | "research" | "api";

interface Persona {
  id: PersonaId;
  label: string;
  icon: typeof Navigation;
  pro?: boolean;
  /** Resolves the href the tab should navigate to. */
  href: (pathname: string) => string;
  /** True when current location should render this tab as active. */
  isActive: (pathname: string, mode: string | null, inbox: string | null) => boolean;
}

const PERSONAS: Persona[] = [
  {
    id: "browse",
    label: "Browse",
    icon: Compass,
    href: () => "/",
    isActive: (pathname, mode) =>
      pathname === "/" && (mode === null || mode === "browse"),
  },
  {
    id: "routing",
    label: "Routing",
    icon: Navigation,
    href: () => "/?mode=routing",
    isActive: (pathname, mode) => pathname === "/" && mode === "routing",
  },
  {
    id: "newsroom",
    label: "Newsroom",
    icon: Radio,
    pro: true,
    href: () => "/?mode=newsroom&inbox=settings",
    isActive: (pathname, mode) => pathname === "/" && mode === "newsroom",
  },
  {
    id: "security",
    label: "Security",
    icon: Shield,
    href: () => "/?mode=security",
    isActive: (pathname, mode) => pathname === "/" && mode === "security",
  },
  {
    id: "research",
    label: "Research",
    icon: BookOpen,
    href: () => "/feed",
    isActive: (pathname) => pathname.startsWith("/feed"),
  },
  {
    id: "api",
    label: "API",
    icon: Code2,
    pro: true,
    href: () => "/use-cases/api",
    isActive: (pathname) => pathname.startsWith("/use-cases/api"),
  },
];

export default function PersonaTabs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode");
  const inbox = searchParams.get("inbox");

  return (
    <div
      className="flex items-center gap-1 rounded-full overflow-x-auto no-scrollbar shrink-0 backdrop-blur-md shadow-lg px-1 py-1"
      style={{ background: "var(--pill-bg)", border: "1px solid var(--pill-border)" }}
      role="tablist"
      aria-label="View by use case"
    >
      {PERSONAS.map((p) => {
        const Icon = p.icon;
        const active = p.isActive(pathname, mode, inbox);
        return (
          <Link
            key={p.id}
            href={p.href(pathname)}
            replace
            role="tab"
            aria-selected={active}
            title={p.label}
            className="flex items-center gap-1.5 px-2.5 md:px-3 py-1.5 rounded-full text-[10px] md:text-xs font-medium transition-all relative whitespace-nowrap"
            style={{
              background: active ? "rgba(59,130,246,0.15)" : "transparent",
              color: active ? "#3b82f6" : "var(--pill-text)",
            }}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" />
            <span>{p.label}</span>
            {p.pro && (
              <Lock
                className="w-2.5 h-2.5 shrink-0"
                style={{ color: active ? "#3b82f6" : "var(--panel-text-muted)" }}
                aria-label="Pro"
              />
            )}
          </Link>
        );
      })}
    </div>
  );
}
