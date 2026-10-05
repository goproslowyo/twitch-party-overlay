/**
 * The Help page copy as HTML. `help.md` is content shipped with the binary; the converter below
 * is deliberately minimal — `##`/`###` headings, blank-line paragraphs, `- ` lists (a `[ ]`/`[x]` checkbox prefix
 * becomes a plain item), `**bold**` and `` `code` `` inline. Text is escaped before the two inline forms are applied.
 */
import { escapeHtml } from "../http-util.ts";
import helpMd from "./help.md" with { type: "text" };

const HEADING = /^(#{2,3}) (.+)$/;
const ITEM = /^- (?:\[[ xX]\] )?(.+)$/;

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function renderMarkdown(md: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push(`<p>${inline(paragraph.join(" "))}</p>`);
    if (list.length > 0) blocks.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    paragraph = [];
    list = [];
  };
  for (const rawLine of md.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      if (paragraph.length > 0) flush();
      list.push(item[1]!);
      continue;
    }
    if (list.length > 0) flush();
    paragraph.push(line);
  }
  flush();
  return blocks.join("\n");
}

let cached: string | null = null;

/** The rendered Help page body (rendered once; the copy never changes at runtime). */
export function helpHtml(): string {
  cached ??= renderMarkdown(helpMd);
  return cached;
}
