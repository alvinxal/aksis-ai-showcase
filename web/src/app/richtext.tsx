import type { ReactNode } from 'react'

/** WhatsApp-style marks: *tebal*, _miring_, ~coret~ and `kode`. Only text nodes are produced, so React escapes everything. */
const MARK = /(\*[^\s*](?:[^*\n]*[^\s*])?\*|_[^\s_](?:[^_\n]*[^\s_])?_|~[^\s~](?:[^~\n]*[^\s~])?~|`[^`\n]+`)/g

export function renderRich(text: string): ReactNode[] {
  return text.split(MARK).map((part, index) => {
    if (index % 2 === 0) return part
    const inner = part.slice(1, -1)
    switch (part[0]) {
      case '*':
        return <strong key={index} className="font-semibold">{renderRich(inner)}</strong>
      case '_':
        return <em key={index}>{renderRich(inner)}</em>
      case '~':
        return <del key={index}>{renderRich(inner)}</del>
      default:
        return <code key={index} className="rounded bg-black/5 px-1 py-0.5 font-mono text-[0.8125rem]">{inner}</code>
    }
  })
}
