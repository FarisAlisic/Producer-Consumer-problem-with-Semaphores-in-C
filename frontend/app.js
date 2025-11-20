let ws = null;

// UI refs
const simulateBtn = document.getElementById("simulate");
const logEl = document.getElementById("log");
const hlogEl = document.getElementById("hlog");
const storeEl = document.getElementById("store");

// State
let itemsOrder = [];
const semCounts = {};
const mutexActive = {};
const slots = {};

const MIN_MUTEX_GLOW_MS = 300;
const mutexOffTimers = {};
const mutexUntil = {};

const lanesState = {};
function laneState(item){
  return (lanesState[item] ??= { prod: [], cons: [] });
}
function makeActorSVG(kind, color){
  const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("viewBox", kind==="truck" ? "0 0 40 26" : "0 0 16 32");
  svg.classList.add("actor", kind==="truck" ? "truck" : "person", "wait");
  svg.style.color = color;
  const use = document.createElementNS("http://www.w3.org/2000/svg","use");
  use.setAttributeNS("http://www.w3.org/1999/xlink","href", kind==="truck" ? "#truck" : "#person");
  svg.appendChild(use);
  return svg;
}

function enqueueProducer(item){
  ensureItemUI(item);
  const lane = document.getElementById(`lane-prod-${item}`);
  const actor = makeActorSVG("truck", colorFor(item));
  actor.classList.add("drive-in");
  lane.appendChild(actor);
  laneState(item).prod.push(actor);
}

function enqueueConsumer(item){
  ensureItemUI(item);
  const lane = document.getElementById(`lane-cons-${item}`);
  const actor = makeActorSVG("person", colorFor(item));
  actor.classList.add("walk-in");
  actor.style.transform = "scaleX(-1)";
  lane.appendChild(actor);
  laneState(item).cons.push(actor);
}

function serveProducer(item, holdMs=300){
  const st = laneState(item);
  const actor = st.prod.shift();
  if(!actor){
    // transient: spawn quick truck if no queue existed
    enqueueProducer(item);
    return setTimeout(()=>serveProducer(item, holdMs), 60);
  }
  // move to shelf (left→center)
  actor.classList.remove("wait"); actor.classList.add("to-shelf");
  setTimeout(()=>{
    // hold while in CS; keep yellow glow logic you added
    setTimeout(()=>{
      actor.classList.remove("to-shelf"); actor.classList.add("from-shelf");
      setTimeout(()=> actor.remove(), 380);
    }, holdMs);
  }, 450);
}

function serveConsumer(item, holdMs=300){
  const st = laneState(item);
  const actor = st.cons.shift();
  if(!actor){
    enqueueConsumer(item);
    return setTimeout(()=>serveConsumer(item, holdMs), 60);
  }
  // right lane: move to shelf (right→center)
  actor.classList.remove("wait");
  actor.style.transform = "scaleX(-1) translateX(-52px)";
  actor.classList.add("to-shelf");
  // tweak keyframes for right side travel:
  actor.style.animation = "toShelf .45s ease-in-out forwards";
  setTimeout(()=>{
    setTimeout(()=>{
      // leave rightwards
      actor.style.animation = "fromShelf .35s ease-in-out forwards";
      actor.style.transform = "scaleX(-1) translateX(-82px)";
      setTimeout(()=> actor.remove(), 380);
    }, holdMs);
  }, 450);
}

// Palette (neon accents cycle)
const palette = ["#22d3ee","#f472b6","#a78bfa","#6366f1","#06b6d4","#f59e0b","#f43f5e","#84cc16"];
const itemColor = {};
function colorFor(item){
  if(!itemColor[item]){
    itemColor[item]=palette[(itemsOrder.indexOf(item))%palette.length];
  }
  return itemColor[item];
}

function resetUI(){
  logEl.textContent=""; hlogEl.textContent=""; storeEl.innerHTML=""; itemsOrder=[];
  for(const k in semCounts) delete semCounts[k];
  for(const k in slots) delete slots[k];
  for(const k in mutexActive) delete mutexActive[k];
}

function logJSON(ev){ logEl.textContent += JSON.stringify(ev)+"\n"; logEl.scrollTop = logEl.scrollHeight; }
function hlog(s){ hlogEl.textContent += s + "\n"; hlogEl.scrollTop = hlogEl.scrollHeight; }

function mkTrafficLight(idBase,label){
  const wrap=document.createElement("div");
  wrap.className="flex flex-col items-center gap-2";
  wrap.innerHTML = `
    <div class="tl">
      <div id="${idBase}-red" class="bulb red"></div>
      <div id="${idBase}-yellow" class="bulb yellow"></div>
      <div id="${idBase}-green" class="bulb green"></div>
    </div>
    <div class="text-[11px] text-indigo-200/80">${label}</div>
  `;
  return wrap;
}

