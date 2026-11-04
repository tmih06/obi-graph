import { useEffect, useMemo, useRef, useState } from "react";
import "./note-drawer.css";

/**
 * Obsidian-style note drawer for the demo.
 *
 * The panel is an overlay: it sits on top of the canvas and never resizes the
 * graph, so opening a note cannot re-frame what the user was looking at.
 *
 * `marked` is imported dynamically, which is the whole reason this component
 * exists separately — the markdown parser is demo-only and must not land in the
 * published library bundle. Rolldown emits it as its own chunk and it is only
 * fetched when the first note opens.
 */

interface NoteDrawerProps {
  /** Node currently selected, or null when the drawer is closed. */
  nodeId: string | null;
  title: string;
  markdown: string;
  /** Follow a `[[wiki-link]]` inside the note. */
  onNavigate: (nodeId: string) => void;
  onClose: () => void;
}

/** Escape text before it is placed into an attribute or an anchor body. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Parse markdown once `marked` has loaded.
 *
 * `[[Wiki links]]` become anchors carrying `data-wikilink`; the drawer's click
 * handler turns those into graph jumps. Doing it as a renderer extension keeps
 * the source markdown untouched instead of rewriting the parsed HTML with a
 * regex, which would also hit text inside code blocks.
 */
function useRenderedMarkdown(
  markdown: string,
  enabled: boolean,
): { html: string | null; failed: boolean } {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Closed panels must not fetch the parser: the whole point of the dynamic
    // import is that markdown costs nothing until a note actually opens.
    if (!enabled) return;
    let cancelled = false;
    setFailed(false);
    import("marked")
      .then(({ Marked }) => {
        if (cancelled) return;
        const parser = new Marked({ gfm: true, breaks: false });
        parser.use({
          extensions: [
            {
              name: "wikilink",
              level: "inline",
              start(src: string) {
                return src.indexOf("[[");
              },
              tokenizer(src: string) {
                const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(src);
                if (!match) return undefined;
                return {
                  type: "wikilink",
                  raw: match[0],
                  target: match[1]!.trim(),
                  text: (match[2] ?? match[1]!).trim(),
                };
              },
              renderer(token) {
                const target = escapeHtml(token.target as string);
                return `<a href="#" data-wikilink="${target}" class="wikilink">${escapeHtml(token.text as string)}</a>`;
              },
            },
          ],
        });
        setHtml(parser.parse(markdown, { async: false }) as string);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [markdown, enabled]);

  return { html, failed };
}

export function NoteDrawer({ nodeId, title, markdown, onNavigate, onClose }: NoteDrawerProps) {
  const open = nodeId !== null;
  const { html, failed } = useRenderedMarkdown(markdown, open);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and focus lands on the close button so the panel is usable
  // from the keyboard without hunting for it.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Reset the scroll position when the note changes, or a long note would open
  // scrolled to wherever the previous one was.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [nodeId]);

  /**
   * Wiki-links are plain anchors with a `data-wikilink` attribute; clicking one
   * jumps the graph instead of navigating the page.
   */
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !html) return;
    body.querySelectorAll<HTMLAnchorElement>("a[data-wikilink]").forEach((anchor) => {
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        const target = anchor.getAttribute("data-wikilink");
        if (target) onNavigate(target);
      });
    });
  }, [html, onNavigate]);

  const rendered = useMemo(() => html ?? "", [html]);

  return (
    <aside
      className="note-drawer"
      data-open={open ? "true" : "false"}
      aria-hidden={!open}
      aria-label="Note"
      // Keep pointer events off the canvas while the panel is open, but let the
      // panel itself scroll and select text normally.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="note-drawer__header">
        <h2 className="note-drawer__title" title={title}>
          {title}
        </h2>
        <button
          ref={closeRef}
          type="button"
          className="note-drawer__close"
          onClick={onClose}
          aria-label="Close note"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="note-drawer__body" ref={bodyRef}>
        {failed ? (
          <pre className="note-drawer__fallback">{markdown}</pre>
        ) : (
          <div
            className="note-drawer__markdown"
            // Demo content is generated from the bundled taxonomy, not user
            // input, so the parsed HTML is trusted here. A real vault would
            // sanitize before rendering.
            dangerouslySetInnerHTML={{ __html: rendered }}
          />
        )}
      </div>
    </aside>
  );
}
