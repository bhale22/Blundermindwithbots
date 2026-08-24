function botSetTab(tab) {
  botTab = tab;
  // The quick-start block names the bot it will start; a tab change renames it.
  setTimeout(function(){ if (typeof quickBotSync === 'function') quickBotSync(); }, 0);
  ['sf','maia3','maia','lcsf','hybrid'].forEach(t => {
    var btn   = document.getElementById('btab-'+t);
    var panel = document.getElementById('bpanel-'+t);
    if (btn)   btn.classList.toggle('active', t === tab);
    if (panel) panel.style.display = t === tab ? '' : 'none';
  });
  // Auto-init Maia worker when any Maia tab is shown
  if ((tab === 'maia' || tab === 'maia3') && !_maiaWorker) {
    maiaInit();
    _maiaLoadMappings();
  }
}

// ── Phase 5: Opening behavior UI controllers ──────────────────────────────────

function botSetOpeningMode(mode) {
  botOpeningMode = mode;
  ['none','mainline','preferred'].forEach(m => {
    var btn = document.getElementById('obm-' + m);
    if (btn) btn.classList.toggle('active', m === mode);
    var panel = document.getElementById('ob-' + m);
    if (panel) panel.style.display = (m === mode && m !== 'none') ? '' : 'none';
  });
  if (mode === 'preferred') {
    obPrefRenderSlots('white');
    obPrefRenderSlots('black');
    obBuildCuratedPickers();
    // Auto-open search for the active color if no slots set yet
    var activeColor = _obPrefColor || 'white';
    var slots = (botOpeningConfig[activeColor] || []).filter(s => s.name);
    if (!slots.length) {
      setTimeout(() => obPrefOpenSearch(activeColor), 50);
    }
  }
}

function botSetOpeningSrc(src) { botOpeningConfig.source = src; _openingCache.clear(); }

function botSetDeviationResponse(resp) {
  botOpeningConfig.deviationResponse = resp;
  ['engine','mainline'].forEach(r => {
    var b = document.getElementById('obdev-' + r);
    if (b) b.classList.toggle('tc-active', r === resp);
  });
}

// ── Color tabs ────────────────────────────────────────────────────────────────
let _obPrefColor = 'white';

function obPrefSetColor(color) {
  _obPrefColor = color;
  ['white','black'].forEach(c => {
    var btn = document.getElementById('obpref-' + c);
    if (btn) btn.classList.toggle('tc-active', c === color);
    var panel = document.getElementById('obPref' + (c === 'white' ? 'White' : 'Black'));
    if (panel) panel.style.display = c === color ? '' : 'none';
  });
  // Auto-open search if the newly selected color has no slots yet
  var slots = (botOpeningConfig[color] || []).filter(s => s.name);
  if (!slots.length) {
    setTimeout(() => obPrefOpenSearch(color), 30);
  }
}

// ── ECO data loading ──────────────────────────────────────────────────────────
// Loaded once from /data/eco.tsv; used for full-text search.
let _ecoData = null; // [{eco, name, familyPrefix, exactEco}]
// In-flight/settled load promise. Without this, concurrent callers (startup
// kickoff + a bot move + a panel search) each race past the _ecoData guard
// while the first fetch is still pending, so the parse and the log run N times.
// Caching the promise makes the fetch+parse+log happen exactly once.
let _ecoLoadPromise = null;

// Parse a PGN move sequence string into a plain SAN array.
// "1. e4 c5 2. Nf3" → ["e4", "c5", "Nf3"]
function parsePgnMoves(pgn) {
  return pgn
    .replace(/\d+\./g, '')      // strip move numbers
    .trim().split(/\s+/)
    .filter(s => s && !/^\d/.test(s));
}

// ── ECO prefix index ──────────────────────────────────────────────────────────
// Built once after _ecoData loads. Maps first SAN move → entries that start with it,
// so obPreferredNextMoves scans ~50-100 entries instead of all 3,704.
// Key: first move SAN string (e.g. "e4"). Value: array of _ecoData entries.
let _ecoIndex = null; // Map<string, entry[]>

function _buildEcoIndex(data) {
  const idx = new Map();
  for (const entry of data) {
    if (!entry.sanMoves.length) continue;
    const key = entry.sanMoves[0];
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(entry);
  }
  return idx;
}

async function obLoadEcoData() {
  if (_ecoData && _ecoData.length) return _ecoData; // already loaded
  if (_ecoLoadPromise) return _ecoLoadPromise;       // load in flight — share it
  _ecoLoadPromise = _obLoadEcoDataOnce().finally(() => {
    // Keep the resolved promise cached on success (the _ecoData guard covers
    // future calls anyway); only clear it if we ended up with nothing usable,
    // so a later call can retry a genuinely failed load.
    if (!_ecoData || !_ecoData.length) _ecoLoadPromise = null;
  });
  return _ecoLoadPromise;
}

async function _obLoadEcoDataOnce() {
  try {
    const resp = await fetch('/data/eco.tsv');
    if (!resp.ok) throw new Error('eco.tsv ' + resp.status);
    const text = await resp.text();
    const lines = text.trim().split('\n').slice(1); // skip header
    _ecoData = lines.map(line => {
      const parts = line.split('\t');
      const eco = parts[0], name = parts[1], pgn = parts[2];
      if (!eco || !name) return null;
      const familyPrefix = eco.length >= 2 ? eco.slice(0, 2) : eco;
      return {
        eco,
        name: name.trim(),
        exactEco: eco,
        familyPrefix,
        sanMoves: pgn ? parsePgnMoves(pgn) : []  // ← pre-parsed SAN array
      };
    }).filter(Boolean);
    _ecoIndex = _buildEcoIndex(_ecoData);
    console.log('ECO data loaded:', _ecoData.length, 'openings');
    return _ecoData;
  } catch(e) {
    console.warn('Failed to load eco.tsv, falling back to curated index:', e);
    _ecoData = [];
    Object.values(ECO_LIBRARY).forEach(family => {
      Object.values(family).forEach(variations => {
        Object.entries(variations).forEach(([name, data]) => {
          _ecoData.push({
            eco: data.eco, name,
            exactEco: data.eco,
            familyPrefix: data.eco.length >= 2 ? data.eco.slice(0,2) : data.eco,
            sanMoves: []
          });
        });
      });
    });
    _ecoIndex = _buildEcoIndex(_ecoData);
    return _ecoData;
  }
}

// Given the current board state and the played move history (SAN list so far),
// find which candidate UCI moves steer toward preferred slots.
// Returns a Set of UCI strings that are "preferred next moves".
// Uses _ecoIndex to avoid scanning all 3,704 entries — only candidates whose
// first move matches the game's first move are checked.
function obPreferredNextMoves(sanHistory, slots, boardState, turnColor, epSq, castling) {
  if (!_ecoData || !slots.length) return new Set();

  const totalPct = slots.reduce((s, sl) => s + (sl.weight || 0), 0) || 1;

  // Narrow the candidate set using the index.
  // If we have a game history, only entries starting with sanHistory[0] are relevant.
  let candidates;
  if (_ecoIndex && sanHistory.length > 0) {
    candidates = _ecoIndex.get(sanHistory[0]) || [];
  } else if (_ecoIndex) {
    candidates = _ecoData;
  } else {
    candidates = _ecoData;
  }

  // ── "Inside preferred line" detection ────────────────────────────────────────
  // Openings like the Sicilian span ECO codes B20-B99. After 1.e4 c5 2.Nf3, the
  // continuation lives in B30-B49, not B20. If we only match by familyPrefix='B2'
  // we'd find nothing and permanently deactivate. Instead: check if the game's
  // move history so far is a PREFIX of any preferred ECO entry. If yes, we're
  // already "inside" the preferred opening and should accept any continuation.
  let insidePreferredLine = false;
  if (sanHistory.length > 0) {
    for (const prefEntry of candidates) {
      if (prefEntry.sanMoves.length === 0) continue;
      // Is this entry preferred by any slot?
      let isPreferred = false;
      for (const slot of slots) {
        const exact  = slot.exactEco     || null;
        const family = slot.familyPrefix || (slot.eco ? slot.eco.slice(0, 2) : null);
        if ((exact && prefEntry.eco.startsWith(exact)) ||
            (family && prefEntry.eco.startsWith(family))) { isPreferred = true; break; }
      }
      if (!isPreferred) continue;
      // Does this preferred entry's moves match the FULL game history so far
      // (or at least up to this entry's length)?
      const checkLen = Math.min(prefEntry.sanMoves.length, sanHistory.length);
      let prefMatch = true;
      for (let i = 0; i < checkLen; i++) {
        if (prefEntry.sanMoves[i] !== sanHistory[i]) { prefMatch = false; break; }
      }
      if (prefMatch) { insidePreferredLine = true; break; }
    }
  }

  const EXACT_BONUS = 3.0;
  const moveScores = {}; // sanMove → best score

  for (const entry of candidates) {
    if (entry.sanMoves.length <= sanHistory.length) continue; // too short

    // Check that the played moves so far match the start of this ECO line
    let matches = true;
    for (let i = 0; i < sanHistory.length; i++) {
      if (entry.sanMoves[i] !== sanHistory[i]) { matches = false; break; }
    }
    if (!matches) continue;

    // Does this ECO entry match any preferred slot?
    let bestSlotScore = 0;
    for (const slot of slots) {
      const exact  = slot.exactEco     || null;
      const family = slot.familyPrefix || (slot.eco ? slot.eco.slice(0,2) : null);
      let tier = 0;
      if (exact  && entry.eco.startsWith(exact))  tier = 2;
      else if (family && entry.eco.startsWith(family)) tier = 1;
      if (tier > 0) {
        const normW = (slot.weight || 0) / totalPct;
        const sc = (tier === 2 ? EXACT_BONUS : 1.0) * normW;
        if (sc > bestSlotScore) bestSlotScore = sc;
      }
    }

    // If no direct slot match but we're already inside a preferred line (e.g. B20→B30
    // transposition in the Sicilian), give a weak score so we continue in book.
    if (!bestSlotScore && insidePreferredLine) bestSlotScore = 0.2;

    if (!bestSlotScore) continue;

    // The next SAN move in this line is what we want to play
    const nextSan = entry.sanMoves[sanHistory.length];
    if (!nextSan) continue;
    if (!moveScores[nextSan] || bestSlotScore > moveScores[nextSan]) {
      moveScores[nextSan] = bestSlotScore;
    }
  }

  if (!Object.keys(moveScores).length) return new Set();

  // Convert SAN moves to UCI using the current board state
  const preferredUci = new Set();
  for (const [san, score] of Object.entries(moveScores)) {
    const mv = algebraicToMove(san, boardState, turnColor, epSq, castling);
    if (mv) {
      const uci = sqToUci(mv.from, mv.to, mv.promo ? mv.promo.toLowerCase() : null);
      preferredUci.add(uci);
      preferredUci[uci] = score; // piggyback score on the Set object
    }
  }
  return preferredUci;
}

// Kick off load immediately on script parse so it's ready by the time user opens panel
obLoadEcoData();

// ── Slot rendering ────────────────────────────────────────────────────────────
function obPrefRenderSlots(color) {
  var container = document.getElementById('obPref' + (color === 'white' ? 'White' : 'Black') + 'Slots');
  if (!container) return;
  container.innerHTML = '';
  var slots = (botOpeningConfig[color] || []).filter(s => s.name);
  var totalPct = slots.reduce((s, sl) => s + (sl.weight || 0), 0) || 1;

  slots.forEach(function(slot, i) {
    var pct = Math.round((slot.weight || 0) / totalPct * 100);
    var family = slot.familyPrefix || (slot.eco ? slot.eco.slice(0,2) : '');
    var rangeLabel = family ? (family + '0\u2013' + family + '9') : '';
    var matchLabel = slot.exactEco
      ? 'prefers ' + slot.exactEco + (rangeLabel ? ' \xb7 stays in ' + rangeLabel : '')
      : (rangeLabel ? 'stays in ' + rangeLabel : '');

    var chip = document.createElement('div');
    chip.style.cssText = 'padding:5px 7px;background:var(--bg-panel2);' +
      'border:0.5px solid var(--border);border-radius:4px;margin-bottom:4px;';

    chip.innerHTML =
      '<div style="display:flex;align-items:center;gap:4px;">' +
        '<span style="flex:1;font-size:9px;color:var(--text-primary);">' +
          slot.name + ' <span style="color:var(--text-dim);font-size:8px;">(' + (slot.eco || '') + ')</span>' +
        '</span>' +
        (slots.length > 1
          ? '<input type="number" id="obw-' + color + '-' + i + '" min="1" max="100" value="' + pct + '"' +
            ' style="width:34px;font-size:9px;padding:1px 3px;text-align:right;' +
            'background:var(--bg-panel2);border:0.5px solid var(--border);border-radius:3px;color:var(--text-primary);"' +
            ' oninput="obPrefSetPct(\'' + color + '\',' + i + ',this.value)">' +
            '<span style="font-size:8px;color:var(--text-dim);">%</span>'
          : '<span style="font-size:8px;color:var(--text-dim);">100%</span>') +
        '<button onclick="obPrefRemoveSlot(\'' + color + '\',' + i + ')"' +
          ' style="font-size:9px;padding:1px 5px;background:rgba(200,40,40,0.1);' +
          'border:0.5px solid rgba(200,40,40,0.3);border-radius:3px;color:#c84040;cursor:pointer;">&#215;</button>' +
      '</div>' +
      (matchLabel ? '<div style="font-size:7px;color:var(--text-dim);margin-top:2px;">' + matchLabel + '</div>' : '');

    container.appendChild(chip);
  });

  // Show/hide deviation panel
  var anySlots = (botOpeningConfig.white||[]).filter(s=>s.name).length +
                 (botOpeningConfig.black||[]).filter(s=>s.name).length;
  var devPanel = document.getElementById('obPrefDeviation');
  if (devPanel) devPanel.style.display = anySlots ? '' : 'none';
}

