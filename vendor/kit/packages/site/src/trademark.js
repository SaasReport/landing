/**
 * The trademark sign on the brand name, applied to the built site: `project.trademark = { names: ["Brand"], mark: "™",
 * except: ["Brand Ltd"] }` (except: phrases left unmarked, such as the legal entity's name).
 * HTML: text, <title> and the content/title/alt/aria-label/placeholder attributes; never inside <script>, <style>,
 * URLs, ids or classes. JS: only inside string literals, template text and comments, never in code, so a variable
 * named like the brand stays valid; a script that parsed before must still parse after, or the build stops.
 * JSON: the name as a whole word. Always whole words only, so identifiers (BrandNotify), paths (/brand), e-mail
 * addresses, domains (lowercase) and hyphenated compounds (a GitHub organisation such as Brand-Org) stay as they are. Idempotent: a name already followed by the mark is skipped.
 */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function trademarker({ names = [], mark = "™", except = [] } = {}) {
  if (!names.length) return null;
  // Longest names first, so "Brand Protocol" wins over "Brand"; a shorter name is never marked inside a longer one
  // that is already marked ("Brand Protocol™" stays as it is: the mark is idempotent).
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_/.@#-])(${sorted.map(esc).join("|")})(?![\\p{L}\\p{N}_${mark}]|-[\\p{L}\\p{N}])`, "gu");
  // `except`: phrases that contain a name but are not the mark's (a legal entity such as "Brand Ltd") stay unmarked.
  const skip = (str, offset) => except.some((e) => { const i = str.lastIndexOf(e, offset); return i >= 0 && i <= offset && offset < i + e.length; });
  const word = (s) => s.replace(re, (m, name, offset, str) => (skip(str, offset) || sorted.some((l) => l.length > name.length && l.startsWith(name) && str.startsWith(l, offset)) ? m : `${name}${mark}`));
  const ATTR = /(\s(?:content|title|alt|aria-label|placeholder)=")([^"]*)(")/g;
  const html = (s) => s.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>)/).map((part, i) => {
    if (i % 2 === 0) return word(part);                       // text between tags
    if (/^<(script|style)/i.test(part)) return part;          // never inside scripts or styles
    return part.replace(ATTR, (_, a, v, b) => a + word(v) + b);
  }).join("");
  return (file, body) => {
    if (typeof body !== "string") return body;
    if (file.endsWith(".html")) return html(body);
    if (file.endsWith(".js") || file.endsWith(".mjs")) return script(file, body, word);
    if (file.endsWith(".json")) return word(body);
    return body;
  };
}

const parses = (src) => { try { new Function(src); return true; } catch { return false; /* the source does not parse: false is the answer */ } };

/** Apply `fn` to the strings, template text and comments of a script; code (identifiers, regexes) is kept as is. */
export function markScriptText(src, fn) {
  let i = 0, prev = "";
  const n = src.length;
  const regexAllowed = () => prev === "" || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/.test(prev);
  function code(stopAtBrace) {
    let out = "", depth = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === "/" && d === "/") { let j = src.indexOf("\n", i); if (j < 0) j = n; out += fn(src.slice(i, j)); i = j; continue; }
      if (c === "/" && d === "*") { let j = src.indexOf("*/", i + 2); j = j < 0 ? n : j + 2; out += fn(src.slice(i, j)); i = j; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
        out += fn(src.slice(i, j + 1)); i = j + 1; prev = "a"; continue;
      }
      if (c === "`") { out += template(); prev = "a"; continue; }
      if (c === "/" && regexAllowed()) {
        let j = i + 1, cls = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; else if (src[j] === "/" && !cls) break;
          j++;
        }
        j++; while (j < n && /[a-z]/i.test(src[j])) j++;
        out += src.slice(i, j); i = j; prev = "a"; continue;
      }
      const id = /^[\p{L}\p{N}_$]+/u.exec(src.slice(i, i + 64));
      if (id) { let j = i; while (j < n && /[\p{L}\p{N}_$]/u.test(src[j])) j++; prev = src.slice(i, j); out += prev; i = j; continue; }
      if (/\s/.test(c)) { out += c; i++; continue; }
      if (c === "{") depth++;
      if (c === "}") { if (stopAtBrace && depth === 0) return out; depth--; }
      out += c; prev = c; i++;
    }
    return out;
  }
  function template() {
    let out = "`", text = "";
    i++;
    while (i < n) {
      const c = src[i];
      if (c === "\\") { text += src.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { out += fn(text) + "`"; i++; return out; }
      if (c === "$" && src[i + 1] === "{") { out += fn(text) + "${"; text = ""; i += 2; prev = "{"; out += code(true) + "}"; i++; continue; }
      text += c; i++;
    }
    return out + fn(text);
  }
  return code(false);
}

function script(file, body, word) {
  const out = markScriptText(body, word);
  if (out !== body && parses(body) && !parses(out)) throw new Error(`trademark: marking ${file} would break the script`);
  return out;
}
