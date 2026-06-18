const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const engineEl = $("engine");
const setStatus = (s) => { statusEl.textContent = s; };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
function badPage(url) {
  return !url || /^(chrome|edge|brave|about|chrome-extension|view-source|https:\/\/chromewebstore)/.test(url);
}
async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content.js"] });
}
async function call(tabId, fnName, arg) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: (name, a) => window.__codemaru[name](a),
    args: [fnName, arg ?? null]
  });
  return res?.result;
}
function opts() {
  return {
    source: $("source").value,
    target: $("target").value,
    forceMT: $("forceMT").checked,
    includeCode: $("includeCode").checked
  };
}

$("go").addEventListener("click", async () => {
  const tab = await activeTab();
  engineEl.textContent = "";
  if (badPage(tab?.url)) {
    setStatus("このページでは動きません(chrome:// や拡張ストア等)。\n普通のhttps記事で試してください。");
    return;
  }
  const o = opts();
  setStatus("準備中…");
  try {
    await inject(tab.id);
    const probe = await call(tab.id, "probe", o);
    if (!probe?.ok) {
      setStatus(
        "内蔵AIが見つかりません。\n・Chromeを最新に更新\n" +
        "・必要なら chrome://flags で Prompt API / Translation API を Enabled\n" +
        "してから再起動してください。"
      );
      return;
    }
    const usingNano = !o.forceMT && probe.hasNano && probe.nanoAvail && probe.nanoAvail !== "unavailable";
    if (usingNano && probe.nanoAvail !== "available") {
      setStatus("Nanoモデルを初回ダウンロード中…\n(数分かかることがあります。完了後もう一度押すと確実です)");
    } else {
      setStatus("翻訳中…" + (usingNano ? "(Nano / やや時間がかかります)" : "(高速MT)"));
    }
    const r = await call(tab.id, "translate", o);
    if (r?.error) {
      setStatus("利用できませんでした(" + r.error + ")。\nNano非対応の端末なら高速モードを試してください。");
      return;
    }
    setStatus(`完了:${r.done} ブロック訳${r.failed ? `(失敗 ${r.failed})` : ""} / 全 ${r.blocks}`);
    engineEl.textContent = "engine: " + (r.engine === "nano" ? "Gemini Nano (on-device)" : "内蔵MT");
  } catch (e) {
    setStatus("エラー: " + String(e?.message || e));
  }
});

$("undo").addEventListener("click", async () => {
  const tab = await activeTab();
  try {
    await inject(tab.id);
    await call(tab.id, "restore");
    setStatus("原文に戻しました。");
    engineEl.textContent = "";
  } catch (e) {
    setStatus("エラー: " + String(e?.message || e));
  }
});