// Percentage edit with proportional redistribution
function obPrefSetPct(color, editIdx, rawVal) {
  var slots = botOpeningConfig[color];
  if (!slots || slots.length < 2) return;
  var newPct = Math.max(1, Math.min(99, parseInt(rawVal) || 1));
  var others = slots.filter((_, i) => i !== editIdx);
  var otherTotal = others.reduce((s, sl) => s + (sl.weight || 0), 0) || 1;
  var remaining = 100 - newPct;

  // Redistribute remaining % proportionally among the other slots
  slots.forEach((sl, i) => {
    if (i === editIdx) {
      sl.weight = newPct;
    } else {
      sl.weight = Math.max(1, Math.round((sl.weight || 0) / otherTotal * remaining));
    }
  });

  // Fix any rounding drift so total stays at 100
  var drift = 100 - slots.reduce((s, sl) => s + sl.weight, 0);
  for (var i = 0; i < slots.length && drift !== 0; i++) {
    if (i !== editIdx) { slots[i].weight += drift; drift = 0; }
  }

  // Update other inputs in-place without full re-render (avoids losing cursor)
  slots.forEach((sl, i) => {
    if (i !== editIdx) {
      var inp = document.getElementById('obw-' + color + '-' + i);
      if (inp) inp.value = sl.weight;
    }
  });

  _openingCache.clear();
}

function obPrefRemoveSlot(color, idx) {
  if (botOpeningConfig[color]) {
    botOpeningConfig[color].splice(idx, 1);
    // Re-equalise weights
    var slots = botOpeningConfig[color];
    if (slots.length) {
      var eq = Math.floor(100 / slots.length);
      slots.forEach((sl, i) => { sl.weight = i === 0 ? 100 - eq*(slots.length-1) : eq; });
    }
  }
  obPrefRenderSlots(color);
  _openingCache.clear();
}

// ── Curated picker (sliding nested, per color) ────────────────────────────────
let _curatedState = { white: { level: 0, family: null }, black: { level: 0, family: null } };

function obBuildCuratedPickers() {
  ['white','black'].forEach(color => {
    var container = document.getElementById('obCurated' + (color==='white'?'White':'Black'));
    if (!container || container.dataset.built) return;
    container.dataset.built = '1';
    obCuratedRenderFamilies(color);
  });
}

function obCuratedRenderFamilies(color) {
  var container = document.getElementById('obCurated' + (color==='white'?'White':'Black'));
  if (!container) return;
  container.innerHTML = '';
  _curatedState[color] = { level: 0, family: null };

  Object.keys(ECO_LIBRARY).forEach(family => {
    var btn = document.createElement('button');
    btn.className = 'ob-pick-btn';
    btn.innerHTML = '<span>' + family + '</span><span class="ob-pick-chevron">\u203a</span>';
    btn.onclick = () => obCuratedRenderVariations(color, family);
    container.appendChild(btn);
  });
}

function obCuratedRenderVariations(color, family) {
  var container = document.getElementById('obCurated' + (color==='white'?'White':'Black'));
  if (!container) return;
  container.innerHTML = '';
  _curatedState[color] = { level: 1, family };

  // Back button
  var back = document.createElement('button');
  back.className = 'ob-pick-btn';
  back.style.color = 'var(--text-dim)';
  back.innerHTML = '\u2039 ' + family;
  back.onclick = () => obCuratedRenderFamilies(color);
  container.appendChild(back);

  var variations = ECO_LIBRARY[family];
  Object.keys(variations).forEach(varName => {
    var entries = variations[varName];
    var entryKeys = Object.keys(entries);
    var btn = document.createElement('button');
    btn.className = 'ob-pick-btn';
    if (entryKeys.length === 1 && entryKeys[0] === varName) {
      // Leaf — select directly
      var d = entries[varName];
      btn.innerHTML = '<span>' + varName + ' <span style="font-size:7px;color:var(--text-dim);">(' + d.eco + ')</span></span>';
      btn.onclick = () => obCuratedSelect(color, varName, d, true);
    } else {
      btn.innerHTML = '<span>' + varName + '</span><span class="ob-pick-chevron">\u203a</span>';
      btn.onclick = () => obCuratedRenderSpecific(color, family, varName, entries);
    }
    container.appendChild(btn);
  });
}

function obCuratedRenderSpecific(color, family, varName, entries) {
  var container = document.getElementById('obCurated' + (color==='white'?'White':'Black'));
  if (!container) return;
  container.innerHTML = '';

  var back = document.createElement('button');
  back.className = 'ob-pick-btn';
  back.style.color = 'var(--text-dim)';
  back.innerHTML = '\u2039 ' + varName;
  back.onclick = () => obCuratedRenderVariations(color, family);
  container.appendChild(back);

  Object.entries(entries).forEach(([name, data]) => {
    var btn = document.createElement('button');
    btn.className = 'ob-pick-btn';
    btn.innerHTML = '<span>' + name + ' <span style="font-size:7px;color:var(--text-dim);">(' + data.eco + ')</span></span>';
    btn.onclick = () => obCuratedSelect(color, name, data, false);
    container.appendChild(btn);
  });
}

// isFamilyPick = true when selected from curated (prefix match); false = variation-level exact
function obCuratedSelect(color, name, data, isFamilyPick) {
  var entry = {
    name,
    eco: data.eco,
    exactEco:     isFamilyPick ? null     : data.eco,
    familyPrefix: isFamilyPick ? data.prefix : (data.eco.length >= 2 ? data.eco.slice(0,2) : data.eco),
    ecoDisplay:   data.eco,
    weight: 0  // will be equalised below
  };
  obPrefAddSlot(color, entry);
  // Return to family list after selection
  obCuratedRenderFamilies(color);
}

// Only close the search/curated panel if focus has moved outside the whole
// preferred-openings panel. This prevents the onblur on the search input from
// killing the curated dropdown when the user clicks a family/variation button.
function obPrefMaybeClose(color) {
  var sfx = color === 'white' ? 'White' : 'Black';
  var panel = document.getElementById('obPref' + sfx);
  if (!panel) { obPrefCloseSearch(color); return; }
  var focused = document.activeElement;
  // If focus is still inside this color's panel, do not close
  if (focused && panel.contains(focused)) return;
  obPrefCloseSearch(color);
}

// ── Search ────────────────────────────────────────────────────────────────────
function obPrefOpenSearch(color) {
  var sfx       = color === 'white' ? 'White' : 'Black';
  var searchBox = document.getElementById('obPrefSearch' + sfx);
  var input     = document.getElementById('obPrefSearchInput' + sfx);
  var addBtn    = document.getElementById('obAddBtn' + sfx);
  var slider    = document.getElementById('obSlider' + sfx);
  if (!searchBox) return;
  searchBox.style.display = '';
  if (slider)  slider.style.display  = '';   // show curated alongside search
  if (addBtn)  addBtn.style.display  = 'none';
  if (input) { input.value = ''; setTimeout(() => input.focus(), 40); }
  var results = document.getElementById('obPrefResults' + sfx);
  if (results) { results.style.display = 'none'; results.innerHTML = ''; }
  // Always reset curated picker to top-level family list when (re-)opening
  obCuratedRenderFamilies(color);
}

function obPrefCloseSearch(color) {
  var sfx       = color === 'white' ? 'White' : 'Black';
  var searchBox = document.getElementById('obPrefSearch' + sfx);
  var addBtn    = document.getElementById('obAddBtn' + sfx);
  var slider    = document.getElementById('obSlider' + sfx);
  if (searchBox) searchBox.style.display = 'none';
  if (slider)   slider.style.display    = 'none'; // hide curated when search closes
  if (addBtn)   addBtn.style.display    = '';
}

async function obPrefFilterSearch(color, query) {
  var results = document.getElementById('obPrefResults' + (color==='white'?'White':'Black'));
  if (!results) return;
  var q = query.trim().toLowerCase();
  if (!q) { results.style.display = 'none'; results.innerHTML = ''; return; }

  // Ensure ECO data is loaded (usually already done at startup)
  var data = await obLoadEcoData();

  var matches = data.filter(e =>
    e.name.toLowerCase().includes(q) ||
    e.eco.toLowerCase().startsWith(q)
  ).slice(0, 15);

  if (!matches.length) {
    results.innerHTML = '<div style="padding:5px 10px;font-size:8px;color:var(--text-dim);">No matches</div>';
    results.style.display = '';
    return;
  }

  results.innerHTML = '';
  matches.forEach(entry => {
    var row = document.createElement('button');
    row.style.cssText = 'display:block;width:100%;text-align:left;padding:5px 10px;' +
      'font-size:9px;background:none;border:none;border-bottom:0.5px solid var(--border);' +
      'color:var(--text-primary);cursor:pointer;line-height:1.4;';
    // Highlight matching substring in name
    var q2 = query.trim();
    var highlighted = entry.name.replace(
      new RegExp('(' + q2.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'gi'),
      '<span style="color:var(--accent);font-weight:600;">$1</span>'
    );
    row.innerHTML = highlighted +
      ' <span style="color:var(--text-dim);font-size:8px;">(' + entry.eco + ')</span>';
    row.onmousedown = (e) => {
      e.preventDefault();
      obPrefAddSlot(color, {
        name: entry.name,
        eco: entry.eco,
        exactEco: entry.eco,
        familyPrefix: entry.familyPrefix,
        ecoDisplay: entry.eco,
        weight: 0
      });
      obPrefCloseSearch(color);
    };
    results.appendChild(row);
  });
  results.style.display = '';
}

function obPrefAddSlot(color, entry) {
  if (!botOpeningConfig[color]) botOpeningConfig[color] = [];
  if (botOpeningConfig[color].length >= 10) return;
  // Prevent duplicate by exact ECO
  if (entry.exactEco && botOpeningConfig[color].some(s => s.exactEco === entry.exactEco)) return;

  botOpeningConfig[color].push(entry);

  // Re-equalise all weights as whole percentages summing to 100
  var slots = botOpeningConfig[color];
  var eq = Math.floor(100 / slots.length);
  var rem = 100 - eq * slots.length;
  slots.forEach((sl, i) => { sl.weight = eq + (i === 0 ? rem : 0); });

  obPrefRenderSlots(color);
  _openingCache.clear();
}

// Restore UI after config load
function obRestorePreferredUI() {
  obPrefRenderSlots('white');
  obPrefRenderSlots('black');
  obBuildCuratedPickers();
  var resp = botOpeningConfig.deviationResponse || 'engine';
  botSetDeviationResponse(resp);
}

// ── End phase 5 UI controllers ──────────────────────────────────────────────────────

function botSetTpBtn(val) {
  botTimePressure = val;
  const descs = {
    steady: 'Stays near top move even when flagging',
    normal: 'Gradually widens move choice as clock drops',
    panicky: 'Picks among top 10 moves randomly under pressure'
  };
  ['steady','normal','panicky'].forEach(v => {
    document.getElementById('tp-'+v).classList.toggle('active', v === val);
  });
  document.getElementById('tpDesc').textContent = descs[val] || '';
}

