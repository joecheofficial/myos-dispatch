"use strict";

// Word boundaries for every script. JavaScript's \b only knows ASCII
// [A-Za-z0-9_], so a Cyrillic or accented alias ("Камарумс", "café") had no
// boundary to match at all and never routed. Here any Unicode letter, number,
// combining mark or "_" is a word character; for ASCII neighbours that is
// exactly \b, so English matching is unchanged.
//
// The boundary is checked in code around a plain match rather than compiled
// into each pattern: a \p{L} lookaround inside every alias regex compiles to
// very large code under the "iu" flags, and routing builds one regex per alias
// (it exhausted the heap over a ~900 capability index).
const WORD_CHAR_RE = /^[\p{L}\p{N}\p{M}_]$/u;

function charBefore(text, index) {
  if (index <= 0) return "";
  const code = text.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) return text.slice(index - 2, index);
  return text[index - 1];
}

function charAt(text, index) {
  if (index >= text.length) return "";
  return String.fromCodePoint(text.codePointAt(index));
}

function isWordChar(char) {
  return Boolean(char) && WORD_CHAR_RE.test(char);
}

// True where \b would hold, with Unicode word characters.
function isBoundary(text, index) {
  return isWordChar(charBefore(text, index)) !== isWordChar(charAt(text, index));
}

// `body` is an already-escaped regex source; `flags` may include "i".
function compileBoundedPhrase(body, flags = "i") {
  const re = new RegExp(body, `${String(flags).replace(/[gy]/g, "")}g`);
  function indices(text, limit = Infinity) {
    const value = String(text ?? "");
    const found = [];
    re.lastIndex = 0;
    let match;
    while (found.length < limit && (match = re.exec(value)) !== null) {
      const end = match.index + match[0].length;
      // Like a global \b...\b scan: resume after an accepted match, or one
      // character on from a rejected one.
      if (match[0].length > 0 && isBoundary(value, match.index) && isBoundary(value, end)) {
        found.push(match.index);
        re.lastIndex = end;
      } else {
        re.lastIndex = match.index + 1;
      }
    }
    re.lastIndex = 0;
    return found;
  }
  return {
    test: (text) => indices(text, 1).length > 0,
    indices: (text) => indices(text),
  };
}

module.exports = { compileBoundedPhrase, isBoundary };
