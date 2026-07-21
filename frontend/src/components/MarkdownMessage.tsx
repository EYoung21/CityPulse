"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeHttpUrl } from "@/lib/safe-url";

// Markdown elements styled against the Ask Pulse panel theme tokens
// (defined in globals.css) so they adapt to light/dark automatically.
const components: Components = {
  p: ({ children }) => (
    <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>
  ),
  // Render markdown headings as ARIA headings rather than real <h1>-<h6>:
  // LLM replies often start with "#"/"##", and injecting real heading tags
  // into the panel would corrupt the page's heading outline (the panel already
  // owns an <h1>). role="heading" + aria-level keeps screen-reader semantics
  // without polluting the document hierarchy; visual sizing is unchanged.
  h1: ({ children }) => (
    <div
      role="heading"
      aria-level={1}
      className="mb-1.5 mt-3 text-base font-semibold first:mt-0"
      style={{ color: "var(--panel-text)" }}
    >
      {children}
    </div>
  ),
  h2: ({ children }) => (
    <div
      role="heading"
      aria-level={2}
      className="mb-1.5 mt-3 text-sm font-semibold first:mt-0"
      style={{ color: "var(--panel-text)" }}
    >
      {children}
    </div>
  ),
  h3: ({ children }) => (
    <div
      role="heading"
      aria-level={3}
      className="mb-1 mt-2.5 text-sm font-semibold first:mt-0"
      style={{ color: "var(--panel-text)" }}
    >
      {children}
    </div>
  ),
  h4: ({ children }) => (
    <div
      role="heading"
      aria-level={4}
      className="mb-1 mt-2.5 text-sm font-semibold first:mt-0"
      style={{ color: "var(--panel-text)" }}
    >
      {children}
    </div>
  ),
  h5: ({ children }) => (
    <div
      role="heading"
      aria-level={5}
      className="mb-1 mt-2.5 text-sm font-semibold first:mt-0"
      style={{ color: "var(--panel-text)" }}
    >
      {children}
    </div>
  ),
  h6: ({ children }) => (
    <div
      role="heading"
      aria-level={6}
      className="mb-1 mt-2.5 text-sm font-semibold first:mt-0"
      style={{ color: "var(--panel-text)" }}
    >
      {children}
    </div>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold" style={{ color: "var(--panel-text)" }}>
      {children}
    </strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => (
    <ul className="my-1.5 ml-4 list-disc space-y-0.5 marker:opacity-50">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 ml-4 list-decimal space-y-0.5 marker:opacity-50">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => {
    const safeHref = normalizeHttpUrl(href);
    if (!safeHref) {
      return <span className="underline decoration-dotted">{children}</span>;
    }
    return (
      <a
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2"
        style={{ color: "#60a5fa" }}
      >
        {children}
      </a>
    );
  },
  // Do not let model-authored Markdown trigger arbitrary third-party image
  // requests (tracking pixels, IP leakage, or huge downloads). Preserve the
  // useful alt text without loading the remote resource.
  img: ({ alt }) => (
    <span className="italic" style={{ color: "var(--panel-text-muted)" }}>
      {alt ? `[Image: ${alt}]` : "[Image omitted]"}
    </span>
  ),
  hr: () => (
    <hr
      className="my-2.5 border-0 border-t"
      style={{ borderColor: "var(--panel-border)" }}
    />
  ),
  blockquote: ({ children }) => (
    <blockquote
      className="my-1.5 border-l-2 pl-3 italic"
      style={{ borderColor: "var(--panel-border)" }}
    >
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const isBlock = /language-/.test(className ?? "") || text.includes("\n");
    // Block code defers its surface to <pre>; just ensure full-strength text.
    if (isBlock) {
      return (
        <code className={className} style={{ color: "var(--panel-text)" }}>
          {children}
        </code>
      );
    }
    // Inline code needs a surface distinct from the bubble (which itself uses
    // --panel-input-bg), hence --panel-code-bg + a border. break-words keeps a
    // long unbroken token from overflowing the bubble.
    return (
      <code
        className="rounded border px-1 py-0.5 text-[0.85em] break-words"
        style={{
          background: "var(--panel-code-bg)",
          borderColor: "var(--panel-border)",
          color: "var(--panel-text)",
        }}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg border p-2.5 text-[0.85em]"
      style={{
        background: "var(--panel-code-bg)",
        borderColor: "var(--panel-border)",
      }}
    >
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[0.85em]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th
      className="border px-2 py-1 text-left font-semibold"
      style={{ borderColor: "var(--panel-border)", color: "var(--panel-text)" }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      className="border px-2 py-1 align-top"
      style={{ borderColor: "var(--panel-border)" }}
    >
      {children}
    </td>
  ),
};

export function MarkdownMessage({ content }: { content: string }) {
  if (!content?.trim()) {
    return (
      <span className="text-sm italic" style={{ color: "var(--panel-text-muted)" }}>
        No response.
      </span>
    );
  }
  return (
    <div className="text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