// ── Think Time Mode selector ─────────────────────────────────────────────────
// botTimeBehavior: 'pace' | 'instant' | 'mirror'
// 'pace'    — entropy-based delay from botPace slider (default)
// 'instant' — zero artificial delay; engine result plays as soon as ready
// 'mirror'  — bot averages human's recent move times (rolling window, ±20% jitter)
function botSetTimeBehavior(val) {
  botTimeBehavior = val;
  const descs = {
    pace:    'Entropy-based delay from pace slider',
    instant: 'No delay — bot plays as soon as engine responds',
    mirror:  'Bot averages your recent move times (±20% jitter)'
  };
  ['pace','instant','mirror'].forEach(v => {
    document.getElementById('tb-'+v).classList.toggle('active', v === val);
  });
  const descEl = document.getElementById('tbDesc');
  if (descEl) descEl.textContent = descs[val] || '';
  // Grey out pace slider when it has no effect
  const paceRow = document.getElementById('botPaceRow');
  if (paceRow) paceRow.style.opacity = (val === 'pace') ? '1' : '0.4';
}

function botSetPlayerColor(col) {
  botPlayerColor = col === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : col;
  ['white','black','random'].forEach(v => {
    document.getElementById('pcolor-'+v).classList.toggle('active', v === col);
  });
}

// Hybrid slot management
function botAddHybridSlot() {
  const slot = { type: 'sf', level: 8, weight: 33 };
  botHybridSlots.push(slot);
  botRenderHybridSlots();
}

function botRenderHybridSlots() {
  const container = document.getElementById('hybridSlots');
  if (!container) return;
  container.innerHTML = '';
  botHybridSlots.forEach(function(slot, i) {
    const div = document.createElement('div');
    div.className = 'hybrid-slot';

    // Type selector
    const sel = document.createElement('select');
    sel.onchange = function() { botHybridSlots[i].type = this.value; botRenderHybridSlots(); };
    ['sf','maia'].forEach(function(v) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v === 'sf' ? 'Stockfish' : 'Lichess Explorer';
      if (slot.type === v) opt.selected = true;
      sel.appendChild(opt);
    });
    div.appendChild(sel);

    // Level input (Stockfish only)
    if (slot.type === 'sf') {
      const lbl = document.createElement('label');
      lbl.style.cssText = 'font-size:8px;color:var(--text-dim);';
      lbl.textContent = 'Lvl ';
      const lvlIn = document.createElement('input');
      lvlIn.type = 'number'; lvlIn.min = '1'; lvlIn.max = '20';
      lvlIn.value = String(slot.level || 8);
      lvlIn.style.cssText = 'width:38px;';
      lvlIn.onchange = function() { botHybridSlots[i].level = parseInt(this.value) || 8; };
      lbl.appendChild(lvlIn);
      div.appendChild(lbl);
    }

    // Weight input
    const wlbl = document.createElement('label');
    wlbl.style.cssText = 'font-size:8px;color:var(--text-dim);margin-left:auto;';
    wlbl.textContent = '% ';
    const wIn = document.createElement('input');
    wIn.type = 'number'; wIn.min = '1'; wIn.max = '100';
    wIn.value = String(slot.weight || 0);
    wIn.style.cssText = 'width:38px;';
    wIn.onchange = function() { botHybridSlots[i].weight = parseInt(this.value) || 0; botUpdateHybridTotal(); };
    wlbl.appendChild(wIn);
    div.appendChild(wlbl);

    // Remove button
    const rm = document.createElement('button');
    rm.className = 'rm-btn'; rm.textContent = '✕';
    rm.onclick = function() { botHybridSlots.splice(i, 1); botRenderHybridSlots(); };
    div.appendChild(rm);

    container.appendChild(div);
  });
  botUpdateHybridTotal();
}

function botUpdateHybridTotal() {
  const total = botHybridSlots.reduce((s, sl) => s + (sl.weight || 0), 0);
  const el = document.getElementById('hybridTotalVal');
  if (el) { el.textContent = total; el.style.color = Math.abs(total - 100) < 2 ? '#5ad490' : '#c84040'; }
}

// ── Start / Stop bot ─────────────────────────────────────────────────────────
// ── Bot time control selector (new two-row UI) ───────────────────────────────
let _botBaseMin = 0;  // 0 = untimed
let _botIncSec  = 0;

function botSetBaseMin(min) {
  _botBaseMin = min;
  document.querySelectorAll('[id^="tcm-"]').forEach(function(b) {
    b.classList.toggle('tc-active', b.id === 'tcm-' + min);
  });
  _botUpdateTCDisplay();
}

function botSetIncSec(sec) {
  _botIncSec = sec;
  document.querySelectorAll('[id^="tci-"]').forEach(function(b) {
    b.classList.toggle('tc-active', b.id === 'tci-' + sec);
  });
  _botUpdateTCDisplay();
}

function _botUpdateTCDisplay() {
  var el = document.getElementById('tcDisplay');
  if (!el) return;
  if (_botBaseMin === 0) {
    el.textContent = 'Untimed';
    botSelectedTC = 'untimed';
    return;
  }
  var incStr = _botIncSec > 0 ? ' + ' + _botIncSec + 's' : '';
  el.textContent = _botBaseMin + ' min' + incStr;
  // Store as custom TC
  var key = 'custom';
  TIME_CONTROLS.custom = { label: _botBaseMin + '+' + _botIncSec, time: _botBaseMin * 60, inc: _botIncSec };
  botSelectedTC = key;
}

// Legacy botSetTC kept for save/load compatibility
function botSetTC(key) {
  botSelectedTC = key;
  // Map legacy keys back to new UI
  var legacyMap = {
    'untimed': [0,0], 'bullet': [1,0], 'blitz3': [3,2],
    'blitz5': [5,0], 'rapid10': [10,0], 'rapid15': [15,10], 'tournament': [30,0]
  };
  if (legacyMap[key]) {
    botSetBaseMin(legacyMap[key][0]);
    botSetIncSec(legacyMap[key][1]);
  }
}

// ── Bot name generation ──────────────────────────────────────────────────────
function botGenerateName() {
  // Check if user has set a custom name
  var nameEl = document.getElementById('botNameInput');
  if (nameEl && nameEl.value.trim()) return nameEl.value.trim();

  // Auto-generate from settings
  var tpLabel = { steady: 'Steady', normal: 'Normal', panicky: 'Panicky' }[botTimePressure] || '';
  var tabLabel = '';
  if (botTab === 'sf') {
    var lvl = parseInt(document.getElementById('sfLevel').value) || 8;
    tabLabel = 'Stockfish ' + lvl;
  } else if (botTab === 'maia3') {
    tabLabel = 'Maya ' + (maia3SelectedRating || '1200');
  } else if (botTab === 'maia') {
    tabLabel = 'Lichess ' + (lcSelectedRating || '1200');
  } else if (botTab === 'hybrid') {
    tabLabel = 'Hybrid Bot';
  }
  return (tpLabel ? tpLabel + ' ' : '') + tabLabel;
}

// Sets the player name display for the bot and human
function botEngineTag() {
  // Show live engine type after first move (no level — keeps player guessing on SF/hybrid)
  if (lastBotMoveSource) {
    return ' ‹' + lastBotMoveSource + '›';
  }
  // Before first move: show configured tab type only
  if (botTab === 'maia3')  return ' ‹Maia3›';
  if (botTab === 'maia')   return ' ‹LC+Maia›';
  if (botTab === 'lcsf')   return ' ‹LC+SF›';
  if (botTab === 'sf')     return ' ‹SF›';
  if (botTab === 'hybrid') return ' ‹Hybrid›';
  return '';
}

function botUpdatePlayerNames(humanColor) {
  var botName   = botGenerateName() + botEngineTag();
  var humanName = 'You';
  var nameW = document.querySelector('#playerBoxW .player-name');
  var nameB = document.querySelector('#playerBoxB .player-name');
  if (humanColor === 'white') {
    if (nameW) nameW.textContent = humanName;
    if (nameB) nameB.textContent = botName;
  } else {
    if (nameW) nameW.textContent = botName;
    if (nameB) nameB.textContent = humanName;
  }
}

// Brief amber toast for engine problems — auto-dismisses after 6 s
function showEngineWarning(msg) {
  var existing = document.getElementById('bm-engine-warn');
  if (existing) existing.remove();
  var d = document.createElement('div');
  d.id = 'bm-engine-warn';
  d.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);' +
    'background:#1e1200;border:1px solid rgba(235,140,0,0.65);border-radius:6px;' +
    'color:#f0ede8;font-size:12px;padding:10px 20px;z-index:9999;max-width:360px;' +
    'text-align:center;box-shadow:0 4px 22px rgba(0,0,0,0.75);pointer-events:none;';
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(function(){ if(d.parentNode) d.parentNode.removeChild(d); }, 6000);
}

function _checkEngineReady(tab) {
  var sfTabs = ['sf','stockfish','lcsf','hybrid'];
  var maiaTabs = ['maia3','maia','lcmaia','hybrid'];
  if (sfTabs.includes(tab)) {
    if (sfWorker && !sfReady) {
      showEngineWarning('⚠ Stockfish is loading — the first move may be delayed.');
    } else if (!sfWorker) {
      // Will be started by sfInit() — no warning needed, just inform
    }
  }
  if (maiaTabs.includes(tab)) {
    var st = (typeof _maiaStatus !== 'undefined') ? _maiaStatus : 'idle';
    var rdy = (typeof _maiaReady !== 'undefined') ? _maiaReady : false;
    if (!rdy) {
      if (st === 'no-cache') {
        showEngineWarning('⚠ Maia 3 model not downloaded. Open the bot panel and download it first.');
      } else if (st === 'error') {
        showEngineWarning('⚠ Maia 3 failed to load. Try reloading the page.');
      } else if (st === 'downloading' || st === 'loading') {
        showEngineWarning('⚠ Maia 3 is loading — the first move may be delayed.');
      }
    }
  }
}

