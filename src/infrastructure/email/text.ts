// Turning an e-mail's HTML into a readable plain-text copy.
/** Removes anything that looks like an HTML tag in one pass (a loop, so a long run of "<" cannot make it quadratic). */
function stripTags(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('<', i);
    const close = open === -1 ? -1 : html.indexOf('>', open + 1);
    if (close === -1) { out += html.slice(i); break; } // no tag left to strip
    out += html.slice(i, open);
    i = close + 1;
  }
  return out;
}

/** A readable plain-text version of an email's HTML: links become "label: address", block ends become line breaks. */
export function htmlToText(html: string): string {
  return stripTags(
    html
      .replace(/<(style|head|script)[\s\S]{0,20000}?<\/\1>/gi, '')
      .replace(/<a\b[^>]{0,500}?href="([^"]{1,2000})"[^>]{0,500}>([\s\S]{0,2000}?)<\/a>/gi, (_m, href: string, label: string) => `${stripTags(label).trim()}: ${href}`)
      .replace(/<\/?(?:br|p|div|h[1-6]|tr|li|table)\b[^>]*>/gi, '\n'),
  )
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]{1,200}\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}
