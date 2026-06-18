// Codemaru v0.2 content logic. Injected into the MAIN world so it can reach the
// page's built-in AI globals (LanguageModel / Translator).
// Exposes window.__codemaru = { translate, restore, probe }.
(function () {
  if (window.__codemaruV2) return;
  window.__codemaruV2 = true;

  // ---- constants ---------------------------------------------------------
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "SVG", "MATH",
    "CODE", "PRE", "KBD", "SAMP", "VAR", "TT"
  ]);
  const BLOCK_SEL =
    "p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt,figcaption,summary,caption,details";

  const SEP = "\u2502";          // │  marker separator (rare in code/prose)
  const OQ = "\uE000", CQ = "\uE001"; // opaque sentinels for the MT engine
  const MARK_RE = new RegExp("\u27E6(\\d+)" + SEP + "[^\u27E7]*\u27E7", "g"); // ⟦N│literal⟧
  const OPAQUE_RE = new RegExp(OQ + "\\s*(\\d+)\\s*" + CQ, "g");

  // Conservative "don't translate" patterns for bare text (beyond <code>).
  const INLINE_MASKS = [
    /https?:\/\/[^\s]+/g,                 // URLs
    /(?:^|\s)(--?[A-Za-z][\w-]*)/g,       // CLI flags  --verbose / -v
    /\bv\d+(?:\.\d+)+\b/g,                // v1.2.3
    /\b\d+\.\d+\.\d+\b/g,                 // 1.2.3
    /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g  // ENV_VAR_NAMES
  ];

  // ---- tiny helpers ------------------------------------------------------
  function escapeHTML(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
  function trunc(s, n) {
    s = String(s).replace(/\s+/g, " ").replace(/\u27E7/g, "").trim();
    return s.length > n ? s.slice(0, n) + "\u2026" : s;
  }

  const cache = new Map(); // source(masked) -> translated(marked)

  // ---- masking -----------------------------------------------------------
  // Returns { text, tokens } where tokens[i] = { raw } (HTML) or { text } (plain).
  function maskBlock(el, includeCode) {
    let text = "";
    const tokens = [];
    const push = (token, literal) => {
      const i = tokens.length;
      tokens.push(token);
      return "\u27E6" + i + SEP + trunc(literal, 24) + "\u27E7";
    };

    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const isCode = SKIP_TAGS.has(node.tagName) || node.closest("code,pre");
        if (isCode && !includeCode) {
          text += " " + push({ raw: node.outerHTML }, node.textContent) + " ";
        } else {
          text += node.textContent; // inline markup flattened (v0.2 limitation)
        }
      }
    });

    // mask bare in-text technical tokens
    if (!includeCode) {
      for (const re of INLINE_MASKS) {
        text = text.replace(re, (m, g1) => {
          const lead = g1 && m.startsWith(g1) === false ? m.slice(0, m.length - g1.length) : "";
          const val = g1 || m;
          return lead + push({ text: val }, val);
        });
      }
    }
    return { text: text.replace(/\s+/g, " ").trim(), tokens };
  }

  function tokenHTML(tokens, i) {
    const t = tokens[i];
    if (!t) return "";
    return t.raw != null ? t.raw : escapeHTML(t.text);
  }

  // Rebuild HTML from a (translated) marked string.
  function restore(s, tokens) {
    const seen = new Set();
    let html = escapeHTML(s)
      .replace(MARK_RE, (_, i) => { seen.add(+i); return tokenHTML(tokens, +i); })
      .replace(OPAQUE_RE, (_, i) => { seen.add(+i); return tokenHTML(tokens, +i); });
    // never silently lose code: append any tokens the model dropped
    const missing = [];
    for (let i = 0; i < tokens.length; i++) if (!seen.has(i)) missing.push(tokenHTML(tokens, i));
    if (missing.length) html += " " + missing.join(" ");
    return html;
  }

  function tagsOk(s, n) {
    if (n === 0) return true;
    const found = new Set();
    let m;
    MARK_RE.lastIndex = 0;
    while ((m = MARK_RE.exec(s))) found.add(+m[1]);
    OPAQUE_RE.lastIndex = 0;
    while ((m = OPAQUE_RE.exec(s))) found.add(+m[1]);
    for (let i = 0; i < n; i++) if (!found.has(i)) return false;
    return true;
  }

  // ---- block collection --------------------------------------------------
  function collectBlocks() {
    const out = [];
    document.querySelectorAll(BLOCK_SEL).forEach((el) => {
      if (el.closest('[data-codemaru="t"]')) return;
      if (el.dataset.codemaruDone) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.querySelector(BLOCK_SEL)) return;     // leaf blocks only
      if (el.closest("code,pre")) return;
      if (el.textContent.replace(/\s+/g, " ").trim().length < 2) return;
      out.push(el);
    });
    return out;
  }

  // ---- availability probe (defensive across API shapes) ------------------
  async function lmAvailability(source, target) {
    const langs = [...new Set(["en", source, target])];
    try {
      return await LanguageModel.availability({
        expectedInputs: [{ type: "text", languages: langs }],
        expectedOutputs: [{ type: "text", languages: [target] }]
      });
    } catch (_) {
      try { return await LanguageModel.availability({ languages: langs }); }
      catch (__) { try { return await LanguageModel.availability(); } catch (e3) { return "available"; } }
    }
  }

  // ---- prompt construction (system + few-shot) ---------------------------
  function initialPrompts() {
    const sys =
      "You are a professional translator of software/programming documentation, " +
      "translating English into natural, fluent Japanese (technical-documentation style, polite \u3067\u3059\u30FB\u307E\u3059 form, consistent).\n" +
      "RULES:\n" +
      "1. The input may contain tokens shaped like \u27E6N\u2502text\u27E7 (e.g. \u27E60\u2502init()\u27E7). " +
      "These are code identifiers, flags, paths, URLs or versions. NEVER translate or modify them. " +
      "Treat each token as a single NOUN and place it where it reads naturally in Japanese word order. " +
      "Reproduce every token EXACTLY, including its \u27E6N\u2502...\u27E7 wrapper.\n" +
      "2. Keep these terms in English: API, URL, HTTP, JSON, true, false, null, async, await, Promise, callback.\n" +
      "3. Prefer consistent terms: function=\u95A2\u6570, method=\u30E1\u30BD\u30C3\u30C9, argument/parameter=\u5F15\u6570, " +
      "return value=\u623B\u308A\u5024, array=\u914D\u5217, object=\u30AA\u30D6\u30B8\u30A7\u30AF\u30C8, deprecated=\u975E\u63A8\u5968, default=\u30C7\u30D5\u30A9\u30EB\u30C8.\n" +
      "4. Output ONLY the Japanese translation. No preamble, no quotes, no English original.";
    return [
      { role: "system", content: sys },
      { role: "user", content: "Call \u27E60\u2502foo()\u27E7 before \u27E61\u2502init()\u27E7." },
      { role: "assistant", content: "\u27E61\u2502init()\u27E7 \u306E\u524D\u306B \u27E60\u2502foo()\u27E7 \u3092\u547C\u3073\u51FA\u3057\u307E\u3059\u3002" },
      { role: "user", content: "The \u27E60\u2502--verbose\u27E7 flag enables detailed logging in \u27E61\u2502config.yaml\u27E7." },
      { role: "assistant", content: "\u27E60\u2502--verbose\u27E7 \u30D5\u30E9\u30B0\u3092\u4F7F\u3046\u3068\u3001\u27E61\u2502config.yaml\u27E7 \u3067\u8A73\u7D30\u306A\u30ED\u30B0\u51FA\u529B\u304C\u6709\u52B9\u306B\u306A\u308A\u307E\u3059\u3002" }
    ];
  }

  function cleanOut(s) {
    return String(s).trim()
      .replace(/^```[\w]*\n?|```$/g, "")
      .replace(/^(翻訳|訳|Japanese)\s*[:：]\s*/i, "")
      .replace(/^["「『]|["」』]$/g, "")
      .trim();
  }

  // ---- ENGINE INTERFACE --------------------------------------------------
  // Each engine implements: ensure(src,tgt) and translate(markedText, ctx, opts) -> markedJa
  // Adding a BYOK cloud engine later = add another object here. No core rewrite.
  const Engines = {
    // On-device Gemini Nano via the Prompt API.
    nano: {
      session: null, key: "",
      async ensure(source, target) {
        if (typeof LanguageModel === "undefined") { const e = new Error("NO_API"); e.code = "NO_API"; throw e; }
        const k = source + ">" + target;
        if (this.session && this.key === k) return;
        const a = await lmAvailability(source, target);
        if (a === "unavailable") { const e = new Error("UNAVAILABLE"); e.code = "UNAVAILABLE"; throw e; }
        this.session = await LanguageModel.create({
          initialPrompts: initialPrompts(),
          expectedInputs: [{ type: "text", languages: [...new Set(["en", source, target])] }],
          expectedOutputs: [{ type: "text", languages: [target] }],
          monitor(m) {
            m.addEventListener("downloadprogress", (e) =>
              console.log("[Codemaru] Nano download " + Math.round(e.loaded * 100) + "%"));
          }
        });
        this.key = k;
        this.availability = a;
      },
      async translate(text, ctx, opts) {
        const user =
          (ctx && ctx.prev ? "\u6587\u8108(\u8A33\u3055\u306A\u3044): " + ctx.prev + "\n\n" : "") +
          "\u6B21\u306E\u6587\u3092\u65E5\u672C\u8A9E\u306B\u8A33\u3057\u3066:\n" + text;
        let s = this.session, clone = null;
        if (s.clone) { clone = await s.clone(); s = clone; }
        try {
          return cleanOut(await s.prompt(user));
        } finally {
          if (clone && clone.destroy) { try { clone.destroy(); } catch (_) {} }
        }
      }
    },

    // Fallback: Chrome's purpose-built Translator API (pure MT, no instructions).
    mt: {
      t: null, key: "",
      async ensure(source, target) {
        if (typeof Translator === "undefined") { const e = new Error("NO_API"); e.code = "NO_API"; throw e; }
        const k = source + ">" + target;
        if (this.t && this.key === k) return;
        const a = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
        if (a === "unavailable") { const e = new Error("UNAVAILABLE"); e.code = "UNAVAILABLE"; throw e; }
        this.t = await Translator.create({
          sourceLanguage: source, targetLanguage: target,
          monitor(m) {
            m.addEventListener("downloadprogress", (e) =>
              console.log("[Codemaru] Translator download " + Math.round(e.loaded * 100) + "%"));
          }
        });
        this.key = k;
      },
      async translate(text, ctx, opts) {
        // MT can't follow tag rules: strip literals to bare opaque sentinels.
        const opaque = text.replace(MARK_RE, (_, i) => OQ + i + CQ);
        return await this.t.translate(opaque);
      }
    }

    /* FUTURE — BYOK cloud engine (not implemented):
    , cloud: {
        async ensure(s,t){ /* read user's own API key from storage * / },
        async translate(text, ctx, opts){ /* POST to provider with same tag rules * / }
      }
    */
  };

  async function pickEngine(opts) {
    if (!opts.forceMT) {
      try { await Engines.nano.ensure(opts.source, opts.target); return { e: Engines.nano, name: "nano" }; }
      catch (_) { /* fall through to MT */ }
    }
    await Engines.mt.ensure(opts.source, opts.target); // may throw NO_API/UNAVAILABLE
    return { e: Engines.mt, name: "mt" };
  }

  // ---- public API --------------------------------------------------------
  window.__codemaru = {
    async probe(opts) {
      const o = opts || {};
      const hasNano = typeof LanguageModel !== "undefined";
      const hasMT = typeof Translator !== "undefined";
      if (!hasNano && !hasMT) return { ok: false, code: "NO_API" };
      let nanoAvail = null;
      if (hasNano && !o.forceMT) { try { nanoAvail = await lmAvailability(o.source || "en", o.target || "ja"); } catch (_) {} }
      return { ok: true, hasNano, hasMT, nanoAvail };
    },

    async translate(opts) {
      const o = opts || {};
      o.source = o.source || "en";
      o.target = o.target || "ja";

      let engine, name;
      try { const r = await pickEngine(o); engine = r.e; name = r.name; }
      catch (e) { return { error: e.code || String(e.message || e) }; }

      const blocks = collectBlocks();
      let done = 0, failed = 0, prev = "";

      for (const el of blocks) {
        if (el.dataset.codemaruDone) continue;
        const { text, tokens } = maskBlock(el, !!o.includeCode);
        if (!text) continue;

        let ja = cache.get(text);
        if (ja == null) {
          try {
            ja = await engine.translate(text, { prev: trunc(prev, 120) }, o);
            if (name === "nano" && !tagsOk(ja, tokens.length)) {
              ja = await engine.translate(text, { prev: "" }, o); // one retry, no context
            }
          } catch (_) { failed++; prev = el.textContent; continue; }
          cache.set(text, ja);
        }

        const out = document.createElement("div");
        out.setAttribute("data-codemaru", "t");
        out.style.cssText =
          "margin:.15em 0 .55em;padding:.25em .55em;border-left:3px solid #6c8cff;" +
          "background:rgba(108,140,255,.06);border-radius:3px;font-size:.97em;line-height:1.6;";
        out.innerHTML = restore(ja, tokens);
        el.after(out);
        el.dataset.codemaruDone = "1";
        prev = el.textContent;
        done++;
      }
      return { blocks: blocks.length, done, failed, engine: name };
    },

    restore() {
      document.querySelectorAll('[data-codemaru="t"]').forEach((n) => n.remove());
      document.querySelectorAll("[data-codemaru-done]").forEach((n) => { delete n.dataset.codemaruDone; });
      return { ok: true };
    }
  };
})();