async function botStart() {
  // Guard: starting (or restarting) a game while one is in progress forfeits
  // it — online game OR an active bot game with moves already played.
  //
  // A posted challenge counts too, even though nothing is being played. It used
  // to slip through: post a challenge, go back to the board, start a bot game —
  // then whenever someone accepted, the accept tore the bot game down mid-play.
  // Requiring the challenge to be withdrawn first is what makes that impossible.
  const _live    = typeof _isLiveGame === 'function' && _isLiveGame();
  const _pending = typeof _isPendingChallenge === 'function' && _isPendingChallenge();
  if (_live || _pending) {
    if (!confirmAbandonLiveGame('Start a new bot game')) return;
    // Tear down an online game; an active bot game is replaced below anyway
    if (typeof mpRoomId !== 'undefined' && mpRoomId) {
      // Only an actual game can be resigned — a standing offer is just withdrawn.
      if (_live && typeof mpWs !== 'undefined' && mpWs && mpWs.readyState === WebSocket.OPEN) {
        try { mpWs.send(JSON.stringify({ type: 'resign' })); } catch(e) {}
      }
      if (typeof mpLeave === 'function') mpLeave();
    }
  }

  botActive = false;
  botThinking = false;
  _botGameGen++;   // invalidate any in-flight botMakeMove from the previous game
  if (typeof botPremoveReset === 'function') botPremoveReset(); // drop stale premove + stats
  clearGhostPieces();
  botGhostResponses = {};
  botLastHoverSq = -1;

  // Check engine readiness and warn the user if something isn't loaded
  _checkEngineReady(botTab);

  // Pre-init Stockfish in background
  if (botTab !== 'maia') sfInit().catch(e => console.warn('SF init:', e));
  // Signal a new game to SF so its transposition table is cleared once,
  // not on every single move (which would actively hurt its play quality).
  if (sfWorker && sfReady) {
    sfWorker.postMessage('ucinewgame');
  }
  sfCurrentSkillLevel = -1; // force skill-level to be (re)sent on first move

  // Clear any leftover multiplayer display state so it doesn't interfere with
  // board-flip logic in render() and getSq() (which OR boardFlipped with mpRole).
  mpRoomId = null;
  mpRole = null;

  // Apply player color FIRST so boardFlipped is correct before resetGame renders.
  // Always resolve 'random' here and write it back so all downstream code that
  // reads botPlayerColor (botClockMs, botPostMoveHook, playerColor, etc.) is consistent.
  let pc = botPlayerColor;
  if (pc === 'random') pc = Math.random() < 0.5 ? 'white' : 'black';
  botPlayerColor = pc;
  boardFlipped = (pc === 'black');
  // Sync the CSS class so player boxes rearrange to match board orientation
  var _bc = document.getElementById('board-col');
  if (_bc) _bc.classList.toggle('board-flipped', boardFlipped);

  // Apply time control then reset board (render() inside resetGame will use correct flip)
  clockInit(botSelectedTC || 'untimed');
  resetGame();

  // "Play from here": consume a pending custom start position (from replay or
  // a loaded PGN). Restart Bot Game re-starts from the standard position.
  var _customStart = false;
  if (window._pendingStartPos && window._pendingStartPos.fen) {
    const sp = window._pendingStartPos;
    window._pendingStartPos = null;
    _customStart = applyStartPosition(sp.fen, sp.sans);
  }

  // Phase 1: reset move history and capture starting clock for fracRemaining
  botMoveHistory = [];
  botSanHistory  = [];
  botOppClockMs = null;
  // Sample per-game opening familiarity jitter. Lower ELO bots have uneven
  // book knowledge (high variance); higher ELO bots are more consistent.
  // Variance shrinks from ±3 plies at 600 to ±1 ply at 2600.
  {
    const _elo = (typeof botEffectiveElo === 'function') ? botEffectiveElo() : 1500;
    const _t   = Math.max(0, Math.min(1, (_elo - 600) / 2000));
    const _range = 3 - _t * 2; // 3 at 600 ELO, 1 at 2600
    _bookFamiliarityJitter = (Math.random() * 2 - 1) * _range;
  }
  // Reset explorer-confidence state so familiarity and surprise start fresh.
  _explorerConfidence    = null;
  _explorerSurpriseBoost = 0;
  // Activate preferred-opening fast path if mode is 'preferred' and slots exist.
  // Bot color is opposite of human player color.
  const _resolvedBotCol = (pc === 'white' ? 'black' : 'white');
  // Per-color opening mode (new panel): pick the mode for the color the bot plays
  // this game. off→none, mainline→mainline, repertoire→preferred.
  if (botOpeningConfig.modeWhite !== undefined || botOpeningConfig.modeBlack !== undefined) {
    const _cm = botOpeningConfig[_resolvedBotCol === 'white' ? 'modeWhite' : 'modeBlack'] || 'off';
    botOpeningMode = (_cm === 'mainline') ? 'mainline' : (_cm === 'repertoire') ? 'preferred' : 'none';
  }
  if (botOpeningMode === 'preferred') {
    const _hasSlots = (botOpeningConfig[_resolvedBotCol] || [])
                        .filter(s => s.name).length > 0;
    // Frequency roll: if < 100%, sometimes skip openings for this game
    const _freqRoll = (botOpeningFrequencyPct >= 100) || (Math.random() * 100 < botOpeningFrequencyPct);
    preferredOpeningActive = _hasSlots && _freqRoll;
  } else {
    preferredOpeningActive = false;
  }
  // Custom-position start: repertoire lines assume the standard opening — skip
  // them. The Lichess explorer stays on: it queries by FEN, so for classic
  // positions it supplies genuine human move frequencies.
  if (_customStart) preferredOpeningActive = false;
  lichessExplorerActive = (botOpeningMode !== 'none');
  // clockTimeW/B are set by clockInit — capture now as the baseline
  try {
    if (typeof clockTimeW !== 'undefined' && clockControl !== 'untimed') {
      botStartClockMs = (botPlayerColor === 'black' ? clockTimeW : clockTimeB) * 1000;
    } else {
      botStartClockMs = null;
    }
  } catch(e) { botStartClockMs = null; }

  botActive = true;
  _botLastDrawOfferPly = -99;

  // Show the Resign/Draw row in the beginner shell so draw offers work vs bots
  var _gaEl = document.getElementById('gameActions');
  if (_gaEl) _gaEl.style.display = 'flex';

  // Update player name displays
  botUpdatePlayerNames(pc);

  // Update UI
  const startBtn = document.getElementById('botStartBtn');
  const stopBtn  = document.getElementById('botStopBtn');
  const sideBtn  = document.getElementById('botSidebarBtn');
  if (startBtn) startBtn.textContent = '↺ Restart Bot Game';
  if (stopBtn)  stopBtn.style.display = '';
  if (sideBtn)  { sideBtn.style.borderColor = '#22a85a'; }
  var bsEl = document.getElementById('botStatus');
  if (bsEl) bsEl.textContent = 'You play ' + (pc === 'white' ? 'White ♔' : 'Black ♚') +
    (botSelectedTC !== 'untimed' ? ' · ' + botSelectedTC : '');

  closeAllPanels();

  // Start clock if timed
  if (botSelectedTC && botSelectedTC !== 'untimed') clockStart();

  // The pro column swaps its idle actions (73px) for Resign/Draw (39px) once a
  // game is live, and proSync is what performs that swap. Without this call the
  // swap waited for the first move — which reads as the board lurching one move
  // into every game, and on a short viewport it genuinely moves it: the extra
  // 73px overflows the page, and the reflow when it disappears shifts the board.
  if (typeof proSync === 'function') proSync();

  // If bot plays White (human is Black), bot moves first
  const botColor = pc === 'white' ? 'b' : 'w';
  if (turn === botColor) {
    setTimeout(botMakeMove, 800);
  } else {
    // Human moves first — start timing their first move for mirror mode
    botUserTurnStartMs = Date.now();
  }
}

function botStop() {
  botActive = false;
  botThinking = false;
  _botGameGen++;   // invalidate any in-flight botMakeMove
  if (typeof botPremoveReset === 'function') botPremoveReset(); // drop stale premove + stats
  clearGhostPieces();
  botGhostResponses = {};
  boardFlipped = false;
  var _bc = document.getElementById('board-col');
  if (_bc) _bc.classList.remove('board-flipped');
  // Phase 1: clear move history and clock baseline on stop
  botMoveHistory = [];
  botSanHistory  = [];
  botStartClockMs = null;
  botOppClockMs = null;
  // Reset mirror timing state
  botUserMoveTimestamps = [];
  botUserTurnStartMs = null;
  preferredOpeningActive = false;
  lichessExplorerActive = false;
  sfCurrentSkillLevel = -1;
  // Reset player names
  lastBotMoveSource = '';
  var nW = document.querySelector('#playerBoxW .player-name');
  var nB = document.querySelector('#playerBoxB .player-name');
  if (nW) nW.textContent = 'White';
  if (nB) nB.textContent = 'Black';

  const startBtn = document.getElementById('botStartBtn');
  const stopBtn  = document.getElementById('botStopBtn');
  const sideBtn  = document.getElementById('botSidebarBtn');
  if (startBtn) startBtn.textContent = '▶ Start Game vs Bot';
  if (stopBtn)  stopBtn.style.display = 'none';
  if (sideBtn)  { sideBtn.style.borderColor = ''; }
  document.getElementById('botStatus').textContent = '';
  // Hide the Resign/Draw row shown for bot games (MP manages it separately)
  var _gaEl2 = document.getElementById('gameActions');
  if (_gaEl2 && (typeof mpRoomId === 'undefined' || !mpRoomId)) _gaEl2.style.display = 'none';
  // Same reason as botStart: the pro column's idle actions come back now, not
  // whenever something else next happens to call proSync.
  if (typeof proSync === 'function') proSync();
}

// ── Save / Load bot config ───────────────────────────────────────────────────
// Collect the full bot configuration as a plain object. Split out of
// botSaveConfig so the session snapshot can persist the exact same shape the
// file export uses — a restored game must come back as the same opponent, not
// a default bot wearing its name.
function botCollectConfig(configName, botNameVal) {
  // Every DOM read here is guarded. The Maia rating slider (#maiaElo) was
  // replaced by the #maia3RatingBtns button row backed by maia3SelectedRating,
  // and the stale getElementById('maiaElo').value threw — which took out Save
  // Config entirely, not just this snapshot.
  const _num = (id, dflt) => {
    const el = document.getElementById(id);
    const v = el ? parseFloat(el.value) : NaN;
    return isNaN(v) ? dflt : v;
  };
  return {
    name: configName,
    botName: botNameVal || '',
    tab: botTab,
    stockfish: {
      level: _num('sfLevel', 8),
      pressureLevel: _num('sfPressureLevel', 4),
      temperature: _num('sfTemperature', 0)
    },
    maia: {
      elo: (typeof maia3SelectedRating !== 'undefined' && maia3SelectedRating)
        ? maia3SelectedRating : _num('maiaElo', 1200),
      temperature: _num('maia3Temp', _num('maiaTemp', 1.0))
    },
    hybrid: botHybridSlots,
    timePressure: botTimePressure,
    timeBehavior: botTimeBehavior,
    pace: _num('botPace', 40),
    playerColor: botPlayerColor,
    ghostPieces: !!(document.getElementById('cbGhostPieces') || {}).checked,
    premove: {
      enabled:      botPremoveEnabled,
      ratePct:      botPremoveRatePct,
      minPct:       botPremoveMinPct,
      onlyLowClock: botPremoveOnlyLowClock,
      oppClockSecs: botPremoveOppClockSecs,
      clockSecs:    botPremoveClockSecs,
      bustDelayMs:  botPremoveBustDelayMs
    },
    opening: {
      mode: botOpeningMode,
      config: botOpeningConfig,
      frequencyPct: botOpeningFrequencyPct
    },
    // Personality: the attractors, CP budget and custom controls set by the
    // Build-A-Bot panel. Without these a config records a bot's RATING but not
    // the bot — a restored or reloaded Hustler came back as a generic engine of
    // the same strength, which is the opposite of the point.
    personality: {
      attractorValues: (window._bcpAttractorValues && Object.keys(window._bcpAttractorValues).length)
        ? window._bcpAttractorValues : null,
      pieceValues:     (window._bcpPieceValues && Object.keys(window._bcpPieceValues).length)
        ? window._bcpPieceValues : null,
      cpBudget:        window._bcpCpBudget,
      hardFloorCp:     window._bcpCpHardFloor,
      customControls:  Array.isArray(window._bcpCustomControls) ? window._bcpCustomControls : [],
      hustlerTempMode: !!window._bcpHustlerTempMode,
      minProbPct:      (typeof botMinProbPct !== 'undefined') ? botMinProbPct : null,
      dayLower:        (typeof botDayLower   !== 'undefined') ? botDayLower   : null,
      dayUpper:        (typeof botDayUpper   !== 'undefined') ? botDayUpper   : null,
      badDayMode:      (typeof botBadDayMode !== 'undefined') ? !!botBadDayMode : false,
      maiaTempValue:   (typeof botMaiaTempValue !== 'undefined') ? botMaiaTempValue : null,
      sfTempLevel:     (typeof botSfTempLevel   !== 'undefined') ? botSfTempLevel   : null,
      pressureDepth:   (typeof botPressureDepth !== 'undefined') ? botPressureDepth : null,
      deficitWeight:   (typeof botDeficitWeight !== 'undefined') ? botDeficitWeight : null,
      behavBlink:       !!botBehavBlink,
      behavReconsider:  !!botBehavReconsider,
      behavClockMirror: !!botBehavClockMirror,
      canFlag:          !!botCanFlag,
    }
  };
}

function botSaveConfig() {
  var botCustomName = document.getElementById('botNameInput');
  var configName = (botCustomName && botCustomName.value.trim()) || (botGenerateName() + ' — ' + new Date().toLocaleDateString());
  const config = botCollectConfig(configName, botCustomName ? botCustomName.value.trim() : '');
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'blundermind_bot_' + Date.now() + '.json';
  a.click();
}

