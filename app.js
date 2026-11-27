// 말모 — Gemini Live API로 3분 영어 음성 통화
(() => {
  const CALL_SECONDS = 180;
  const API = "https://generativelanguage.googleapis.com/v1beta";
  const WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
  const LIVE_FALLBACKS = [
    "gemini-2.5-flash-native-audio-preview-09-2025",
    "gemini-live-2.5-flash-preview",
    "gemini-2.0-flash-live-001",
  ];
  const TEXT_FALLBACK = "gemini-2.5-flash";
  const LS = { key: "malmo.geminiKey", voice: "malmo.gvoice", level: "malmo.level" };

  const $ = (id) => document.getElementById(id);
  const screens = ["home", "settings", "call", "result"];
  const show = (name) => screens.forEach((s) => $("screen-" + s).classList.toggle("hidden", s !== name));
  // 브라우저 저장이 막혀 있어도(개인정보 보호 모드 등) 이번 방문 동안은 기억해요
  const mem = {};
  const store = {
    get(k, d = "") { try { const v = localStorage.getItem(k); if (v != null) return v; } catch {} return mem[k] ?? d; },
    set(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch {} },
  };
  // 복사할 때 섞여 들어간 공백·따옴표·보이지 않는 문자를 지워요
  const cleanKey = (v) => String(v || "").replace(/[\s"'`\u200B-\u200D\uFEFF]/g, "");

  // ───────── 설정 ─────────
  let afterSettings = null;
  function openSettings(next = null) {
    afterSettings = next;
    $("api-key").value = store.get(LS.key);
    $("api-key").dispatchEvent(new Event("input"));
    $("voice").value = store.get(LS.voice, "Aoede");
    $("level").value = store.get(LS.level, "intermediate");
    show("settings");
  }
  $("btn-settings").onclick = () => openSettings();
  $("btn-cancel").onclick = () => show("home");
  const keyMsg = (text, cls = "") => { $("key-msg").textContent = text; $("key-msg").className = "key-msg " + cls; };
  $("api-key").addEventListener("input", () => {
    const k = cleanKey($("api-key").value);
    if (!k) keyMsg("");
    else if (/^AIza[0-9A-Za-z_-]{30,}$/.test(k)) keyMsg("키 모양이 맞아요 ✓", "good");
    else keyMsg("Gemini 키는 보통 AIza 로 시작해요. 다시 확인해 주세요.", "bad");
  });
  $("btn-paste").onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      $("api-key").value = cleanKey(t);
      $("api-key").dispatchEvent(new Event("input"));
    } catch {
      $("api-key").focus();
      keyMsg("칸을 길게 누른 뒤 '붙여넣기'를 눌러 주세요.", "bad");
    }
  };
  $("btn-eye").onclick = () => {
    const shown = $("api-key").classList.toggle("show");
    $("btn-eye").textContent = shown ? "숨기기" : "보기";
  };
  $("btn-save").onclick = () => {
    const key = cleanKey($("api-key").value);
    if (key && !/^AIza/.test(key)) { keyMsg("Gemini 키는 AIza 로 시작해요. 다시 확인해 주세요.", "bad"); return; }
    store.set(LS.key, key);
    store.set(LS.voice, $("voice").value);
    store.set(LS.level, $("level").value);
    $("home-error").textContent = "";
    show("home");
    if (key && afterSettings) { const f = afterSettings; afterSettings = null; f(); }
  };

  // ───────── 프롬프트 ─────────
  const LEVEL_TEXT = {
    beginner: "The learner is a beginner. Use very short, simple sentences and common words. Speak slowly and clearly.",
    intermediate: "The learner is an intermediate speaker. Use everyday, natural English at a relaxed pace.",
    advanced: "The learner is fairly advanced. Speak naturally, at normal speed, with natural idioms.",
  };
  const instructions = (level) => [
    "You are Malmo, a warm and friendly English conversation partner on a 3-minute phone call with a Korean learner.",
    LEVEL_TEXT[level] || LEVEL_TEXT.intermediate,
    "Always speak in English only. Never switch to Korean, even if the learner does.",
    "IMPORTANT: The learner may mix Korean words or phrases into their English when they don't know the English word (for example: \"I went to the 편의점 yesterday\").",
    "Understand the Korean naturally and keep the conversation going smoothly. Do not stop to teach, correct, or translate. The learner gets a summary of those words after the call.",
    "Keep each turn short (1-3 sentences) and end most turns with an easy, open question so the learner talks more than you.",
    "When you are told the call is ending, say a short, warm goodbye.",
  ].join("\n");

  // ───────── 모델 찾기 ─────────
  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  let modelCache = null;
  async function findModels(key) {
    if (modelCache?.key === key) return modelCache;
    let names = [];
    let pageToken = "";
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${API}/models?pageSize=200${pageToken ? "&pageToken=" + pageToken : ""}`, { headers: { "x-goog-api-key": key } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, body?.error?.message || "");
      names.push(...(body.models || []));
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    const short = (m) => m.name.replace(/^models\//, "");
    const live = names.filter((m) => (m.supportedGenerationMethods || []).includes("bidiGenerateContent")).map(short);
    const score = (n) => (/native-audio/.test(n) ? 4 : 0) + (/flash/.test(n) ? 2 : 0) + (/preview|exp/.test(n) ? 0 : 1);
    live.sort((a, b) => score(b) - score(a) || b.localeCompare(a));
    const liveList = live.length ? live : LIVE_FALLBACKS;
    const text = names
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(short)
      .filter((n) => /flash/.test(n) && !/live|audio|image|tts|lite|exp|preview/.test(n));
    text.sort((a, b) => b.localeCompare(a));
    modelCache = { key, live: liveList, text: text[0] || TEXT_FALLBACK };
    return modelCache;
  }

  function friendlyError(status, msg = "") {
    const m = String(msg);
    if (/API key not valid|API_KEY_INVALID|invalid api key/i.test(m) || status === 400 && /key/i.test(m)) return "API 키가 올바르지 않아요. 설정에서 다시 확인해 주세요.";
    if (status === 429 || /quota|RESOURCE_EXHAUSTED|rate limit/i.test(m)) return "오늘 무료 사용량을 다 썼어요. 잠시 후나 내일 다시 해 주세요.";
    if (status === 403 || /permission|location|region/i.test(m)) return "이 API 키로는 음성 모델을 쓸 수 없어요. 키를 다시 만들어 보세요.";
    return "연결에 실패했어요. 잠시 후 다시 시도해 주세요." + (status ? ` (${status})` : "");
  }

  // ───────── 오디오 도우미 ─────────
  function toBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function fromBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Float32(원래 샘플레이트) → Int16 16kHz
  function downsampleTo16k(input, inRate) {
    const ratio = inRate / 16000;
    const len = Math.floor(input.length / ratio);
    const out = new Int16Array(len);
    let pos = 0;
    for (let i = 0; i < len; i++) {
      const next = Math.floor((i + 1) * ratio);
      let sum = 0, n = 0;
      for (; pos < next && pos < input.length; pos++) { sum += input[pos]; n++; }
      const v = Math.max(-1, Math.min(1, n ? sum / n : 0));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  }

  // ───────── 통화 상태 ─────────
  let ws = null, ctx = null, mic = null, srcNode = null, proc = null, analyser = null;
  let timerId = null, rafId = null, remaining = CALL_SECONDS, ending = false, muted = false, ready = false;
  let playHead = 0, playing = [];
  let convo = [];   // {role:'user'|'assistant', text}

  const fmt = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");

  function addText(role, text) {
    if (!text) return;
    const last = convo[convo.length - 1];
    if (last && last.role === role) last.text += text;
    else convo.push({ role, text: text.replace(/^\s+/, "") });
    if (role === "assistant") setCaption(convo[convo.length - 1].text);
  }
  function setCaption(text) {
    const c = $("caption");
    c.innerHTML = "<small>AI</small>";
    c.appendChild(document.createTextNode(text));
  }

  function resetUi() {
    convo = []; ending = false; muted = false; ready = false;
    remaining = CALL_SECONDS; playHead = 0; playing = [];
    $("timer").textContent = fmt(CALL_SECONDS);
    $("timer").classList.remove("low");
    $("bar").style.transform = "scaleX(1)";
    $("caption").innerHTML = "<small>AI</small>&nbsp;";
    $("btn-mute").classList.remove("on");
    $("mute-label").textContent = "음소거";
    $("orb-wrap").classList.remove("speaking");
  }

  function failHome(msg) {
    cleanup();
    show("home");
    $("home-error").textContent = msg;
    $("btn-start").disabled = false;
    $("btn-start").textContent = "통화 시작";
  }

  async function startCall() {
    const key = store.get(LS.key);
    if (!key) { openSettings(startCall); return; }
    $("home-error").textContent = "";
    $("btn-start").disabled = true;
    $("btn-start").textContent = "연결 중…";

    // 아이폰/아이패드: 클릭 직후에 오디오를 열어야 소리가 나요
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume();
    } catch { failHome("이 브라우저에서는 오디오를 쓸 수 없어요."); return; }

    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch {
      failHome("마이크를 사용할 수 있게 허용해 주세요.");
      return;
    }

    let models;
    try { models = await findModels(key); }
    catch (e) { failHome(e instanceof ApiError ? friendlyError(e.status, e.message) : "인터넷 연결을 확인해 주세요."); return; }

    resetUi();
    show("call");
    $("status").textContent = "연결 중…";
    connect(key, models.live, 0);
  }

  function connect(key, list, idx, lastReason = "") {
    if (idx >= list.length) {
      failHome(lastReason ? friendlyError(/quota|exhaust/i.test(lastReason) ? 429 : 0, lastReason) : "지금 쓸 수 있는 음성 모델을 찾지 못했어요.");
      return;
    }
    const model = list[idx];
    let gotSetup = false;
    ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(key)}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: "models/" + model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: store.get(LS.voice, "Aoede") } } },
          },
          systemInstruction: { parts: [{ text: instructions(store.get(LS.level, "intermediate")) }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      }));
    };

    ws.onmessage = async (e) => {
      let data;
      try { data = JSON.parse(typeof e.data === "string" ? e.data : await e.data.text()); } catch { return; }
      if (data.setupComplete) {
        gotSetup = true;
        onReady();
        return;
      }
      handleServer(data);
    };

    ws.onclose = (e) => {
      if (ending) return;
      const reason = e.reason || "";
      if (!gotSetup) {
        // 키 문제가 아니면 다음 모델 후보로
        if (/API key|API_KEY/i.test(reason)) { failHome(friendlyError(400, reason)); return; }
        connect(key, list, idx + 1, reason || lastReason);
        return;
      }
      endCall(/quota|exhaust/i.test(reason) ? friendlyError(429, reason) : "연결이 끊어졌어요.");
    };
  }

  function onReady() {
    ready = true;
    $("status").textContent = "통화 중";
    $("btn-start").disabled = false;
    $("btn-start").textContent = "통화 시작";
    startMic();
    // AI가 먼저 인사
    sendText("(The call just connected. Greet me briefly and ask one easy question about my day.)");
    timerId = setInterval(tick, 1000);
  }

  function sendText(text) {
    if (ws?.readyState !== 1) return;
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }));
  }

  function startMic() {
    srcNode = ctx.createMediaStreamSource(mic);
    proc = ctx.createScriptProcessor(4096, 1, 1);
    const silent = ctx.createGain(); silent.gain.value = 0;
    proc.onaudioprocess = (ev) => {
      if (!ready || muted || ws?.readyState !== 1) return;
      const pcm = downsampleTo16k(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: toBase64(new Uint8Array(pcm.buffer)), mimeType: "audio/pcm;rate=16000" } } }));
    };
    srcNode.connect(proc); proc.connect(silent); silent.connect(ctx.destination);

    // AI 목소리 크기로 원 움직이기
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.connect(ctx.destination);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const orb = $("orb"), wrap = $("orb-wrap");
    const loop = () => {
      analyser.getByteFrequencyData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
      const lvl = sum / buf.length / 255;
      orb.style.transform = `scale(${1 + Math.min(lvl * 1.6, 0.35)})`;
      wrap.classList.toggle("speaking", lvl > 0.03);
      rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  function playPcm(b64) {
    const bytes = fromBase64(b64);
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    const audio = ctx.createBuffer(1, pcm.length, 24000);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(analyser);
    playHead = Math.max(playHead, ctx.currentTime + 0.05);
    src.start(playHead);
    playHead += audio.duration;
    playing.push(src);
    src.onended = () => { playing = playing.filter((s) => s !== src); };
  }

  function stopPlayback() {
    playing.forEach((s) => { try { s.stop(); } catch {} });
    playing = []; playHead = 0;
  }

  function handleServer(d) {
    const sc = d.serverContent;
    if (sc) {
      if (sc.interrupted) stopPlayback();
      for (const p of sc.modelTurn?.parts || []) {
        if (p.inlineData?.data && /audio/.test(p.inlineData.mimeType || "audio")) playPcm(p.inlineData.data);
      }
      if (sc.inputTranscription?.text) { addText("user", sc.inputTranscription.text); $("status").textContent = "듣고 있어요…"; }
      if (sc.outputTranscription?.text) { addText("assistant", sc.outputTranscription.text); $("status").textContent = "통화 중"; }
      if (sc.turnComplete) $("status").textContent = "통화 중";
    }
    if (d.goAway && !ending) { /* 서버가 곧 끊는다고 알림 */ }
  }

  function tick() {
    remaining--;
    $("timer").textContent = fmt(Math.max(remaining, 0));
    $("bar").style.transform = `scaleX(${Math.max(remaining, 0) / CALL_SECONDS})`;
    if (remaining <= 20) $("timer").classList.add("low");
    if (remaining === 12) sendText("(Our time is up now. Say a short, warm goodbye in one sentence.)");
    if (remaining <= 0) endCall();
  }

  $("btn-mute").onclick = () => {
    muted = !muted;
    $("btn-mute").classList.toggle("on", muted);
    $("mute-label").textContent = muted ? "음소거 해제" : "음소거";
  };
  $("btn-end").onclick = () => endCall();

  function cleanup() {
    ready = false;
    clearInterval(timerId); timerId = null;
    cancelAnimationFrame(rafId); rafId = null;
    try { ws?.close(); } catch {}
    try { proc?.disconnect(); srcNode?.disconnect(); } catch {}
    mic?.getTracks().forEach((t) => t.stop());
    stopPlayback();
    try { ctx?.close(); } catch {}
    ws = ctx = mic = srcNode = proc = analyser = null;
  }

  function endCall(errorMsg) {
    if (ending) return;
    ending = true;
    cleanup();
    $("btn-start").disabled = false;
    $("btn-start").textContent = "통화 시작";
    const lines = convo.filter((m) => m.text.trim());
    if (errorMsg && !lines.some((m) => m.role === "user")) {
      show("home");
      $("home-error").textContent = errorMsg;
      return;
    }
    showResult(lines);
  }

  // ───────── 결과 ─────────
  const HANGUL = /[ㄱ-ㆎ가-힣]/;

  function renderLog(lines) {
    const log = $("log"); log.innerHTML = "";
    lines.forEach((m) => {
      const d = document.createElement("div");
      d.className = "msg " + (m.role === "user" ? "user" : "ai");
      d.innerHTML = `<small>${m.role === "user" ? "나" : "AI"}</small>`;
      d.appendChild(document.createTextNode(m.text.trim()));
      log.appendChild(d);
    });
    $("log-wrap").classList.toggle("hidden", lines.length === 0);
  }

  function speak(text) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US"; u.rate = 0.9;
      speechSynthesis.speak(u);
    } catch {}
  }

  function renderWords(list) {
    const ul = $("words"); ul.innerHTML = "";
    list.forEach((w) => {
      const li = document.createElement("li");
      const pair = document.createElement("div"); pair.className = "pair";
      const ko = document.createElement("span"); ko.className = "ko"; ko.textContent = w.korean;
      const ar = document.createElement("span"); ar.className = "arrow"; ar.textContent = "→";
      const en = document.createElement("span"); en.className = "en"; en.textContent = w.english;
      const btn = document.createElement("button"); btn.className = "say"; btn.setAttribute("aria-label", "발음 듣기");
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
      btn.onclick = () => speak(w.english);
      pair.append(ko, ar, en, btn);
      li.appendChild(pair);
      if (w.original || w.corrected) {
        const ex = document.createElement("div"); ex.className = "ex";
        if (w.original) ex.append("내가 한 말: " + w.original);
        if (w.corrected) {
          if (w.original) ex.appendChild(document.createElement("br"));
          const b = document.createElement("b"); b.textContent = w.corrected;
          ex.append("영어로: ", b);
        }
        li.appendChild(ex);
      }
      ul.appendChild(li);
    });
  }

  async function showResult(lines) {
    show("result");
    renderLog(lines);
    $("words").innerHTML = "";
    $("no-words").classList.add("hidden");
    $("result-loading").classList.remove("hidden");
    $("result-sub").textContent = "내가 한국어로 말한 부분을 영어로 정리했어요.";

    const userLines = lines.filter((m) => m.role === "user").map((m) => m.text.trim());
    const finish = (words, msg) => {
      $("result-loading").classList.add("hidden");
      if (words.length) renderWords(words);
      else { $("no-words").textContent = msg; $("no-words").classList.remove("hidden"); }
    };
    if (!userLines.length) return finish([], "이번 통화에서는 내가 한 말이 기록되지 않았어요.\n다음엔 조금 더 길게 이야기해 봐요!");
    if (!userLines.some((l) => HANGUL.test(l))) {
      $("result-sub").textContent = "대단해요!";
      return finish([], "이번 통화에서는 한국어를 하나도 쓰지 않았어요 👏\n아래에서 대화 전체를 다시 볼 수 있어요.");
    }

    try {
      const key = store.get(LS.key);
      const model = (modelCache?.key === key && modelCache.text) || TEXT_FALLBACK;
      const prompt =
        "A Korean learner of English had a short English phone call. When they didn't know an English word, they said it in Korean.\n" +
        "Here is everything the learner said (from speech recognition), one line per turn:\n" +
        userLines.map((l, i) => `${i + 1}. ${l}`).join("\n") + "\n\n" +
        "Find every Korean word or phrase they used (ignore filler sounds like 음, 어, 그). For each, give the most natural English expression for that context.\n" +
        'Return JSON: {"items":[{"korean":"<Korean as said>","english":"<natural English word or phrase>","original":"<the learner\'s full sentence as said>","corrected":"<that sentence rewritten fully in natural English>"}]}. No duplicates.';
      const res = await fetch(`${API}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, body?.error?.message || "");
      const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      const parsed = JSON.parse(text.replace(/^```(json)?|```$/g, "").trim() || "{}");
      const words = (parsed.items || []).filter((w) => w && w.korean && w.english);
      finish(words, "한국어로 말한 단어를 찾지 못했어요.\n아래에서 대화 전체를 볼 수 있어요.");
    } catch (e) {
      console.error(e);
      $("result-sub").textContent = e instanceof ApiError ? friendlyError(e.status, e.message) : "정리하지 못했어요.";
      finish([], "한국어가 들어간 문장:\n" + userLines.filter((l) => HANGUL.test(l)).join("\n"));
    }
  }

  $("btn-start").onclick = startCall;
  $("btn-again").onclick = startCall;
  $("btn-home").onclick = () => show("home");
  window.addEventListener("beforeunload", cleanup);
})();
