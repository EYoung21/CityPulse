"use client";

import { Code, Book, Terminal, Zap, CheckCircle2, Copy, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

export default function ApiDocsPage() {
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const ENDPOINTS = [
    {
      method: "GET",
      path: "/api/incidents/page",
      desc: "Fetch a paginated list of incidents with optional filtering.",
      params: [
        { name: "city", desc: "Slug of the city (e.g., philly, nyc)" },
        { name: "limit", desc: "Number of items to return (default 20)" },
        { name: "cursor", desc: "Pagination cursor from previous response" },
      ],
      example: "curl https://api.citypulse.io/api/incidents/page?city=philly"
    },
    {
      method: "GET",
      path: "/api/incidents/{id}",
      desc: "Get detailed information for a specific incident.",
      params: [
        { name: "id", desc: "The unique incident ID" },
      ],
      example: "curl https://api.citypulse.io/api/incidents/12345"
    }
  ];

  return (
    <div className="min-h-screen bg-[#0b1120] text-slate-200 selection:bg-blue-500/30">
      <header className="sticky top-0 z-50 backdrop-blur-md bg-[#0b1120]/80 border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20 group-hover:scale-105 transition-transform">
              <Zap className="w-5 h-5 text-white fill-current" />
            </div>
            <span className="font-bold text-lg tracking-tight">CityPulse <span className="text-blue-500">API</span></span>
          </Link>
          <nav className="flex items-center gap-6">
            <a href="https://github.com/EYoung21/CityPulse" target="_blank" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">GitHub</a>
            <Link href="/?view=map&inbox=settings" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-full text-sm font-semibold shadow-lg shadow-blue-500/20 transition-all active:scale-95">
              Get API Key
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-12">
          <div className="space-y-16">
            {/* Hero Section */}
            <section>
              <h1 className="text-4xl md:text-5xl font-extrabold text-white mb-6 tracking-tight">
                Build on the Pulse of your city.
              </h1>
              <p className="text-lg text-slate-400 leading-relaxed max-w-2xl">
                Access real-time, AI-summarized scanner activity through our high-performance REST API. 
                Designed for developers building safety tools, news aggregators, and urban analytics.
              </p>
              <div className="mt-8 flex flex-wrap gap-4">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-bold uppercase tracking-wider">
                  <CheckCircle2 className="w-4 h-4" /> System Operational
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-bold uppercase tracking-wider">
                  <Terminal className="w-4 h-4" /> REST v1.0
                </div>
              </div>
            </section>

            {/* Authentication */}
            <section id="auth" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 bg-slate-800 rounded-lg">
                  <Book className="w-5 h-5 text-blue-400" />
                </div>
                <h2 className="text-2xl font-bold text-white">Authentication</h2>
              </div>
              <p className="text-slate-400 mb-6 leading-relaxed">
                All API requests require a Bearer token in the <code className="text-blue-400 bg-blue-500/10 px-1 rounded">Authorization</code> header. 
                You can generate your personal API key in the CityPulse Settings dashboard.
              </p>
              <div className="relative group">
                <pre className="bg-slate-900 border border-slate-800 rounded-xl p-5 overflow-x-auto font-mono text-sm leading-relaxed">
                  <code className="text-slate-300">
                    Authorization: Bearer <span className="text-blue-400">YOUR_API_KEY</span>
                  </code>
                </pre>
                <button 
                  onClick={() => copyToClipboard("Authorization: Bearer YOUR_API_KEY", "auth")}
                  className="absolute top-4 right-4 p-2 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                >
                  {copied === "auth" ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-slate-400" />}
                </button>
              </div>
            </section>

            {/* Endpoints */}
            <section id="endpoints" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-8">
                <div className="p-2 bg-slate-800 rounded-lg">
                  <Code className="w-5 h-5 text-blue-400" />
                </div>
                <h2 className="text-2xl font-bold text-white">Endpoints</h2>
              </div>
              
              <div className="space-y-10">
                {ENDPOINTS.map((ep, i) => (
                  <div key={i} className="group">
                    <div className="flex items-center gap-3 mb-4">
                      <span className="px-2.5 py-1 bg-blue-500/20 text-blue-400 rounded text-xs font-black tracking-tighter">{ep.method}</span>
                      <h3 className="text-lg font-mono font-bold text-slate-100">{ep.path}</h3>
                    </div>
                    <p className="text-slate-400 mb-4">{ep.desc}</p>
                    
                    <div className="mb-4">
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Parameters</h4>
                      <div className="space-y-2">
                        {ep.params.map((p, pi) => (
                          <div key={pi} className="flex items-start gap-4 text-sm">
                            <code className="text-blue-400 shrink-0 font-bold">{p.name}</code>
                            <span className="text-slate-500">—</span>
                            <span className="text-slate-400">{p.desc}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="relative group/code">
                      <pre className="bg-slate-900/50 border border-slate-800 rounded-xl p-5 overflow-x-auto font-mono text-sm leading-relaxed">
                        <code className="text-blue-300">{ep.example}</code>
                      </pre>
                      <button 
                        onClick={() => copyToClipboard(ep.example, `ep-${i}`)}
                        className="absolute top-4 right-4 p-2 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors opacity-0 group-hover/code:opacity-100"
                      >
                        {copied === `ep-${i}` ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-slate-400" />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Sidebar Nav */}
          <aside className="hidden lg:block">
            <div className="sticky top-28 space-y-8">
              <div>
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Documentation</h4>
                <nav className="space-y-2">
                  <a href="#auth" className="block text-sm text-slate-400 hover:text-blue-400 transition-colors">Authentication</a>
                  <a href="#endpoints" className="block text-sm text-slate-400 hover:text-blue-400 transition-colors">Endpoints</a>
                  <a href="#rate-limits" className="block text-sm text-slate-400 hover:text-blue-400 transition-colors">Rate Limits</a>
                  <a href="#errors" className="block text-sm text-slate-400 hover:text-blue-400 transition-colors">Error Handling</a>
                </nav>
              </div>
              
              <div className="p-6 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-700 shadow-xl shadow-blue-900/20">
                <Zap className="w-6 h-6 text-white mb-4 fill-current" />
                <h4 className="text-white font-bold mb-2">Need higher limits?</h4>
                <p className="text-blue-100 text-xs leading-relaxed mb-4">
                  Upgrade to a Pro or Enterprise plan for dedicated throughput and bulk exports.
                </p>
                <button className="w-full py-2 bg-white text-blue-600 rounded-lg text-xs font-bold hover:bg-blue-50 transition-colors">
                  View Pricing
                </button>
              </div>

              <div className="flex items-center gap-4 text-slate-500">
                <a href="#" className="hover:text-slate-300 transition-colors"><ExternalLink className="w-4 h-4" /></a>
                <span className="text-[10px] font-medium tracking-wider uppercase">v1.0.4 stable</span>
              </div>
            </div>
          </aside>
        </div>
      </main>

      <footer className="border-t border-slate-800 py-12 mt-20">
        <div className="max-w-5xl mx-auto px-4 text-center">
          <p className="text-sm text-slate-500">
            &copy; {new Date().getFullYear()} Pulse Network. All rights reserved. Built for safety and transparency.
          </p>
        </div>
      </footer>
    </div>
  );
}