// Apply a collected config object. Split out of botLoadConfig so the session
// restore can reuse the identical application path — one place decides what a
// config means, whether it came from a file or from the snapshot.
function botApplyConfig(cfg) {
      if (cfg.botName !== undefined) {
        var ni = document.getElementById('botNameInput');
        if (ni) ni.value = cfg.botName || '';
      }
      // Guarded the same way as botCollectConfig: a renamed or absent control
      // must not abort the whole apply half-way through.
      var _setVal = function (id, v) { var e = document.getElementById(id); if (e) e.value = v; };
      var _setTxt = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
      if (cfg.tab) botSetTab(cfg.tab);
      if (cfg.stockfish) {
        _setVal('sfLevel', cfg.stockfish.level || 8);
        _setTxt('sfLevelVal', cfg.stockfish.level || 8);
        _setVal('sfPressureLevel', cfg.stockfish.pressureLevel || 4);
        _setTxt('sfPressureVal', cfg.stockfish.pressureLevel || 4);
        if (cfg.stockfish.temperature !== undefined) {
          _setVal('sfTemperature', cfg.stockfish.temperature);
          var td = document.getElementById('sfTempDesc');
          if (td) td.textContent = cfg.stockfish.temperature === 0 ? 'Always plays at selected level' : 'Varies: 50% target · 20% ±1 · 5% ±2';
        }
      }
      if (cfg.maia) {
        // Rating lives in maia3SelectedRating now, driven by the button row.
        if (cfg.maia.elo && typeof maia3SetRating === 'function') maia3SetRating(cfg.maia.elo);
        _setVal('maiaElo', cfg.maia.elo || 900);
        _setTxt('maiaEloVal', cfg.maia.elo || 900);
        var _mt = cfg.maia.temperature || 1.0;
        _setVal('maia3Temp', _mt);  _setTxt('maia3TempVal', _mt.toFixed(1));
        _setVal('maiaTemp', _mt);   _setTxt('maiaTempVal', _mt.toFixed(1));
      }
      if (cfg.hybrid) { botHybridSlots = cfg.hybrid; botRenderHybridSlots(); }
      if (cfg.timePressure) botSetTpBtn(cfg.timePressure);
      if (cfg.timeBehavior) botSetTimeBehavior(cfg.timeBehavior);
      if (cfg.pace) { _setVal('botPace', cfg.pace); _setTxt('botPaceVal', cfg.pace); }
      // Restore the personality. Only keys actually present are applied, so a
      // config written before this section existed leaves the live values alone
      // rather than blanking the bot into a default engine.
      if (cfg.personality) {
        var _pz = cfg.personality;
        if (_pz.attractorValues) window._bcpAttractorValues = _pz.attractorValues;
        if (_pz.pieceValues)     window._bcpPieceValues     = _pz.pieceValues;
        if (_pz.cpBudget    != null) window._bcpCpBudget    = _pz.cpBudget;
        if (_pz.hardFloorCp != null) window._bcpCpHardFloor = _pz.hardFloorCp;
        if (Array.isArray(_pz.customControls)) window._bcpCustomControls = _pz.customControls;
        window._bcpHustlerTempMode = !!_pz.hustlerTempMode;
        if (_pz.minProbPct != null) botMinProbPct = _pz.minProbPct;
        if (_pz.dayLower   != null) botDayLower   = _pz.dayLower;
        if (_pz.dayUpper   != null) botDayUpper   = _pz.dayUpper;
        botBadDayMode = !!_pz.badDayMode;
        if (_pz.maiaTempValue != null && typeof botMaiaTempValue !== 'undefined') botMaiaTempValue = _pz.maiaTempValue;
        if (_pz.sfTempLevel   != null && typeof botSfTempLevel   !== 'undefined') botSfTempLevel   = _pz.sfTempLevel;
        if (_pz.pressureDepth != null) botPressureDepth = _pz.pressureDepth;
        if (_pz.deficitWeight != null) botDeficitWeight = _pz.deficitWeight;
        if (_pz.behavBlink       !== undefined) botBehavBlink       = !!_pz.behavBlink;
        if (_pz.behavReconsider  !== undefined) botBehavReconsider  = !!_pz.behavReconsider;
        if (_pz.behavClockMirror !== undefined) botBehavClockMirror = !!_pz.behavClockMirror;
        if (_pz.canFlag          !== undefined) botCanFlag          = !!_pz.canFlag;
      }
      if (cfg.playerColor) botSetPlayerColor(cfg.playerColor);
      if (cfg.ghostPieces !== undefined) {
        var _gp = document.getElementById('cbGhostPieces');
        if (_gp) _gp.checked = cfg.ghostPieces;
      }
      if (cfg.premove) {
        botPremoveEnabled      = !!cfg.premove.enabled;
        botPremoveRatePct      = (cfg.premove.ratePct   != null) ? +cfg.premove.ratePct   : 80;
        botPremoveMinPct       = (cfg.premove.minPct    != null) ? +cfg.premove.minPct    : 85;
        botPremoveOnlyLowClock = !!cfg.premove.onlyLowClock;
        botPremoveOppClockSecs = (cfg.premove.oppClockSecs != null) ? +cfg.premove.oppClockSecs : 30;
        botPremoveClockSecs    = (cfg.premove.clockSecs != null) ? +cfg.premove.clockSecs : 30;
        botPremoveBustDelayMs  = (cfg.premove.bustDelayMs != null) ? +cfg.premove.bustDelayMs : 2000;
      }
      if (cfg.opening) {
        botOpeningConfig = Object.assign(botOpeningConfig, cfg.opening.config || {});
        // Migrate old loyalty/repertoire modes to unified 'preferred'
        const mode = cfg.opening.mode === 'loyalty' || cfg.opening.mode === 'repertoire'
          ? 'preferred' : (cfg.opening.mode || 'none');
        botSetOpeningMode(mode);
        if (botOpeningConfig.source) botSetOpeningSrc(botOpeningConfig.source);
        if (mode === 'preferred') { setTimeout(obRestorePreferredUI, 0); }
        if (cfg.opening.frequencyPct != null) {
          botOpeningFrequencyPct = cfg.opening.frequencyPct;
          var freqSlider = document.getElementById('obFreqSlider');
          var freqVal    = document.getElementById('obFreqVal');
          if (freqSlider) freqSlider.value = botOpeningFrequencyPct;
          if (freqVal)    freqVal.textContent = botOpeningFrequencyPct + '%';
        }
      }
}