function ensureItemUI(item){
  if(itemsOrder.includes(item)) return;
  itemsOrder.push(item);
  semCounts[item] = { empty:"?", full:"?", mutex:"?" };
  mutexActive[item] = false;
  slots[item] = new Array(20).fill(false);

  const card = document.createElement("div");
  card.id = `card-${item}`;
  card.className = "rounded-2xl border border-indigo-700/40 bg-indigo-950/30 backdrop-blur px-4 py-4";

  const head = document.createElement("div");
  head.className = "flex items-center justify-between mb-3";
  head.innerHTML = `
    <div class="flex items-center gap-2">
      <div class="w-2.5 h-2.5 rounded-full" style="background:${colorFor(item)}"></div>
      <h3 class="font-semibold text-indigo-100">${item[0].toUpperCase()+item.slice(1)} shelf</h3>
    </div>
  `;

  const row = document.createElement("div");
  row.className = "flex justify-center items-start gap-4";

  const lanes = document.createElement("div");
  lanes.className = "relative w-full flex items-start justify-center gap-6";

  const laneProd = document.createElement("div");
  laneProd.id = `lane-prod-${item}`;
  laneProd.className = "lane h-36 w-20 flex flex-col-reverse items-center gap-2";

  const laneCons = document.createElement("div");
  laneCons.id = `lane-cons-${item}`;
  laneCons.className = "lane h-36 w-20 flex flex-col-reverse items-center gap-2";

  // Left: Stock TL
  const tlStock = mkTrafficLight(`tl-cons-${item}`,'Stock');

  // Middle: 4×5 shelf
  const strip = document.createElement("div");
  strip.id = `strip-${item}`;
  strip.className = "grid grid-cols-5 gap-2";
  for(let i=0;i<20;i++){
    const d=document.createElement("div");
    d.id=`slot-${item}-${i}`;
    d.className="w-8 h-8 rounded-md border flex items-center justify-center text-[11px] select-none";
    d.style.borderColor = "rgba(99,102,241,.35)"; // indigo-500 faint
    d.style.background = "transparent";
    d.style.color = "transparent";
    strip.appendChild(d);
  }

  // Right: Space TL
  const tlSpace = mkTrafficLight(`tl-prod-${item}`,'Space');

  lanes.appendChild(laneProd);
  lanes.appendChild(tlSpace);
  lanes.appendChild(strip);
  lanes.appendChild(tlStock);
  lanes.appendChild(laneCons);
  row.appendChild(lanes);

  card.appendChild(head);
  card.appendChild(row);
  storeEl.appendChild(card);

  renderSemaphores(item);
  renderShelf(item);
}

function renderShelf(item){
  const badge=(item[0]||"?").toUpperCase();
  const col=colorFor(item);
  for(let i=0;i<20;i++){
    const el=document.getElementById(`slot-${item}-${i}`); if(!el) continue;
    const filled=!!slots[item][i];
    el.textContent = filled ? badge : "";
    el.style.borderColor = filled ? col : "rgba(99,102,241,.35)";
    el.style.color = filled ? "#e2e8f0" : "transparent";
    el.style.background = filled ? "rgba(2,6,23,.25)" : "transparent";
    el.style.boxShadow = filled ? `0 0 10px ${col}40` : "none";
  }
}
function setSlot(item, idx, fill, anim=false){
  slots[item][idx] = !!fill;
  const el=document.getElementById(`slot-${item}-${idx}`); if(!el) return;
  const col=colorFor(item);
  el.textContent = fill ? (item[0]||"?").toUpperCase() : "";
  el.style.borderColor = fill ? col : "rgba(99,102,241,.35)";
  el.style.color = fill ? "#e2e8f0" : "transparent";
  el.style.background = fill ? "rgba(2,6,23,.25)" : "transparent";
  el.style.boxShadow = fill ? `0 0 10px ${col}40` : "none";
  if(anim){ el.classList.remove("slot-pulse"); void el.offsetWidth; el.classList.add("slot-pulse"); }
}
function setSlotsBatch(item, indices, fill){ if(!Array.isArray(indices)) return; for(const i of indices) setSlot(item,i,fill,true); }

function bulb(id, on){
  const el=document.getElementById(id); if(!el) return;
  el.style.color = getComputedStyle(el).backgroundColor;
  if(on){ el.classList.add("on"); } else { el.classList.remove("on"); }
}

function renderSemaphores(item){
  const counts=semCounts[item]||{};
  const full = Number(counts.full);
  const empty = Number(counts.empty);

  // Consumer: stock TL
  bulb(`tl-cons-${item}-red`,   !(isFinite(full) && full>0));
  bulb(`tl-cons-${item}-green`,  (isFinite(full) && full>0));
  bulb(`tl-cons-${item}-yellow`, !!mutexActive[item]);

  // Producer: space TL
  bulb(`tl-prod-${item}-red`,   !(isFinite(empty) && empty>0));
  bulb(`tl-prod-${item}-green`,  (isFinite(empty) && empty>0));
  bulb(`tl-prod-${item}-yellow`, !!mutexActive[item]);
}

function fmtMs(ms){ if(ms==null) return ""; const n=+ms; if(!isFinite(n))return""; return n<1000?`${n} ms`:`${(n/1000).toFixed(2)} s`; }

function connectWS(){
  if(ws) try{ ws.close(); }catch{}
  ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = (m)=>{
    const ev = JSON.parse(m.data);
    logJSON(ev);

    if(ev.t==="INIT"){
      ensureItemUI(ev.item);
      semCounts[ev.item][ev.sem]=ev.count;
      renderSemaphores(ev.item);
      return;
    }

    if (ev.t === "CS_ENTER") {
      ensureItemUI(ev.item);
      mutexActive[ev.item] = true;
      mutexUntil[ev.item] = performance.now() + MIN_MUTEX_GLOW_MS;
      if (mutexOffTimers[ev.item]) { clearTimeout(mutexOffTimers[ev.item]); }
      renderSemaphores(ev.item);
      return;
    }

    if (ev.t === "CS_EXIT") {
      ensureItemUI(ev.item);
      const now = performance.now();
      const due = Math.max(0, (mutexUntil[ev.item] || 0) - now);
      if (due <= 0) {
        mutexActive[ev.item] = false;
        renderSemaphores(ev.item);
      } else {
        if (mutexOffTimers[ev.item]) clearTimeout(mutexOffTimers[ev.item]);
        mutexOffTimers[ev.item] = setTimeout(() => {
          mutexActive[ev.item] = false;
          renderSemaphores(ev.item);
          mutexOffTimers[ev.item] = null;
        }, due);
      }
      return;
    }

    if((ev.t==="WAIT_ACQUIRE"||ev.t==="SIGNAL") && ev.sem && ev.item){
      ensureItemUI(ev.item);
      if(ev.count!==undefined){ semCounts[ev.item][ev.sem]=ev.count; renderSemaphores(ev.item); }
      return;
    }

    if(ev.t==="SHIPMENT_WAIT"){ ensureItemUI(ev.item); enqueueProducer(ev.item);
      hlog(`🚚 Shipment paused: ${ev.item} waiting for ${ev.want_qty??1}`); return; }

    if(ev.t==="PURCHASE_WAIT"){ ensureItemUI(ev.item); enqueueConsumer(ev.item);
      hlog(`🧍 Customer waiting: ${ev.item} ×${ev.want_qty??1}`); return; }

    if(ev.t==="SHIPMENT"){
      ensureItemUI(ev.item);
      setSlotsBatch(ev.item, ev.slots||[], true);
      serveProducer(ev.item, 280);
      hlog(`✅ Shipment: +${ev.qty??1} ${ev.item} ${ev.wait_ms!=null?`after ${fmtMs(ev.wait_ms)}`:""}`);
      return;
    }

    if(ev.t==="PURCHASE_OK"){
      ensureItemUI(ev.item);
      setSlotsBatch(ev.item, ev.slots||[], false);
      serveConsumer(ev.item, 280);
      hlog(`🛒 Purchase: ${ev.qty??1} ${ev.item} ${ev.wait_ms!=null?`after ${fmtMs(ev.wait_ms)}`:""}`);
      return;
    }
    if(ev.t==="PURCHASE_FAIL"){ ensureItemUI(ev.item); hlog(`⚠️ Purchase failed: ${ev.item} (${ev.reason||"unknown"})`); return; }
  };
}

simulateBtn.onclick = async () => {
  resetUI();

  // Parse items from the text field
  const itemsStr = document.getElementById("items").value;
  const items = itemsStr.split(",").map(s => s.trim()).filter(Boolean);

  // Pre-create shelves so the UI updates immediately
  items.forEach(it => ensureItemUI(it));

  // Send config to backend (so it actually simulates those items)
  const body = {
    producers: Number(document.getElementById("prod").value),
    consumers: Number(document.getElementById("cons").value),
    runSec:    Number(document.getElementById("run").value),
    seed:      42,
    itemTypes: items.join(","),
    speedMs:   Number(document.getElementById("speed").value)
  };

  await fetch("/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  // Connect to stream events (INIT/WAIT/… will fill the shelves)
  connectWS();
};