function botLoadConfig(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const cfg = JSON.parse(e.target.result);
      botApplyConfig(cfg);
      document.getElementById('botStatus').textContent = '✓ Config loaded: ' + (cfg.name || 'unnamed');
      setTimeout(() => { document.getElementById('botStatus').textContent = ''; }, 3000);
    } catch(e) { alert('Could not parse config file.'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ── Init hybrid slots with one default ──────────────────────────────────────
botHybridSlots = [
  { type: 'sf', level: 8, weight: 75 },
  { type: 'maia', level: null, weight: 25 }
];
botRenderHybridSlots();

// The move-odds panel is display:none in the markup and only revealed by
// distUpdateVisibility(). That runs on shell switches and on new games, neither
// of which happens on an ordinary first load — so on the visualization board
// (the default) the panel stayed hidden until you toggled shells or started a
// game. Sync it once at start-up.
document.addEventListener('DOMContentLoaded', function () {
  if (typeof distUpdateVisibility === 'function') distUpdateVisibility();
});

// ── Landing page logic ───────────────────────────────────────────────────────
function landingDismiss() {
  const overlay = document.getElementById('landingOverlay');
  if (!overlay) return;
  overlay.classList.add('fade-out');
  setTimeout(() => {
    overlay.style.display = 'none';
    // Home sits above the marker, so a standing challenge has to reappear once
    // the landing is out of the way again.
    if (typeof mpUpdateChallengeMarker === 'function') mpUpdateChallengeMarker();
  }, 420);
}

// Choose the board experience from the landing: Beginner (amateur) or Expert (pro).
// setShell persists bm_shell, so the choice is remembered for next visit.
function landingSetShell(shell) {
  const s = (shell === 'pro') ? 'pro' : 'amateur';
  if (typeof setShell === 'function') setShell(s);
  // setShell no-ops (and skips persisting) when already in that shell, so commit
  // the choice here too — this is also what marks the visitor as "returning".
  try { localStorage.setItem('bm_shell', s); } catch (e) {}
  _landingApplyShellStyle(s);
}

// Re-style the landing to match a shell: Expert = carbon/amber panel look,
// Beginner = the default blue look. Also syncs the selected toggle button.
function _landingApplyShellStyle(s) {
  const ov = document.getElementById('landingOverlay');
  if (ov) ov.classList.toggle('landing-expert', s === 'pro');
  document.querySelectorAll('.landing-shell-btn').forEach(b => {
    const on = b.dataset.shell === s;
    b.classList.toggle('sel', on);
    // These are role="radio", so the state has to be exposed, not just drawn.
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

// Re-open the landing (Home), styled for the currently active shell.
function landingShow() {
  const ov = document.getElementById('landingOverlay');
  if (!ov) return;
  // Clear the inline display rather than setting one: the overlay is a plain
  // block scroll container now (.landing-inner does the centring), so hardcoding
  // 'flex' here would re-open Home in a different layout than a fresh load.
  ov.style.display = '';
  // force reflow so the fade-in transition re-runs after removing fade-out
  void ov.offsetWidth;
  ov.classList.remove('fade-out');
  _landingApplyShellStyle((typeof proMode !== 'undefined' && proMode) ? 'pro' : 'amateur');
}

function landingChoose(mode) {
  // Commit the current shell so returning visitors skip the landing next time.
  try {
    localStorage.setItem('bm_shell', (typeof proMode !== 'undefined' && proMode) ? 'pro' : 'amateur');
  } catch (e) {}
  landingDismiss();
  setTimeout(() => {
    if (mode === 'bot') {
      openBotModal();
    } else if (mode === 'mp') {
      openPanel('mpPanel');
    } else if (mode === 'pgn') {
      document.getElementById('pgnFileInput').click();
    }
    // 'solo' just dismisses — board is already set up and ready
  }, 300);
  // First time landing on the board, auto-start the guided tour (once per shell).
  if (mode === 'solo' && typeof maybeAutoTour === 'function') {
    setTimeout(maybeAutoTour, 700);
  }
}

// ── Guided tours from the landing ────────────────────────────────────────────
// "Take a guided tour" asks which one first rather than guessing: the board
// overlays and the bot builder are separate skills, and which one a visitor
// wants depends on why they came.
function landingTourPick(show) {
  const el = document.getElementById('landingTourPick');
  if (!el) return;
  el.hidden = !show;
  if (show) {
    const first = el.querySelector('.ltp-opt');
    if (first) first.focus();
    el.scrollIntoView({ block: 'nearest' });
  }
}

// 'board' runs the overlay tour for whichever shell is active; 'bot' opens the
// panel and runs the tour that lives inside its iframe.
function landingStartTour(which) {
  landingTourPick(false);
  try {
    localStorage.setItem('bm_shell', (typeof proMode !== 'undefined' && proMode) ? 'pro' : 'amateur');
  } catch (e) {}
  if (which === 'bot') {
    landingDismiss();
    setTimeout(function () { openBotModal(); startBotTour(); }, 340);
  } else {
    // Mirror the bot branch: leave the landing, show the board this tour is
    // about, then start on its first step.
    //
    // This used to keep the landing up and open with a step explaining the
    // board choice. However well that reads on paper, in use it looks like the
    // tour never started — you press "tour of the visualization board" and you
    // are still staring at the landing page you just chose to leave. Raising
    // the tour above the landing made the panel visible but did not fix the
    // impression, because the landing is still what fills the screen.
    if (typeof landingSetShell === 'function') landingSetShell('amateur');
    landingDismiss();
    // Past the landing's 420ms fade, so the tour opens on the board itself.
    setTimeout(function () {
      if (typeof startTour === 'function') startTour();
    }, 460);
  }
}

// Force the panel's own tour. openBotModal() also sends botTourAuto, which the
// panel ignores once the visitor has seen it — this one was asked for, so it
// takes a message the panel never suppresses.
function startBotTour() {
  setTimeout(function () {
    try {
      const f = document.getElementById('botModalFrame');
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'botTourForce' }, location.origin);
    } catch (e) {}
  }, 620);
}

function landingLoadBotConfig(event) {
  botLoadConfig(event);
  landingDismiss();
  setTimeout(() => openPanel('botPanel'), 350);
}

// Clicking anywhere on the app area behind the overlay also dismisses it
document.addEventListener('DOMContentLoaded', () => {
  // Detect if running on server (vs local file) and update multiplayer UI
  const isServer = location.protocol !== 'file:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
  const mpNote = document.getElementById('mpServerNote');
  const mpCard = document.querySelector('.landing-card[onclick*="mp"]');
  if (isServer) {
    if (mpNote) {
      mpNote.style.background = 'rgba(34,168,90,0.08)';
      mpNote.style.borderColor = 'rgba(34,168,90,0.25)';
      mpNote.innerHTML = '✅ Server connected — multiplayer is available.';
    }
    // Check for ?join= invite link in URL
    mpCheckInviteUrl();
  } else {
    // Running locally — dim the multiplayer landing card and say why (the
    // deployed site never hits this branch)
    if (mpCard) {
      mpCard.style.opacity = '0.55';
      mpCard.title = 'Multiplayer requires the deployed server';
      // Say it in the call-to-action rather than adding an element. The phone
      // layout is a grid with a named area per child; anything extra gets
      // auto-placed into the 36px icon column and wraps to one word per line.
      var mpGo = mpCard.querySelector('.landing-card-go');
      if (mpGo) {
        mpGo.textContent = 'Unavailable locally';
        mpGo.style.background = 'transparent';
        mpGo.style.color = '#c06060';
        mpGo.style.fontStyle = 'italic';
      }
    }
  }
  const cv3 = document.getElementById('cv');
  if (cv3) cv3.addEventListener('click', () => {
    const overlay = document.getElementById('landingOverlay');
    if (overlay && overlay.style.display !== 'none' && !overlay.classList.contains('fade-out')) {
      landingChoose('solo');
    }
  }, { once: true });
});


// ── Maia move-distribution panel (Expert board) ───────────────────────────────
// Retrospective: after each move, show the odds Maia (at a fixed 1500 reference)
// gave every option from the position the move was played in, with the played
// move highlighted. Descriptive, never normative — no eval/good-bad framing.
// Lazy: the extra inference runs only while the panel is expanded. Hidden in
// 2-player online games (same rationale as ghost replies).
let _distExpanded = false;
let _distPreMove  = null;  // { board, turn, castling, epSq, fen } snapshot before last move
let _distLastUci  = null;  // uci of the move just played (may be outside Maia's top set)
let _distSeq      = 0;     // guards against a stale async render overwriting a newer one

// Visualization board only. This used to be Expert-board only, which had it
// backwards on both counts: the Expert board's promise is a clean tournament
// view, and this is the one piece of coaching chrome in a column that is
// otherwise clocks, notation and game actions. Meanwhile everything on the
// visualization board exists to show you what you did not see — and this is
// the only instrument that closes that loop AFTER the move, which is exactly
// where it belongs. Being retrospective, it also cannot pick your move for you.
// Still off in multiplayer, where engine input undercuts human-vs-human play.
function _distApplicable() {
  const pro  = (typeof proMode  !== 'undefined' && proMode);
  const inMp = (typeof mpRoomId !== 'undefined' && mpRoomId);
  return !pro && !inMp;
}

// Which Maia rating the odds are read at.
//
// A fixed 1500 answered a question nobody asked when you are playing a 2200:
// the odds that matter are the ones your ACTUAL opponent was drawing from. So
// when the opponent is Maia-based, use its rating; fall back to 1500 for solo
// exploration and for Stockfish opponents, which have no human rating band.
function _distRefRating() {
  try {
    if (typeof botActive !== 'undefined' && botActive) {
      const tab = (typeof botTab !== 'undefined') ? botTab : '';
      if ((tab === 'maia3' || tab === 'maia' || tab === 'lcmaia' || tab === 'hybrid') &&
          typeof maia3SelectedRating !== 'undefined' && maia3SelectedRating) {
        return String(maia3SelectedRating);
      }
    }
  } catch (e) {}
  return '1500';
}

// Who actually made the move being shown. distCapturePreMove runs before the
// board mutates, so _distPreMove.turn is the side that moved. The panel used to
// say "You played" unconditionally — but it captures on EVERY move including
// the bot's reply, so in a bot game the move on screen is usually the bot's.
function _distMoverLabel() {
  const mover = _distPreMove ? _distPreMove.turn : null;
  if (!mover) return 'Last move';
  if (typeof botActive !== 'undefined' && botActive && typeof botPlayerColor !== 'undefined') {
    const human = botPlayerColor === 'white' ? 'w' : 'b';
    return mover === human ? 'You played' : 'Bot played';
  }
  return 'Last move';   // solo exploration: both sides are the user
}

function distUpdateVisibility() {
  const panel = document.getElementById('distPanel');
  if (panel) panel.style.display = _distApplicable() ? 'flex' : 'none';
}

// Snapshot the position BEFORE a move is applied (called from executeMove pre-mutation).
function distCapturePreMove(from, to, promo) {
  if (!_distApplicable()) { _distPreMove = null; _distLastUci = null; return; }
  try {
    const fullmove = Math.floor((typeof gameMovesAlgebraic !== 'undefined' ? gameMovesAlgebraic.length : 0) / 2) + 1;
    const half     = (typeof halfmoveClock !== 'undefined') ? halfmoveClock : 0;
    _distPreMove = {
      board: {...board}, turn: turn, castling: {...castling}, epSq: epSq,
      fen: boardToFen(board, turn, castling, epSq, half, fullmove),
    };
    _distLastUci = sqToUci(from, to, promo ? String(promo).toLowerCase() : null);
  } catch (e) { _distPreMove = null; _distLastUci = null; }
}

// After a move completes: keep visibility in sync and refresh if the panel is open.
function distOnMoveComplete() {
  distUpdateVisibility();
  if (_distApplicable() && _distExpanded) distRefresh();
}

// New game — drop any stale distribution.
function distReset() {
  _distPreMove = null; _distLastUci = null;
  distUpdateVisibility();
  if (_distExpanded) distRefresh();
}

function distToggle() {
  _distExpanded = !_distExpanded;
  const body = document.getElementById('distBody');
  const chev = document.getElementById('distChevron');
  if (body) body.style.display = _distExpanded ? 'flex' : 'none';
  if (chev) chev.style.transform = _distExpanded ? 'rotate(180deg)' : '';
  if (_distExpanded) distRefresh();
}

async function distRefresh() {
  const rows = document.getElementById('distRows');
  const hint = document.getElementById('distHint');
  const tag  = document.getElementById('distEntropyTag');
  if (!rows) return;
  if (tag) tag.style.display = 'none';
  if (!_distPreMove) {
    rows.innerHTML = '';
    if (hint) hint.textContent = 'Make a move to see the odds Maia gave each option here.';
    return;
  }
  // Maia model required — nudge a cache/init load if it isn't up yet.
  if (typeof _maiaReady === 'undefined' || !_maiaReady) {
    if (typeof maiaInit === 'function' && (typeof _maiaWorker === 'undefined' || !_maiaWorker)) {
      try { maiaInit(); if (typeof _maiaLoadMappings === 'function') _maiaLoadMappings(); } catch (e) {}
    }
    rows.innerHTML = '';
    if (hint) hint.innerHTML = 'Maia 3 model not loaded — <a href="#" onclick="if(typeof maiaDownloadModel===\'function\')maiaDownloadModel();return false;" style="color:#c8922a;">download it</a> to see move odds.';
    return;
  }
  const seq = ++_distSeq;
  if (hint) hint.textContent = 'Reading Maia…';
  // Read at the opponent's own rating when that opponent is Maia — see
  // _distRefRating. The caption names the rating so it is never a guess.
  let probs = null;
  try {
    const saved = lcSelectedRating; lcSelectedRating = _distRefRating();
    probs = await maia3GetMoveProbs(_distPreMove.fen);
    lcSelectedRating = saved;
  } catch (e) { probs = null; }
  if (seq !== _distSeq) return; // superseded by a newer refresh
  if (!probs || !Object.keys(probs).length) {
    rows.innerHTML = '';
    if (hint) hint.textContent = 'No Maia distribution for this position.';
    return;
  }
  distRender(probs);
}

function _distUciToSan(uci) {
  try {
    const mv = uciToSq(uci);
    if (!mv || !_distPreMove) return uci;
    return moveToSAN(mv.from, mv.to, mv.promo || null, _distPreMove.board, _distPreMove.epSq, _distPreMove.castling);
  } catch (e) { return uci; }
}

function distRender(probs) {
  const rows = document.getElementById('distRows');
  const hint = document.getElementById('distHint');
  const tag  = document.getElementById('distEntropyTag');
  if (!rows) return;
  const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const TOP  = 5;
  const top  = entries.slice(0, TOP);
  const rest = entries.slice(TOP);
  const maxP = top.length ? top[0][1] : 1;
  const playedEntry   = _distLastUci ? entries.find(([u]) => u === _distLastUci) : null;
  const playedInTop   = playedEntry && top.some(([u]) => u === _distLastUci);
  const pctTxt = p => { const n = Math.round(p * 100); return (n < 1 ? '<1' : n) + '%'; };
  const html = [];
  const addRow = (uci, p, played, faint) => {
    const w = Math.max(2, Math.round(p / maxP * 100));
    html.push(
      '<div class="dist-row' + (played ? ' played' : '') + '">' +
        '<span class="dist-move"' + (faint ? ' style="opacity:0.6;"' : '') + '>' + _distUciToSan(uci) + '</span>' +
        '<span class="dist-bar-wrap"><span class="dist-bar" style="width:' + w + '%' + (faint ? ';opacity:0.5' : '') + '"></span></span>' +
        '<span class="dist-pct">' + pctTxt(p) + '</span>' +
      '</div>');
  };
  top.forEach(([u, p]) => addRow(u, p, u === _distLastUci, false));
  if (rest.length) {
    const otherP = rest.reduce((s, [, p]) => s + p, 0);
    const w = Math.max(2, Math.round(otherP / maxP * 100));
    html.push(
      '<div class="dist-row"><span class="dist-move" style="opacity:0.6;">other</span>' +
      '<span class="dist-bar-wrap"><span class="dist-bar" style="width:' + w + '%;opacity:0.5"></span></span>' +
      '<span class="dist-pct">' + pctTxt(otherP) + '</span></div>');
  }
  // Played move outside the top set — show it explicitly so the move that was
  // actually played always appears, however unlikely Maia thought it was.
  if (playedEntry && !playedInTop) addRow(playedEntry[0], playedEntry[1], true, false);
  rows.innerHTML = html.join('');
  // Descriptive caption.
  if (hint) {
    if (playedEntry) {
      hint.textContent = _distMoverLabel() + ' ' + _distUciToSan(playedEntry[0]) + ' — ' +
        pctTxt(playedEntry[1]) + ' of Maia ' + _distRefRating() + ' moves here.';
    } else if (_distLastUci) {
      hint.textContent = _distMoverLabel() + ' a move below Maia ' + _distRefRating() +
        '’s considered options here (<0.1%).';
    } else {
      hint.textContent = '';
    }
  }
  // Optional entropy tag (bits): 0 = one forced move, higher = many live options.
  if (tag) {
    const ent = (typeof positionEntropy === 'function') ? positionEntropy(probs) : null;
    const label = (ent == null) ? '' : (ent < 1.0 ? 'forced' : ent > 2.8 ? 'wide open' : '');
    if (label) { tag.textContent = label; tag.style.display = ''; }
    else tag.style.display = 'none';
  }
}

// Donate JS stubs (functionality temporarily disabled)
function toggleHaikuBox() {
  var box = document.getElementById('haikuBox');
  if (box) box.style.display = box.style.display === 'none' ? '' : 'none';
}
function submitHaiku() {
  var txt = document.getElementById('donateHaiku');
  if (!txt || !txt.value.trim()) return;
  window.open('mailto:?subject=Blundermind%20Haiku&body=' + encodeURIComponent(txt.value));
  txt.value = '';
}

/* Ko-fi URL: update href in donate panel HTML to your actual ko-fi.com page */

/* ═══════════════════════════════════════════════════════════════
   BOT CONTROL PANEL MODAL
═══════════════════════════════════════════════════════════════ */
function openBotModal() {
  const modal = document.getElementById('botModal');
  if (modal) modal.style.display = 'block';
  // Ensure Maia worker is running so it can detect the cached model in IndexedDB.
  // Without this, _maiaStatus stays 'idle' forever when the new bot-control-panel
  // modal is used (the old botSetTab path that called maiaInit is never reached).
  if (!_maiaWorker) {
    maiaInit();
    _maiaLoadMappings();
  }
  // Push current Maia status to the panel; small delay so iframe scripts are ready.
  // _maiaUpdateStatusUI() will send follow-up pushes as the worker reports back.
  setTimeout(function() {
    try {
      var frame = document.getElementById('botModalFrame');
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({
          type: 'maiaStatus', status: _maiaStatus || 'idle',
          ready: _maiaReady, progress: _maiaProgress || 0
        }, location.origin);
        frame.contentWindow.postMessage({ type: 'botTourAuto' }, location.origin);
        // Push current palette so the panel always matches the app's active BG theme.
        if (typeof _syncPanelTheme === 'function') {
          const t = (typeof BG_THEMES !== 'undefined' && typeof currentBgTheme !== 'undefined')
            ? (BG_THEMES[currentBgTheme] || BG_THEMES.navy) : null;
          if (t) _syncPanelTheme(t);
        }
      }
    } catch(e) {}
  }, 120);
}
function closeBotModal() {
  const modal = document.getElementById('botModal');
  if (modal) modal.style.display = 'none';
}

// Pick the band BUTTON a continuous Elo belongs to. The bands are floors, not
// points — the 1600 button plays 1600-1799 games, and 400 covers everything
// below 1000 — so this snaps DOWN into the band that CONTAINS the rating.
// Snapping to the nearest one instead answered a 1550 bot with 1600-1799 games:
// a band it does not belong to, and one it can only have reached by rounding up
// out of its own. Same floor-vs-nearest distinction lcRatingParam makes on the
// wire; this is the UI half of it.
function _snapToLcBand(elo) {
  const bands = [400, 1000, 1200, 1400, 1600, 1800, 2000, 2200];
  let band = bands[0];
  for (const b of bands) if (elo >= b) band = b;
  return String(band);
}

window.addEventListener('message', function(e) {
  // Only accept config from our own origin (the bot-control-panel iframe) —
  // a page embedding this site must not be able to inject bot configs.
  if (e.origin !== location.origin) return;
  if (!e.data) return;
  // Appearance controls inside the bot panel drive the app-wide settings
  if (e.data.type === 'setAppearance') {
    if (e.data.bg && BG_THEMES[e.data.bg]) applyBgTheme(e.data.bg);           // re-pushes vars
    if (e.data.board && BOARD_THEMES[e.data.board]) applyBoardTheme(e.data.board);
    if (e.data.pieces) setPieceSet(e.data.pieces);
    if (e.data.shell && typeof setShell === 'function') setShell(e.data.shell === 'pro' ? 'pro' : 'amateur');
    return;
  }
  if (e.data.type === 'formatChanged') {
    if (typeof applyFormat === 'function') applyFormat(e.data.format, true);  // true = no echo back
    return;
  }
  // The bot tour finished and the visitor chose the board tour. Close the panel
  // first — the overlay tour measures elements behind it.
  if (e.data.type === 'startBoardTour') {
    closeBotModal();
    // The panel names which board it wants. Switch shells before starting:
    // TOURS.pro targets chrome that only exists in pro mode, and startTour()
    // drops steps whose targets aren't visible.
    if (e.data.shell && typeof setShell === 'function') {
      setShell(e.data.shell === 'pro' ? 'pro' : 'amateur');
    }
    setTimeout(function () { if (typeof startTour === 'function') startTour(); }, 440);
    return;
  }
  if (e.data.type !== 'botConfig') return;
  const cfg = e.data;
  // Keep the applied config so the pro board's "Save bot" can export it later
  window._lastAppliedBotConfig = cfg;

  // Engine tab
  const engineMap = { maia3: 'maia3', stockfish: 'sf', hybrid: 'hybrid', lcsf: 'lcsf', lcmaia: 'maia' };
  botSetTab(engineMap[cfg.engine] || 'sf');

  // Player color (resolved in botStart if 'random')
  botPlayerColor = cfg.color || 'random';

  // Time control — build a 'custom' entry so clockInit() finds a valid key
  if (cfg.tcTime > 0) {
    TIME_CONTROLS.custom = {
      label:       cfg.tcTime + '+' + (cfg.tcInc || 0),
      time:        cfg.tcTime * 60,
      inc:         cfg.tcInc || 0,
      bonusSecs:   (cfg.tcBonus || 0) * 60,
      bonusAtMove: cfg.tcBonusAtMove || 0,
      incFromMove: cfg.tcIncFromMove || 1
    };
    botSelectedTC = 'custom';
  } else {
    botSelectedTC = 'untimed';
  }

  // Stockfish level: new panel 1–10 → existing 1–20 (multiply ×2)
  const sfLvl20 = Math.min(20, Math.max(1, (cfg.sfLevel || 5) * 2));
  var sfLvlEl = document.getElementById('sfLevel');
  if (sfLvlEl) { sfLvlEl.value = sfLvl20; document.getElementById('sfLevelVal').textContent = sfLvl20; }
  var pressLvl = Math.max(1, sfLvl20 - 4);
  var pressEl = document.getElementById('sfPressureLevel');
  if (pressEl) { pressEl.value = pressLvl; document.getElementById('sfPressureVal').textContent = pressLvl; }

  // SF Variety: store slider percentages directly so sfPickLevel uses them
  botSfVar1 = cfg.sfvar1 || 0;
  botSfVar2 = cfg.sfvar2 || 0;

  // Maia3 ELO and temperature (temp derived from style gauge in new panel)
  maia3SetRating(cfg.elo || 1500);
  var m3TempEl = document.getElementById('maia3Temp');
  if (m3TempEl) { m3TempEl.value = cfg.maia3Temp || 1.0; document.getElementById('maia3TempVal').textContent = (cfg.maia3Temp || 1.0).toFixed(1); }

  // LC mode ratings (snap continuous ELO to nearest Lichess rating band)
  if (cfg.engine === 'lcsf')   { lcsfSetRating(_snapToLcBand(cfg.lcsfElo || 2000)); }
  if (cfg.engine === 'lcmaia') { lcSetRating(_snapToLcBand(cfg.lcMaiaLcElo || 2000)); maia3SetRating(cfg.lcMaiaMaiaElo || 1500); }

  // Temperature — store raw float; also update legacy maiaTemp DOM element for fallback reads
  if (cfg.tempValue != null) {
    botMaiaTempValue = Math.max(0.1, Math.min(4.0, parseFloat(cfg.tempValue) || 1.0));
    var _mTempEl = document.getElementById('maiaTemp');
    if (_mTempEl) _mTempEl.value = Math.min(3.0, Math.max(0.3, botMaiaTempValue));
  }
  // Temperature preset → sfPickLevel tier (deterministic=0 focused=1 neutral=2 varied=3 wild=4)
  var tempTierMap = { deterministic: 0, low: 1, neutral: 2, high: 3, wild: 4 };
  botSfTempLevel = tempTierMap.hasOwnProperty(cfg.tempPresetId) ? tempTierMap[cfg.tempPresetId] : 2;

  // Timing behavior — 'complexity' is now a live mode
  var timingMap = { complexity: 'complexity', instant: 'instant', fixed: 'fixed', mirror: 'mirror' };
  botSetTimeBehavior(timingMap[cfg.timingMode] || 'pace');
  botFixedDelayMs    = cfg.fixedDelayMs    || 5000;
  botMirrorOffsetPct = cfg.mirrorOffsetPct || 0;
  botCplxBase = cfg.cplxBase || 3;
  botCplxMin  = cfg.cplxMin  || 0.4;
  botCplxMax  = cfg.cplxMax  || 2.5;

  // Human behaviour modifiers
  botBehavReconsider  = cfg.behavReconsider  !== false;
  botBehavBlink       = cfg.behavBlink       !== false;
  botBehavClockMirror = cfg.behavClockMirror !== false;
  botCanFlag          = cfg.canFlag          !== false;
  // Time-pressure feel. Both default to the tuned values rather than 0 so a
  // config saved before these existed still gets the graduated behaviour —
  // 0 would silently restore the old "ignore my own clock" model.
  botPressureDepth    = (cfg.pressureDepth  != null) ? Math.max(0, Math.min(1, +cfg.pressureDepth))  : 0.85;
  botDeficitWeight    = (cfg.deficitWeight  != null) ? Math.max(0, Math.min(1, +cfg.deficitWeight))  : 0.5;

  // Premove — the bot commits a reply before seeing the human's move, so the
  // human can practice baiting a premove and punishing it.
  botPremoveEnabled      = !!cfg.premoveEnabled;
  botPremoveRatePct      = (cfg.premoveRatePct   != null) ? +cfg.premoveRatePct   : 80;
  botPremoveMinPct       = (cfg.premoveMinPct    != null) ? +cfg.premoveMinPct    : 85;
  botPremoveOnlyLowClock = !!cfg.premoveOnlyLowClock;
  botPremoveOppClockSecs = (cfg.premoveOppClockSecs != null) ? +cfg.premoveOppClockSecs : 30;
  botPremoveClockSecs    = (cfg.premoveClockSecs != null) ? +cfg.premoveClockSecs : 30;
  botPremoveBustDelayMs  = (cfg.premoveBustDelayMs != null) ? +cfg.premoveBustDelayMs : 2000;

  // Time pressure max drop → drives sfEffectiveLevel floor
  botTimePressureMaxDrop = (cfg.timePressureMaxDrop != null) ? cfg.timePressureMaxDrop : null;

  // Candidate filter (absolute popularity floor; legacy cfg.blunderLimitCp is
  // ignored — the CP budget is now engine-verified per pick instead)
  botMinProbPct     = (cfg.minProbPct     != null) ? cfg.minProbPct     : 5;
  botBadDayMode     = !!cfg.badDayMode;

  // Draw behaviour + stalemate seeking (desperation)
  botAcceptDraws      = !!cfg.acceptDraws;
  botDrawAcceptMargin = (cfg.drawAcceptMarginCp != null) ? +cfg.drawAcceptMarginCp : 50;
  botOfferDraws       = !!cfg.offerDraws;
  botOfferDrawThresh  = (cfg.offerDrawThreshCp  != null) ? +cfg.offerDrawThreshCp  : 50;
  botOfferDrawMove    = (cfg.offerDrawFromMove  != null) ? +cfg.offerDrawFromMove  : 20;
  botStaleSeek        = !!cfg.staleSeek;
  botStaleSeekMove    = (cfg.staleSeekFromMove  != null) ? +cfg.staleSeekFromMove  : 30;
  botStaleSeekCp      = (cfg.staleSeekCp        != null) ? +cfg.staleSeekCp        : 500;

  // Time pressure curves (cvA = ELO degradation, cvB = temperature ramp — it
  // flattens the move distribution rather than cutting it off; see
  // timePressureTempByThink).
  // Each mechanism has its own off flag (pressureOffA / pressureOffB); older
  // configs only carry the master pressureOff flag, which disables both.
  var _tpOffA = (cfg.pressureOffA != null) ? !!cfg.pressureOffA : !!cfg.pressureOff;
  var _tpOffB = (cfg.pressureOffB != null) ? !!cfg.pressureOffB : !!cfg.pressureOff;
  botPressureCurveA = (!_tpOffA && cfg.ctrlA && cfg.ctrlA.length >= 2) ? cfg.ctrlA : null;
  // ctrlB's y-axis changed from a 0-100 distribution % to a sampling
  // temperature (user-adjustable ceiling, panel slider caps at 15). A save
  // from before that change carries percentage-scale points (routinely >15)
  // that would misread as an absurd temperature and wreck move sampling —
  // discard and let the panel reseed a fresh curve from the current base
  // Temperature instead.
  var _ctrlBLooksLegacy = cfg.ctrlB && cfg.ctrlB.some(function(p){ return +p.y > 15; });
  botPressureCurveB = (!_tpOffB && cfg.ctrlB && cfg.ctrlB.length >= 2 && !_ctrlBLooksLegacy) ? cfg.ctrlB : null;

  // Weaponizer
  botWeaponizerEnabled = !!cfg.weaponizerEnabled;
  // Trigger is the opponent's remaining clock, not the bot's lead over it — a
  // 5-minute lead means nothing in a 90-minute game, but 15 s left is always
  // flaggable. Bots saved before this change carry weaponizerLeadSec instead;
  // that value was a lead, not a threshold, so it is ignored in favour of the
  // 15 s default rather than silently reinterpreted.
  botWeaponizerTriggerMs = (cfg.weaponizerTriggerSec != null)
    ? Math.max(1, Math.min(120, +cfg.weaponizerTriggerSec)) * 1000
    : 15000;
  botWeaponizerMinMs   = Math.max(0, Math.min(5, +cfg.weaponizerMinSec || 0)) * 1000;

  // Calm/panicky (-5..+5) → botTimePressure
  // Center (0) = steady (no boost); positive = panicky boost under pressure
  var cp = cfg.calmPanickyValue || 0;
  botTimePressure = cp >= 3 ? 'panicky' : cp >= 1 ? 'normal' : 'steady';

  // Opening — per-color modes (As White / As Black): off | mainline | repertoire.
  // The bot only plays one color per game, so the effective global botOpeningMode
  // is resolved from the bot's color at game start (see botStartGameSetup).
  // Back-compat: older configs sent a single global cfg.openingMode.
  var _owMode = cfg.openingModeWhite, _obMode = cfg.openingModeBlack;
  if (_owMode === undefined && _obMode === undefined && cfg.openingMode) {
    _owMode = _obMode = cfg.openingMode;
  }
  var mapSlot = function(s) { return { eco: s.code, familyPrefix: (s.code || '').slice(0,2), name: s.name, pct: s.pct }; };
  botOpeningConfig.white        = (cfg.repSlots && cfg.repSlots.white || []).map(mapSlot);
  botOpeningConfig.black        = (cfg.repSlots && cfg.repSlots.black || []).map(mapSlot);
  botOpeningConfig.source       = cfg.openingSource || 'masters';
  botOpeningConfig.maxBookDepth = cfg.openingDepth  || 20;
  botOpeningConfig.strictness   = 0.8;
  if (cfg.modernOnly) botOpeningConfig.since = '2020-01'; else delete botOpeningConfig.since;
  botOpeningConfig.modeWhite    = _owMode || 'off';
  botOpeningConfig.modeBlack    = _obMode || 'off';
  // Provisional global mode for the legacy inline opening UI; per-color mode wins
  // at game start. Map: off→none, mainline→mainline, repertoire→preferred.
  var _provMode = (botOpeningConfig.modeWhite !== 'off') ? botOpeningConfig.modeWhite
                : (botOpeningConfig.modeBlack !== 'off') ? botOpeningConfig.modeBlack : 'off';
  botSetOpeningMode(_provMode === 'mainline' ? 'mainline' : _provMode === 'repertoire' ? 'preferred' : 'none');

  // Hybrid slots: panel sends type 'sf' (level 1–10 in s.level); the legacy
  // panel sent 'stockfish' (s.sfLevel). Accept both — checking only
  // 'stockfish' silently turned every SF slot into a Maia slot.
  if (cfg.engine === 'hybrid' && cfg.hybridSlots && cfg.hybridSlots.length) {
    botHybridSlots = cfg.hybridSlots.map(function(s) {
      var isSf = (s.type === 'stockfish' || s.type === 'sf');
      return {
        type:   isSf ? 'sf' : 'maia',
        elo:    isSf ? null : (s.elo || 1500), // Maia3 slot ELO, used directly by botMakeMove
        level:  isSf ? Math.min(20, Math.max(1, (s.sfLevel || s.level || 5) * 2))
                     : Math.round((s.elo || 1500) / 200),
        weight: s.pct || 0
      };
    });
    botRenderHybridSlots();
  }

  // Move quality range (dual slider)
  botDayLower = (cfg.dayLower != null) ? cfg.dayLower : 0;
  botDayUpper = (cfg.dayUpper != null) ? cfg.dayUpper : 100;

  // Attractor + piece values — used live by applyMoveAttractors()
  window._bcpAttractorValues  = cfg.attractorValues || {};
  window._bcpPieceValues      = cfg.pieceValues     || {};
  window._bcpCpBudget         = cfg.cpBudget;
  // Hard Floor: the absolute backstop on picks from ANY mechanism
  // (applyHardFloorBackstop). Budget remains the personality's own ceiling,
  // enforced in applyCpBudgetAcceptance, and also scales attractor push.
  // Defaults to Budget for configs saved before Hard Floor existed.
  window._bcpCpHardFloor      = (cfg.hardFloorCp != null) ? cfg.hardFloorCp : cfg.cpBudget;
  // User-defined custom controls: [{ id, name, metric, phase, value }]
  window._bcpCustomControls   = Array.isArray(cfg.customControls) ? cfg.customControls : [];
  window._bcpHustlerTempMode  = (cfg.personalityId === 'hustler');

  closeBotModal();
  botStart();
});


// ═══════════════════════════════════════════════════════════════════════════
// SESSION PERSISTENCE — surviving a backgrounded phone
// ═══════════════════════════════════════════════════════════════════════════
// Android discards a backgrounded WebView under memory pressure, and this app
// is an unusually fat target: a 44MB Maia net plus Stockfish WASM resident.
// When it comes back the page has RELOADED, and because nothing about a live
// game was ever persisted the user landed on the home screen with the game
// gone. beforeunload does not fire on an OS kill, so the snapshot is written
// eagerly — after every move and on visibilitychange — rather than on exit.
//
// Multiplayer is deliberately excluded: the room lives on the server, and a
// restored client would be reasoning about a position the server disagrees
// with. Those reconnect through the multiplayer path or not at all.
const BM_SESSION_KEY = 'bm_liveGame';
const BM_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function bmSessionEligible() {
  if (typeof mpRoomId !== 'undefined' && mpRoomId) return false;   // multiplayer
  if (typeof replayActive !== 'undefined' && replayActive) return false;
  if (typeof gameOver === 'undefined' || gameOver) return false;
  if (typeof gameMovesAlgebraic === 'undefined' || !gameMovesAlgebraic.length) return false;
  return true;
}

function bmSessionSave() {
  if (!bmSessionEligible()) return;
  try {
    const fullmove = Math.floor(gameMovesAlgebraic.length / 2) + 1;
    const snap = {
      v: 1,
      ts: Date.now(),
      fen: boardToFen(board, turn, castling, epSq, halfmoveClock, fullmove),
      moves: gameMovesAlgebraic.slice(),
      lastMoveFrom: lastMoveFrom,
      lastMoveTo: lastMoveTo,
      startFen: (typeof _gameStartFen !== 'undefined') ? _gameStartFen : null,
      startSans: (typeof _gameStartSans !== 'undefined' && _gameStartSans) ? _gameStartSans.slice() : [],
      halfmoveClock: halfmoveClock,
      positionCounts: Object.assign({}, positionCounts),
      flipped: !!boardFlipped,
      clock: {
        control: clockControl,
        inc: clockInc,
        w: clockTimeW,
        b: clockTimeB
      },
      bot: botActive ? {
        active: true,
        playerColor: botPlayerColor,
        startClockMs: botStartClockMs,
        moveHistory: botMoveHistory.slice(),
        sanHistory: botSanHistory.slice(),
        config: botCollectConfig('session', (document.getElementById('botNameInput') || {}).value || '')
      } : { active: false }
    };
    localStorage.setItem(BM_SESSION_KEY, JSON.stringify(snap));
  } catch (e) {
    // Never break the game over a failed snapshot — but never fail silently
    // either. A swallowed throw here is exactly how a stale element id went
    // unnoticed: the game looked fine and simply stopped being resumable.
    console.warn('bmSessionSave failed — game will not be resumable:', e);
  }
}

function bmSessionClear() {
  try { localStorage.removeItem(BM_SESSION_KEY); } catch (e) {}
}

// Called from updatePlayerBoxes(), alongside maybeAutoSaveGame — the one place
// that already runs after every move and every turn change.
function maybeSessionSave() {
  if (typeof gameOver !== 'undefined' && gameOver) { bmSessionClear(); return; }
  bmSessionSave();
}

function bmSessionRead() {
  try {
    const raw = localStorage.getItem(BM_SESSION_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || snap.v !== 1 || !snap.fen) return null;
    if (!snap.moves || !snap.moves.length) return null;
    if (Date.now() - (snap.ts || 0) > BM_SESSION_MAX_AGE_MS) { bmSessionClear(); return null; }
    return snap;
  } catch (e) { return null; }
}

function bmSessionRestore() {
  const snap = bmSessionRead();
  if (!snap) return false;
  try {
    // Bot identity first: botApplyConfig touches sliders and the colour
    // buttons, and botSetPlayerColor flips the board. Doing it before the
    // position means nothing it changes can clobber the restored board.
    if (snap.bot && snap.bot.active && snap.bot.config) {
      botApplyConfig(snap.bot.config);
      botPlayerColor  = snap.bot.playerColor || botPlayerColor;
      botStartClockMs = (snap.bot.startClockMs != null) ? snap.bot.startClockMs : null;
      botMoveHistory  = Array.isArray(snap.bot.moveHistory) ? snap.bot.moveHistory.slice() : [];
      botSanHistory   = Array.isArray(snap.bot.sanHistory)  ? snap.bot.sanHistory.slice()  : [];
    }

    // Clocks: clockInit resets the times to the control defaults, so it has to
    // run first and the saved times go on top of it.
    clockStop();
    clockInit(snap.clock ? snap.clock.control : 'untimed');
    if (snap.clock) {
      if (typeof snap.clock.inc === 'number') clockInc = snap.clock.inc;
      clockTimeW = snap.clock.w;
      clockTimeB = snap.clock.b;
    }

    // Position. parseFen sets turn/castling/epSq as a side effect.
    board = parseFen(snap.fen);
    // Charge the player who was on move for the time the app was gone. The
    // snapshot records when it was written, so this is real elapsed time, not
    // a guess — without it, closing the tab was a free pause, which is exactly
    // what a clock is supposed to prevent. Applied AFTER parseFen because that
    // is what sets `turn`.
    if (snap.clock && snap.clock.control !== 'untimed' && typeof snap.ts === 'number') {
      const awaySec = Math.max(0, Math.floor((Date.now() - snap.ts) / 1000));
      if (awaySec > 0) {
        if (turn === 'w') clockTimeW = Math.max(0, clockTimeW - awaySec);
        else              clockTimeB = Math.max(0, clockTimeB - awaySec);
      }
    }
    halfmoveClock      = snap.halfmoveClock || 0;
    positionCounts     = snap.positionCounts || {};
    gameMovesAlgebraic = Array.isArray(snap.moves) ? snap.moves.slice() : [];
    lastMoveFrom       = (snap.lastMoveFrom != null) ? snap.lastMoveFrom : -1;
    lastMoveTo         = (snap.lastMoveTo   != null) ? snap.lastMoveTo   : -1;
    _gameStartFen      = snap.startFen  || null;
    _gameStartSans     = Array.isArray(snap.startSans) ? snap.startSans.slice() : [];
    gameOver = false; gameOverMsg = '';
    promotionPending = null; premoveQueue = [];
    selSq = -1; legalMoves = []; dragFrom = -1; dragMoved = false; hoverSq = -1;
    clearPreview();
    setAwaitingConfirm(false);

    boardFlipped = !!snap.flipped;
    const bcol = document.getElementById('board-col');
    if (bcol) bcol.classList.toggle('board-flipped', boardFlipped);

    atkMap = buildAtk(board);
    const _rp = computePins(board);
    pinnedWSquares = _rp.w; pinnedBSquares = _rp.b;
    if (typeof indInitAll === 'function') { indInitAll(); indApply(); }

    // Bot game UI: mirror what botStart() puts on screen.
    if (snap.bot && snap.bot.active) {
      botActive = true;
      botThinking = false;
      const _ga = document.getElementById('gameActions');
      if (_ga) _ga.style.display = 'flex';
      if (typeof botUpdatePlayerNames === 'function') botUpdatePlayerNames(botPlayerColor);
      const startBtn = document.getElementById('botStartBtn');
      const stopBtn  = document.getElementById('botStopBtn');
      const sideBtn  = document.getElementById('botSidebarBtn');
      if (startBtn) startBtn.textContent = '↺ Restart Bot Game';
      if (stopBtn)  stopBtn.style.display = '';
      if (sideBtn)  { sideBtn.style.borderColor = '#22a85a'; }
    }

    updatePlayerBoxes();
    render();
    if (typeof landingDismiss === 'function') landingDismiss();

    // Resume the clock only for a timed game that still has time on both sides.
    // Time spent away IS charged (see the deduction above), so a game left long
    // enough comes back already lost on time rather than silently paused —
    // which is what a clock means. Declare that here rather than leaving a
    // playable board sitting at 0:00.
    if (clockControl !== 'untimed') {
      if (clockTimeW <= 0)      clockTimeout('w');
      else if (clockTimeB <= 0) clockTimeout('b');
      else                      clockStart();
    }

    // If it is the bot's move, let it play. The delay matches botStart's, and
    // gives the engines a moment to come back up after the reload.
    if (botActive) {
      const botColor = (botPlayerColor === 'white') ? 'b' : 'w';
      if (turn === botColor) setTimeout(botMakeMove, 1200);
      else if (typeof botUserTurnStartMs !== 'undefined') botUserTurnStartMs = Date.now();
    }

    bmSessionToast();
    return true;
  } catch (e) {
    console.warn('session restore failed', e);
    bmSessionClear();
    return false;
  }
}

// Says what happened and offers the way out, because silently dropping someone
// into a half-played game is its own kind of confusing.
function bmSessionToast() {
  const old = document.getElementById('bm-session-toast'); if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'bm-session-toast';
  d.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
    'background:#14161a;border:0.5px solid rgba(74,200,120,0.5);border-radius:6px;' +
    'color:#e8e6e0;font-family:system-ui,sans-serif;font-size:12px;padding:10px 14px;' +
    'display:flex;align-items:center;gap:12px;z-index:9999;box-shadow:0 4px 18px rgba(0,0,0,0.4);';
  const span = document.createElement('span');
  span.textContent = '♟ Game resumed';
  const btn = document.createElement('button');
  btn.textContent = 'Start fresh';
  btn.style.cssText = 'background:none;border:0.5px solid rgba(232,230,224,0.35);' +
    'border-radius:4px;color:#e8e6e0;font-size:11px;padding:3px 9px;cursor:pointer;font-family:inherit;';
  btn.onclick = function () {
    bmSessionClear();
    d.remove();
    if (typeof botStop === 'function' && botActive) botStop();
    if (typeof resetGame === 'function') resetGame();
    if (typeof landingShow === 'function') landingShow();
  };
  d.appendChild(span); d.appendChild(btn);
  document.body.appendChild(d);
  setTimeout(function () { if (d.parentNode) d.remove(); }, 9000);
}

// Write on the way out as well as after each move: visibilitychange is the one
// signal Android reliably delivers before discarding the page.
document.addEventListener('visibilitychange', function () {
  if (document.hidden) bmSessionSave();
});
window.addEventListener('pagehide', bmSessionSave);

// Restore after the whole app has finished its own inline start-up, so nothing
// downstream re-initialises the board out from under the restored position.
window.addEventListener('load', function () {
  setTimeout(function () {
    // A multiplayer rejoin takes precedence: the server holds the real game,
    // and this local snapshot never covers multiplayer anyway.
    if (typeof _mpResumePending !== 'undefined' && _mpResumePending) return;
    if (typeof mpRoomId !== 'undefined' && mpRoomId) return;
    try { bmSessionRestore(); } catch (e) { console.warn('session restore', e); }
  }, 500);
});
